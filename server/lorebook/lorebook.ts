/**
 * SillyTavern World Info. Field names are ST's; the imported JSON is kept
 * verbatim so export returns exactly what was imported.
 *
 * Semantics below follow SillyTavern 1.18's public/scripts/world-info.js.
 */

/** ST world_info_position. */
export const POSITION = {
  before: 0,
  after: 1,
  anTop: 2,
  anBottom: 3,
  atDepth: 4,
  emTop: 5,
  emBottom: 6,
  outlet: 7,
} as const;

/** ST world_info_logic for secondary keys. */
export const LOGIC = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
} as const;

export interface LorebookEntry {
  uid: number;
  /** ST's "comment": the human-readable title of the entry. */
  comment: string;
  key: string[];
  keysecondary: string[];
  content: string;
  constant: boolean;
  disable: boolean;
  selectiveLogic: number;
  order: number;
  position: number;
  depth: number;
  /** 0 system, 1 user, 2 assistant — only meaningful at position atDepth. */
  role: number | null;
  probability: number;
  useProbability: boolean;
  /** Not activated during a recursion pass. */
  excludeRecursion: boolean;
  /** Its content never triggers other entries. */
  preventRecursion: boolean;
  /** null means "use the global setting". */
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  scanDepth: number | null;
}

export interface Lorebook {
  name: string;
  entries: LorebookEntry[];
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const flag = (value: unknown): boolean => value === true;

const nullableFlag = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];

/**
 * Reads a World Info file. ST stores entries as an object keyed by index; the
 * `character_book` inside a V2/V3 card stores them as an array with slightly
 * different field names, and both are accepted.
 */
export function parseLorebook(json: string, fallbackName: string): Lorebook {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Файл лорбука — не JSON");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Файл лорбука — не объект JSON");
  }

  const book = raw as Record<string, unknown>;
  const rawEntries = book.entries;

  const list: Record<string, unknown>[] = Array.isArray(rawEntries)
    ? (rawEntries as Record<string, unknown>[])
    : rawEntries && typeof rawEntries === "object"
      ? Object.values(rawEntries as Record<string, Record<string, unknown>>)
      : [];

  if (list.length === 0) {
    throw new Error("Это не World Info: нет записей");
  }

  return {
    name: text(book.name, fallbackName),
    entries: list.map(readEntry),
  };
}

function readEntry(entry: Record<string, unknown>, index: number): LorebookEntry {
  // A card's character_book uses the spec's names; a World Info file uses ST's.
  const extensions = (entry.extensions ?? {}) as Record<string, unknown>;
  const position =
    typeof entry.position === "number"
      ? entry.position
      : entry.position === "after_char"
        ? POSITION.after
        : entry.position === "before_char"
          ? POSITION.before
          : number(extensions.position, POSITION.before);

  return {
    uid: number(entry.uid, index),
    comment: text(entry.comment) || text(entry.name) || `Запись ${index + 1}`,
    key: stringList(entry.key ?? entry.keys),
    keysecondary: stringList(entry.keysecondary ?? entry.secondary_keys),
    content: text(entry.content),
    constant: flag(entry.constant),
    disable: entry.enabled === false ? true : flag(entry.disable),
    selectiveLogic: number(entry.selectiveLogic, LOGIC.AND_ANY),
    order: number(entry.order ?? entry.insertion_order, 100),
    position,
    depth: number(entry.depth ?? extensions.depth, 4),
    role:
      typeof entry.role === "number"
        ? entry.role
        : typeof extensions.role === "number"
          ? (extensions.role as number)
          : null,
    probability: number(entry.probability ?? extensions.probability, 100),
    useProbability: entry.useProbability !== false,
    excludeRecursion: flag(entry.excludeRecursion ?? extensions.exclude_recursion),
    preventRecursion: flag(entry.preventRecursion ?? extensions.prevent_recursion),
    caseSensitive: nullableFlag(entry.caseSensitive ?? extensions.case_sensitive),
    matchWholeWords: nullableFlag(
      entry.matchWholeWords ?? extensions.match_whole_words,
    ),
    scanDepth:
      typeof entry.scanDepth === "number" ? entry.scanDepth : null,
  };
}
