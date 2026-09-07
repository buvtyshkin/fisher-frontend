import type { Preset, PresetPrompt } from "./preset.js";

/**
 * The preset used when a chat has none. It is a real preset, not a special
 * code path, so there is exactly one assembly engine to reason about — and
 * importing a preset from SillyTavern simply replaces it.
 */
const marker = (identifier: string, name: string): PresetPrompt => ({
  identifier,
  name,
  role: "system",
  content: "",
  marker: true,
  injection_position: 0,
  injection_depth: 4,
  injection_order: 100,
});

const prompts: PresetPrompt[] = [
  marker("worldInfoBefore", "Лорбук (до карточки)"),
  marker("chronicle", "Хроники"),
  marker("charDescription", "Описание персонажа"),
  marker("charPersonality", "Характер"),
  marker("scenario", "Сцена"),
  marker("personaDescription", "Персона игрока"),
  marker("worldInfoAfter", "Лорбук (после карточки)"),
  marker("dialogueExamples", "Примеры реплик"),
  {
    identifier: "chatHistory",
    name: "История чата",
    role: "system",
    content: "",
    marker: true,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
  },
];

export const DEFAULT_PRESET: Preset = {
  name: "Без пресета",
  prompts,
  order: prompts.map((prompt) => ({
    identifier: prompt.identifier,
    enabled: true,
  })),
  maxTokens: null,
  sampling: {},
  newChatPrompt: "[Start a new Chat]",
  newExampleChatPrompt: "[Example Chat]",
  scenarioFormat: "{{scenario}}",
  personalityFormat: "{{personality}}",
};
