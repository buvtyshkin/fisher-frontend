import type { FastifyInstance, FastifyReply } from "fastify";
import { extractCardJson, writeCardIntoPng } from "../cards/png.js";
import { parseCard, toExportJson, type CardData } from "../cards/card.js";
import { parsePreset } from "../preset/preset.js";
import { parseLorebook } from "../lorebook/lorebook.js";
import { importSillyTavernChat } from "../import-chat.js";
import { loadedPlugins } from "../plugins.js";
import { getBranch } from "../store.js";
import {
  deleteCharacter,
  deletePersona,
  deleteLorebook,
  deletePreset,
  getCharacter,
  getPersona,
  listCharacters,
  listPersonas,
  getLorebook,
  listLorebooks,
  listPresets,
  saveLorebook,
  savePreset,
  savePersona,
  saveCharacter,
  updateCharacter,
  updatePersona,
} from "../store.js";

interface IdParams {
  id: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const isPng = (file: Buffer) =>
  file.length > 8 && file.subarray(0, 8).equals(PNG_SIGNATURE);

/**
 * Character names are Russian far more often than not, and HTTP headers only
 * carry ASCII — so the readable name goes in the RFC 5987 field and a
 * transliteration-free fallback keeps old clients happy.
 */
function contentDisposition(name: string, extension: string): string {
  const safe = name.replace(/[^\w -]/g, "").trim() || "card";
  const encoded = encodeURIComponent(`${name.replace(/[/\\"]/g, "")}.${extension}`);
  return `attachment; filename="${safe}.${extension}"; filename*=UTF-8''${encoded}`;
}

function sendPng(reply: FastifyReply, avatar: Buffer | null) {
  if (!avatar) return reply.code(404).send({ error: "no avatar" });
  return reply
    .header("Content-Type", "image/png")
    .header("Cache-Control", "public, max-age=86400")
    .send(avatar);
}

export async function libraryRoutes(app: FastifyInstance) {
  /* ── Characters ────────────────────────────────────────────────────────── */

  app.get("/api/characters", async () => listCharacters());

  app.get<{ Params: IdParams }>("/api/characters/:id", async (req, reply) => {
    const character = getCharacter(req.params.id);
    if (!character) return reply.code(404).send({ error: "not found" });
    return {
      id: character.id,
      name: character.name,
      spec: character.spec,
      created_at: character.created_at,
      data: JSON.parse(character.data) as CardData,
    };
  });

  /** Imports a Character Card: a PNG with an embedded card, or plain JSON. */
  app.post("/api/characters/import", async (req, reply) => {
    const upload = await req.file();
    if (!upload) return reply.code(400).send({ error: "нет файла" });

    const file = await upload.toBuffer();
    try {
      const png = isPng(file);
      const card = parseCard(png ? extractCardJson(file) : file.toString("utf8"));
      const saved = saveCharacter({
        name: card.data.name,
        spec: card.spec,
        data: JSON.stringify(card.data),
        avatar: png ? file : null,
      });
      return reply.code(201).send({
        id: saved.id,
        name: saved.name,
        spec: saved.spec,
        created_at: saved.created_at,
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  /**
   * Edits card fields. Only known text fields are writable — everything else
   * the card arrived with is carried through untouched.
   */
  app.patch<{ Params: IdParams; Body: Record<string, unknown> }>(
    "/api/characters/:id",
    async (req, reply) => {
      const character = getCharacter(req.params.id);
      if (!character) return reply.code(404).send({ error: "not found" });

      const data = JSON.parse(character.data) as CardData;
      const body = req.body ?? {};

      const textFields = [
        "name",
        "description",
        "personality",
        "scenario",
        "first_mes",
        "mes_example",
        "system_prompt",
        "post_history_instructions",
        "creator_notes",
        "creator",
        "character_version",
      ] as const;

      for (const field of textFields) {
        if (typeof body[field] === "string") data[field] = body[field] as string;
      }
      for (const field of ["alternate_greetings", "tags"] as const) {
        if (Array.isArray(body[field])) {
          data[field] = (body[field] as unknown[]).filter(
            (v): v is string => typeof v === "string",
          );
        }
      }

      if (!data.name.trim()) return reply.code(400).send({ error: "нужно имя" });

      const saved = updateCharacter(character.id, {
        name: data.name,
        data: JSON.stringify(data),
      })!;
      return {
        id: saved.id,
        name: saved.name,
        spec: saved.spec,
        created_at: saved.created_at,
        data,
      };
    },
  );

  app.delete<{ Params: IdParams }>("/api/characters/:id", async (req, reply) => {
    deleteCharacter(req.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: IdParams }>("/api/characters/:id/avatar", async (req, reply) =>
    sendPng(reply, getCharacter(req.params.id)?.avatar ?? null),
  );

  /**
   * Export back to SillyTavern. A card imported as PNG leaves as the original
   * bytes; one imported as JSON leaves as JSON.
   */
  app.get<{ Params: IdParams; Querystring: { format?: string } }>(
    "/api/characters/:id/export",
    async (req, reply) => {
      const character = getCharacter(req.params.id);
      if (!character) return reply.code(404).send({ error: "not found" });

      const data = JSON.parse(character.data) as CardData;

      if (req.query.format !== "json" && character.avatar) {
        // Re-embed the current card so edits actually leave with the file.
        const keyword = character.spec === "chara_card_v3" ? "ccv3" : "chara";
        const png = writeCardIntoPng(
          character.avatar,
          keyword,
          toExportJson({ spec: character.spec as "chara_card_v2", data }),
        );
        return reply
          .header("Content-Type", "image/png")
          .header("Content-Disposition", contentDisposition(character.name, "png"))
          .send(png);
      }

      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Content-Disposition", contentDisposition(character.name, "json"))
        .send(toExportJson({ spec: character.spec as "chara_card_v2", data }));
    },
  );

  /* ── Presets ───────────────────────────────────────────────────────────── */

  app.get("/api/presets", async () => listPresets());

  /** Imports a SillyTavern Chat Completion preset (JSON). */
  app.post("/api/presets/import", async (req, reply) => {
    const upload = await req.file();
    if (!upload) return reply.code(400).send({ error: "нет файла" });

    const json = (await upload.toBuffer()).toString("utf8");
    const fallbackName = upload.filename.replace(/\.json$/i, "") || "Пресет";

    try {
      const preset = parsePreset(json, fallbackName);
      const saved = savePreset({ name: preset.name || fallbackName, data: json });
      return reply.code(201).send({
        id: saved.id,
        name: saved.name,
        created_at: saved.created_at,
        blocks: preset.order.filter((entry) => entry.enabled).length,
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.delete<{ Params: IdParams }>("/api/presets/:id", async (req, reply) => {
    deletePreset(req.params.id);
    return reply.code(204).send();
  });

  /* ── Chat migration ────────────────────────────────────────────────────── */

  /** Imports a SillyTavern chat (JSONL) as a tree: swipes become siblings. */
  app.post("/api/chats/import", async (req, reply) => {
    const upload = await req.file();
    if (!upload) return reply.code(400).send({ error: "нет файла" });

    const jsonl = (await upload.toBuffer()).toString("utf8");
    try {
      return reply.code(201).send(importSillyTavernChat(jsonl, upload.filename));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  /* ── Plugins ───────────────────────────────────────────────────────────── */

  app.get("/api/plugins", async () =>
    loadedPlugins()
      .filter((plugin) => plugin.action)
      .map((plugin) => ({ name: plugin.name, label: plugin.action!.label })),
  );

  /** Runs a plugin's toolbar action and returns the text for its modal. */
  app.post<{ Params: { name: string }; Body: { chatId?: string } }>(
    "/api/plugins/:name/run",
    async (req, reply) => {
      const plugin = loadedPlugins().find(
        (candidate) => candidate.name === req.params.name,
      );
      if (!plugin?.action) return reply.code(404).send({ error: "not found" });

      const chatId = req.body?.chatId ?? "";
      try {
        const text = await plugin.action.run({
          chatId,
          branch: getBranch(chatId),
        });
        return { title: plugin.action.title, text };
      } catch (error) {
        app.log.error({ plugin: plugin.name, err: error }, "действие плагина упало");
        return reply.code(500).send({ error: (error as Error).message });
      }
    },
  );

  /* ── Lorebooks ─────────────────────────────────────────────────────────── */

  app.get("/api/lorebooks", async () => listLorebooks());

  /** Imports a SillyTavern World Info file. */
  app.post("/api/lorebooks/import", async (req, reply) => {
    const upload = await req.file();
    if (!upload) return reply.code(400).send({ error: "нет файла" });

    const json = (await upload.toBuffer()).toString("utf8");
    const fallbackName = upload.filename.replace(/\.json$/i, "") || "Лорбук";

    try {
      const book = parseLorebook(json, fallbackName);
      const saved = saveLorebook({ name: book.name || fallbackName, data: json });
      return reply.code(201).send({
        id: saved.id,
        name: saved.name,
        created_at: saved.created_at,
        entries: book.entries.length,
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.delete<{ Params: IdParams }>("/api/lorebooks/:id", async (req, reply) => {
    deleteLorebook(req.params.id);
    return reply.code(204).send();
  });

  /** Exports the World Info file exactly as it was imported. */
  app.get<{ Params: IdParams }>("/api/lorebooks/:id/export", async (req, reply) => {
    const book = getLorebook(req.params.id);
    if (!book) return reply.code(404).send({ error: "not found" });
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", contentDisposition(book.name, "json"))
      .send(book.data);
  });

  /* ── Personas ──────────────────────────────────────────────────────────── */

  app.get("/api/personas", async () => listPersonas());

  app.post<{ Body: { name?: string; description?: string } }>(
    "/api/personas",
    async (req, reply) => {
      const name = (req.body?.name ?? "").trim();
      if (!name) return reply.code(400).send({ error: "нужно имя" });
      const persona = savePersona({
        name,
        description: req.body?.description ?? "",
      });
      return reply.code(201).send({
        id: persona.id,
        name: persona.name,
        description: persona.description,
        created_at: persona.created_at,
      });
    },
  );

  app.patch<{ Params: IdParams; Body: { name?: string; description?: string } }>(
    "/api/personas/:id",
    async (req, reply) => {
      const persona = updatePersona(req.params.id, {
        name: req.body?.name,
        description: req.body?.description,
      });
      if (!persona) return reply.code(404).send({ error: "not found" });
      return {
        id: persona.id,
        name: persona.name,
        description: persona.description,
        created_at: persona.created_at,
      };
    },
  );

  app.delete<{ Params: IdParams }>("/api/personas/:id", async (req, reply) => {
    deletePersona(req.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: IdParams }>("/api/personas/:id/avatar", async (req, reply) =>
    sendPng(reply, getPersona(req.params.id)?.avatar ?? null),
  );

  app.post<{ Params: IdParams }>("/api/personas/:id/avatar", async (req, reply) => {
    if (!getPersona(req.params.id)) return reply.code(404).send({ error: "not found" });
    const upload = await req.file();
    if (!upload) return reply.code(400).send({ error: "нет файла" });

    const file = await upload.toBuffer();
    if (!isPng(file)) return reply.code(400).send({ error: "аватар должен быть PNG" });

    updatePersona(req.params.id, { avatar: file });
    return reply.code(204).send();
  });
}
