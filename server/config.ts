import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export const config = {
  apiKey: required("ANTHROPIC_API_KEY"),
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  model: process.env.MODEL ?? "claude-opus-5",
  maxTokens: Number(process.env.MAX_TOKENS ?? 8000),
  thinking: (process.env.THINKING ?? "adaptive") as "adaptive" | "off",
  dataDir: process.env.DATA_DIR ?? "./data",
  // Prompt cache. depth is counted in role changes, as in ST; -1 turns the
  // message breakpoints off.
  cache: {
    depth: Number(process.env.CACHE_DEPTH ?? 2),
    system: process.env.CACHE_SYSTEM !== "false",
    ttl: (process.env.CACHE_TTL === "1h" ? "1h" : "5m") as "5m" | "1h",
  },
  // SillyTavern's global World Info settings; its own defaults.
  worldInfo: {
    scanDepth: Number(process.env.WI_SCAN_DEPTH ?? 2),
    recursive: process.env.WI_RECURSIVE !== "false",
    caseSensitive: process.env.WI_CASE_SENSITIVE === "true",
    matchWholeWords: process.env.WI_MATCH_WHOLE_WORDS !== "false",
  },
};
