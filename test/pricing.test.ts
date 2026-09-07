import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-price-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "test-key";

const { costOf, loadPricing } = await import("../server/pricing.ts");
const { appendMessage, createChat, startOfToday, usageSince } = await import(
  "../server/store.ts"
);

test("every model in pricing.json has all four rates", () => {
  const models = loadPricing();
  assert.ok(Object.keys(models).length > 0, "pricing.json is empty");
  for (const [name, price] of Object.entries(models)) {
    for (const field of ["input", "output", "cache_write", "cache_read"]) {
      const value = (price as Record<string, number>)[field];
      assert.equal(typeof value, "number", `${name}.${field} must be a number`);
      assert.ok(value >= 0, `${name}.${field} must not be negative`);
    }
  }
});

test("cost is summed per token type at the model's own rates", () => {
  // claude-opus-5: 5 / 25 / 6.25 / 0.50 per million.
  const cost = costOf("claude-opus-5", {
    input: 1_000_000,
    output: 1_000_000,
    cacheWrite: 1_000_000,
    cacheRead: 1_000_000,
  });
  assert.equal(cost, 5 + 25 + 6.25 + 0.5);
});

test("a realistic reply costs cents, not dollars", () => {
  const cost = costOf("claude-opus-5", {
    input: 2_000,
    output: 1_200,
    cacheWrite: 0,
    cacheRead: 40_000,
  })!;
  // 0.01 + 0.03 + 0.02
  assert.ok(Math.abs(cost - 0.06) < 1e-9, `unexpected cost ${cost}`);
});

test("an unknown model has no cost rather than a wrong one", () => {
  assert.equal(
    costOf("some-future-model", { input: 100, output: 100, cacheWrite: 0, cacheRead: 0 }),
    null,
  );
  assert.equal(costOf(null, { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }), null);
});

test("usage totals cover assistant replies only, and flag unpriced models", () => {
  const chat = createChat("Деньги");
  const user = appendMessage({
    chatId: chat.id,
    parentId: null,
    role: "user",
    content: "ход",
  });
  appendMessage({
    chatId: chat.id,
    parentId: user.id,
    role: "assistant",
    content: "ответ",
    model: "claude-opus-5",
    usage: { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 },
  });
  appendMessage({
    chatId: chat.id,
    parentId: user.id,
    role: "assistant",
    content: "ещё",
    model: "some-future-model",
    usage: { input: 500, output: 500, cacheWrite: 0, cacheRead: 0 },
  });

  const bucket = usageSince(startOfToday());
  assert.equal(bucket.replies, 2, "the user message must not be counted");
  assert.equal(bucket.input, 1_000_500);
  assert.equal(bucket.cost, 5, "the unpriced model must not distort the total");
  assert.deepEqual(bucket.unpricedModels, ["some-future-model"]);
});

test("a period that ends before the messages is empty", () => {
  const future = usageSince(Date.now() + 60_000);
  assert.equal(future.replies, 0);
  assert.equal(future.cost, 0);
});
