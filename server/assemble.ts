import {
  chatLorebooks,
  getChat,
  getCharacter,
  getPersona,
  getPreset,
} from "./store.js";
import type { Message } from "./db.js";
import type { CardData } from "./cards/card.js";
import { buildPrompt } from "./preset/build.js";
import { DEFAULT_PRESET } from "./preset/default.js";
import { parsePreset } from "./preset/preset.js";
import { parseLorebook } from "./lorebook/lorebook.js";
import { DEFAULT_WORLD_INFO_SETTINGS, keyScanEngine } from "./lorebook/engine.js";
import { placeEntries } from "./lorebook/placement.js";
import { applyCache, planCache } from "./preset/cache.js";
import { config } from "./config.js";

/**
 * Assembles the request for a chat: preset blocks, card, persona, lorebooks and
 * cache breakpoints. Lives outside the routes because the background cache
 * refresher has to build the very same request — a keep-alive whose prefix
 * differs by one byte pays for a fresh write instead of reading the cache.
 */

/** ~1024 tokens of Russian prose, the smallest prefix models will cache. */
const MIN_CACHEABLE_CHARS = 2500;

export const flatten = (system: string | { text: string }[] | undefined): string =>
  typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("");

/** Everything a chat is bound to: card, persona and preset. */
export function chatContext(chatId: string) {
  const chat = getChat(chatId);
  const character = chat?.character_id ? getCharacter(chat.character_id) : undefined;
  const persona = chat?.persona_id ? getPersona(chat.persona_id) : undefined;
  const presetRow = chat?.preset_id ? getPreset(chat.preset_id) : undefined;

  return {
    card: character ? (JSON.parse(character.data) as CardData) : null,
    persona: persona ?? null,
    preset: presetRow
      ? parsePreset(presetRow.data, presetRow.name)
      : DEFAULT_PRESET,
  };
}

/** Assembles the request for a branch through the preset engine. */
export function assemble(chatId: string, branch: Message[], extraUser?: string) {
  const { card, persona, preset } = chatContext(chatId);
  const { lore, activated } = scanLore(chatId, branch);
  const built = buildPrompt({ preset, card, persona, branch, extraUser, lore });

  const plan = planCache(built.messages, built.messageParts, config.cache);
  const cached = applyCache(built.system, built.messages, plan);

  // A prefix below the model's minimum is not cached and nothing says so —
  // the request just quietly costs full price. Warn on the rough estimate.
  if (plan.systemBreakpoint || plan.breakpoints.length > 0) {
    const cachedChars =
      flatten(built.system).length +
      built.messages
        .slice(0, (plan.breakpoints.at(-1) ?? -1) + 1)
        .reduce((sum, m) => sum + String(m.content).length, 0);
    if (cachedChars < MIN_CACHEABLE_CHARS) {
      plan.warnings.push(
        `Префикс под кэшем короткий (~${cachedChars} символов). Модели не кэшируют ` +
          `префикс меньше примерно 1024 токенов — запрос может пойти по полной цене.`,
      );
    }
  }

  return {
    ...built,
    system: cached.system,
    messages: cached.messages,
    warnings: [...built.warnings, ...plan.warnings],
    cache: plan,
    maxTokens: preset.maxTokens ?? undefined,
    activatedLore: activated,
  };
}

/** Runs every lorebook attached to the chat through the activation engine. */
function scanLore(chatId: string, branch: Message[]) {
  const entries = chatLorebooks(chatId).flatMap(
    (row) => parseLorebook(row.data, row.name).entries,
  );
  if (entries.length === 0) {
    return { lore: undefined, activated: [] as { title: string; reason: string }[] };
  }

  const activated = keyScanEngine.activate({
    entries,
    messages: branch.map((message) => message.content),
    settings: {
      ...DEFAULT_WORLD_INFO_SETTINGS,
      scanDepth: config.worldInfo.scanDepth,
      recursive: config.worldInfo.recursive,
      caseSensitive: config.worldInfo.caseSensitive,
      matchWholeWords: config.worldInfo.matchWholeWords,
    },
  });

  return {
    lore: placeEntries(activated),
    activated: activated.map(({ entry, reason }) => ({
      title: entry.comment,
      reason,
    })),
  };
}
