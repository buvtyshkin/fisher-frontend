import { randomUUID } from "node:crypto";
import {
  db,
  type Chat,
  type CharacterRow,
  type Message,
  type PersonaRow,
} from "./db.js";
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
    character_id: null,
    persona_id: null,
  };
  db.prepare(
    `INSERT INTO chats (id, title, created_at, updated_at, active_leaf_id)
     VALUES (@id, @title, @created_at, @updated_at, NULL)`,
  ).run({
    id: chat.id,
    title: chat.title,
    created_at: chat.created_at,
    updated_at: chat.updated_at,
  });
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

export function getMessage(id: string): Message | undefined {
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | Message
    | undefined;
}

/**
 * Root-to-node path: walk up via parent_id, then reverse. The `seen` guard
 * means a corrupted cycle truncates the path instead of hanging the server.
 */
export function pathTo(messageId: string | null): Message[] {
  const path: Message[] = [];
  const seen = new Set<string>();
  let cursor = messageId;

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = getMessage(cursor);
    if (!node) break;
    path.push(node);
    cursor = node.parent_id;
  }

  return path.reverse();
}

/** The branch currently in view: the path to the chat's active leaf. */
export function getBranch(chatId: string): Message[] {
  return pathTo(getChat(chatId)?.active_leaf_id ?? null);
}

/**
 * Alternative children of the same parent, in insertion order. Swipes, edits
 * and branches are all just siblings, so one query serves all three.
 *
 * Ordering is by rowid, not created_at: several siblings are routinely written
 * inside the same millisecond — a card's greetings always are — and a
 * timestamp tie would shuffle them.
 */
export function getSiblings(message: Message): Message[] {
  return db
    .prepare(
      `SELECT * FROM messages
        WHERE chat_id = ? AND parent_id IS ?
        ORDER BY rowid`,
    )
    .all(message.chat_id, message.parent_id) as Message[];
}

/** Follows the most recent child down to a leaf — the last path taken here. */
export function deepestLeaf(messageId: string): string {
  const newestChild = db.prepare(
    "SELECT id FROM messages WHERE parent_id = ? ORDER BY rowid DESC LIMIT 1",
  );
  const seen = new Set<string>();
  let cursor = messageId;

  while (!seen.has(cursor)) {
    seen.add(cursor);
    const child = newestChild.get(cursor) as { id: string } | undefined;
    if (!child) break;
    cursor = child.id;
  }

  return cursor;
}

export function setActiveLeaf(chatId: string, messageId: string): void {
  db.prepare("UPDATE chats SET active_leaf_id = ?, updated_at = ? WHERE id = ?").run(
    messageId,
    Date.now(),
    chatId,
  );
}

/** How many branch tips the chat has — messages with no children. */
export function countLeaves(chatId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS leaves FROM messages m
        WHERE m.chat_id = ?
          AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.parent_id = m.id)`,
    )
    .get(chatId) as { leaves: number };
  return row.leaves;
}

export interface BranchMessage extends Message {
  /** Ids of every alternative at this point, oldest first, including this one. */
  sibling_ids: string[];
  sibling_index: number;
}

/** The active branch, each message tagged with its position among siblings. */
export function getBranchWithSiblings(chatId: string): BranchMessage[] {
  return getBranch(chatId).map((message) => {
    const siblingIds = getSiblings(message).map((s) => s.id);
    return {
      ...message,
      sibling_ids: siblingIds,
      sibling_index: siblingIds.indexOf(message.id),
    };
  });
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

/**
 * Editing never overwrites: the new text becomes another child of the same
 * parent, so the original stays in the tree and both are reachable.
 */
export function editMessage(id: string, content: string): Message | undefined {
  const original = getMessage(id);
  if (!original) return undefined;
  return appendMessage({
    chatId: original.chat_id,
    parentId: original.parent_id,
    role: original.role,
    content,
  });
}

/**
 * Appends continued text to an existing reply and adds the new usage to what
 * the message already cost — a continue is the same reply, billed twice.
 */
export function appendToMessage(
  id: string,
  text: string,
  model: string | null,
  usage: TokenCounts | null,
): Message | undefined {
  const message = getMessage(id);
  if (!message) return undefined;

  const extraCost = usage ? costOf(model ?? message.model, usage) : null;

  db.prepare(
    `UPDATE messages
        SET content = content || ?,
            model = COALESCE(?, model),
            input_tokens  = COALESCE(input_tokens, 0)  + ?,
            output_tokens = COALESCE(output_tokens, 0) + ?,
            cache_creation_input_tokens = COALESCE(cache_creation_input_tokens, 0) + ?,
            cache_read_input_tokens     = COALESCE(cache_read_input_tokens, 0) + ?,
            cost_usd = CASE
              WHEN ? IS NULL THEN cost_usd
              ELSE COALESCE(cost_usd, 0) + ?
            END
      WHERE id = ?`,
  ).run(
    text,
    model,
    usage?.input ?? 0,
    usage?.output ?? 0,
    usage?.cacheWrite ?? 0,
    usage?.cacheRead ?? 0,
    extraCost,
    extraCost,
    id,
  );

  return getMessage(id);
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

/* ── Characters ──────────────────────────────────────────────────────────── */

export function listCharacters(): Omit<CharacterRow, "avatar" | "data">[] {
  return db
    .prepare("SELECT id, name, spec, created_at FROM characters ORDER BY name")
    .all() as Omit<CharacterRow, "avatar" | "data">[];
}

export function getCharacter(id: string): CharacterRow | undefined {
  return db.prepare("SELECT * FROM characters WHERE id = ?").get(id) as
    | CharacterRow
    | undefined;
}

export function saveCharacter(input: {
  name: string;
  spec: string;
  data: string;
  avatar: Buffer | null;
}): CharacterRow {
  const row: CharacterRow = {
    id: randomUUID(),
    name: input.name,
    spec: input.spec,
    data: input.data,
    avatar: input.avatar,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO characters (id, name, spec, data, avatar, created_at)
     VALUES (@id, @name, @spec, @data, @avatar, @created_at)`,
  ).run(row);
  return row;
}

export function deleteCharacter(id: string): void {
  db.transaction(() => {
    db.prepare("UPDATE chats SET character_id = NULL WHERE character_id = ?").run(id);
    db.prepare("DELETE FROM characters WHERE id = ?").run(id);
  })();
}

/* ── Personas ────────────────────────────────────────────────────────────── */

export function listPersonas(): Omit<PersonaRow, "avatar">[] {
  return db
    .prepare("SELECT id, name, description, created_at FROM personas ORDER BY name")
    .all() as Omit<PersonaRow, "avatar">[];
}

export function getPersona(id: string): PersonaRow | undefined {
  return db.prepare("SELECT * FROM personas WHERE id = ?").get(id) as
    | PersonaRow
    | undefined;
}

export function savePersona(input: {
  name: string;
  description: string;
}): PersonaRow {
  const row: PersonaRow = {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    avatar: null,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO personas (id, name, description, avatar, created_at)
     VALUES (@id, @name, @description, NULL, @created_at)`,
  ).run({
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
  });
  return row;
}

export function updatePersona(
  id: string,
  input: { name?: string; description?: string; avatar?: Buffer },
): PersonaRow | undefined {
  const persona = getPersona(id);
  if (!persona) return undefined;
  db.prepare(
    "UPDATE personas SET name = ?, description = ?, avatar = ? WHERE id = ?",
  ).run(
    input.name?.trim() || persona.name,
    input.description ?? persona.description,
    input.avatar ?? persona.avatar,
    id,
  );
  return getPersona(id);
}

export function deletePersona(id: string): void {
  db.transaction(() => {
    db.prepare("UPDATE chats SET persona_id = NULL WHERE persona_id = ?").run(id);
    db.prepare("DELETE FROM personas WHERE id = ?").run(id);
  })();
}

/* ── Binding a chat ──────────────────────────────────────────────────────── */

export function bindChat(
  chatId: string,
  input: { characterId?: string | null; personaId?: string | null },
): Chat | undefined {
  const chat = getChat(chatId);
  if (!chat) return undefined;

  db.prepare(
    "UPDATE chats SET character_id = ?, persona_id = ?, updated_at = ? WHERE id = ?",
  ).run(
    input.characterId === undefined ? chat.character_id : input.characterId,
    input.personaId === undefined ? chat.persona_id : input.personaId,
    Date.now(),
    chatId,
  );
  return getChat(chatId);
}

export function countMessages(chatId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?")
    .get(chatId) as { n: number };
  return row.n;
}

/**
 * Seeds a fresh chat with the card's greetings. Alternates become siblings of
 * the first one — the same mechanism as a swipe — and the first stays active.
 */
export function seedGreetings(chatId: string, greetings: string[]): void {
  if (greetings.length === 0) return;

  db.transaction(() => {
    let firstId: string | null = null;
    for (const greeting of greetings) {
      const message = appendMessage({
        chatId,
        parentId: null,
        role: "assistant",
        content: greeting,
      });
      firstId ??= message.id;
    }
    if (firstId) setActiveLeaf(chatId, firstId);
  })();
}
