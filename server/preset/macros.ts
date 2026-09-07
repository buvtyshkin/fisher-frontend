/**
 * The macro subset from the spec. Anything unknown becomes an empty string and
 * a warning — a macro must never be able to break a generation.
 */

export interface MacroContext {
  char: string;
  user: string;
  description: string;
  personality: string;
  scenario: string;
  persona: string;
  mesExamplesRaw: string;
  /** Chronicle text; stays empty until phase 6. */
  summary: string;
  /** Group members; a single character for now. */
  group: string;
}

export interface MacroRun {
  text: string;
  warnings: string[];
  /** Variables after the pass, so a later block can read what an earlier set. */
  variables: Map<string, string>;
}

const MACRO_PATTERN = /\{\{([^{}]*)\}\}/g;

// {{trim}} eats the whitespace around itself, which needs a second pass. The
// sentinel is a private-use codepoint, so a prompt that merely contains the
// word "trim" is left alone.
const TRIM_SENTINEL = "\uE000";
const TRIM_PATTERN = /\s*\uE000\s*/g;

export function createMacroContext(
  partial: Partial<MacroContext> = {},
): MacroContext {
  return {
    char: "",
    user: "",
    description: "",
    personality: "",
    scenario: "",
    persona: "",
    mesExamplesRaw: "",
    summary: "",
    group: "",
    ...partial,
  };
}

/**
 * Expands macros left to right, so `{{setvar::x::1}}` is visible to a later
 * `{{getvar::x}}`. Variables carry across blocks via `variables`.
 */
export function applyMacros(
  text: string,
  context: MacroContext,
  variables = new Map<string, string>(),
): MacroRun {
  const warnings: string[] = [];

  const simple: Record<string, () => string> = {
    user: () => context.user,
    char: () => context.char,
    group: () => context.group || context.char,
    description: () => context.description,
    personality: () => context.personality,
    scenario: () => context.scenario,
    persona: () => context.persona,
    mesexamplesraw: () => context.mesExamplesRaw,
    summary: () => context.summary,
  };

  const expanded = text.replace(MACRO_PATTERN, (_match, body: string) => {
    const raw = body.trim();
    const lower = raw.toLowerCase();

    if (lower.startsWith("//")) return ""; // {{// комментарий}}
    if (lower === "trim") return TRIM_SENTINEL;

    const setvar = /^setvar::([^:]+)::([\s\S]*)$/i.exec(raw);
    if (setvar) {
      variables.set(setvar[1].trim(), setvar[2]);
      return "";
    }

    const getvar = /^getvar::([\s\S]+)$/i.exec(raw);
    if (getvar) return variables.get(getvar[1].trim()) ?? "";

    const known = simple[lower];
    if (known) return known();

    warnings.push(`Неизвестный макрос {{${raw}}} — подставлена пустая строка`);
    return "";
  });

  return {
    text: expanded.replace(TRIM_PATTERN, ""),
    warnings,
    variables,
  };
}
