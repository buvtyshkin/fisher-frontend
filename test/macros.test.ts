import assert from "node:assert/strict";
import test from "node:test";
import { applyMacros, createMacroContext } from "../server/preset/macros.ts";

const context = createMacroContext({
  char: "Фишер",
  user: "Аня",
  description: "Смотритель маяка",
  personality: "Немногословен",
  scenario: "Шторм",
  persona: "Механик",
  mesExamplesRaw: "<START>\nПример.",
  summary: "Было темно.",
});

const run = (text: string, variables?: Map<string, string>) =>
  applyMacros(text, context, variables);

test("the name and card macros expand", () => {
  assert.equal(
    run("{{char}} и {{user}}: {{description}} / {{personality}} / {{scenario}}").text,
    "Фишер и Аня: Смотритель маяка / Немногословен / Шторм",
  );
  assert.equal(run("{{persona}}").text, "Механик");
  assert.equal(run("{{mesExamplesRaw}}").text, "<START>\nПример.");
  assert.equal(run("{{summary}}").text, "Было темно.");
});

test("macro names are case-insensitive and tolerate spaces", () => {
  assert.equal(run("{{CHAR}} {{ user }} {{Description}}").text, "Фишер Аня Смотритель маяка");
});

test("{{group}} falls back to the character when there is no group", () => {
  assert.equal(run("{{group}}").text, "Фишер");
  assert.equal(
    applyMacros("{{group}}", createMacroContext({ char: "Ф", group: "А и Б" })).text,
    "А и Б",
  );
});

test("comments disappear entirely", () => {
  assert.equal(run("до{{// это заметка}}после").text, "допосле");
  assert.equal(run("{{//}}").text, "");
});

test("variables are set, read, and survive across blocks", () => {
  const variables = new Map<string, string>();
  assert.equal(run("{{setvar::mood::мрачно}}", variables).text, "");
  assert.equal(variables.get("mood"), "мрачно");
  // A later block reads what an earlier one set.
  assert.equal(run("настроение: {{getvar::mood}}", variables).text, "настроение: мрачно");
});

test("an unset variable is empty, not an error", () => {
  assert.equal(run("[{{getvar::нет}}]").text, "[]");
});

test("{{trim}} removes the whitespace around itself", () => {
  assert.equal(run("первая\n\n{{trim}}\n\nвторая").text, "перваявторая");
  assert.equal(run("а {{trim}} б").text, "аб");
  // A prompt that merely contains the word must not be touched.
  assert.equal(run("trim и trimmed").text, "trim и trimmed");
});

test("an unknown macro yields an empty string and a warning", () => {
  const result = run("до{{неведомый}}после");
  assert.equal(result.text, "допосле");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /неведомый/);
});

test("text without macros is returned untouched", () => {
  assert.equal(run("Обычный текст с { одной } скобкой.").text, "Обычный текст с { одной } скобкой.");
  assert.deepEqual(run("Обычный текст.").warnings, []);
});
