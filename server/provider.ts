import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

export interface GenerateRequest {
  system?: string;
  messages: Anthropic.MessageParam[];
  signal?: AbortSignal;
}

export interface GenerateUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
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
  ): Promise<GenerateUsage>;
}

const client = new Anthropic({ apiKey: config.apiKey });

export const anthropicAdapter: ProviderAdapter = {
  async streamReply(request, onText) {
    const stream = client.messages.stream(
      {
        model: config.model,
        max_tokens: config.maxTokens,
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
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
    };
  },
};
