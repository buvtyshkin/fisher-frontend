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

  /** Reads the cached prefix to reset its TTL, generating nothing. */
  warmCache(request: GenerateRequest): Promise<GenerateResult>;
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
    return { model: final.model, tokens: usageOf(final) };
  },

  /**
   * `max_tokens: 0` runs prefill and returns immediately: no output tokens are
   * billed, and reading the cached prefix resets its TTL at no extra cost. The
   * request must otherwise be byte-identical to the real one — changing the
   * thinking configuration alone would invalidate the messages cache — and it
   * cannot be streamed, which the API rejects together with max_tokens: 0.
   */
  async warmCache(request) {
    const send = (maxTokens: number) =>
      client.messages.create(
        {
          model: config.model,
          max_tokens: maxTokens,
          // Identical to the real request: a different thinking configuration
          // would invalidate the very messages cache we are keeping alive.
          ...(config.thinking === "off"
            ? { thinking: { type: "disabled" as const } }
            : {}),
          ...(request.system ? { system: request.system } : {}),
          messages: request.messages,
        },
        { signal: request.signal },
      );

    try {
      const response = await send(0);
      return { model: response.model, tokens: usageOf(response) };
    } catch (error) {
      // max_tokens: 0 is rejected in some combinations; one token costs
      // practically nothing and keeps the keep-alive working either way.
      const rejected =
        error instanceof Anthropic.APIError &&
        error.status === 400 &&
        String(error.message).includes("max_tokens");
      if (!rejected) throw error;

      const response = await send(1);
      return { model: response.model, tokens: usageOf(response) };
    }
  },
};

function usageOf(message: Anthropic.Message) {
  return {
    input: message.usage.input_tokens,
    output: message.usage.output_tokens,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
  };
}
