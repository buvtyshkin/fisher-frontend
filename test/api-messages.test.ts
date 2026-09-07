import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-api-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "test-key";

const { toApiMessages } = await import("../server/routes/chats.ts");
import type { Message } from "../server/db.ts";

let counter = 0;
const node = (role: Message["role"], content: string): Message => ({
  id: `m${counter++}`,
  chat_id: "c",
  parent_id: null,
  role,
  content,
  created_at: counter,
  model: null,
  input_tokens: null,
  output_tokens: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  cost_usd: null,
});

test("a plain branch maps one message per turn", () => {
  assert.deepEqual(
    toApiMessages([
      node("user", "раз"),
      node("assistant", "два"),
      node("user", "три"),
    ]),
    [
      { role: "user", content: "раз" },
      { role: "assistant", content: "два" },
      { role: "user", content: "три" },
    ],
  );
});

test("neighbours of the same role are squashed into one turn", () => {
  // Forking from an assistant reply puts two user messages in a row.
  assert.deepEqual(
    toApiMessages([
      node("user", "раз"),
      node("user", "два"),
      node("assistant", "ответ"),
    ]),
    [
      { role: "user", content: "раз\n\nдва" },
      { role: "assistant", content: "ответ" },
    ],
  );
});

test("a branch starting with an assistant message drops it", () => {
  // The API requires the first turn to be the user's.
  assert.deepEqual(
    toApiMessages([node("assistant", "пролог"), node("user", "вопрос")]),
    [{ role: "user", content: "вопрос" }],
  );
});

test("system nodes are not sent as chat turns yet", () => {
  assert.deepEqual(
    toApiMessages([
      node("user", "раз"),
      node("system", "служебное"),
      node("assistant", "два"),
    ]),
    [
      { role: "user", content: "раз" },
      { role: "assistant", content: "два" },
    ],
  );
});

test("the continue instruction is appended as the final user turn", () => {
  const turns = toApiMessages(
    [node("user", "начни"), node("assistant", "оборвалось")],
    "продолжи",
  );
  assert.deepEqual(turns.at(-1), { role: "user", content: "продолжи" });
  assert.equal(turns.length, 3);
});

test("the continue instruction merges into a trailing user turn", () => {
  const turns = toApiMessages([node("user", "начни")], "продолжи");
  assert.deepEqual(turns, [{ role: "user", content: "начни\n\nпродолжи" }]);
});

test("an empty branch produces no turns", () => {
  assert.deepEqual(toApiMessages([]), []);
});
