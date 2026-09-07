import { randomUUID } from "node:crypto";
import { db, type Chat, type Message } from "./db.js";

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
  inputTokens?: number | null;
  outputTokens?: number | null;
}): Message {
  const message: Message = {
    id: randomUUID(),
    chat_id: input.chatId,
    parent_id: input.parentId,
    role: input.role,
    content: input.content,
    created_at: Date.now(),
    model: input.model ?? null,
    input_tokens: input.inputTokens ?? null,
    output_tokens: input.outputTokens ?? null,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO messages
         (id, chat_id, parent_id, role, content, created_at, model, input_tokens, output_tokens)
       VALUES
         (@id, @chat_id, @parent_id, @role, @content, @created_at, @model, @input_tokens, @output_tokens)`,
    ).run(message);
    db.prepare(
      "UPDATE chats SET active_leaf_id = ?, updated_at = ? WHERE id = ?",
    ).run(message.id, message.created_at, input.chatId);
  })();

  return message;
}
