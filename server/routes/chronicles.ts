import type { FastifyInstance } from "fastify";
import {
  chroniclesForBranch,
  deleteChronicle,
  getBranch,
  getChat,
  getChronicle,
  listChronicles,
  saveChronicle,
  updateChronicle,
} from "../store.js";
import type { ChronicleLevel, Message } from "../db.js";
import { anthropicAdapter } from "../provider.js";
import { chroniclePrompt } from "../chronicle-prompt.js";

interface IdParams {
  id: string;
}

const LEVELS: ChronicleLevel[] = ["scene", "arc", "chapter"];

const isLevel = (value: unknown): value is ChronicleLevel =>
  typeof value === "string" && LEVELS.includes(value as ChronicleLevel);

/** The slice of the branch a chronicle covers, inclusive at both ends. */
function coveredRange(
  branch: Message[],
  fromId: string,
  toId: string,
): Message[] | null {
  const from = branch.findIndex((message) => message.id === fromId);
  const to = branch.findIndex((message) => message.id === toId);
  if (from === -1 || to === -1) return null;
  return branch.slice(Math.min(from, to), Math.max(from, to) + 1);
}

const speaker = (message: Message) =>
  message.role === "assistant" ? "Модель" : "Игрок";

export async function chronicleRoutes(app: FastifyInstance) {
  app.get<{ Params: IdParams }>("/api/chats/:id/chronicles", async (req, reply) => {
    const chat = getChat(req.params.id);
    if (!chat) return reply.code(404).send({ error: "not found" });

    const branch = getBranch(chat.id);
    const onBranch = new Set(
      chroniclesForBranch(chat.id, branch).visible.map((c) => c.id),
    );

    return listChronicles(chat.id).map((chronicle) => ({
      id: chronicle.id,
      level: chronicle.level,
      title: chronicle.title,
      content: chronicle.content,
      anchor_message_id: chronicle.anchor_message_id,
      from_message_id: chronicle.from_message_id,
      to_message_id: chronicle.to_message_id,
      hide_covered: chronicle.hide_covered === 1,
      created_at: chronicle.created_at,
      cost_usd: chronicle.cost_usd,
      /** False means it belongs to another branch and is not in play here. */
      on_branch: onBranch.has(chronicle.id),
    }));
  });

  /** Saves a chronicle. The anchor is the end of the range it covers. */
  app.post<{
    Params: IdParams;
    Body: {
      level?: string;
      title?: string;
      content?: string;
      fromMessageId?: string;
      toMessageId?: string;
      hideCovered?: boolean;
    };
  }>("/api/chats/:id/chronicles", async (req, reply) => {
    const chat = getChat(req.params.id);
    if (!chat) return reply.code(404).send({ error: "not found" });

    const body = req.body ?? {};
    const content = (body.content ?? "").trim();
    if (!content) return reply.code(400).send({ error: "хроника пуста" });
    if (!isLevel(body.level)) return reply.code(400).send({ error: "неверный уровень" });

    const branch = getBranch(chat.id);
    const range = coveredRange(branch, body.fromMessageId ?? "", body.toMessageId ?? "");
    if (!range) {
      return reply.code(400).send({ error: "диапазон не лежит на текущей ветке" });
    }

    const saved = saveChronicle({
      chatId: chat.id,
      level: body.level,
      title: (body.title ?? "").trim(),
      content,
      // The last covered message is the anchor: the chronicle is visible on
      // exactly the branches that pass through it.
      anchorMessageId: range.at(-1)!.id,
      fromMessageId: range[0].id,
      toMessageId: range.at(-1)!.id,
      hideCovered: body.hideCovered === true,
    });

    return reply.code(201).send({ id: saved.id });
  });

  app.patch<{
    Params: IdParams;
    Body: { title?: string; content?: string; hideCovered?: boolean };
  }>("/api/chronicles/:id", async (req, reply) => {
    const updated = updateChronicle(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: "not found" });
    return { id: updated.id };
  });

  app.delete<{ Params: IdParams }>("/api/chronicles/:id", async (req, reply) => {
    deleteChronicle(req.params.id);
    return reply.code(204).send();
  });

  /**
   * Streams a summary of the chosen range. Nothing is saved: the text lands in
   * the editor so it can be read and corrected before it becomes a chronicle.
   */
  app.post<{
    Params: IdParams;
    Body: { level?: string; fromMessageId?: string; toMessageId?: string };
  }>("/api/chats/:id/chronicles/generate", async (req, reply) => {
    const chat = getChat(req.params.id);
    if (!chat) return reply.code(404).send({ error: "not found" });

    const body = req.body ?? {};
    if (!isLevel(body.level)) return reply.code(400).send({ error: "неверный уровень" });

    const branch = getBranch(chat.id);
    const range = coveredRange(branch, body.fromMessageId ?? "", body.toMessageId ?? "");
    if (!range || range.length === 0) {
      return reply.code(400).send({ error: "диапазон не лежит на текущей ветке" });
    }

    // Higher levels are built from the chronicles below them where those exist,
    // and from the raw messages where they do not.
    const { visible } = chroniclesForBranch(chat.id, branch);
    const covered = new Set(range.map((message) => message.id));
    const lower = visible.filter(
      (chronicle) =>
        LEVELS.indexOf(chronicle.level) < LEVELS.indexOf(body.level as ChronicleLevel) &&
        covered.has(chronicle.anchor_message_id),
    );

    const source =
      lower.length > 0
        ? lower.map((chronicle) => chronicle.content).join("\n\n")
        : range.map((message) => `${speaker(message)}: ${message.content}`).join("\n\n");

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const controller = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    try {
      // A summarisation request shares no prefix with the chat, so it carries
      // no cache breakpoints — marking one here would only cost a write.
      const result = await anthropicAdapter.streamReply(
        {
          system: chroniclePrompt(body.level),
          messages: [{ role: "user", content: source }],
          signal: controller.signal,
        },
        (chunk) => send("delta", chunk),
      );
      send("done", { model: result.model, usage: result.tokens });
    } catch (error) {
      app.log.error(error);
      if (!controller.signal.aborted) {
        send("error", { message: (error as Error).message });
      }
    } finally {
      reply.raw.end();
    }
  });
}
