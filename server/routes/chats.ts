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
  bindChat,
  countMessages,
  getCharacter,
  getMessage,
  getPersona,
  getPreset,
  chatLorebooks,
  attachLorebook,
  detachLorebook,
  listChats,
  pathTo,
  renameChat,
  setActiveLeaf,
  seedGreetings,
  startOfToday,
  tipChildren,
  usageSince,
} from "../store.js";
import { applyNameMacros, greetingsOf, type CardData } from "../cards/card.js";
import { buildPrompt, DEFAULT_USER_NAME } from "../preset/build.js";
import { DEFAULT_PRESET } from "../preset/default.js";
import { parsePreset } from "../preset/preset.js";
import { parseLorebook } from "../lorebook/lorebook.js";
import {
  DEFAULT_WORLD_INFO_SETTINGS,
  keyScanEngine,
} from "../lorebook/engine.js";
import { placeEntries } from "../lorebook/placement.js";
import { config } from "../config.js";
import type { Message } from "../db.js";
import { anthropicAdapter } from "../provider.js";

interface IdParams {
  id: string;
}

/** Everything the UI needs to draw a branch and every way out of it. */
function branchResponse(chatId: string) {
  return {
    messages: getBranchWithSiblings(chatId),
    leaves: countLeaves(chatId),
    tip_children: tipChildren(chatId),
  };
}

/** Asks the model to resume a reply that was cut off. */
const CONTINUE_INSTRUCTION =
  "Продолжи свой предыдущий ответ ровно с того места, где он оборвался. " +
  "Не повторяй уже написанное и не добавляй вступлений — просто продолжай текст.";

/**
 * Asks for the next beat when the branch already ends with the model's own
 * words — generating after a greeting, for instance. The API rejects a request
 * whose last turn is the assistant's, so the nudge has to be a user turn.
 */
const NEXT_BEAT_INSTRUCTION = "Продолжай сцену.";

/**
 * SillyTavern's marker for a chat that opens with the character's greeting.
 * Without it the greeting would have to be dropped — the API requires the
 * first turn to be the user's — and the model would not see its own opening.
 */
const NEW_CHAT_MARKER = "[Start a new Chat]";

/** Everything a chat is bound to: card, persona and preset. */
function chatContext(chatId: string) {
  const chat = getChat(chatId);
  const character = chat?.character_id ? getCharacter(chat.character_id) : undefined;
  const persona = chat?.persona_id ? getPersona(chat.persona_id) : undefined;
  const presetRow = chat?.preset_id ? getPreset(chat.preset_id) : undefined;

  return {
    card: character ? (JSON.parse(character.data) as CardData) : null,
    persona: persona ?? null,
    preset: presetRow
      ? parsePreset(presetRow.data, presetRow.name)
      : DEFAULT_PRESET,
  };
}

/** Assembles the request for a branch through the preset engine. */
function assemble(chatId: string, branch: Message[], extraUser?: string) {
  const { card, persona, preset } = chatContext(chatId);
  const { lore, activated } = scanLore(chatId, branch);
  return {
    ...buildPrompt({ preset, card, persona, branch, extraUser, lore }),
    maxTokens: preset.maxTokens ?? undefined,
    activatedLore: activated,
  };
}

/** Runs every lorebook attached to the chat through the activation engine. */
function scanLore(chatId: string, branch: Message[]) {
  const entries = chatLorebooks(chatId).flatMap(
    (row) => parseLorebook(row.data, row.name).entries,
  );
  if (entries.length === 0) {
    return { lore: undefined, activated: [] as { title: string; reason: string }[] };
  }

  const activated = keyScanEngine.activate({
    entries,
    messages: branch.map((message) => message.content),
    settings: {
      ...DEFAULT_WORLD_INFO_SETTINGS,
      scanDepth: config.worldInfo.scanDepth,
      recursive: config.worldInfo.recursive,
      caseSensitive: config.worldInfo.caseSensitive,
      matchWholeWords: config.worldInfo.matchWholeWords,
    },
  });

  return {
    lore: placeEntries(activated),
    activated: activated.map(({ entry, reason }) => ({
      title: entry.comment,
      reason,
    })),
  };
}

export interface GenerationPlan {
  parentId: string;
  extraUser?: string;
}

/**
 * How to produce the next reply for a branch. Answering the user's move is the
 * normal case; a branch ending in the model's own words (a greeting) gets a
 * nudge instead, because the API will not accept an assistant-last request.
 */
export function generationPlan(branch: Message[]): GenerationPlan | null {
  const tip = branch.at(-1);
  if (!tip) return null;
  return tip.role === "assistant"
    ? { parentId: tip.id, extraUser: NEXT_BEAT_INSTRUCTION }
    : { parentId: tip.id };
}

interface StreamOptions {
  chatId: string;
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

  const built = assemble(options.chatId, options.context, options.extraUser);
  for (const warning of built.warnings) app.log.warn(warning);

  let answer = "";
  try {
    const result = await anthropicAdapter.streamReply(
      {
        system: built.system,
        messages: built.messages,
        maxTokens: built.maxTokens,
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
    return branchResponse(req.params.id);
  });

  /**
   * Binds a character and/or persona. Binding a card to a still-empty chat
   * seeds its greetings, with the alternates as siblings of the first.
   */
  app.post<{
    Params: IdParams;
    Body: {
      characterId?: string | null;
      personaId?: string | null;
      presetId?: string | null;
    };
  }>("/api/chats/:id/bind", async (req, reply) => {
    const chat = getChat(req.params.id);
    if (!chat) return reply.code(404).send({ error: "not found" });

    if (req.body?.characterId && !getCharacter(req.body.characterId)) {
      return reply.code(404).send({ error: "персонаж не найден" });
    }
    if (req.body?.personaId && !getPersona(req.body.personaId)) {
      return reply.code(404).send({ error: "персона не найдена" });
    }
    if (req.body?.presetId && !getPreset(req.body.presetId)) {
      return reply.code(404).send({ error: "пресет не найден" });
    }

    const updated = bindChat(chat.id, req.body ?? {})!;
    const { card, persona } = chatContext(chat.id);

    if (card && countMessages(chat.id) === 0) {
      const names = {
        char: card.name,
        user: persona?.name?.trim() || DEFAULT_USER_NAME,
      };
      seedGreetings(
        chat.id,
        greetingsOf(card).map((greeting) => applyNameMacros(greeting, names)),
      );
    }

    return { chat: updated, ...branchResponse(chat.id) };
  });

  /** The assembled prompt, block by block — the debug screen from the spec. */
  app.get<{ Params: IdParams }>("/api/chats/:id/prompt", async (req, reply) => {
    const chat = getChat(req.params.id);
    if (!chat) return reply.code(404).send({ error: "not found" });

    const { preset } = chatContext(chat.id);
    const built = assemble(chat.id, getBranch(chat.id));

    return {
      preset: preset.name,
      system: built.system ?? "",
      messages: built.messages,
      parts: built.parts.map((part: (typeof built.parts)[number]) => ({
        identifier: part.identifier,
        name: part.name,
        role: part.role,
        content: part.content,
        injectedAt: part.injectedAt ?? null,
      })),
      warnings: built.warnings,
      emptyBlocks: built.emptyBlocks,
      activatedLore: built.activatedLore,
      maxTokens: preset.maxTokens,
      // Kept visible but never sent: current Claude models reject these.
      samplingIgnored: preset.sampling,
    };
  });

  /** Attaches or detaches a lorebook; a chat can carry several. */
  app.post<{ Params: IdParams; Body: { lorebookId: string; attached: boolean } }>(
    "/api/chats/:id/lorebooks",
    async (req, reply) => {
      const chat = getChat(req.params.id);
      if (!chat) return reply.code(404).send({ error: "not found" });

      const { lorebookId, attached } = req.body ?? {};
      if (!lorebookId) return reply.code(400).send({ error: "нужен lorebookId" });

      if (attached) attachLorebook(chat.id, lorebookId);
      else detachLorebook(chat.id, lorebookId);

      return chatLorebooks(chat.id).map((row) => ({
        id: row.id,
        name: row.name,
        created_at: row.created_at,
      }));
    },
  );

  app.get<{ Params: IdParams }>("/api/chats/:id/lorebooks", async (req) =>
    chatLorebooks(req.params.id).map((row) => ({
      id: row.id,
      name: row.name,
      created_at: row.created_at,
    })),
  );

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
      return branchResponse(chat.id);
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
      return branchResponse(original.chat_id);
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
          chatId: chat.id,
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

  /**
   * Answers whatever the branch currently ends with, without a new user
   * message. Backs the "Сгенерировать" button and the reply that follows
   * editing one's own message.
   */
  app.post<{ Params: IdParams }>("/api/chats/:id/generate", async (req, reply) => {
    const chat = getChat(req.params.id);
    if (!chat) return reply.code(404).send({ error: "not found" });

    const branch = getBranch(chat.id);
    const plan = generationPlan(branch);
    if (!plan) return reply.code(400).send({ error: "в ветке нет сообщений" });

    await streamGeneration(app, reply, {
      chatId: chat.id,
      context: branch,
      extraUser: plan.extraUser,
      onComplete: (text, model, usage) =>
        appendMessage({
          chatId: chat.id,
          parentId: plan.parentId,
          role: "assistant",
          content: text,
          model,
          usage,
        }),
      onPartial: (text) =>
        void appendMessage({
          chatId: chat.id,
          parentId: plan.parentId,
          role: "assistant",
          content: text,
        }),
    });
  });

  /** A swipe: another reply to the same parent, kept alongside the old one. */
  app.post<{ Params: IdParams }>("/api/messages/:id/swipe", async (req, reply) => {
    const target = getMessage(req.params.id);
    if (!target) return reply.code(404).send({ error: "not found" });
    if (target.role !== "assistant") {
      return reply.code(400).send({ error: "only assistant messages can be swiped" });
    }

    await streamGeneration(app, reply, {
      chatId: target.chat_id,
      context: pathTo(target.parent_id),
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
      chatId: target.chat_id,
      context: pathTo(target.id),
      extraUser: CONTINUE_INSTRUCTION,
      onComplete: (text, model, usage) =>
        appendToMessage(target.id, text, model, usage ?? null),
      onPartial: (text) => void appendToMessage(target.id, text, null, null),
    });
  });
}
