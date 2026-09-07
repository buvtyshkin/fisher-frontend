import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-chron-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "test-key";

const {
  appendMessage,
  chroniclesForBranch,
  createChat,
  deleteChronicle,
  getBranch,
  listChronicles,
  renderChronicles,
  saveChronicle,
  setActiveLeaf,
  updateChronicle,
} = await import("../server/store.ts");
const { buildPrompt } = await import("../server/preset/build.ts");
const { DEFAULT_PRESET } = await import("../server/preset/default.ts");

const say = (
  chatId: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
) => appendMessage({ chatId, parentId, role, content });

/**
 * A tree that forks after the second reply:
 *   q1 → a1 → q2 → a2   (branch A)
 *              ↘ q2b → a2b (branch B)
 */
function forked(title: string) {
  const chat = createChat(title);
  const q1 = say(chat.id, null, "user", "вопрос 1");
  const a1 = say(chat.id, q1.id, "assistant", "ответ 1");
  const q2 = say(chat.id, a1.id, "user", "вопрос 2");
  const a2 = say(chat.id, q2.id, "assistant", "ответ 2");
  const q2b = say(chat.id, a1.id, "user", "вопрос 2 иначе");
  const a2b = say(chat.id, q2b.id, "assistant", "ответ 2 иначе");
  return { chat, q1, a1, q2, a2, q2b, a2b };
}

const chronicle = (
  chatId: string,
  anchor: string,
  over: Partial<Parameters<typeof saveChronicle>[0]> = {},
) =>
  saveChronicle({
    chatId,
    level: "scene",
    title: "Сцена",
    content: "ТЕКСТ ХРОНИКИ",
    anchorMessageId: anchor,
    fromMessageId: anchor,
    toMessageId: anchor,
    hideCovered: false,
    ...over,
  });

/* ── The criterion: a chronicle must not leak into a parallel branch ─────── */

test("a chronicle anchored on one branch is invisible on the parallel one", () => {
  const { chat, a2, a2b } = forked("Изоляция");

  chronicle(chat.id, a2.id, { content: "ТОЛЬКО ВЕТКА A" });

  // The active leaf is a2b — the other branch. Nothing should be visible.
  setActiveLeaf(chat.id, a2b.id);
  assert.deepEqual(chroniclesForBranch(chat.id, getBranch(chat.id)).visible, []);

  // Switch to branch A and it appears.
  setActiveLeaf(chat.id, a2.id);
  const onA = chroniclesForBranch(chat.id, getBranch(chat.id)).visible;
  assert.equal(onA.length, 1);
  assert.equal(onA[0].content, "ТОЛЬКО ВЕТКА A");
});

test("a chronicle anchored before the fork is visible on both branches", () => {
  const { chat, a1, a2, a2b } = forked("Общий предок");
  chronicle(chat.id, a1.id, { content: "ОБЩЕЕ ПРОШЛОЕ" });

  for (const leaf of [a2.id, a2b.id]) {
    setActiveLeaf(chat.id, leaf);
    const visible = chroniclesForBranch(chat.id, getBranch(chat.id)).visible;
    assert.deepEqual(visible.map((c) => c.content), ["ОБЩЕЕ ПРОШЛОЕ"]);
  }
});

test("the leak is prevented in the assembled prompt, not just in the list", () => {
  const { chat, a2, a2b } = forked("Промпт");
  chronicle(chat.id, a2.id, { content: "СЕКРЕТ ВЕТКИ A" });

  const promptFor = (leaf: string) => {
    setActiveLeaf(chat.id, leaf);
    const branch = getBranch(chat.id);
    const { visible, hidden } = chroniclesForBranch(chat.id, branch);
    return buildPrompt({
      preset: DEFAULT_PRESET,
      card: null,
      persona: null,
      branch,
      summary: renderChronicles(visible),
      hidden,
    });
  };

  assert.match(promptFor(a2.id).system ?? "", /СЕКРЕТ ВЕТКИ A/);
  assert.doesNotMatch(promptFor(a2b.id).system ?? "", /СЕКРЕТ ВЕТКИ A/);
});

/* ── Ordering and rendering ──────────────────────────────────────────────── */

test("chronicles come out in branch order, not creation order", () => {
  const { chat, a1, q2, a2 } = forked("Порядок");
  // Created late, anchored early.
  chronicle(chat.id, a2.id, { content: "ПОЗЖЕ" });
  chronicle(chat.id, a1.id, { content: "РАНЬШЕ" });
  chronicle(chat.id, q2.id, { content: "СЕРЕДИНА" });

  setActiveLeaf(chat.id, a2.id);
  assert.deepEqual(
    chroniclesForBranch(chat.id, getBranch(chat.id)).visible.map((c) => c.content),
    ["РАНЬШЕ", "СЕРЕДИНА", "ПОЗЖЕ"],
  );
});

test("the rendered block labels each level and its title", () => {
  const { chat, a1, a2 } = forked("Отрисовка");
  chronicle(chat.id, a1.id, { level: "chapter", title: "Пролог", content: "текст главы" });
  chronicle(chat.id, a2.id, { level: "scene", title: "", content: "текст сцены" });

  setActiveLeaf(chat.id, a2.id);
  const text = renderChronicles(chroniclesForBranch(chat.id, getBranch(chat.id)).visible);
  assert.match(text, /\[Глава: Пролог\]\nтекст главы/);
  assert.match(text, /\[Сцена\]\nтекст сцены/);
});

/* ── Hiding summarised messages ──────────────────────────────────────────── */

test("a hiding chronicle keeps its messages in the tree but out of the request", () => {
  const { chat, q1, a1, a2, q2 } = forked("Скрытие");
  chronicle(chat.id, a1.id, {
    content: "ПЕРЕСКАЗ НАЧАЛА",
    fromMessageId: q1.id,
    toMessageId: a1.id,
    hideCovered: true,
  });

  setActiveLeaf(chat.id, a2.id);
  const branch = getBranch(chat.id);
  const { visible, hidden } = chroniclesForBranch(chat.id, branch);

  assert.equal(branch.length, 4, "дерево не тронуто");
  assert.deepEqual([...hidden].sort(), [q1.id, a1.id].sort());

  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: null,
    persona: null,
    branch,
    summary: renderChronicles(visible),
    hidden,
  });

  const sent = JSON.stringify(built.messages);
  assert.ok(!sent.includes("вопрос 1"), "скрытое не уходит в API");
  assert.ok(!sent.includes("ответ 1"));
  assert.ok(sent.includes("вопрос 2"), "остальное на месте");
  assert.match(built.system ?? "", /ПЕРЕСКАЗ НАЧАЛА/);
  assert.ok(q2);
});

test("hiding is off unless asked for", () => {
  const { chat, q1, a1, a2 } = forked("Без скрытия");
  chronicle(chat.id, a1.id, { fromMessageId: q1.id, toMessageId: a1.id });
  setActiveLeaf(chat.id, a2.id);
  assert.equal(chroniclesForBranch(chat.id, getBranch(chat.id)).hidden.size, 0);
});

test("a range that left this branch hides nothing", () => {
  const { chat, a1, q2b, a2b, a2 } = forked("Разошлись");
  // Covers branch B, anchored before the fork so it stays visible on A.
  chronicle(chat.id, a1.id, {
    fromMessageId: q2b.id,
    toMessageId: a2b.id,
    hideCovered: true,
  });

  setActiveLeaf(chat.id, a2.id);
  const { visible, hidden } = chroniclesForBranch(chat.id, getBranch(chat.id));
  assert.equal(visible.length, 1, "хроника видна: её якорь на ветке");
  assert.equal(hidden.size, 0, "но скрывать здесь нечего — диапазон в другой ветке");
});

/* ── Editing ─────────────────────────────────────────────────────────────── */

test("a chronicle can be rewritten and its hiding toggled", () => {
  const { chat, a1, a2, q1 } = forked("Правка");
  const saved = chronicle(chat.id, a1.id, { fromMessageId: q1.id, toMessageId: a1.id });

  updateChronicle(saved.id, { content: "ПЕРЕПИСАНО", hideCovered: true });
  setActiveLeaf(chat.id, a2.id);

  const { visible, hidden } = chroniclesForBranch(chat.id, getBranch(chat.id));
  assert.equal(visible[0].content, "ПЕРЕПИСАНО");
  assert.equal(hidden.size, 2);

  deleteChronicle(saved.id);
  assert.deepEqual(listChronicles(chat.id), []);
});

test("a chat with no chronicles renders an empty block", () => {
  const { chat, a2 } = forked("Пусто");
  setActiveLeaf(chat.id, a2.id);
  const { visible } = chroniclesForBranch(chat.id, getBranch(chat.id));
  assert.equal(renderChronicles(visible), "");
});
