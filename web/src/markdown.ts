/**
 * A deliberately small markdown subset for literary prose: *italic*, **bold**
 * and `>` blockquotes. Parsing is separate from rendering so it can be tested,
 * and the renderer builds React elements rather than HTML — nothing a model
 * writes can turn into markup.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "quote"; children: Inline[] };

// Order matters: ** is tried before * at the same position. Underscore
// delimiters must sit on a word boundary so snake_case survives untouched.
const INLINE_PATTERN = new RegExp(
  [
    "(?<bold1>\\*\\*)(?=\\S)(?<boldText1>[\\s\\S]*?\\S)\\*\\*",
    "(?<italic1>\\*)(?=\\S)(?<italicText1>[\\s\\S]*?\\S)\\*",
    "(?<![\\p{L}\\p{N}])(?<bold2>__)(?=\\S)(?<boldText2>[\\s\\S]*?\\S)__(?![\\p{L}\\p{N}])",
    "(?<![\\p{L}\\p{N}])(?<italic2>_)(?=\\S)(?<italicText2>[\\s\\S]*?\\S)_(?![\\p{L}\\p{N}])",
  ].join("|"),
  "u",
);

export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let rest = text;

  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match?.groups) {
      nodes.push({ type: "text", text: rest });
      break;
    }

    if (match.index > 0) {
      nodes.push({ type: "text", text: rest.slice(0, match.index) });
    }

    const { groups } = match;
    const boldText = groups.boldText1 ?? groups.boldText2;
    const italicText = groups.italicText1 ?? groups.italicText2;

    if (boldText !== undefined) {
      nodes.push({ type: "bold", children: parseInline(boldText) });
    } else {
      nodes.push({ type: "italic", children: parseInline(italicText!) });
    }

    rest = rest.slice(match.index + match[0].length);
  }

  return nodes;
}

const QUOTE_LINE = /^\s*>\s?(.*)$/;

/**
 * Splits text into blocks. A blank line ends a block; runs of `>` lines
 * collapse into one quote. Single newlines stay inside a block — the renderer
 * keeps them via `white-space: pre-wrap`.
 */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let quoting = false;

  const flush = () => {
    if (buffer.length === 0) return;
    blocks.push({
      type: quoting ? "quote" : "paragraph",
      children: parseInline(buffer.join("\n")),
    });
    buffer = [];
  };

  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      flush();
      continue;
    }

    const quoted = QUOTE_LINE.exec(line);
    if (Boolean(quoted) !== quoting) {
      flush();
      quoting = Boolean(quoted);
    }
    buffer.push(quoted ? quoted[1] : line);
  }

  flush();
  return blocks;
}
