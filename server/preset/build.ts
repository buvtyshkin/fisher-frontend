import type Anthropic from "@anthropic-ai/sdk";
import type { CardData } from "../cards/card.js";
import type { Message, PersonaRow } from "../db.js";
import { applyMacros, createMacroContext } from "./macros.js";
import type { Preset, PresetPrompt, PromptRole } from "./preset.js";
import type { PlacedLore } from "../lorebook/placement.js";

/**
 * Reproduces SillyTavern's assembly order for a Chat Completion preset:
 * blocks in prompt_order, markers filled from the card and the branch,
 * absolute injections placed into the chat at their depth, then adjacent
 * same-role parts squashed.
 */

export interface BuildInput {
  preset: Preset;
  card: CardData | null;
  persona: PersonaRow | null;
  branch: Message[];
  /** Appended as a final user turn — the continue and next-beat nudges. */
  extraUser?: string;
  /** Chronicle text for {{summary}}; empty until phase 6. */
  summary?: string;
  /** Activated lorebook entries, already placed into their slots. */
  lore?: PlacedLore;
}

/** One assembled piece, kept separate so the debug screen can show its origin. */
export interface PromptPart {
  identifier: string;
  name: string;
  role: PromptRole;
  content: string;
  /** Set when the block was injected into the chat rather than ordered. */
  injectedAt?: { depth: number; order: number };
}

export interface BuiltPrompt {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
  /** Which parts each message was squashed from — the cache planner needs it
   *  to tell a stable message from one carrying a moving injection. */
  messageParts: PromptPart[][];
  parts: PromptPart[];
  warnings: string[];
  /** Enabled blocks that rendered to nothing — the first thing to check when
   *  a diff against SillyTavern comes up short. */
  emptyBlocks: { identifier: string; name: string }[];
}

export const DEFAULT_USER_NAME = "Пользователь";

/** Markers the builder fills itself; anything else marker-ish renders empty. */
const CHAT_HISTORY = "chatHistory";

export function buildPrompt(input: BuildInput): BuiltPrompt {
  const { preset, card, persona, branch } = input;
  const warnings: string[] = [];

  const macroContext = createMacroContext({
    char: card?.name ?? "",
    user: persona?.name?.trim() || DEFAULT_USER_NAME,
    description: card?.description ?? "",
    personality: card?.personality ?? "",
    scenario: card?.scenario ?? "",
    persona: persona?.description ?? "",
    mesExamplesRaw: card?.mes_example ?? "",
    summary: input.summary ?? "",
  });

  // Variables live for one build, so {{setvar}} in an early block is readable
  // by a later one — the same lifetime ST gives them.
  const variables = new Map<string, string>();
  const expand = (text: string, where: string): string => {
    const run = applyMacros(text, macroContext, variables);
    for (const warning of run.warnings) warnings.push(`${where}: ${warning}`);
    return run.text;
  };

  const byIdentifier = new Map(preset.prompts.map((p) => [p.identifier, p]));

  /** Content for ST's built-in placeholder blocks. */
  const markerContent = (prompt: PresetPrompt): string => {
    switch (prompt.identifier) {
      case "charDescription":
        return card?.description ?? "";
      case "charPersonality":
        return card?.personality ? preset.personalityFormat : "";
      case "scenario":
        return card?.scenario ? preset.scenarioFormat : "";
      case "personaDescription":
        return persona?.description ?? "";
      case "dialogueExamples":
        return card?.mes_example
          ? `${preset.newExampleChatPrompt}\n${card.mes_example}`
          : "";
      case "worldInfoBefore":
        return input.lore?.before ?? "";
      case "worldInfoAfter":
        return input.lore?.after ?? "";
      default:
        warnings.push(
          `Блок-маркер «${prompt.name}» (${prompt.identifier}) пока не поддерживается — пропущен`,
        );
        return "";
    }
  };

  const ordered: PromptPart[] = [];
  const injections: PresetPrompt[] = cardDepthPrompt(card);
  const emptyBlocks: { identifier: string; name: string }[] = [];
  let historyIndex = -1;

  for (const entry of preset.order) {
    if (!entry.enabled) continue;

    const prompt = byIdentifier.get(entry.identifier);
    if (!prompt) {
      warnings.push(`В пресете нет блока «${entry.identifier}» из prompt_order`);
      continue;
    }

    if (prompt.identifier === CHAT_HISTORY) {
      historyIndex = ordered.length;
      continue;
    }

    if (prompt.injection_position === 1) {
      injections.push(prompt);
      continue;
    }

    const content = expand(
      prompt.marker ? markerContent(prompt) : prompt.content,
      prompt.name,
    ).trim();
    if (content) {
      ordered.push({
        identifier: prompt.identifier,
        name: prompt.name,
        role: prompt.role,
        content,
      });
    } else {
      emptyBlocks.push({ identifier: prompt.identifier, name: prompt.name });
    }
  }

  // A preset without a chatHistory block still has to carry the conversation.
  if (historyIndex === -1) {
    warnings.push("В пресете нет блока chatHistory — история добавлена в конец");
    historyIndex = ordered.length;
  }

  for (const entry of input.lore?.unsupported ?? []) {
    warnings.push(
      `Запись лорбука «${entry.title}» с позицией ${entry.position} пропущена: такого слота пока нет`,
    );
  }

  const history = buildHistory(input, expand, injections);
  const parts = [
    ...ordered.slice(0, historyIndex),
    ...history,
    ...ordered.slice(historyIndex),
  ];

  openWithUserTurn(parts, preset.newChatPrompt);
  return { ...toAnthropic(parts), parts, warnings, emptyBlocks };
}

/**
 * SillyTavern injects a card's `extensions.depth_prompt` into the chat at its
 * own depth, the same mechanism as a preset block with injection_position 1 —
 * so it rides the same path here. Practically every real card carries one.
 */
function cardDepthPrompt(card: CardData | null): PresetPrompt[] {
  const extension = (card?.extensions as Record<string, unknown> | undefined)
    ?.depth_prompt as
    | { prompt?: unknown; depth?: unknown; role?: unknown }
    | undefined;

  const prompt = typeof extension?.prompt === "string" ? extension.prompt : "";
  if (!prompt.trim()) return [];

  return [
    {
      identifier: "charDepthPrompt",
      name: "Инструкция карточки (depth prompt)",
      role:
        extension?.role === "user" || extension?.role === "assistant"
          ? extension.role
          : "system",
      content: prompt,
      marker: false,
      injection_position: 1,
      injection_depth: typeof extension?.depth === "number" ? extension.depth : 4,
      injection_order: 100,
    },
  ];
}

/**
 * The API needs the first non-system turn to be the user's. When a chat opens
 * on the character's greeting — and no block precedes it — SillyTavern's
 * new-chat marker goes in front, so the greeting reaches the model instead of
 * being dropped.
 */
function openWithUserTurn(parts: PromptPart[], newChatPrompt: string): void {
  const first = parts.findIndex((part) => part.role !== "system");
  if (first === -1 || parts[first].role !== "assistant") return;

  parts.splice(first, 0, {
    identifier: "newChat",
    name: "Начало чата",
    role: "user",
    content: newChatPrompt,
  });
}

/**
 * The chat branch with absolute injections placed into it. Depth counts
 * messages from the end: depth 0 sits after the last message, depth 1 before
 * it. Several blocks at one depth keep injection_order, ascending, as in ST.
 */
function buildHistory(
  input: BuildInput,
  expand: (text: string, where: string) => string,
  injections: PresetPrompt[],
): PromptPart[] {
  const history: PromptPart[] = input.branch
    .filter((message) => message.role !== "system")
    .map((message) => ({
      identifier: CHAT_HISTORY,
      name: message.role === "assistant" ? "Ответ модели" : "Ход игрока",
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));

  if (input.extraUser) {
    history.push({
      identifier: "nudge",
      name: "Служебная инструкция",
      role: "user",
      content: input.extraUser,
    });
  }

  const loreAtDepth: PresetPrompt[] = (input.lore?.depths ?? []).map((group) => ({
    identifier: "worldInfoDepth",
    name: `Лорбук на глубине ${group.depth}`,
    role: group.role === 1 ? "user" : group.role === 2 ? "assistant" : "system",
    content: group.content,
    marker: false,
    injection_position: 1,
    injection_depth: group.depth,
    injection_order: 100,
  }));

  const sorted = [...injections, ...loreAtDepth].sort(
    (a, b) => a.injection_order - b.injection_order,
  );

  for (const prompt of sorted) {
    const content = expand(prompt.content, prompt.name).trim();
    if (!content) continue;

    const depth = Math.max(0, prompt.injection_depth);
    const at = Math.max(0, history.length - depth);
    history.splice(at, 0, {
      identifier: prompt.identifier,
      name: prompt.name,
      role: prompt.role,
      content,
      injectedAt: { depth, order: prompt.injection_order },
    });
  }

  return history;
}

/**
 * Splits the parts into the Anthropic shape: the leading run of system blocks
 * becomes `system`, the rest become messages. A system block that lands after
 * the conversation started becomes a user turn — the API takes no system role
 * inside the message list, and this is what ST sends to Claude.
 */
function toAnthropic(parts: PromptPart[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
  messageParts: PromptPart[][];
} {
  const firstNonSystem = parts.findIndex((part) => part.role !== "system");
  const head = firstNonSystem === -1 ? parts : parts.slice(0, firstNonSystem);
  const tail = firstNonSystem === -1 ? [] : parts.slice(firstNonSystem);

  const system = head.map((part) => part.content).join("\n\n").trim();

  const messages: Anthropic.MessageParam[] = [];
  const messageParts: PromptPart[][] = [];

  for (const part of tail) {
    const role = part.role === "assistant" ? "assistant" : "user";
    const last = messages.at(-1);
    if (last?.role === role) {
      last.content = `${last.content as string}\n\n${part.content}`;
      messageParts.at(-1)!.push(part);
    } else {
      messages.push({ role, content: part.content });
      messageParts.push([part]);
    }
  }

  return { system: system || undefined, messages, messageParts };
}
