/**
 * Character Card V1/V2/V3. We do not invent fields: the `data` object is the
 * spec's own, kept as imported. V1 cards are flat, so they get wrapped into a
 * `data` object; V2 and V3 already carry one.
 *
 * Spec: https://github.com/malfoyslastname/character-card-spec-v2
 *       https://github.com/kwaroran/character-card-spec-v3
 */

export type CardSpec = "chara_card_v1" | "chara_card_v2" | "chara_card_v3";

export interface CardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  // V2 additions
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings?: string[];
  character_book?: unknown;
  tags?: string[];
  creator?: string;
  character_version?: string;
  extensions?: Record<string, unknown>;
  // V3 additions
  nickname?: string;
  assets?: unknown[];
  group_only_greetings?: string[];
  source?: string[];
  [key: string]: unknown;
}

export interface ParsedCard {
  spec: CardSpec;
  data: CardData;
}

const asText = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asTextList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Accepts a V1, V2 or V3 card and returns it in one shape. Unknown fields are
 * carried through untouched so nothing is lost on export.
 */
export function parseCard(json: string): ParsedCard {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Файл карточки — не JSON");
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("Файл карточки — не объект JSON");
  }

  const card = raw as Record<string, unknown>;
  const spec = typeof card.spec === "string" ? card.spec : null;
  const inner =
    spec && card.data && typeof card.data === "object"
      ? (card.data as Record<string, unknown>)
      : card;

  const name = asText(inner.name);
  if (!name.trim()) {
    throw new Error("В карточке нет имени персонажа");
  }

  const data: CardData = {
    ...inner,
    name,
    description: asText(inner.description),
    personality: asText(inner.personality),
    scenario: asText(inner.scenario),
    first_mes: asText(inner.first_mes),
    mes_example: asText(inner.mes_example),
    alternate_greetings: asTextList(inner.alternate_greetings),
  };

  return {
    spec:
      spec === "chara_card_v3"
        ? "chara_card_v3"
        : spec === "chara_card_v2"
          ? "chara_card_v2"
          : "chara_card_v1",
    data,
  };
}

/** Every greeting the card offers: the first message, then the alternates. */
export function greetingsOf(data: CardData): string[] {
  return [data.first_mes, ...(data.alternate_greetings ?? [])]
    .map((greeting) => greeting.trim())
    .filter((greeting) => greeting.length > 0);
}

/**
 * The `{{char}}` / `{{user}}` substitution greetings need to read correctly.
 * The full macro engine arrives with the prompt builder in phase 3; this is
 * deliberately just the two names.
 */
export function applyNameMacros(
  text: string,
  names: { char: string; user: string },
): string {
  return text
    .replace(/\{\{char\}\}/gi, names.char)
    .replace(/\{\{user\}\}/gi, names.user);
}

/** Rebuilds a V2-shaped card for JSON export back into SillyTavern. */
export function toExportJson(card: ParsedCard): string {
  if (card.spec === "chara_card_v1") {
    const { name, description, personality, scenario, first_mes, mes_example } =
      card.data;
    return JSON.stringify(
      { name, description, personality, scenario, first_mes, mes_example },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      spec: card.spec,
      spec_version: card.spec === "chara_card_v3" ? "3.0" : "2.0",
      data: card.data,
    },
    null,
    2,
  );
}
