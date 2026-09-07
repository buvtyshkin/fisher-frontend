import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt } from "../server/preset/build.ts";
import { DEFAULT_PRESET } from "../server/preset/default.ts";
import { parsePreset, type Preset, type PresetPrompt } from "../server/preset/preset.ts";
import type { CardData } from "../server/cards/card.ts";
import type { Message, PersonaRow } from "../server/db.ts";

let counter = 0;
const message = (role: Message["role"], content: string): Message => ({
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

const card = {
  name: "Фишер",
  description: "{{char}} — смотритель маяка.",
  personality: "Немногословен",
  scenario: "Шторм",
  first_mes: "Привет.",
  mes_example: "<START>\nПример.",
} as CardData;

const persona: PersonaRow = {
  id: "p",
  name: "Аня",
  description: "{{user}} — механик.",
  avatar: null,
  created_at: 0,
};

const block = (over: Partial<PresetPrompt>): PresetPrompt => ({
  identifier: "x",
  name: "Блок",
  role: "system",
  content: "",
  marker: false,
  injection_position: 0,
  injection_depth: 4,
  injection_order: 100,
  ...over,
});

const preset = (prompts: PresetPrompt[], order?: string[]): Preset => ({
  ...DEFAULT_PRESET,
  prompts,
  order: (order ?? prompts.map((p) => p.identifier)).map((identifier) => ({
    identifier,
    enabled: true,
  })),
});

const branch = [message("user", "мой ход"), message("assistant", "ответ")];

/* ── Order and markers ───────────────────────────────────────────────────── */

test("blocks render in prompt_order, not in the order they are declared", () => {
  const built = buildPrompt({
    preset: preset(
      [
        block({ identifier: "a", content: "ПЕРВЫЙ" }),
        block({ identifier: "b", content: "ВТОРОЙ" }),
        block({ identifier: "chatHistory", marker: true }),
      ],
      ["b", "a", "chatHistory"],
    ),
    card: null,
    persona: null,
    branch,
  });
  assert.equal(built.system, "ВТОРОЙ\n\nПЕРВЫЙ");
});

test("a disabled block is left out", () => {
  const built = buildPrompt({
    preset: {
      ...preset([block({ identifier: "a", content: "ЕСТЬ" }), block({ identifier: "b", content: "НЕТ" })]),
      order: [
        { identifier: "a", enabled: true },
        { identifier: "b", enabled: false },
      ],
    },
    card: null,
    persona: null,
    branch: [],
  });
  assert.equal(built.system, "ЕСТЬ");
});

test("markers are filled from the card and the persona, macros resolved", () => {
  const built = buildPrompt({ preset: DEFAULT_PRESET, card, persona, branch });
  assert.match(built.system!, /Фишер — смотритель маяка\./);
  assert.match(built.system!, /Немногословен/);
  assert.match(built.system!, /Шторм/);
  assert.match(built.system!, /Аня — механик\./);
  assert.doesNotMatch(built.system!, /\{\{/);
});

test("an empty marker contributes nothing instead of a blank block", () => {
  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: { ...card, personality: "", scenario: "", mes_example: "" } as CardData,
    persona: null,
    branch,
  });
  assert.ok(!built.system!.includes("\n\n\n"));
  assert.deepEqual(
    built.parts.filter((p) => p.identifier === "charPersonality"),
    [],
  );
});

test("an unknown marker is skipped with a warning, not rendered raw", () => {
  const built = buildPrompt({
    preset: preset([block({ identifier: "chronicles", name: "Хроники", marker: true })]),
    card: null,
    persona: null,
    branch: [],
  });
  assert.equal(built.system, undefined);
  assert.match(built.warnings.join(" "), /Хроники/);
});

test("an order entry with no matching block warns instead of failing", () => {
  const built = buildPrompt({
    preset: preset([block({ identifier: "a", content: "ЕСТЬ" })], ["a", "нетТакого"]),
    card: null,
    persona: null,
    branch: [],
  });
  assert.equal(built.system, "ЕСТЬ");
  assert.match(built.warnings.join(" "), /нетТакого/);
});

/* ── Chat history placement ──────────────────────────────────────────────── */

test("chat history lands where chatHistory sits, not at the end", () => {
  const built = buildPrompt({
    preset: preset(
      [
        block({ identifier: "before", content: "ДО" }),
        block({ identifier: "chatHistory", marker: true }),
        block({ identifier: "after", role: "system", content: "ПОСЛЕ" }),
      ],
      ["before", "chatHistory", "after"],
    ),
    card: null,
    persona: null,
    branch,
  });

  assert.equal(built.system, "ДО");
  // The trailing system block follows the conversation as a user turn.
  assert.deepEqual(built.messages, [
    { role: "user", content: "мой ход" },
    { role: "assistant", content: "ответ" },
    { role: "user", content: "ПОСЛЕ" },
  ]);
});

test("a preset without chatHistory still carries the conversation", () => {
  const built = buildPrompt({
    preset: preset([block({ identifier: "a", content: "ТОЛЬКО БЛОК" })]),
    card: null,
    persona: null,
    branch,
  });
  assert.equal(built.messages.length, 2);
  assert.match(built.warnings.join(" "), /chatHistory/);
});

test("a branch opening on the greeting keeps it, behind the new-chat marker", () => {
  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: null,
    persona: null,
    branch: [message("assistant", "приветствие"), message("user", "ход")],
  });
  assert.deepEqual(built.messages, [
    { role: "user", content: "[Start a new Chat]" },
    { role: "assistant", content: "приветствие" },
    { role: "user", content: "ход" },
  ]);
});

/* ── Absolute injections ─────────────────────────────────────────────────── */

test("an absolute injection lands at its depth, counted from the end", () => {
  const long = [
    message("user", "1"),
    message("assistant", "2"),
    message("user", "3"),
    message("assistant", "4"),
  ];
  const built = buildPrompt({
    preset: preset([
      block({ identifier: "chatHistory", marker: true }),
      block({
        identifier: "jb",
        role: "system",
        content: "ИНЪЕКЦИЯ",
        injection_position: 1,
        injection_depth: 2,
      }),
    ]),
    card: null,
    persona: null,
    branch: long,
  });

  const injected = built.parts.findIndex((p) => p.identifier === "jb");
  assert.equal(built.parts[injected].injectedAt?.depth, 2);
  // Depth 2 means two messages remain after it.
  assert.deepEqual(
    built.parts.slice(injected + 1).map((p) => p.content),
    ["3", "4"],
  );
});

test("depth 0 puts the injection after the last message", () => {
  const built = buildPrompt({
    preset: preset([
      block({ identifier: "chatHistory", marker: true }),
      block({
        identifier: "jb",
        content: "ПОСЛЕДНИМ",
        injection_position: 1,
        injection_depth: 0,
      }),
    ]),
    card: null,
    persona: null,
    branch,
  });
  assert.equal(built.parts.at(-1)!.content, "ПОСЛЕДНИМ");
});

test("injections at one depth keep injection_order, ascending", () => {
  const built = buildPrompt({
    preset: preset([
      block({ identifier: "chatHistory", marker: true }),
      block({
        identifier: "second",
        content: "ВТОРАЯ",
        injection_position: 1,
        injection_depth: 0,
        injection_order: 200,
      }),
      block({
        identifier: "first",
        content: "ПЕРВАЯ",
        injection_position: 1,
        injection_depth: 0,
        injection_order: 50,
      }),
    ]),
    card: null,
    persona: null,
    branch,
  });
  assert.deepEqual(
    built.parts.slice(-2).map((p) => p.content),
    ["ПЕРВАЯ", "ВТОРАЯ"],
  );
});

/* ── Roles and squashing ─────────────────────────────────────────────────── */

test("adjacent system blocks squash into one system prompt", () => {
  const built = buildPrompt({
    preset: preset([
      block({ identifier: "a", content: "РАЗ" }),
      block({ identifier: "b", content: "ДВА" }),
      block({ identifier: "chatHistory", marker: true }),
    ]),
    card: null,
    persona: null,
    branch,
  });
  assert.equal(built.system, "РАЗ\n\nДВА");
});

test("adjacent user turns squash into one message", () => {
  const built = buildPrompt({
    preset: preset([
      block({ identifier: "a", role: "user", content: "РАЗ" }),
      block({ identifier: "b", role: "user", content: "ДВА" }),
      block({ identifier: "chatHistory", marker: true }),
    ]),
    card: null,
    persona: null,
    branch: [message("assistant", "ответ")],
  });
  assert.equal(built.messages[0].content, "РАЗ\n\nДВА");
  assert.equal(built.messages[1].role, "assistant");
});

test("a block with the user role ends the system prefix", () => {
  const built = buildPrompt({
    preset: preset([
      block({ identifier: "a", content: "СИСТЕМА" }),
      block({ identifier: "b", role: "user", content: "ХОД" }),
      block({ identifier: "c", content: "ПОЗЖЕ" }),
      block({ identifier: "chatHistory", marker: true }),
    ]),
    card: null,
    persona: null,
    branch: [],
  });
  assert.equal(built.system, "СИСТЕМА");
  // A system block after the conversation opened becomes a user turn.
  assert.deepEqual(built.messages, [{ role: "user", content: "ХОД\n\nПОЗЖЕ" }]);
});

test("the request never ends on the model's own turn", () => {
  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: null,
    persona: null,
    branch: [message("assistant", "приветствие")],
    extraUser: "Продолжай сцену.",
  });
  assert.equal(built.messages.at(-1)!.role, "user");
});

/* ── Variables span blocks ───────────────────────────────────────────────── */

test("a variable set in one block is readable in a later one", () => {
  const built = buildPrompt({
    preset: preset([
      block({ identifier: "a", content: "{{setvar::tone::мрачно}}начало" }),
      block({ identifier: "b", content: "тон: {{getvar::tone}}" }),
      block({ identifier: "chatHistory", marker: true }),
    ]),
    card: null,
    persona: null,
    branch: [],
  });
  assert.equal(built.system, "начало\n\nтон: мрачно");
});

/* ── Preset parsing ──────────────────────────────────────────────────────── */

test("a real preset shape parses: order, roles, depths, sampling", () => {
  const parsed = parsePreset(
    JSON.stringify({
      temperature: 1.1,
      top_p: 0.99,
      openai_max_tokens: 1200,
      new_chat_prompt: "[Новый чат]",
      prompts: [
        { identifier: "main", name: "Main", role: "system", content: "ГЛАВНЫЙ" },
        { identifier: "chatHistory", name: "Chat History", marker: true },
        {
          identifier: "jailbreak",
          name: "JB",
          role: "system",
          content: "ДЖБ",
          injection_position: 1,
          injection_depth: 3,
          injection_order: 42,
        },
      ],
      prompt_order: [
        { character_id: 100001, order: [
          { identifier: "main", enabled: true },
          { identifier: "chatHistory", enabled: true },
          { identifier: "jailbreak", enabled: false },
        ] },
      ],
    }),
    "файл",
  );

  assert.deepEqual(
    parsed.order.map((e) => [e.identifier, e.enabled]),
    [["main", true], ["chatHistory", true], ["jailbreak", false]],
  );
  assert.equal(parsed.maxTokens, 1200);
  assert.deepEqual(parsed.sampling, { temperature: 1.1, top_p: 0.99 });
  assert.equal(parsed.newChatPrompt, "[Новый чат]");

  const jb = parsed.prompts.find((p) => p.identifier === "jailbreak")!;
  assert.equal(jb.injection_position, 1);
  assert.equal(jb.injection_depth, 3);
  assert.equal(jb.injection_order, 42);
});

test("a preset with no prompt_order falls back to the declared order", () => {
  const parsed = parsePreset(
    JSON.stringify({ prompts: [{ identifier: "a" }, { identifier: "b" }] }),
    "файл",
  );
  assert.deepEqual(
    parsed.order.map((e) => e.identifier),
    ["a", "b"],
  );
});

test("something that is not a preset is refused", () => {
  assert.throws(() => parsePreset("не json", "ф"), /не JSON/i);
  assert.throws(() => parsePreset(JSON.stringify({ hello: 1 }), "ф"), /prompts/i);
});

test("a card's depth prompt is injected at its own depth", () => {
  // Real cards carry extensions.depth_prompt, and ST injects it into the chat
  // rather than into the system prefix.
  const withDepth = {
    ...card,
    extensions: { depth_prompt: { prompt: "ГОЛОС КАРТОЧКИ", depth: 1, role: "system" } },
  } as CardData;

  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: withDepth,
    persona: null,
    branch: [message("user", "раз"), message("assistant", "два"), message("user", "три")],
  });

  const at = built.parts.findIndex((p) => p.identifier === "charDepthPrompt");
  assert.notEqual(at, -1, "the depth prompt must reach the request");
  assert.equal(built.parts[at].injectedAt?.depth, 1);
  assert.deepEqual(
    built.parts.slice(at + 1).map((p) => p.content),
    ["три"],
  );
});

test("a card without a depth prompt injects nothing", () => {
  const built = buildPrompt({ preset: DEFAULT_PRESET, card, persona: null, branch });
  assert.deepEqual(
    built.parts.filter((p) => p.identifier === "charDepthPrompt"),
    [],
  );
});

test("an empty depth prompt is ignored rather than injected blank", () => {
  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: { ...card, extensions: { depth_prompt: { prompt: "   ", depth: 2 } } } as CardData,
    persona: null,
    branch,
  });
  assert.deepEqual(
    built.parts.filter((p) => p.identifier === "charDepthPrompt"),
    [],
  );
});

test("the built-in preset has somewhere to put lorebook entries", () => {
  // Without these slots a lorebook activates and then goes nowhere for any
  // chat that has no imported preset.
  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: null,
    persona: null,
    branch,
    lore: { before: "ДО КАРТОЧКИ", after: "ПОСЛЕ КАРТОЧКИ", depths: [], unsupported: [] },
  });
  assert.match(built.system!, /ДО КАРТОЧКИ/);
  assert.match(built.system!, /ПОСЛЕ КАРТОЧКИ/);
});

test("lore placed at a depth is injected into the chat, not the system prompt", () => {
  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: null,
    persona: null,
    branch: [message("user", "раз"), message("assistant", "два"), message("user", "три")],
    lore: {
      before: "",
      after: "",
      depths: [{ depth: 1, role: 0, content: "НА ГЛУБИНЕ", entries: ["НА ГЛУБИНЕ"] }],
      unsupported: [],
    },
  });

  const at = built.parts.findIndex((p) => p.identifier === "worldInfoDepth");
  assert.notEqual(at, -1);
  assert.equal(built.parts[at].injectedAt?.depth, 1);
  assert.deepEqual(
    built.parts.slice(at + 1).map((p) => p.content),
    ["три"],
  );
  assert.ok(!(built.system ?? "").includes("НА ГЛУБИНЕ"));
});

test("an unplaceable lorebook position is reported as a warning", () => {
  const built = buildPrompt({
    preset: DEFAULT_PRESET,
    card: null,
    persona: null,
    branch,
    lore: {
      before: "",
      after: "",
      depths: [],
      unsupported: [{ title: "заметка автора", position: 2 }],
    },
  });
  assert.match(built.warnings.join(" "), /заметка автора/);
});
