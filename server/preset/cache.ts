import type Anthropic from "@anthropic-ai/sdk";
import type { PromptPart } from "./build.js";

/**
 * Prompt cache breakpoints.
 *
 * Placement follows SillyTavern's `cachingAtDepthForClaude`: depth is counted
 * in *role changes* from the end, skipping trailing assistant turns, and two
 * breakpoints go in — at `depth` and at `depth + 2`. The pair rolls: the deeper
 * one stays valid for several turns while the shallower one picks up the newer
 * text.
 *
 * On top of ST we enforce the invariant from the spec: nothing that moves every
 * turn may sit inside a cached prefix. An injected block sits at a fixed depth
 * from the end, so it slides through the message list as the chat grows — if a
 * breakpoint were placed after it, the prefix would change on every single turn
 * and the cache would never be read. The breakpoint is moved back until every
 * injection is outside the cached prefix, and the move is reported rather than
 * done quietly.
 */

export type CacheTtl = "5m" | "1h";

export interface CacheSettings {
  /** Role-change depth, as in ST. -1 turns message caching off. */
  depth: number;
  /** Cache the system prompt as its own prefix. */
  system: boolean;
  ttl: CacheTtl;
}

export interface CachePlan {
  /** Indices into `messages` that carry a breakpoint. */
  breakpoints: number[];
  systemBreakpoint: boolean;
  requestedDepth: number;
  /** The shallowest breakpoint actually used, in messages from the end. */
  effectiveFromEnd: number | null;
  ttl: CacheTtl;
  warnings: string[];
}

/** ST's algorithm: count role changes from the end, skipping the prefill tail. */
function stBreakpoints(
  messages: Anthropic.MessageParam[],
  cachingAtDepth: number,
): number[] {
  const found: number[] = [];
  let passedThePrefill = false;
  let depth = 0;
  let previousRole = "";

  for (let i = messages.length - 1; i >= 0; i--) {
    if (!passedThePrefill && messages[i].role === "assistant") continue;
    passedThePrefill = true;

    if (messages[i].role !== previousRole) {
      if (depth === cachingAtDepth || depth === cachingAtDepth + 2) {
        found.push(i);
      }
      if (depth === cachingAtDepth + 2) break;
      depth += 1;
      previousRole = messages[i].role;
    }
  }

  return found.sort((a, b) => a - b);
}

export function planCache(
  messages: Anthropic.MessageParam[],
  messageParts: PromptPart[][],
  settings: CacheSettings,
): CachePlan {
  const warnings: string[] = [];
  const plan: CachePlan = {
    breakpoints: [],
    systemBreakpoint: settings.system,
    requestedDepth: settings.depth,
    effectiveFromEnd: null,
    ttl: settings.ttl,
    warnings,
  };

  if (settings.depth < 0 || messages.length === 0) return plan;

  // The first message carrying an injection is where stability ends.
  const firstMoving = messageParts.findIndex((parts) =>
    parts.some((part) => part.injectedAt),
  );

  let breakpoints = stBreakpoints(messages, settings.depth);

  if (firstMoving !== -1) {
    const limit = firstMoving - 1;
    const offenders = breakpoints.filter((index) => index > limit);

    if (offenders.length > 0) {
      const moving = messageParts[firstMoving]
        .filter((part) => part.injectedAt)
        .map((part) => `«${part.name}» на глубине ${part.injectedAt!.depth}`)
        .join(", ");

      if (limit < 0) {
        warnings.push(
          `Кэш сообщений выключен: ${moving} — инъекция стоит в самом начале, ` +
            `перед ней нечего кэшировать.`,
        );
        breakpoints = [];
      } else {
        warnings.push(
          `Точка кэширования сдвинута с глубины ${settings.depth} вглубь: ` +
            `${moving} сдвигается каждый ход, и внутри кэша префикс ломался бы ` +
            `на каждом запросе.`,
        );
        breakpoints = breakpoints.filter((index) => index <= limit);
        if (breakpoints.length === 0) breakpoints = [limit];
      }
    }
  }

  plan.breakpoints = breakpoints;
  plan.effectiveFromEnd =
    breakpoints.length > 0 ? messages.length - 1 - Math.max(...breakpoints) : null;
  return plan;
}

/**
 * Rewrites the request with cache_control on the planned breakpoints. Message
 * content becomes a single text block so the marker has somewhere to live.
 */
export function applyCache(
  system: string | undefined,
  messages: Anthropic.MessageParam[],
  plan: CachePlan,
): {
  system: string | Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
} {
  const cacheControl = { type: "ephemeral" as const, ttl: plan.ttl };

  const nextSystem =
    system && plan.systemBreakpoint
      ? [{ type: "text" as const, text: system, cache_control: cacheControl }]
      : system;

  const nextMessages = messages.map((message, index) => {
    if (!plan.breakpoints.includes(index)) return message;
    return {
      role: message.role,
      content: [
        {
          type: "text" as const,
          text: message.content as string,
          cache_control: cacheControl,
        },
      ],
    };
  });

  return { system: nextSystem, messages: nextMessages };
}
