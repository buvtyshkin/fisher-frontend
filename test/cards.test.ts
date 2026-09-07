import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-cards-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "test-key";

const { extractCardJson, readTextChunks, writeCardIntoPng } = await import(
  "../server/cards/png.ts"
);
const { applyNameMacros, greetingsOf, parseCard, toExportJson } = await import(
  "../server/cards/card.ts"
);
const { createChat, getBranchWithSiblings, getMessage, seedGreetings } =
  await import("../server/store.ts");

/* ── A minimal but real PNG, so the parser is tested against actual bytes ── */

function chunk(type: string, body: Buffer): Buffer {
  const header = Buffer.concat([Buffer.alloc(4), Buffer.from(type, "latin1")]);
  header.writeUInt32BE(body.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "latin1"), body])), 0);
  return Buffer.concat([header, body, crc]);
}

function textChunk(keyword: string, text: string): Buffer {
  return chunk(
    "tEXt",
    Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.alloc(1), Buffer.from(text, "latin1")]),
  );
}

function makePng(chunks: Buffer[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    ...chunks,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const embed = (keyword: string, card: unknown) =>
  textChunk(keyword, Buffer.from(JSON.stringify(card), "utf8").toString("base64"));

const v2Card = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Фишер",
    description: "{{char}} — смотритель маяка.",
    personality: "Немногословен",
    scenario: "Ночь, шторм",
    first_mes: "Привет, {{user}}.",
    mes_example: "",
    alternate_greetings: ["Ты снова здесь, {{user}}?", "Молчание."],
    tags: ["маяк"],
  },
};

/* ── PNG ─────────────────────────────────────────────────────────────────── */

test("a card is read out of a real PNG's tEXt chunk", () => {
  const png = makePng([embed("chara", v2Card)]);
  assert.deepEqual(JSON.parse(extractCardJson(png)), v2Card);
});

test("V3 wins when a PNG carries both chara and ccv3", () => {
  const v3 = { spec: "chara_card_v3", spec_version: "3.0", data: { ...v2Card.data, name: "Фишер V3" } };
  const png = makePng([embed("chara", v2Card), embed("ccv3", v3)]);
  assert.equal(JSON.parse(extractCardJson(png)).data.name, "Фишер V3");
});

test("other text chunks are read but do not confuse the card lookup", () => {
  const png = makePng([textChunk("Software", "SillyTavern"), embed("chara", v2Card)]);
  assert.deepEqual(
    readTextChunks(png).map((c) => c.keyword),
    ["Software", "chara"],
  );
});

test("PNGs without a card, and non-PNGs, fail with a readable message", () => {
  assert.throws(() => extractCardJson(makePng([])), /нет карточки/i);
  assert.throws(() => extractCardJson(Buffer.from("не png")), /не PNG/i);
});

/* ── Card shapes ─────────────────────────────────────────────────────────── */

test("V2 and V3 keep their spec and every field they came with", () => {
  const v2 = parseCard(JSON.stringify(v2Card));
  assert.equal(v2.spec, "chara_card_v2");
  assert.equal(v2.data.name, "Фишер");
  assert.deepEqual(v2.data.tags, ["маяк"]);

  const v3 = parseCard(
    JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data: { ...v2Card.data, nickname: "Смотритель" } }),
  );
  assert.equal(v3.spec, "chara_card_v3");
  assert.equal(v3.data.nickname, "Смотритель");
});

test("a flat V1 card is wrapped without losing anything", () => {
  const v1 = parseCard(
    JSON.stringify({
      name: "Старик",
      description: "Рыбак",
      personality: "",
      scenario: "",
      first_mes: "Здравствуй.",
      mes_example: "",
    }),
  );
  assert.equal(v1.spec, "chara_card_v1");
  assert.equal(v1.data.name, "Старик");
  assert.deepEqual(v1.data.alternate_greetings, []);
});

test("a card without a name is refused", () => {
  assert.throws(() => parseCard(JSON.stringify({ description: "нет имени" })), /нет имени/i);
  assert.throws(() => parseCard("не json"), /не JSON/i);
});

test("export keeps the V2 wrapper and every carried-through field", () => {
  const exported = JSON.parse(toExportJson(parseCard(JSON.stringify(v2Card))));
  assert.equal(exported.spec, "chara_card_v2");
  assert.equal(exported.spec_version, "2.0");
  assert.deepEqual(exported.data.tags, ["маяк"]);
  assert.equal(exported.data.first_mes, "Привет, {{user}}.");
});

/* ── Greetings and macros ────────────────────────────────────────────────── */

test("greetings are the first message plus the alternates, blanks dropped", () => {
  assert.deepEqual(greetingsOf(parseCard(JSON.stringify(v2Card)).data), [
    "Привет, {{user}}.",
    "Ты снова здесь, {{user}}?",
    "Молчание.",
  ]);
  assert.deepEqual(
    greetingsOf({ ...v2Card.data, first_mes: "  ", alternate_greetings: [] } as never),
    [],
  );
});

test("name macros are replaced case-insensitively", () => {
  assert.equal(
    applyNameMacros("{{char}} смотрит на {{USER}}, {{User}}.", { char: "Фишер", user: "Аня" }),
    "Фишер смотрит на Аня, Аня.",
  );
});

test("greetings become siblings, and the first one stays active", () => {
  const chat = createChat("Карточка");
  seedGreetings(chat.id, ["первое", "второе", "третье"]);

  const branch = getBranchWithSiblings(chat.id);
  assert.equal(branch.length, 1, "only one greeting is on the branch");
  assert.equal(branch[0].content, "первое");
  assert.equal(branch[0].sibling_index, 0);
  assert.equal(branch[0].sibling_ids.length, 3, "the alternates are swipes");

  // Card order must survive: greetings are written within the same millisecond,
  // so anything ordered by timestamp would shuffle them.
  assert.deepEqual(
    branch[0].sibling_ids.map((id) => getMessage(id)!.content),
    ["первое", "второе", "третье"],
  );
});
