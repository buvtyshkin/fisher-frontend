import type { FastifyInstance, FastifyReply } from "fastify";
import { extractCardJson } from "../cards/png.js";
import { parseCard, toExportJson, type CardData } from "../cards/card.js";
import {
  deleteCharacter,
  deletePersona,
  getCharacter,
  getPersona,
  listCharacters,
  listPersonas,
  savePersona,
  saveCharacter,
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

      if (req.query.format !== "json" && character.avatar) {
        return reply
          .header("Content-Type", "image/png")
          .header("Content-Disposition", contentDisposition(character.name, "png"))
          .send(character.avatar);
      }

      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Content-Disposition", contentDisposition(character.name, "json"))
        .send(
          toExportJson({
            spec: character.spec as "chara_card_v2",
            data: JSON.parse(character.data) as CardData,
          }),
        );
    },
  );

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
