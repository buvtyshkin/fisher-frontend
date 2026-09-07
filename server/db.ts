import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

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
    cache_read_input_tokens     INTEGER
  );

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

export interface Chat {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  active_leaf_id: string | null;
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
}
