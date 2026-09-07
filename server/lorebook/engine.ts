import { LOGIC, type LorebookEntry } from "./lorebook.js";

/**
 * Key-scanning activation, following SillyTavern 1.18's world-info.js.
 *
 * The engine is an interface so a smarter retriever — a cheap model deciding
 * what is relevant — can replace it later without touching the prompt builder.
 */

export interface WorldInfoSettings {
  /** How many recent messages are scanned. ST's world_info_depth, default 2. */
  scanDepth: number;
  /** ST's world_info_recursive, default false. */
  recursive: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  /** Injected so tests are deterministic; ST rolls a real die. */
  random?: () => number;
}

export const DEFAULT_WORLD_INFO_SETTINGS: WorldInfoSettings = {
  scanDepth: 2,
  recursive: false,
  caseSensitive: false,
  matchWholeWords: false,
};

export interface ScanInput {
  entries: LorebookEntry[];
  /** Message texts, oldest first — the branch as shown. */
  messages: string[];
  settings: WorldInfoSettings;
}

export interface ActivationReason {
  entry: LorebookEntry;
  /** Why it fired, for the debug screen. */
  reason: string;
}

export interface LorebookEngine {
  activate(input: ScanInput): ActivationReason[];
}

/**
 * ST separates messages in the scan buffer with a control character so a key
 * cannot match across a message boundary and so whole-word matching sees the
 * start of each message as a word boundary.
 */
const MATCHER = "\u0001";
const JOINER = `\n${MATCHER}`;

/** `/pattern/flags` keys are regexes in ST and override every other option. */
function asRegex(key: string): RegExp | null {
  const match = /^\/(.+)\/([gimsuy]*)$/s.exec(key.trim());
  if (!match) return null;
  try {
    return new RegExp(match[1], match[2].replace("g", ""));
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchKey(
  haystack: string,
  needle: string,
  entry: LorebookEntry,
  settings: WorldInfoSettings,
): boolean {
  const regex = asRegex(needle);
  if (regex) return regex.test(haystack);

  const caseSensitive = entry.caseSensitive ?? settings.caseSensitive;
  const text = caseSensitive ? haystack : haystack.toLowerCase();
  const key = caseSensitive ? needle : needle.toLowerCase();

  const wholeWords = entry.matchWholeWords ?? settings.matchWholeWords;
  if (!wholeWords) return text.includes(key);

  // ST only applies word boundaries to single-word keys.
  if (key.split(/\s+/).length > 1) return text.includes(key);
  return new RegExp(`(?:^|\\W)(${escapeRegex(key)})(?:$|\\W)`).test(text);
}

/** The last `depth` messages, newest first, in ST's buffer shape. */
function scanBuffer(messages: string[], depth: number): string {
  if (depth <= 0) return "";
  const newestFirst = [...messages].reverse().slice(0, depth);
  return MATCHER + newestFirst.join(JOINER);
}

function matchesSecondary(
  text: string,
  entry: LorebookEntry,
  settings: WorldInfoSettings,
): boolean {
  let anyMatch = false;
  let allMatch = true;

  for (const secondary of entry.keysecondary) {
    const hit = matchKey(text, secondary.trim(), entry, settings);
    if (hit) anyMatch = true;
    else allMatch = false;

    if (entry.selectiveLogic === LOGIC.AND_ANY && hit) return true;
    if (entry.selectiveLogic === LOGIC.NOT_ALL && !hit) return true;
  }

  if (entry.selectiveLogic === LOGIC.NOT_ANY && !anyMatch) return true;
  if (entry.selectiveLogic === LOGIC.AND_ALL && allMatch) return true;
  return false;
}

export const keyScanEngine: LorebookEngine = {
  activate({ entries, messages, settings }: ScanInput): ActivationReason[] {
    const roll = settings.random ?? Math.random;
    const activated = new Map<LorebookEntry, string>();
    const usable = entries.filter((entry) => !entry.disable && entry.content.trim());

    const passesProbability = (entry: LorebookEntry) =>
      !entry.useProbability ||
      entry.probability >= 100 ||
      roll() * 100 < entry.probability;

    for (const entry of usable) {
      if (entry.constant && passesProbability(entry)) {
        activated.set(entry, "constant");
      }
    }

    // Each pass scans the messages plus whatever earlier passes activated.
    const recursionText: string[] = [];
    let isRecursion = false;

    for (let pass = 0; pass < 32; pass++) {
      const buffer =
        scanBuffer(messages, settings.scanDepth) +
        (recursionText.length > 0 ? JOINER + recursionText.join(JOINER) : "");

      const fired: LorebookEntry[] = [];

      for (const entry of usable) {
        if (activated.has(entry) || entry.constant) continue;
        if (isRecursion && entry.excludeRecursion) continue;
        if (entry.key.length === 0) continue;

        const text =
          entry.scanDepth === null
            ? buffer
            : scanBuffer(messages, entry.scanDepth) +
              (recursionText.length > 0 ? JOINER + recursionText.join(JOINER) : "");

        const primary = entry.key.find((key) =>
          matchKey(text, key.trim(), entry, settings),
        );
        if (!primary) continue;

        if (entry.keysecondary.length > 0 && !matchesSecondary(text, entry, settings)) {
          continue;
        }
        if (!passesProbability(entry)) continue;

        fired.push(entry);
        activated.set(
          entry,
          isRecursion ? `рекурсия, ключ «${primary}»` : `ключ «${primary}»`,
        );
      }

      if (!settings.recursive) break;

      const feed = (pass === 0 ? [...activated.keys()] : fired).filter(
        (entry) => !entry.preventRecursion,
      );
      const before = recursionText.length;
      for (const entry of feed) recursionText.push(entry.content);
      if (recursionText.length === before) break;

      isRecursion = true;
    }

    return [...activated.entries()].map(([entry, reason]) => ({ entry, reason }));
  },
};
