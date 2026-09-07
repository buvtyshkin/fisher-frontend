import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WORLD_INFO_SETTINGS,
  keyScanEngine,
  type WorldInfoSettings,
} from "../server/lorebook/engine.ts";
import { LOGIC, POSITION, parseLorebook, type LorebookEntry } from "../server/lorebook/lorebook.ts";
import { placeEntries } from "../server/lorebook/placement.ts";

let uid = 0;
const entry = (over: Partial<LorebookEntry>): LorebookEntry => ({
  uid: uid++,
  comment: "Запись",
  key: [],
  keysecondary: [],
  content: "СОДЕРЖИМОЕ",
  constant: false,
  disable: false,
  selectiveLogic: LOGIC.AND_ANY,
  order: 100,
  position: POSITION.before,
  depth: 4,
  role: null,
  probability: 100,
  useProbability: true,
  excludeRecursion: false,
  preventRecursion: false,
  caseSensitive: null,
  matchWholeWords: null,
  scanDepth: null,
  ...over,
});

const fire = (
  entries: LorebookEntry[],
  messages: string[],
  settings: Partial<WorldInfoSettings> = {},
) =>
  keyScanEngine
    .activate({
      entries,
      messages,
      settings: { ...DEFAULT_WORLD_INFO_SETTINGS, ...settings },
    })
    .map((a) => a.entry.comment);

/* ── Activation ──────────────────────────────────────────────────────────── */

test("a constant entry fires with no keys at all", () => {
  assert.deepEqual(fire([entry({ comment: "всегда", constant: true })], []), ["всегда"]);
});

test("a primary key fires when it appears in the scanned messages", () => {
  const book = [entry({ comment: "маяк", key: ["маяк"] })];
  assert.deepEqual(fire(book, ["Мы пошли к маяку."]), ["маяк"]);
  assert.deepEqual(fire(book, ["Ничего похожего."]), []);
});

test("matching ignores case unless the entry asks otherwise", () => {
  assert.deepEqual(fire([entry({ comment: "к", key: ["Маяк"] })], ["маяк"]), ["к"]);
  assert.deepEqual(
    fire([entry({ comment: "к", key: ["Маяк"], caseSensitive: true })], ["маяк"]),
    [],
  );
});

test("whole-word matching bounds Latin keys and falls back for multi-word ones", () => {
  const single = [entry({ comment: "к", key: ["cat"], matchWholeWords: true })];
  assert.deepEqual(fire(single, ["a cat sat"]), ["к"]);
  assert.deepEqual(fire(single, ["catalogue"]), [], "часть слова не считается");
  // A multi-word key falls back to a plain substring test, as in ST.
  const multi = [entry({ comment: "м", key: ["black cat"], matchWholeWords: true })];
  assert.deepEqual(fire(multi, ["a black catalogue"]), ["м"]);
});

test("whole-word matching does not bound Cyrillic keys — as in SillyTavern", () => {
  // ST builds the boundary from \W, and JavaScript's \w is ASCII-only, so every
  // Cyrillic letter counts as a boundary. The setting therefore does nothing
  // for Russian keys. Reproduced deliberately: the triggers must match ST's.
  const book = [entry({ comment: "к", key: ["кот"], matchWholeWords: true })];
  assert.deepEqual(fire(book, ["котлета"]), ["к"]);
});

test("a /regex/ key overrides the other matching options", () => {
  const book = [entry({ comment: "р", key: ["/шторм\\w*/i"], caseSensitive: true })];
  assert.deepEqual(fire(book, ["ШТОРМОВАЯ ночь"]), ["р"]);
});

test("only the last scanDepth messages are scanned", () => {
  const book = [entry({ comment: "к", key: ["маяк"] })];
  const messages = ["маяк был давно", "первое", "второе"];
  assert.deepEqual(fire(book, messages, { scanDepth: 2 }), []);
  assert.deepEqual(fire(book, messages, { scanDepth: 3 }), ["к"]);
});

test("an entry can override the scan depth for itself", () => {
  const book = [entry({ comment: "к", key: ["маяк"], scanDepth: 3 })];
  assert.deepEqual(fire(book, ["маяк", "a", "b"], { scanDepth: 1 }), ["к"]);
});

test("a key cannot match across a message boundary", () => {
  // "маяк" split over two messages must not fire.
  const book = [entry({ comment: "к", key: ["ма як"] })];
  assert.deepEqual(fire(book, ["ма", "як"], { scanDepth: 5 }), []);
});

test("a disabled or empty entry never fires", () => {
  assert.deepEqual(fire([entry({ comment: "в", constant: true, disable: true })], []), []);
  assert.deepEqual(fire([entry({ comment: "п", constant: true, content: "  " })], []), []);
});

/* ── Secondary keys ──────────────────────────────────────────────────────── */

const secondary = (logic: number) =>
  entry({ comment: "в", key: ["маяк"], keysecondary: ["шторм", "ночь"], selectiveLogic: logic });

test("AND ANY needs at least one secondary key", () => {
  const book = [secondary(LOGIC.AND_ANY)];
  assert.deepEqual(fire(book, ["маяк в шторм"]), ["в"]);
  assert.deepEqual(fire(book, ["просто маяк"]), []);
});

test("AND ALL needs every secondary key", () => {
  const book = [secondary(LOGIC.AND_ALL)];
  assert.deepEqual(fire(book, ["маяк, шторм, ночь"]), ["в"]);
  assert.deepEqual(fire(book, ["маяк в шторм"]), []);
});

test("NOT ANY needs none of the secondary keys", () => {
  const book = [secondary(LOGIC.NOT_ANY)];
  assert.deepEqual(fire(book, ["просто маяк"]), ["в"]);
  assert.deepEqual(fire(book, ["маяк в шторм"]), []);
});

test("NOT ALL fires while at least one secondary key is missing", () => {
  const book = [secondary(LOGIC.NOT_ALL)];
  assert.deepEqual(fire(book, ["маяк в шторм"]), ["в"]);
  assert.deepEqual(fire(book, ["маяк, шторм, ночь"]), []);
});

/* ── Recursion ───────────────────────────────────────────────────────────── */

const chain = () => [
  entry({ comment: "первая", key: ["маяк"], content: "Смотрителя зовут Фишер." }),
  entry({ comment: "вторая", key: ["Фишер"], content: "Фишер служил на флоте." }),
];

test("recursion is off by default, so a triggered entry triggers nothing", () => {
  assert.deepEqual(fire(chain(), ["маяк"]), ["первая"]);
});

test("with recursion on, an activated entry can activate another", () => {
  assert.deepEqual(fire(chain(), ["маяк"], { recursive: true }).sort(), ["вторая", "первая"]);
});

test("preventRecursion stops an entry's content from triggering others", () => {
  const book = chain();
  book[0].preventRecursion = true;
  assert.deepEqual(fire(book, ["маяк"], { recursive: true }), ["первая"]);
});

test("excludeRecursion stops an entry from being activated by recursion", () => {
  const book = chain();
  book[1].excludeRecursion = true;
  assert.deepEqual(fire(book, ["маяк"], { recursive: true }), ["первая"]);
  // It still fires when the message itself mentions it.
  assert.deepEqual(
    fire(book, ["Фишер"], { recursive: true }).sort(),
    ["вторая"],
  );
});

/* ── Probability ─────────────────────────────────────────────────────────── */

test("probability gates an entry, and 100 always passes", () => {
  const half = [entry({ comment: "п", constant: true, probability: 50 })];
  assert.deepEqual(fire(half, [], { random: () => 0.1 }), ["п"]);
  assert.deepEqual(fire(half, [], { random: () => 0.9 }), []);
  assert.deepEqual(
    fire([entry({ comment: "в", constant: true })], [], { random: () => 0.99 }),
    ["в"],
  );
});

/* ── Placement ───────────────────────────────────────────────────────────── */

const activated = (entries: LorebookEntry[]) =>
  entries.map((e) => ({ entry: e, reason: "тест" }));

test("entries join in ascending order, as SillyTavern emits them", () => {
  const placed = placeEntries(
    activated([
      entry({ content: "ТРЕТИЙ", order: 300 }),
      entry({ content: "ПЕРВЫЙ", order: 100 }),
      entry({ content: "ВТОРОЙ", order: 200 }),
    ]),
  );
  assert.equal(placed.before, "ПЕРВЫЙ\nВТОРОЙ\nТРЕТИЙ");
});

test("before and after go to their own slots", () => {
  const placed = placeEntries(
    activated([
      entry({ content: "ДО", position: POSITION.before }),
      entry({ content: "ПОСЛЕ", position: POSITION.after }),
    ]),
  );
  assert.equal(placed.before, "ДО");
  assert.equal(placed.after, "ПОСЛЕ");
});

test("at-depth entries group by depth and role", () => {
  const placed = placeEntries(
    activated([
      entry({ content: "A", position: POSITION.atDepth, depth: 2, order: 100 }),
      entry({ content: "B", position: POSITION.atDepth, depth: 2, order: 200 }),
      entry({ content: "C", position: POSITION.atDepth, depth: 5, role: 1 }),
    ]),
  );
  assert.equal(placed.depths.length, 2);
  const two = placed.depths.find((g) => g.depth === 2)!;
  assert.equal(two.content, "A\nB");
  assert.equal(two.role, 0);
  assert.equal(placed.depths.find((g) => g.depth === 5)!.role, 1);
});

test("a position with no slot is reported instead of silently dropped", () => {
  const placed = placeEntries(
    activated([entry({ comment: "заметка автора", position: POSITION.anTop })]),
  );
  assert.deepEqual(placed.unsupported, [{ title: "заметка автора", position: 2 }]);
});

/* ── Parsing ─────────────────────────────────────────────────────────────── */

test("a World Info file parses, keeping ST's field names", () => {
  const book = parseLorebook(
    JSON.stringify({
      name: "Мир",
      entries: {
        "0": {
          uid: 0,
          comment: "Маяк",
          key: ["маяк"],
          keysecondary: ["шторм"],
          content: "текст",
          constant: false,
          order: 250,
          position: 1,
          selectiveLogic: 3,
          depth: 6,
          role: 2,
          excludeRecursion: true,
        },
      },
    }),
    "файл",
  );
  assert.equal(book.name, "Мир");
  const [first] = book.entries;
  assert.deepEqual(first.key, ["маяк"]);
  assert.equal(first.selectiveLogic, LOGIC.AND_ALL);
  assert.equal(first.order, 250);
  assert.equal(first.position, POSITION.after);
  assert.equal(first.depth, 6);
  assert.equal(first.role, 2);
  assert.equal(first.excludeRecursion, true);
});

test("a card's character_book shape parses too", () => {
  const book = parseLorebook(
    JSON.stringify({
      name: "Из карточки",
      entries: [
        {
          name: "Запись",
          keys: ["ключ"],
          secondary_keys: ["второй"],
          content: "текст",
          enabled: false,
          insertion_order: 42,
          position: "after_char",
          extensions: { depth: 3, exclude_recursion: true },
        },
      ],
    }),
    "файл",
  );
  const [first] = book.entries;
  assert.deepEqual(first.key, ["ключ"]);
  assert.deepEqual(first.keysecondary, ["второй"]);
  assert.equal(first.disable, true, "enabled: false означает выключено");
  assert.equal(first.order, 42);
  assert.equal(first.position, POSITION.after);
  assert.equal(first.depth, 3);
  assert.equal(first.excludeRecursion, true);
});

test("something that is not World Info is refused", () => {
  assert.throws(() => parseLorebook("не json", "ф"), /не JSON/i);
  assert.throws(() => parseLorebook(JSON.stringify({ hello: 1 }), "ф"), /нет записей/i);
});
