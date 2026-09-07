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
    // Priced now, stored forever: later pricing.json edits must not move it.
    cost_usd: input.usage ? costOf(input.model ?? null, input.usage) : null,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO messages
         (id, chat_id, parent_id, role, content, created_at, model,
          input_tokens, output_tokens, cache_creation_input_tokens,
          cache_read_input_tokens, cost_usd)
       VALUES
         (@id, @chat_id, @parent_id, @role, @content, @created_at, @model,
          @input_tokens, @output_tokens, @cache_creation_input_tokens,
          @cache_read_input_tokens, @cost_usd)`,
    ).run(message);
    db.prepare(
      "UPDATE chats SET active_leaf_id = ?, updated_at = ? WHERE id = ?",
    ).run(message.id, message.created_at, input.chatId);
  })();

  return message;
}

export interface UsageBucket extends TokenCounts {
  replies: number;
  cost: number;
  /** Models with replies that carry no stored cost (no price when generated). */
  unpricedModels: string[];
}

interface UsageRow {
  model: string | null;
  input: number | null;
  output: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  cost: number | null;
  unpriced: number;
  replies: number;
}

/**
 * Sums assistant replies since `since` from the costs frozen at generation
 * time — the totals never move when pricing.json is edited.
 */
export function usageSince(since: number): UsageBucket {
  const rows = db
    .prepare(
      `SELECT model,
              SUM(input_tokens)                AS input,
              SUM(output_tokens)               AS output,
              SUM(cache_creation_input_tokens) AS cacheWrite,
              SUM(cache_read_input_tokens)     AS cacheRead,
              SUM(cost_usd)                    AS cost,
              SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
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
    bucket.input += row.input ?? 0;
    bucket.output += row.output ?? 0;
    bucket.cacheWrite += row.cacheWrite ?? 0;
    bucket.cacheRead += row.cacheRead ?? 0;
    bucket.replies += row.replies;
    bucket.cost += row.cost ?? 0;
    if (row.unpriced > 0 && row.model) bucket.unpricedModels.push(row.model);
  }

  return bucket;
}

export function startOfToday(now = new Date()): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}
