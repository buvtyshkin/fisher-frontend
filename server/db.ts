import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { costOf } from "./pricing.js";

const dataDir = path.resolve(process.cwd(), config.dataDir);
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "fisher.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// The schema is already tree-shaped (parent_id, active_leaf_id) even though
// phase 0 only ever builds a single linear branch. Phase 1 turns it on.
db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    active_leaf_id TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    parent_id     TEXT REFERENCES messages(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    model         TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    cache_read_input_tokens     INTEGER,
    cost_usd                    REAL
  );

  CREATE TABLE IF NOT EXISTS characters (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    spec       TEXT NOT NULL,
    data       TEXT NOT NULL,
    avatar     BLOB,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS personas (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    avatar      BLOB,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS presets (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lorebooks (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- A chat can carry several lorebooks at once, as in SillyTavern.
  CREATE TABLE IF NOT EXISTS chat_lorebooks (
    chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
    PRIMARY KEY (chat_id, lorebook_id)
  );

  -- Keep-alive requests cost money too; they must show up in the totals.
  CREATE TABLE IF NOT EXISTS cache_refreshes (
    id                          TEXT PRIMARY KEY,
    chat_id                     TEXT NOT NULL,
    created_at                  INTEGER NOT NULL,
    model                       TEXT,
    input_tokens                INTEGER,
    cache_creation_input_tokens INTEGER,
    cache_read_input_tokens     INTEGER,
    cost_usd                    REAL
  );

  CREATE INDEX IF NOT EXISTS idx_refresh_created ON cache_refreshes(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_chat    ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_parent  ON messages(parent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`);

/** Adds a column to an existing database that predates it. */
function addColumnIfMissing(table: string, column: string, declaration: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

addColumnIfMissing("messages", "cache_creation_input_tokens", "INTEGER");
addColumnIfMissing("messages", "cache_read_input_tokens", "INTEGER");
addColumnIfMissing("messages", "cost_usd", "REAL");
addColumnIfMissing("chats", "character_id", "TEXT REFERENCES characters(id)");
addColumnIfMissing("chats", "persona_id", "TEXT REFERENCES personas(id)");
addColumnIfMissing("chats", "preset_id", "TEXT REFERENCES presets(id)");

/**
 * Cost is frozen at generation time, so editing pricing.json never rewrites
 * history. Replies that predate the column get priced once, here. Rows whose
 * model has no price stay NULL and are retried on a later start — that is the
 * only way they can ever get a cost, and they never had a stored one to lose.
 */
function backfillMissingCosts() {
  const rows = db
    .prepare(
      `SELECT id, model, input_tokens, output_tokens,
              cache_creation_input_tokens, cache_read_input_tokens
         FROM messages
        WHERE role = 'assistant' AND cost_usd IS NULL AND model IS NOT NULL`,
    )
    .all() as {
    id: string;
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
  }[];

  if (rows.length === 0) return;

  const update = db.prepare("UPDATE messages SET cost_usd = ? WHERE id = ?");
  db.transaction(() => {
    for (const row of rows) {
      const cost = costOf(row.model, {
        input: row.input_tokens ?? 0,
        output: row.output_tokens ?? 0,
        cacheWrite: row.cache_creation_input_tokens ?? 0,
        cacheRead: row.cache_read_input_tokens ?? 0,
      });
      if (cost !== null) update.run(cost, row.id);
    }
  })();
}

backfillMissingCosts();

export interface Chat {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  active_leaf_id: string | null;
  character_id: string | null;
  persona_id: string | null;
  preset_id: string | null;
}

export interface CharacterRow {
  id: string;
  name: string;
  spec: string;
  /** The card's `data` object, as imported. */
  data: string;
  avatar: Buffer | null;
  created_at: number;
}

export interface PresetRow {
  id: string;
  name: string;
  /** The imported preset JSON, verbatim. */
  data: string;
  created_at: number;
}

export interface LorebookRow {
  id: string;
  name: string;
  /** The imported World Info JSON, verbatim. */
  data: string;
  created_at: number;
}

export interface PersonaRow {
  id: string;
  name: string;
  description: string;
  avatar: Buffer | null;
  created_at: number;
}

export interface Message {
  id: string;
  chat_id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  /** Dollars, priced when the reply was generated. Never recomputed. */
  cost_usd: number | null;
}
