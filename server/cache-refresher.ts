import type { FastifyBaseLogger } from "fastify";
import { assemble } from "./assemble.js";
import { config } from "./config.js";
import { anthropicAdapter } from "./provider.js";
import { getBranch, recentChats, recordCacheRefresh } from "./store.js";

/**
 * Keeps the prompt cache warm while nobody is typing.
 *
 * A cache read resets the entry's TTL at no extra cost, so the keep-alive is
 * the same request with `max_tokens: 0`: the API runs prefill, bills a cache
 * read and returns nothing. The prefix must be byte-identical to the real
 * request or the read becomes a write at 2x the input price — which is exactly
 * what this is meant to avoid — so it goes through the same assembler.
 *
 * Only the most recently used chats are refreshed, and only while they are
 * still plausibly in play: every refresh costs a read of the whole prefix, and
 * doing that for every chat in the library would be real money for nothing.
 */
export function startCacheRefresher(log: FastifyBaseLogger): () => void {
  const settings = config.cacheRefresh;

  if (!settings.enabled || config.cache.ttl !== "1h") {
    log.info(
      { enabled: settings.enabled, ttl: config.cache.ttl },
      "прогрев кэша выключен",
    );
    return () => {};
  }

  const intervalMs = Math.max(1, settings.everyMinutes) * 60_000;
  log.info(
    { everyMinutes: settings.everyMinutes, chats: settings.chats },
    "прогрев кэша включён",
  );

  const timer = setInterval(() => {
    void refreshOnce(log).catch((error) => log.error(error, "прогрев кэша сорвался"));
  }, intervalMs);

  // Never hold the process open just to refresh a cache.
  timer.unref();
  return () => clearInterval(timer);
}

export async function refreshOnce(log: FastifyBaseLogger): Promise<void> {
  const settings = config.cacheRefresh;
  const since = Date.now() - settings.idleHours * 3_600_000;

  for (const chat of recentChats(settings.chats, since)) {
    const branch = getBranch(chat.id);
    if (branch.length === 0) continue;

    const built = assemble(chat.id, branch);
    if (built.cache.breakpoints.length === 0 && !built.cache.systemBreakpoint) {
      continue; // nothing is cached, so nothing to keep alive
    }

    try {
      const result = await anthropicAdapter.warmCache({
        system: built.system,
        messages: built.messages,
        maxTokens: built.maxTokens,
      });

      recordCacheRefresh({
        chatId: chat.id,
        model: result.model,
        usage: result.tokens,
      });

      // A read means the prefix matched. A write means it did not, and the
      // refresh just paid full price for a new entry — worth saying out loud.
      if (result.tokens.cacheRead > 0) {
        log.info(
          { chat: chat.title, read: result.tokens.cacheRead },
          "кэш продлён",
        );
      } else {
        log.warn(
          { chat: chat.title, written: result.tokens.cacheWrite },
          "прогрев не нашёл кэш и записал его заново — префикс изменился",
        );
      }
    } catch (error) {
      log.error({ chat: chat.title, err: error }, "прогрев кэша не удался");
    }
  }
}
