import fs from "node:fs";
import path from "node:path";

export interface ModelPrice {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING_FILE = process.env.PRICING_FILE
  ? path.resolve(process.env.PRICING_FILE)
  : path.resolve(process.cwd(), "pricing.json");

let cached: { mtimeMs: number; models: Record<string, ModelPrice> } | null = null;

/**
 * Reads pricing.json, re-reading whenever the file changes on disk so prices
 * can be edited by hand without restarting the server.
 */
export function loadPricing(): Record<string, ModelPrice> {
  try {
    const { mtimeMs } = fs.statSync(PRICING_FILE);
    if (cached?.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(PRICING_FILE, "utf8"));
      cached = { mtimeMs, models: parsed.models ?? {} };
    }
    return cached.models;
  } catch {
    return cached?.models ?? {};
  }
}

/** Cost of one reply in dollars, or null when the model has no price entry. */
export function costOf(
  model: string | null,
  tokens: TokenCounts,
): number | null {
  if (!model) return null;
  const price = loadPricing()[model];
  if (!price) return null;

  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheWrite * price.cache_write +
      tokens.cacheRead * price.cache_read) /
    1_000_000
  );
}
