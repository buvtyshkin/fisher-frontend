export interface Chat {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  active_leaf_id: string | null;
}

export interface Message {
  id: string;
  chat_id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  /** Dollars, frozen when the reply was generated; null if the model had no price. */
  cost_usd: number | null;
}

export interface UsageBucket {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  replies: number;
  cost: number;
  unpricedModels: string[];
}

export interface UsageReport {
  today: UsageBucket;
  last24h: UsageBucket;
  last7d: UsageBucket;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.status === 204 ? (undefined as T) : response.json();
}

export const api = {
  listChats: () => json<Chat[]>("/api/chats"),
  createChat: (title: string) =>
    json<Chat>("/api/chats", { method: "POST", body: JSON.stringify({ title }) }),
  renameChat: (id: string, title: string) =>
    json<Chat>(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteChat: (id: string) => json<void>(`/api/chats/${id}`, { method: "DELETE" }),
  listMessages: (id: string) => json<Message[]>(`/api/chats/${id}/messages`),
  usage: () => json<UsageReport>("/api/usage"),
};

export interface StreamHandlers {
  onUser: (message: Message) => void;
  onDelta: (chunk: string) => void;
  onDone: (message: Message) => void;
  onError: (text: string) => void;
}

/**
 * Sends a message and consumes the SSE reply. EventSource can't do POST, so we
 * read the response body ourselves and split on the blank-line frame separator.
 */
export async function sendMessage(
  chatId: string,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal,
  });

  if (!response.ok || !response.body) {
    handlers.onError(`Сервер ответил ${response.status}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separator: number;
    while ((separator = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);

      const eventLine = frame.match(/^event: (.*)$/m)?.[1];
      const dataLine = frame.match(/^data: ([\s\S]*)$/m)?.[1];
      if (!eventLine || dataLine === undefined) continue;
      const payload = JSON.parse(dataLine);

      if (eventLine === "user") handlers.onUser(payload as Message);
      else if (eventLine === "delta") handlers.onDelta(payload as string);
      else if (eventLine === "done") handlers.onDone(payload as Message);
      else if (eventLine === "error") handlers.onError(payload.message);
    }
  }
}
