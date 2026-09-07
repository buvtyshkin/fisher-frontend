import { applyNameMacros, type CardData } from "./cards/card.js";
import type { PersonaRow } from "./db.js";

export const DEFAULT_USER_NAME = "Пользователь";

/**
 * A deliberately plain system prompt assembled from the card and the persona.
 * Phase 3 replaces this entirely with the SillyTavern preset engine — block
 * order, injection depths and the full macro set. Until then this is just
 * enough for a card to actually play.
 */
export function buildSystemPrompt(
  card: CardData | null,
  persona: PersonaRow | null,
): string | undefined {
  if (!card) return undefined;

  const names = {
    char: card.name,
    user: persona?.name?.trim() || DEFAULT_USER_NAME,
  };

  const sections: string[] = [];
  const add = (label: string, value: string | undefined) => {
    const text = applyNameMacros((value ?? "").trim(), names);
    if (text) sections.push(`${label}\n${text}`);
  };

  // A card's own system_prompt overrides nothing here yet; it simply leads.
  add("# Инструкция", card.system_prompt as string | undefined);
  add(`# ${names.char}`, card.description);
  add("# Характер", card.personality);
  add("# Сцена", card.scenario);
  add("# Примеры реплик", card.mes_example);

  if (persona?.description?.trim()) {
    add(`# ${names.user}`, persona.description);
  } else if (persona?.name?.trim()) {
    sections.push(`# ${names.user}\nСобеседника зовут ${names.user}.`);
  }

  add("# После истории", card.post_history_instructions as string | undefined);

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
