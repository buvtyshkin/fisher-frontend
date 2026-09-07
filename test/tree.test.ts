import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Isolate the database and satisfy config.ts before anything imports it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-test-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "test-key";

const { appendMessage, createChat, getBranch, getChat } = await import(
  "../server/store.ts"
);

test("branch walks from the active leaf back to the root, in order", () => {
  const chat = createChat("Ветка");

  const first = appendMessage({
    chatId: chat.id,
    parentId: null,
    role: "user",
    content: "один",
  });
  const second = appendMessage({
    chatId: chat.id,
    parentId: first.id,
    role: "assistant",
    content: "два",
  });
  const third = appendMessage({
    chatId: chat.id,
    parentId: second.id,
    role: "user",
    content: "три",
  });

  const branch = getBranch(chat.id);
  assert.deepEqual(
    branch.map((m) => m.content),
    ["один", "два", "три"],
  );
  assert.equal(getChat(chat.id)?.active_leaf_id, third.id);
});

test("a sibling reply replaces the branch tail without deleting the old one", () => {
  const chat = createChat("Свайп");

  const root = appendMessage({
    chatId: chat.id,
    parentId: null,
    role: "user",
    content: "вопрос",
  });
  const answerA = appendMessage({
    chatId: chat.id,
    parentId: root.id,
    role: "assistant",
    content: "ответ A",
  });
  const answerB = appendMessage({
    chatId: chat.id,
    parentId: root.id,
    role: "assistant",
    content: "ответ B",
  });

  // The active leaf is now B, so the branch shows B — but A is still stored.
  assert.deepEqual(
    getBranch(chat.id).map((m) => m.content),
    ["вопрос", "ответ B"],
  );
  assert.notEqual(answerA.id, answerB.id);
});

test("an empty chat has an empty branch", () => {
  const chat = createChat("Пустой");
  assert.deepEqual(getBranch(chat.id), []);
});
