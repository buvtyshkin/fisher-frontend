import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { TokenCounts } from "./pricing.js";

export interface GenerateRequest {
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  /** From the preset when it sets one, otherwise the .env default. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  model: string;
  /** Thinking tokens are already counted inside `output` by the API. */
  tokens: TokenCounts;
}

/**
 * Provider abstraction (SPEC §3). Only Anthropic is implemented; the interface
 * exists so an OpenAI-compatible adapter can be dropped in later without
 * touching the routes.
 */
export interface ProviderAdapter {
  /** Yields text chunks as they arrive; resolves usage once the reply ends. */
  streamReply(
    request: GenerateRequest,
    onText: (chunk: string) => void,
  ): Promise<GenerateResult>;
}

const client = new Anthropic({ apiKey: config.apiKey });

export const anthropicAdapter: ProviderAdapter = {
  async streamReply(request, onText) {
    const stream = client.messages.stream(
      {
        model: config.model,
        max_tokens: request.maxTokens ?? config.maxTokens,
        // Claude Opus 5 thinks adaptively when `thinking` is omitted.
        ...(config.thinking === "off"
          ? { thinking: { type: "disabled" as const } }
          : {}),
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages,
      },
      { signal: request.signal },
    );

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        onText(event.delta.text);
      }
    }

    const final = await stream.finalMessage();
    return {
      model: final.model,
      tokens: {
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
        cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
        cacheRead: final.usage.cache_read_input_tokens ?? 0,
      },
    };
  },
};
