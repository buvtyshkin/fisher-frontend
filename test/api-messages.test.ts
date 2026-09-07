import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-api-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "test-key";

const { generationPlan, toApiMessages } = await import("../server/routes/chats.ts");
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

test("a card greeting is kept, behind the new-chat marker", () => {
  // The API requires the first turn to be the user's, so a leading greeting
  // needs the marker in front of it — otherwise the model never sees its own
  // opening line.
  assert.deepEqual(
    toApiMessages([node("assistant", "пролог"), node("user", "вопрос")]),
    [
      { role: "user", content: "[Start a new Chat]" },
      { role: "assistant", content: "пролог" },
      { role: "user", content: "вопрос" },
    ],
  );
});

test("several greetings in a row still produce one valid opening", () => {
  const turns = toApiMessages([node("assistant", "раз"), node("assistant", "два")]);
  assert.equal(turns[0].role, "user");
  assert.deepEqual(turns[1], { role: "assistant", content: "раз\n\nдва" });
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

test("a branch ending on the user's move is answered directly", () => {
  const tip = node("user", "мой ход");
  assert.deepEqual(generationPlan([node("assistant", "ответ"), tip]), {
    parentId: tip.id,
  });
});

test("a branch ending on the model's words gets a nudge, not a prefill", () => {
  // An assistant-last request is rejected by the API, so the next beat has to
  // be asked for with a user turn.
  const greeting = node("assistant", "приветствие");
  const plan = generationPlan([greeting])!;
  assert.equal(plan.parentId, greeting.id);
  assert.equal(typeof plan.extraUser, "string");

  const turns = toApiMessages([greeting], plan.extraUser);
  assert.equal(turns.at(-1)!.role, "user", "the request must not end on the model");
});

test("an empty branch has nothing to generate from", () => {
  assert.equal(generationPlan([]), null);
});
