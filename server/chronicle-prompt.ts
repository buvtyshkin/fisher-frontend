import fs from "node:fs";
import path from "node:path";

const PROMPT_FILE = process.env.CHRONICLE_PROMPT_FILE
  ? path.resolve(process.env.CHRONICLE_PROMPT_FILE)
  : path.resolve(process.cwd(), "chronicle-prompt.md");

/** Roughly how long a summary of each level should be. */
export const CHRONICLE_LENGTH = { scene: 200, arc: 400, chapter: 700 } as const;

let cached: { mtimeMs: number; text: string } | null = null;

/**
 * The summarisation instruction, re-read whenever the file changes so it can be
 * edited by hand without restarting the server — the same deal as pricing.json.
 */
export function chroniclePrompt(level: keyof typeof CHRONICLE_LENGTH): string {
  let text = "";
  try {
    const { mtimeMs } = fs.statSync(PROMPT_FILE);
    if (cached?.mtimeMs !== mtimeMs) {
      cached = { mtimeMs, text: fs.readFileSync(PROMPT_FILE, "utf8") };
    }
    text = cached.text;
  } catch {
    text = cached?.text ?? "Составь сжатую хронику этого фрагмента истории.";
  }

  return text.replace(/\{\{length\}\}/g, String(CHRONICLE_LENGTH[level]));
}
