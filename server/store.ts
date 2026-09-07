import { randomUUID } from "node:crypto";
import { db, type Chat, type Message } from "./db.js";
import { costOf, type TokenCounts } from "./pricing.js";

export function listChats(): Chat[] {
  return db
    .prepare("SELECT * FROM chats ORDER BY updated_at DESC")
    .all() as Chat[];
}

export function getChat(id: string): Chat | undefined {
  return db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as
    | Chat
    | undefined;
}

export function createChat(title: string): Chat {
  const now = Date.now();
  const chat: Chat = {
    id: randomUUID(),
    title: title.trim() || "Новый чат",
    created_at: now,
    updated_at: now,
    active_leaf_id: null,
  };
  db.prepare(
    `INSERT INTO chats (id, title, created_at, updated_at, active_leaf_id)
     VALUES (@id, @title, @created_at, @updated_at, @active_leaf_id)`,
  ).run(chat);
  return chat;
}

export function deleteChat(id: string): void {
  db.prepare("DELETE FROM chats WHERE id = ?").run(id);
}

export function renameChat(id: string, title: string): void {
  db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(
    title.trim() || "Новый чат",
    Date.now(),
    id,
  );
}

/**
 * The active branch: walk up from the chat's active leaf to the root via
 * parent_id, then reverse. Phase 0 never forks, so this is just the chat,
 * but the traversal is the real one and phase 1 inherits it unchanged.
 */
export function getBranch(chatId: string): Message[] {
  const chat = getChat(chatId);
  if (!chat?.active_leaf_id) return [];

  const byId = db.prepare("SELECT * FROM messages WHERE id = ?");
  const branch: Message[] = [];
  const seen = new Set<string>();
  let cursor: string | null = chat.active_leaf_id;

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byId.get(cursor) as Message | undefined;
    if (!node) break;
    branch.push(node);
    cursor = node.parent_id;
  }

  return branch.reverse();
}

export function appendMessage(input: {
  chatId: string;
  parentId: string | null;
  role: Message["role"];
  content: string;
  model?: string | null;
  usage?: TokenCounts | null;
}): Message {
  const message: Message = {
    id: randomUUID(),
    chat_id: input.chatId,
    parent_id: input.parentId,
    role: input.role,
    content: input.content,
    created_at: Date.now(),
    model: input.model ?? null,
    input_tokens: input.usage?.input ?? null,
    output_tokens: input.usage?.output ?? null,
    cache_creation_input_tokens: input.usage?.cacheWrite ?? null,
    cache_read_input_tokens: input.usage?.cacheRead ?? null,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO messages
         (id, chat_id, parent_id, role, content, created_at, model,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
       VALUES
         (@id, @chat_id, @parent_id, @role, @content, @created_at, @model,
          @input_tokens, @output_tokens, @cache_creation_input_tokens, @cache_read_input_tokens)`,
    ).run(message);
    db.prepare(
      "UPDATE chats SET active_leaf_id = ?, updated_at = ? WHERE id = ?",
    ).run(message.id, message.created_at, input.chatId);
  })();

  return message;
}

export interface MessageWithCost extends Message {
  /** Dollars for this reply, or null when the model has no price entry. */
  cost: number | null;
}

export function withCost(message: Message): MessageWithCost {
  return {
    ...message,
    cost: costOf(message.model, tokensOf(message)),
  };
}

function tokensOf(message: Message): TokenCounts {
  return {
    input: message.input_tokens ?? 0,
    output: message.output_tokens ?? 0,
    cacheWrite: message.cache_creation_input_tokens ?? 0,
    cacheRead: message.cache_read_input_tokens ?? 0,
  };
}

export interface UsageBucket extends TokenCounts {
  replies: number;
  cost: number;
  /** Models seen in this period that pricing.json has no entry for. */
  unpricedModels: string[];
}

interface UsageRow {
  model: string | null;
  input: number | null;
  output: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  replies: number;
}

/** Sums assistant replies since `since`, costing each model at its own price. */
export function usageSince(since: number): UsageBucket {
  const rows = db
    .prepare(
      `SELECT model,
              SUM(input_tokens)                AS input,
              SUM(output_tokens)               AS output,
              SUM(cache_creation_input_tokens) AS cacheWrite,
              SUM(cache_read_input_tokens)     AS cacheRead,
              COUNT(*)                         AS replies
         FROM messages
        WHERE role = 'assistant' AND created_at >= ?
        GROUP BY model`,
    )
    .all(since) as UsageRow[];

  const bucket: UsageBucket = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    replies: 0,
    cost: 0,
    unpricedModels: [],
  };

  for (const row of rows) {
    const tokens: TokenCounts = {
      input: row.input ?? 0,
      output: row.output ?? 0,
      cacheWrite: row.cacheWrite ?? 0,
      cacheRead: row.cacheRead ?? 0,
    };
    bucket.input += tokens.input;
    bucket.output += tokens.output;
    bucket.cacheWrite += tokens.cacheWrite;
    bucket.cacheRead += tokens.cacheRead;
    bucket.replies += row.replies;

    const cost = costOf(row.model, tokens);
    if (cost === null) {
      if (row.model) bucket.unpricedModels.push(row.model);
    } else {
      bucket.cost += cost;
    }
  }

  return bucket;
}

export function startOfToday(now = new Date()): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}
