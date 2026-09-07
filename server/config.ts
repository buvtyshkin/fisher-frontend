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
};
