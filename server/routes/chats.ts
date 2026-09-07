import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import {
  appendMessage,
  appendToMessage,
  countLeaves,
  createChat,
  deepestLeaf,
  deleteChat,
  editMessage,
  getBranch,
  getBranchWithSiblings,
  getChat,
  getMessage,
  listChats,
  pathTo,
  renameChat,
  setActiveLeaf,
  startOfToday,
  usageSince,
} from "../store.js";
import type { Message } from "../db.js";
import { anthropicAdapter } from "../provider.js";

interface IdParams {
  id: string;
}

/** Asks the model to resume a reply that was cut off. */
const CONTINUE_INSTRUCTION =
  "Продолжи свой предыдущий ответ ровно с того места, где он оборвался. " +
  "Не повторяй уже написанное и не добавляй вступлений — просто продолжай текст.";

/**
 * Converts a branch to Anthropic messages: system nodes are not sent as chat
 * turns yet, a leading assistant message is dropped (the API needs the first
 * turn to be the user's), and neighbours of the same role are squashed.
 */
export function toApiMessages(
  branch: Message[],
  extraUser?: string,
): Anthropic.MessageParam[] {
  const turns: Anthropic.MessageParam[] = [];

  for (const message of branch) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    if (turns.length === 0 && role === "assistant") continue;

    const last = turns.at(-1);
    if (last?.role === role) {
      last.content = `${last.content as string}\n\n${message.content}`;
    } else {
      turns.push({ role, content: message.content });
    }
  }

  if (extraUser) {
    const last = turns.at(-1);
    if (last?.role === "user") {
      last.content = `${last.content as string}\n\n${extraUser}`;
    } else {
      turns.push({ role: "user", content: extraUser });
    }
  }

  return turns;
}

interface StreamOptions {
  context: Message[];
  extraUser?: string;
  /** Called once the model finishes; returns the message to report as done. */
  onComplete: (
    text: string,
    model: string,
    usage: Parameters<typeof appendMessage>[0]["usage"],
  ) => Message | undefined;
  /** Called when generation fails after producing text, so nothing is lost. */
  onPartial: (text: string) => void;
}

/**
 * Shared SSE generation used by a new turn, a swipe and a continue. Events:
 * `user` (new turn only), `delta`, `done`, `error`.
 */
async function streamGeneration(
  app: FastifyInstance,
  reply: FastifyReply,
  options: StreamOptions,
  before?: () => void,
): Promise<void> {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  before?.();

  // Watch the response, not the request: req.raw fires "close" as soon as the
  // request body is read, which would abort every generation instantly.
  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) controller.abort();
  });

  let answer = "";
  try {
    const result = await anthropicAdapter.streamReply(
      {
        messages: toApiMessages(options.context, options.extraUser),
        signal: controller.signal,
      },
      (chunk) => {
        answer += chunk;
        send("delta", chunk);
      },
    );
    send("done", options.onComplete(answer, result.model, result.tokens));
  } catch (error) {
    if (answer) options.onPartial(answer);
    app.log.error(error);
    if (!controller.signal.aborted) {
      send("error", { message: (error as Error).message });
    }
  } finally {
    reply.raw.end();
  }
}

export async function chatRoutes(app: FastifyInstance) {
  app.get("/api/chats", async () => listChats());

  app.post<{ Body: { title?: string } }>("/api/chats", async (req, reply) => {
    const chat = createChat(req.body?.title ?? "");
    return reply.code(201).send(chat);
  });

  app.patch<{ Params: IdParams; Body: { title: string } }>(
    "/api/chats/:id",
    async (req, reply) => {
      if (!getChat(req.params.id)) return reply.code(404).send({ error: "not found" });
      renameChat(req.params.id, req.body.title ?? "");
      return getChat(req.params.id);
    },
  );

  app.delete<{ Params: IdParams }>("/api/chats/:id", async (req, reply) => {
    deleteChat(req.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: IdParams }>("/api/chats/:id/messages", async (req, reply) => {
    if (!getChat(req.params.id)) return reply.code(404).send({ error: "not found" });
    return {
      messages: getBranchWithSiblings(req.params.id),
      leaves: countLeaves(req.params.id),
    };
  });

  app.get("/api/usage", async () => {
    const now = Date.now();
    return {
      today: usageSince(startOfToday()),
      last24h: usageSince(now - 24 * 60 * 60 * 1000),
      last7d: usageSince(now - 7 * 24 * 60 * 60 * 1000),
    };
  });

  /** Moves the view to another branch, or forks the story from an old message. */
  app.post<{ Params: IdParams; Body: { messageId: string; descend?: boolean } }>(
    "/api/chats/:id/leaf",
    async (req, reply) => {
      const chat = getChat(req.params.id);
      if (!chat) return reply.code(404).send({ error: "not found" });

      const target = getMessage(req.body?.messageId ?? "");
      if (!target || target.chat_id !== chat.id) {
        return reply.code(404).send({ error: "message not found" });
      }

      // Switching branches follows that branch to its tip; forking stops here.
      setActiveLeaf(chat.id, req.body.descend === false ? target.id : deepestLeaf(target.id));
      return { messages: getBranchWithSiblings(chat.id), leaves: countLeaves(chat.id) };
    },
  );

  /** Edits a message by adding a sibling; the original stays in the tree. */
  app.post<{ Params: IdParams; Body: { content: string } }>(
    "/api/messages/:id/edit",
    async (req, reply) => {
      const original = getMessage(req.params.id);
      if (!original) return reply.code(404).send({ error: "not found" });

      const content = (req.body?.content ?? "").trim();
      if (!content) return reply.code(400).send({ error: "empty message" });

      editMessage(original.id, content);
      return {
        messages: getBranchWithSiblings(original.chat_id),
        leaves: countLeaves(original.chat_id),
      };
    },
  );

  /** A new turn: append the user message, then generate its reply. */
  app.post<{ Params: IdParams; Body: { content: string } }>(
    "/api/chats/:id/messages",
    async (req, reply) => {
      const chat = getChat(req.params.id);
      if (!chat) return reply.code(404).send({ error: "not found" });

      const content = (req.body?.content ?? "").trim();
      if (!content) return reply.code(400).send({ error: "empty message" });

      const branch = getBranch(chat.id);
      const userMessage = appendMessage({
        chatId: chat.id,
        parentId: branch.at(-1)?.id ?? null,
        role: "user",
        content,
      });

      await streamGeneration(
        app,
        reply,
        {
          context: [...branch, userMessage],
          onComplete: (text, model, usage) =>
            appendMessage({
              chatId: chat.id,
              parentId: userMessage.id,
              role: "assistant",
              content: text,
              model,
              usage,
            }),
          onPartial: (text) =>
            void appendMessage({
              chatId: chat.id,
              parentId: userMessage.id,
              role: "assistant",
              content: text,
            }),
        },
        () => reply.raw.write(`event: user\ndata: ${JSON.stringify(userMessage)}\n\n`),
      );
    },
  );

  /** A swipe: another reply to the same parent, kept alongside the old one. */
  app.post<{ Params: IdParams }>("/api/messages/:id/swipe", async (req, reply) => {
    const target = getMessage(req.params.id);
    if (!target) return reply.code(404).send({ error: "not found" });
    if (target.role !== "assistant") {
      return reply.code(400).send({ error: "only assistant messages can be swiped" });
    }

    const context = pathTo(target.parent_id);
    await streamGeneration(app, reply, {
      context,
      onComplete: (text, model, usage) =>
        appendMessage({
          chatId: target.chat_id,
          parentId: target.parent_id,
          role: "assistant",
          content: text,
          model,
          usage,
        }),
      onPartial: (text) =>
        void appendMessage({
          chatId: target.chat_id,
          parentId: target.parent_id,
          role: "assistant",
          content: text,
        }),
    });
  });

  /** Continues a reply that stopped mid-sentence, in place. */
  app.post<{ Params: IdParams }>("/api/messages/:id/continue", async (req, reply) => {
    const target = getMessage(req.params.id);
    if (!target) return reply.code(404).send({ error: "not found" });
    if (target.role !== "assistant") {
      return reply.code(400).send({ error: "only assistant messages can be continued" });
    }

    await streamGeneration(app, reply, {
      context: pathTo(target.id),
      extraUser: CONTINUE_INSTRUCTION,
      onComplete: (text, model, usage) =>
        appendToMessage(target.id, text, model, usage ?? null),
      onPartial: (text) => void appendToMessage(target.id, text, null, null),
    });
  });
}
