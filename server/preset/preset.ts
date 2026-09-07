/**
 * SillyTavern Chat Completion preset. We keep the imported JSON verbatim and
 * read the parts the builder needs — the field names are ST's, not ours.
 *
 * A preset is a pool of blocks (`prompts`) plus a render order per character
 * (`prompt_order`). Blocks with `marker: true` are placeholders that the
 * builder fills from the card, persona, examples or chat history.
 */

export type PromptRole = "system" | "user" | "assistant";

export interface PresetPrompt {
  identifier: string;
  name: string;
  role: PromptRole;
  content: string;
  marker: boolean;
  /** 0 — in prompt_order position; 1 — injected into the chat at a depth. */
  injection_position: 0 | 1;
  injection_depth: number;
  injection_order: number;
}

export interface PresetOrderEntry {
  identifier: string;
  enabled: boolean;
}

export interface Preset {
  name: string;
  prompts: PresetPrompt[];
  order: PresetOrderEntry[];
  maxTokens: number | null;
  /** Parsed but not sent: current Claude models reject sampling parameters. */
  sampling: Record<string, number>;
  newChatPrompt: string;
  newExampleChatPrompt: string;
  scenarioFormat: string;
  personalityFormat: string;
}

/** ST's placeholder character id for the order that applies to everyone. */
const DEFAULT_CHARACTER_ID = 100001;

const SAMPLING_FIELDS = [
  "temperature",
  "top_p",
  "top_k",
  "top_a",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "min_p",
] as const;

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function asRole(value: unknown): PromptRole {
  return value === "user" || value === "assistant" ? value : "system";
}

export function parsePreset(json: string, fallbackName: string): Preset {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Файл пресета — не JSON");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Файл пресета — не объект JSON");
  }

  const preset = raw as Record<string, unknown>;
  if (!Array.isArray(preset.prompts)) {
    throw new Error("Это не пресет Chat Completion: нет списка prompts");
  }

  const prompts: PresetPrompt[] = (preset.prompts as Record<string, unknown>[])
    .filter((prompt) => typeof prompt?.identifier === "string")
    .map((prompt) => ({
      identifier: prompt.identifier as string,
      name: text(prompt.name, prompt.identifier as string),
      role: asRole(prompt.role),
      content: text(prompt.content),
      marker: prompt.marker === true,
      injection_position: prompt.injection_position === 1 ? 1 : 0,
      injection_depth: number(prompt.injection_depth, 4),
      injection_order: number(prompt.injection_order, 100),
    }));

  return {
    name: text(preset.name, fallbackName),
    prompts,
    order: readOrder(preset),
    maxTokens:
      typeof preset.openai_max_tokens === "number"
        ? preset.openai_max_tokens
        : null,
    sampling: Object.fromEntries(
      SAMPLING_FIELDS.filter((field) => typeof preset[field] === "number").map(
        (field) => [field, preset[field] as number],
      ),
    ),
    newChatPrompt: text(preset.new_chat_prompt, "[Start a new Chat]"),
    newExampleChatPrompt: text(preset.new_example_chat_prompt, "[Example Chat]"),
    scenarioFormat: text(preset.scenario_format, "{{scenario}}"),
    personalityFormat: text(preset.personality_format, "{{personality}}"),
  };
}

/**
 * The render order. ST stores one per character plus a default under a
 * placeholder id; a preset exported without any order falls back to the
 * declared block order, which is what ST shows for a fresh preset.
 */
function readOrder(preset: Record<string, unknown>): PresetOrderEntry[] {
  const groups = Array.isArray(preset.prompt_order)
    ? (preset.prompt_order as Record<string, unknown>[])
    : [];

  const chosen =
    groups.find((group) => group.character_id === DEFAULT_CHARACTER_ID) ??
    groups.at(-1);

  const order = Array.isArray(chosen?.order)
    ? (chosen.order as Record<string, unknown>[])
    : null;

  if (!order) {
    return (preset.prompts as Record<string, unknown>[])
      .filter((prompt) => typeof prompt?.identifier === "string")
      .map((prompt) => ({
        identifier: prompt.identifier as string,
        enabled: true,
      }));
  }

  return order
    .filter((entry) => typeof entry?.identifier === "string")
    .map((entry) => ({
      identifier: entry.identifier as string,
      enabled: entry.enabled !== false,
    }));
}
