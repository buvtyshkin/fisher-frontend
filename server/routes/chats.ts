import type { FastifyInstance } from "fastify";
import {
  appendMessage,
  createChat,
  deleteChat,
  getBranch,
  getChat,
  listChats,
  renameChat,
  startOfToday,
  usageSince,
  withCost,
} from "../store.js";
import { anthropicAdapter } from "../provider.js";

interface IdParams {
  id: string;
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

  app.get<{ Params: IdParams }>(
    "/api/chats/:id/messages",
    async (req, reply) => {
      if (!getChat(req.params.id)) return reply.code(404).send({ error: "not found" });
      return getBranch(req.params.id).map(withCost);
    },
  );

  app.get("/api/usage", async () => {
    const now = Date.now();
    return {
      today: usageSince(startOfToday()),
      last24h: usageSince(now - 24 * 60 * 60 * 1000),
      last7d: usageSince(now - 7 * 24 * 60 * 60 * 1000),
    };
  });

  /**
   * Appends the user message, streams Claude's reply back over SSE, and stores
   * the reply once the stream ends. Events: `user`, `delta`, `done`, `error`.
   */
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

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send("user", withCost(userMessage));

      // Abort the upstream request if the browser goes away mid-generation.
      // Watch the response, not the request: req.raw fires "close" as soon as
      // the request body is read, which would abort every generation instantly.
      const controller = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) controller.abort();
      });

      let answer = "";
      try {
        const result = await anthropicAdapter.streamReply(
          {
            messages: [...branch, userMessage].map((m) => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content,
            })),
            signal: controller.signal,
          },
          (chunk) => {
            answer += chunk;
            send("delta", chunk);
          },
        );

        const assistantMessage = appendMessage({
          chatId: chat.id,
          parentId: userMessage.id,
          role: "assistant",
          content: answer,
          model: result.model,
          usage: result.tokens,
        });
        send("done", withCost(assistantMessage));
      } catch (error) {
        // Keep whatever was generated before the failure so nothing is lost.
        if (answer) {
          appendMessage({
            chatId: chat.id,
            parentId: userMessage.id,
            role: "assistant",
            content: answer,
          });
        }
        app.log.error(error);
        if (!controller.signal.aborted) {
          send("error", { message: (error as Error).message });
        }
      } finally {
        reply.raw.end();
      }
    },
  );
}
