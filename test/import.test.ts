import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-import-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "test-key";

const { importSillyTavernChat } = await import("../server/import-chat.ts");
const { getBranchWithSiblings, getBranch, getMessage, countLeaves } = await import(
  "../server/store.ts"
);
const { buildPrompt } = await import("../server/preset/build.ts");
const { DEFAULT_PRESET } = await import("../server/preset/default.ts");
const { chroniclesForBranch } = await import("../server/store.ts");

const line = (over: Record<string, unknown>) =>
  JSON.stringify({ name: "Кто-то", is_user: false, mes: "", ...over });

const file = (...lines: string[]) => lines.join("\n");

const HEADER = JSON.stringify({ user_name: "unused", character_name: "unused" });

/* ── Shape ───────────────────────────────────────────────────────────────── */

test("a linear chat becomes a linear branch, roles preserved", () => {
  const result = importSillyTavernChat(
    file(
      HEADER,
      line({ is_user: true, mes: "мой ход" }),
      line({ is_user: false, mes: "ответ" }),
      line({ is_user: true, mes: "второй ход" }),
    ),
    "Ева - чат.jsonl",
  );

  assert.equal(result.turns, 3);
  assert.equal(result.nodes, 3);
  assert.deepEqual(
    getBranch(result.chatId).map((m) => [m.role, m.content]),
    [
      ["user", "мой ход"],
      ["assistant", "ответ"],
      ["user", "второй ход"],
    ],
  );
  assert.equal(result.title, "Ева - чат");
});

test("the header line is skipped and a chat without one still imports", () => {
  const withoutHeader = importSillyTavernChat(
    file(line({ is_user: true, mes: "первый" })),
    "без шапки.jsonl",
  );
  assert.equal(withoutHeader.turns, 1);
  assert.equal(getBranch(withoutHeader.chatId)[0].content, "первый");
});

/* ── Swipes become siblings ──────────────────────────────────────────────── */

test("swipes arrive as siblings and swipe_id stays the active one", () => {
  const result = importSillyTavernChat(
    file(
      HEADER,
      line({ is_user: true, mes: "вопрос" }),
      line({
        is_user: false,
        mes: "вариант Б",
        swipes: ["вариант А", "вариант Б", "вариант В"],
        swipe_id: 1,
      }),
    ),
    "свайпы.jsonl",
  );

  assert.equal(result.turns, 2);
  assert.equal(result.nodes, 4, "три свайпа плюс реплика игрока");
  assert.equal(result.swipes, 1);

  const branch = getBranchWithSiblings(result.chatId);
  const reply = branch.at(-1)!;
  assert.equal(reply.content, "вариант Б", "активен тот, что указан в swipe_id");
  assert.equal(reply.sibling_index, 1);
  assert.deepEqual(
    reply.sibling_ids.map((id) => getMessage(id)!.content),
    ["вариант А", "вариант Б", "вариант В"],
    "порядок свайпов сохранён",
  );
  assert.equal(countLeaves(result.chatId), 3, "неиспользованные свайпы — тоже концы");
});

test("an out-of-range swipe_id falls back to the first swipe", () => {
  const result = importSillyTavernChat(
    file(line({ mes: "б", swipes: ["а", "б"], swipe_id: 99 })),
    "кривой.jsonl",
  );
  assert.equal(getBranch(result.chatId).at(-1)!.content, "б");
});

/* ── is_system: kept in the chat, out of the prompt ──────────────────────── */

test("is_system messages stay in the tree but never reach the request", () => {
  // This is how SillyTavern hides summarised history; its real chats hide the
  // bulk of themselves, so dropping the flag would send everything at once.
  const result = importSillyTavernChat(
    file(
      HEADER,
      line({ is_user: true, is_system: true, mes: "давняя реплика" }),
      line({ is_user: false, is_system: true, mes: "давний ответ" }),
      line({ is_user: true, mes: "свежий ход" }),
      line({ is_user: false, mes: "свежий ответ" }),
    ),
    "скрытые.jsonl",
  );

  assert.equal(result.hidden, 2);
  const branch = getBranch(result.chatId);
  assert.equal(branch.length, 4, "в дереве все четыре");

  const { hidden } = chroniclesForBranch(result.chatId, branch);
  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: null,
    persona: null,
    branch,
    hidden,
  });

  const sent = built.messages.map((m) => m.content).join(" ");
  assert.ok(!sent.includes("давняя реплика"), "скрытое не уходит");
  assert.ok(!sent.includes("давний ответ"));
  assert.ok(sent.includes("свежий ход"), "остальное уходит");
  assert.ok(sent.includes("свежий ответ"));
});

/* ── Robustness ──────────────────────────────────────────────────────────── */

test("a truncated last line is skipped, not fatal", () => {
  const result = importSillyTavernChat(
    file(HEADER, line({ mes: "целая" }), '{"mes": "обор'),
    "обрыв.jsonl",
  );
  assert.equal(result.turns, 1);
});

test("a file with nothing importable is refused", () => {
  assert.throws(() => importSillyTavernChat("", "пусто.jsonl"), /пуст/i);
  assert.throws(
    () => importSillyTavernChat(HEADER, "только шапка.jsonl"),
    /не найдено ни одного сообщения/i,
  );
});

test("send_date is kept when it parses", () => {
  const result = importSillyTavernChat(
    file(line({ mes: "раз", send_date: "2026-05-28T10:00:40.408Z" })),
    "даты.jsonl",
  );
  assert.equal(
    getBranch(result.chatId)[0].created_at,
    Date.parse("2026-05-28T10:00:40.408Z"),
  );
});
