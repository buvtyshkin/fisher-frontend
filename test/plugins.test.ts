import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fisher-plugins-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "test-key";

const { runAfterResponse, runBeforePromptBuild, runOnMessageRender } = await import(
  "../server/plugins.ts"
);
import type { FisherPlugin } from "../server/plugins.ts";
import type { Message } from "../server/db.ts";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof runBeforePromptBuild>[0];

/** Replaces the loaded set for one test, then puts it back. */
async function withPlugins<T>(plugins: FisherPlugin[], run: () => Promise<T> | T) {
  const module = await import("../server/plugins.ts");
  const loaded = module.loadedPlugins();
  const original = [...loaded];
  loaded.length = 0;
  loaded.push(...plugins);
  try {
    return await run();
  } finally {
    loaded.length = 0;
    loaded.push(...original);
  }
}

const message = (content: string): Message => ({
  id: "m1",
  chat_id: "c",
  parent_id: null,
  role: "assistant",
  content,
  created_at: 1,
  model: null,
  input_tokens: null,
  output_tokens: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  cost_usd: null,
  hidden_from_prompt: 0,
});

test("beforePromptBuild can rewrite what is about to be sent", async () => {
  await withPlugins(
    [
      {
        name: "переписчик",
        beforePromptBuild(context) {
          context.system = "ПОДМЕНЁННЫЙ СИСТЕМНЫЙ";
          context.messages.push({ role: "user", content: "ДОБАВЛЕНО ПЛАГИНОМ" });
        },
      },
    ],
    async () => {
      const result = await runBeforePromptBuild(silentLog, {
        chatId: "c",
        branch: [],
        system: "исходный",
        messages: [{ role: "user", content: "ход" }],
      });
      assert.equal(result.system, "ПОДМЕНЁННЫЙ СИСТЕМНЫЙ");
      assert.equal(result.messages.at(-1)!.content, "ДОБАВЛЕНО ПЛАГИНОМ");
    },
  );
});

test("hooks run in order and every plugin gets a turn", async () => {
  const order: string[] = [];
  await withPlugins(
    [
      { name: "первый", beforePromptBuild: () => void order.push("первый") },
      { name: "второй", beforePromptBuild: () => void order.push("второй") },
    ],
    () =>
      runBeforePromptBuild(silentLog, {
        chatId: "c",
        branch: [],
        system: undefined,
        messages: [],
      }),
  );
  assert.deepEqual(order, ["первый", "второй"]);
});

test("a throwing plugin cannot take a generation down", async () => {
  const reached: string[] = [];
  await withPlugins(
    [
      {
        name: "падучий",
        beforePromptBuild() {
          throw new Error("сломался");
        },
      },
      { name: "следующий", beforePromptBuild: () => void reached.push("ok") },
    ],
    async () => {
      const result = await runBeforePromptBuild(silentLog, {
        chatId: "c",
        branch: [],
        system: "цел",
        messages: [],
      });
      assert.equal(result.system, "цел");
    },
  );
  assert.deepEqual(reached, ["ok"], "падение одного не мешает остальным");
});

test("afterResponse is awaited and receives the stored reply", async () => {
  const seen: string[] = [];
  await withPlugins(
    [
      {
        name: "хронист",
        async afterResponse(context) {
          await Promise.resolve();
          seen.push(context.text);
        },
      },
    ],
    () =>
      runAfterResponse(silentLog, {
        chatId: "c",
        message: message("ответ"),
        text: "ответ",
      }),
  );
  assert.deepEqual(seen, ["ответ"]);
});

test("onMessageRender transforms messages on their way to the UI", async () => {
  await withPlugins(
    [
      {
        name: "оформитель",
        onMessageRender: (m) => ({ ...m, content: `«${m.content}»` }),
      },
    ],
    () => {
      const rendered = runOnMessageRender(silentLog, [message("текст")]);
      assert.equal(rendered[0].content, "«текст»");
    },
  );
});

test("a throwing renderer leaves the message as it was", async () => {
  await withPlugins(
    [
      {
        name: "падучий",
        onMessageRender() {
          throw new Error("сломался");
        },
      },
    ],
    () => {
      const rendered = runOnMessageRender(silentLog, [message("цел")]);
      assert.equal(rendered[0].content, "цел");
    },
  );
});

test("with no plugins the messages come back untouched, same objects", async () => {
  await withPlugins([], () => {
    const input = [message("текст")];
    assert.equal(runOnMessageRender(silentLog, input), input);
  });
});

test("the bundled example plugin loads and its action returns text", async () => {
  const example = (await import("../plugins/example-stats.ts")).default;
  assert.equal(example.name, "example-stats");
  assert.ok(example.action, "у примера есть кнопка");

  const text = await example.action!.run({
    chatId: "c",
    branch: [
      { ...message("мой ход"), role: "user" },
      message("ответ модели тут"),
    ],
  });
  assert.match(text, /Сообщений в ветке: 2/);
  assert.match(text, /Скрыто из промпта: 0/);
});
