import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, parseMarkdown } from "../web/src/markdown.ts";

const text = (value: string) => ({ type: "text" as const, text: value });

test("bold and italic, including nesting", () => {
  assert.deepEqual(parseInline("*тихо*"), [
    { type: "italic", children: [text("тихо")] },
  ]);
  assert.deepEqual(parseInline("**громко**"), [
    { type: "bold", children: [text("громко")] },
  ]);
  assert.deepEqual(parseInline("**очень *тихо* громко**"), [
    {
      type: "bold",
      children: [
        text("очень "),
        { type: "italic", children: [text("тихо")] },
        text(" громко"),
      ],
    },
  ]);
});

test("underscores work as delimiters but not inside words", () => {
  assert.deepEqual(parseInline("_курсив_"), [
    { type: "italic", children: [text("курсив")] },
  ]);
  assert.deepEqual(parseInline("snake_case_name"), [text("snake_case_name")]);
});

test("lone and unclosed asterisks stay literal", () => {
  assert.deepEqual(parseInline("2 * 3 = 6"), [text("2 * 3 = 6")]);
  assert.deepEqual(parseInline("он начал *говорить"), [
    text("он начал *говорить"),
  ]);
});

test("blank lines split paragraphs, single newlines survive", () => {
  const blocks = parseMarkdown("первый\nабзац\n\nвторой");
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    type: "paragraph",
    children: [text("первый\nабзац")],
  });
  assert.deepEqual(blocks[1], { type: "paragraph", children: [text("второй")] });
});

test("consecutive > lines collapse into one quote", () => {
  const blocks = parseMarkdown("обычный\n\n> цитата\n> продолжение\n\nснова");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "quote", "paragraph"],
  );
  assert.deepEqual(blocks[1].children, [text("цитата\nпродолжение")]);
});

test("a quote directly after a paragraph still becomes its own block", () => {
  const blocks = parseMarkdown("речь\n> мысль");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "quote"],
  );
});

test("markup inside a quote is parsed too", () => {
  const [quote] = parseMarkdown("> он *ушёл*");
  assert.deepEqual(quote.children, [
    text("он "),
    { type: "italic", children: [text("ушёл")] },
  ]);
});

test("empty text yields no blocks", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("\n\n  \n"), []);
});
