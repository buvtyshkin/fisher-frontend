import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { applyCache, planCache, type CacheSettings } from "../server/preset/cache.ts";
import type { PromptPart } from "../server/preset/build.ts";

const settings = (over: Partial<CacheSettings> = {}): CacheSettings => ({
  depth: 2,
  system: true,
  ttl: "5m",
  ...over,
});

const part = (over: Partial<PromptPart> = {}): PromptPart => ({
  identifier: "chatHistory",
  name: "Ход",
  role: "user",
  content: "текст",
  ...over,
});

/** A plain alternating conversation of `n` messages, user first. */
function conversation(n: number) {
  const messages: Anthropic.MessageParam[] = [];
  const parts: PromptPart[][] = [];
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    messages.push({ role, content: `m${i}` });
    parts.push([part({ role })]);
  }
  return { messages, parts };
}

/* ── Placement ───────────────────────────────────────────────────────────── */

test("two breakpoints go in, counted by role changes as in SillyTavern", () => {
  const { messages, parts } = conversation(9);
  const plan = planCache(messages, parts, settings({ depth: 2 }));

  assert.equal(plan.breakpoints.length, 2);
  // Depth counts role changes from the end. In an alternating chat of 9,
  // depth 2 lands on index 6 and depth 4 on index 4 — two turns apart, which
  // is what makes the pair roll as the chat grows.
  assert.deepEqual(plan.breakpoints, [4, 6]);
});

test("a trailing assistant turn is skipped before counting", () => {
  const { messages, parts } = conversation(8); // ends on assistant
  const plan = planCache(messages, parts, settings({ depth: 0 }));
  // Depth 0 must land on the last user message, not the assistant after it.
  assert.equal(messages[Math.max(...plan.breakpoints)].role, "user");
});

test("depth -1 turns message caching off but keeps the system prefix", () => {
  const { messages, parts } = conversation(6);
  const plan = planCache(messages, parts, settings({ depth: -1 }));
  assert.deepEqual(plan.breakpoints, []);
  assert.equal(plan.systemBreakpoint, true);
});

test("an empty conversation yields no message breakpoints", () => {
  assert.deepEqual(planCache([], [], settings()).breakpoints, []);
});

/* ── The invariant: nothing that moves may sit inside a cached prefix ────── */

test("a breakpoint is moved back behind an injection that slides each turn", () => {
  const { messages, parts } = conversation(9);
  // A card depth prompt at depth 4 lands well before the default breakpoint.
  parts[5] = [part({ name: "Инструкция карточки", injectedAt: { depth: 4, order: 100 } })];

  const plan = planCache(messages, parts, settings({ depth: 2 }));
  assert.ok(
    Math.max(...plan.breakpoints) < 5,
    "точка должна оказаться до сдвигающейся инъекции",
  );
  assert.match(plan.warnings.join(" "), /сдвинута/);
  assert.match(plan.warnings.join(" "), /Инструкция карточки/);
});

test("an injection after the breakpoint is fine and warns about nothing", () => {
  const { messages, parts } = conversation(9);
  parts[8] = [part({ name: "Границы", injectedAt: { depth: 0, order: 100 } })];

  const plan = planCache(messages, parts, settings({ depth: 2 }));
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.breakpoints, [4, 6]);
});

test("an injection at the very start disables message caching outright", () => {
  const { messages, parts } = conversation(6);
  parts[0] = [part({ name: "Глубокая", injectedAt: { depth: 6, order: 100 } })];

  const plan = planCache(messages, parts, settings({ depth: 2 }));
  assert.deepEqual(plan.breakpoints, []);
  assert.match(plan.warnings.join(" "), /выключен/);
});

test("the effective depth is reported in messages from the end", () => {
  const { messages, parts } = conversation(9);
  const plan = planCache(messages, parts, settings({ depth: 2 }));
  assert.equal(plan.effectiveFromEnd, messages.length - 1 - 6, "две реплики от конца");
});

/* ── Applying the plan ───────────────────────────────────────────────────── */

test("cache_control lands on the planned messages and nowhere else", () => {
  const { messages, parts } = conversation(9);
  const plan = planCache(messages, parts, settings());
  const applied = applyCache("СИСТЕМА", messages, plan);

  applied.messages.forEach((message, index) => {
    const marked =
      Array.isArray(message.content) &&
      (message.content[0] as { cache_control?: unknown }).cache_control !== undefined;
    assert.equal(marked, plan.breakpoints.includes(index), `сообщение ${index}`);
  });
});

test("the system prompt becomes a cached block, with the chosen TTL", () => {
  const { messages, parts } = conversation(4);
  const plan = planCache(messages, parts, settings({ ttl: "1h" }));
  const applied = applyCache("СИСТЕМА", messages, plan);

  assert.deepEqual(applied.system, [
    { type: "text", text: "СИСТЕМА", cache_control: { type: "ephemeral", ttl: "1h" } },
  ]);
});

test("without system caching the system prompt stays a plain string", () => {
  const { messages, parts } = conversation(4);
  const plan = planCache(messages, parts, settings({ system: false }));
  assert.equal(applyCache("СИСТЕМА", messages, plan).system, "СИСТЕМА");
});

test("message text survives the rewrite untouched", () => {
  const { messages, parts } = conversation(9);
  const plan = planCache(messages, parts, settings());
  const applied = applyCache(undefined, messages, plan);

  applied.messages.forEach((message, index) => {
    const text = Array.isArray(message.content)
      ? (message.content[0] as { text: string }).text
      : (message.content as string);
    assert.equal(text, `m${index}`);
  });
});

/* ── The prefix has to actually repeat ───────────────────────────────────── */

test("the cached prefix is byte-identical after two more turns", () => {
  // What the criterion really asks: the second request must be able to read
  // the cache, which only happens if everything up to the breakpoint repeats.
  const first = conversation(9);
  first.parts[8] = [part({ name: "Границы", injectedAt: { depth: 0, order: 100 } })];
  const firstPlan = planCache(first.messages, first.parts, settings());

  const second = conversation(11);
  second.parts[10] = [part({ name: "Границы", injectedAt: { depth: 0, order: 100 } })];
  const secondPlan = planCache(second.messages, second.parts, settings());

  const prefix = (messages: Anthropic.MessageParam[], upTo: number) =>
    JSON.stringify(messages.slice(0, upTo + 1));

  const shared = Math.max(...firstPlan.breakpoints);
  assert.ok(
    prefix(second.messages, shared) === prefix(first.messages, shared),
    "префикс до точки кэширования должен повториться дословно",
  );
  assert.ok(Math.max(...secondPlan.breakpoints) > shared, "точка сдвигается вперёд");
});

/* ── Keep-alive accounting ───────────────────────────────────────────────── */

test("a keep-alive is recorded and folded into the totals", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-warm-"));
  process.env.DATA_DIR = tmp;
  process.env.ANTHROPIC_API_KEY = "test-key";

  const { recordCacheRefresh, startOfToday, usageSince } = await import(
    "../server/store.ts"
  );

  const before = usageSince(startOfToday());
  recordCacheRefresh({
    chatId: "c",
    model: "claude-opus-5",
    // A pure cache read: 1M tokens at $0.50 per million.
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 1_000_000 },
  });

  const after = usageSince(startOfToday());
  assert.equal(after.refreshes, before.refreshes + 1);
  assert.ok(Math.abs(after.refreshCost - (before.refreshCost + 0.5)) < 1e-9);
  assert.ok(
    Math.abs(after.cost - (before.cost + 0.5)) < 1e-9,
    "прогрев должен входить в общую сумму, а не теряться",
  );
  assert.equal(after.cacheRead, before.cacheRead + 1_000_000);
});
