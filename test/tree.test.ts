import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Isolate the database and satisfy config.ts before anything imports it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-test-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "test-key";

const {
  appendMessage,
  appendToMessage,
  countLeaves,
  createChat,
  deepestLeaf,
  editMessage,
  getBranch,
  getBranchWithSiblings,
  getChat,
  getMessage,
  getSiblings,
  pathTo,
  setActiveLeaf,
  tipChildren,
} = await import("../server/store.ts");

const say = (
  chatId: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
) => appendMessage({ chatId, parentId, role, content });

/** user → assistant → user, the shape every test starts from. */
function conversation(title: string) {
  const chat = createChat(title);
  const q1 = say(chat.id, null, "user", "вопрос 1");
  const a1 = say(chat.id, q1.id, "assistant", "ответ 1");
  const q2 = say(chat.id, a1.id, "user", "вопрос 2");
  return { chat, q1, a1, q2 };
}

test("branch walks from the active leaf back to the root, in order", () => {
  const { chat, q2 } = conversation("Ветка");
  assert.deepEqual(
    getBranch(chat.id).map((m) => m.content),
    ["вопрос 1", "ответ 1", "вопрос 2"],
  );
  assert.equal(getChat(chat.id)?.active_leaf_id, q2.id);
});

test("an empty chat has an empty branch", () => {
  assert.deepEqual(getBranch(createChat("Пустой").id), []);
});

test("a swipe adds a sibling and both replies stay reachable", () => {
  const { chat, q1, a1 } = conversation("Свайп");
  const a1b = say(chat.id, q1.id, "assistant", "ответ 1 (вариант Б)");

  assert.deepEqual(
    getSiblings(a1).map((m) => m.content),
    ["ответ 1", "ответ 1 (вариант Б)"],
  );
  // The new swipe is the active branch, the old one is still in the tree.
  assert.deepEqual(
    getBranch(chat.id).map((m) => m.content),
    ["вопрос 1", "ответ 1 (вариант Б)"],
  );
  assert.ok(getMessage(a1.id), "the original reply must not be deleted");
  assert.equal(a1b.parent_id, a1.parent_id);
});

test("switching to a sibling follows that branch back to its own tip", () => {
  const { chat, q1, a1, q2 } = conversation("Переключение");
  const a2 = say(chat.id, q2.id, "assistant", "ответ 2");
  say(chat.id, q1.id, "assistant", "другая ветка");

  // Coming back to the first reply must restore the whole branch under it.
  setActiveLeaf(chat.id, deepestLeaf(a1.id));
  assert.equal(getChat(chat.id)?.active_leaf_id, a2.id);
  assert.deepEqual(
    getBranch(chat.id).map((m) => m.content),
    ["вопрос 1", "ответ 1", "вопрос 2", "ответ 2"],
  );
});

test("editing keeps the original as a sibling and switches to the new text", () => {
  const { chat, q2 } = conversation("Правка");
  const edited = editMessage(q2.id, "вопрос 2, переписанный")!;

  assert.equal(edited.parent_id, q2.parent_id);
  assert.equal(edited.role, q2.role);
  assert.ok(getMessage(q2.id), "the original wording must survive");
  assert.deepEqual(
    getBranch(chat.id).map((m) => m.content),
    ["вопрос 1", "ответ 1", "вопрос 2, переписанный"],
  );
  assert.equal(getSiblings(edited).length, 2);
});

test("forking from the middle keeps the old continuation intact", () => {
  const { chat, a1, q2 } = conversation("Ветвление");
  const a2 = say(chat.id, q2.id, "assistant", "ответ 2");

  // Fork: go back to the first reply without descending, then continue anew.
  setActiveLeaf(chat.id, a1.id);
  const other = say(chat.id, a1.id, "user", "а если иначе?");

  assert.deepEqual(
    getBranch(chat.id).map((m) => m.content),
    ["вопрос 1", "ответ 1", "а если иначе?"],
  );
  assert.ok(getMessage(a2.id), "the abandoned branch must still exist");
  assert.equal(countLeaves(chat.id), 2);
  assert.equal(getSiblings(other).length, 2);
});

test("sibling position is reported for the branch in view", () => {
  const { chat, q1, a1 } = conversation("Счётчик");
  say(chat.id, q1.id, "assistant", "вариант Б");
  say(chat.id, q1.id, "assistant", "вариант В");

  const branch = getBranchWithSiblings(chat.id);
  const reply = branch.at(-1)!;
  assert.equal(reply.content, "вариант В");
  assert.equal(reply.sibling_ids.length, 3);
  assert.equal(reply.sibling_index, 2);
  assert.equal(reply.sibling_ids.at(-1), reply.id);
  assert.equal(branch[0].sibling_ids.length, 1, "the root has no siblings");
  assert.equal(getSiblings(a1).length, 3);
});

test("continue appends text and adds up the tokens and the cost", () => {
  const chat = createChat("Продолжение");
  const q = say(chat.id, null, "user", "начни");
  const reply = appendMessage({
    chatId: chat.id,
    parentId: q.id,
    role: "assistant",
    content: "Первая половина",
    model: "claude-opus-5",
    usage: { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 },
  });
  assert.equal(reply.cost_usd, 5);

  const continued = appendToMessage(reply.id, " и вторая.", "claude-opus-5", {
    input: 1_000_000,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  })!;

  assert.equal(continued.content, "Первая половина и вторая.");
  assert.equal(continued.input_tokens, 2_000_000);
  assert.equal(continued.cost_usd, 10);
  assert.equal(getBranch(chat.id).length, 2, "continue must not add a node");
});

test("continue after a failure adds text without inventing a cost", () => {
  const chat = createChat("Обрыв");
  const q = say(chat.id, null, "user", "начни");
  const reply = say(chat.id, q.id, "assistant", "оборвалось");

  const continued = appendToMessage(reply.id, "…и продолжилось", null, null)!;
  assert.equal(continued.content, "оборвалось…и продолжилось");
  assert.equal(continued.cost_usd, null);
});

test("pathTo stops instead of hanging if a parent link is missing", () => {
  const chat = createChat("Сирота");
  const orphan = appendMessage({
    chatId: chat.id,
    parentId: null,
    role: "user",
    content: "сирота",
  });
  assert.deepEqual(
    pathTo(orphan.id).map((m) => m.content),
    ["сирота"],
  );
  assert.deepEqual(pathTo(null), []);
  assert.deepEqual(pathTo("нет такого"), []);
});

test("leaf count tracks how many branch tips the chat has", () => {
  const { chat, q1, q2 } = conversation("Листья");
  assert.equal(countLeaves(chat.id), 1);
  say(chat.id, q1.id, "assistant", "второй вариант");
  assert.equal(countLeaves(chat.id), 2);
  say(chat.id, q2.id, "assistant", "ответ 2");
  assert.equal(countLeaves(chat.id), 2, "extending a tip does not add one");
});

test("forking surfaces the abandoned continuation at the branch tip", () => {
  const { chat, a1, q2 } = conversation("Точка развилки");
  say(chat.id, q2.id, "assistant", "ответ 2");

  // Nothing on the branch has siblings yet, so without this the old line
  // would be unreachable from the UI even though it is intact in the tree.
  assert.deepEqual(tipChildren(chat.id), []);

  setActiveLeaf(chat.id, a1.id);
  const children = tipChildren(chat.id);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, q2.id);
  assert.equal(children[0].role, "user");
  assert.equal(children[0].preview, "вопрос 2");
});

test("the tip lists every continuation, in the order they were made", () => {
  const { chat, a1, q2 } = conversation("Несколько продолжений");
  const other = say(chat.id, a1.id, "user", "а если иначе?");
  setActiveLeaf(chat.id, a1.id);

  assert.deepEqual(
    tipChildren(chat.id).map((c) => c.id),
    [q2.id, other.id],
  );
});

test("a long preview is trimmed and stripped of line breaks", () => {
  const chat = createChat("Превью");
  const root = say(chat.id, null, "user", "начало");
  say(chat.id, root.id, "assistant", `строка\nвторая ${"о".repeat(200)}`);
  setActiveLeaf(chat.id, root.id);

  const [child] = tipChildren(chat.id);
  assert.equal(child.preview.length, 70);
  assert.doesNotMatch(child.preview, /\n/);
});

test("an empty chat has no tip children", () => {
  assert.deepEqual(tipChildren(createChat("Пусто").id), []);
});
