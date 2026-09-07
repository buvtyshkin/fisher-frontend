export interface Chat {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  active_leaf_id: string | null;
  character_id: string | null;
  persona_id: string | null;
  preset_id: string | null;
}

export interface Character {
  id: string;
  name: string;
  spec: string;
  created_at: number;
}

/** The card's own `data` object — Character Card V2/V3 field names. */
export interface CardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  alternate_greetings?: string[];
  system_prompt?: string;
  post_history_instructions?: string;
  creator_notes?: string;
  creator?: string;
  character_version?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface CharacterFull extends Character {
  data: CardData;
}

export interface Preset {
  id: string;
  name: string;
  created_at: number;
}

export type ChronicleLevel = "scene" | "arc" | "chapter";

export interface Chronicle {
  id: string;
  level: ChronicleLevel;
  title: string;
  content: string;
  anchor_message_id: string;
  from_message_id: string | null;
  to_message_id: string | null;
  hide_covered: boolean;
  created_at: number;
  cost_usd: number | null;
  /** False means it belongs to another branch and is not in play here. */
  on_branch: boolean;
}

export interface Lorebook {
  id: string;
  name: string;
  created_at: number;
}

export interface PromptPart {
  identifier: string;
  name: string;
  role: "system" | "user" | "assistant";
  content: string;
  injectedAt: { depth: number; order: number } | null;
}

export interface PromptDump {
  preset: string;
  system: string;
  messages: { role: string; content: string }[];
  parts: PromptPart[];
  warnings: string[];
  emptyBlocks: { identifier: string; name: string }[];
  activatedLore: { title: string; reason: string }[];
  chronicles: { id: string; level: string; title: string; hidesMessages: boolean }[];
  hiddenCount: number;
  cache: {
    requestedDepth: number;
    breakpoints: number[];
    systemBreakpoint: boolean;
    effectiveFromEnd: number | null;
    ttl: string;
  };
  maxTokens: number | null;
  samplingIgnored: Record<string, number>;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  created_at: number;
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
  /** Every alternative at this point — swipes, edits and branches alike. */
  sibling_ids: string[];
  sibling_index: number;
}

export interface TipChild {
  id: string;
  role: "user" | "assistant" | "system";
  preview: string;
}

export interface Branch {
  messages: Message[];
  /** How many branch tips the whole chat has. */
  leaves: number;
  /** Continuations that already exist past the end of this branch. */
  tip_children: TipChild[];
}

export interface UsageBucket {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  replies: number;
  cost: number;
  refreshes: number;
  refreshCost: number;
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
  listMessages: (id: string) => json<Branch>(`/api/chats/${id}/messages`),
  usage: () => json<UsageReport>("/api/usage"),

  /** Moves the view to another branch (or forks, with descend: false). */
  setLeaf: (chatId: string, messageId: string, descend = true) =>
    json<Branch>(`/api/chats/${chatId}/leaf`, {
      method: "POST",
      body: JSON.stringify({ messageId, descend }),
    }),

  editMessage: (messageId: string, content: string) =>
    json<Branch>(`/api/messages/${messageId}/edit`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  listCharacters: () => json<Character[]>("/api/characters"),
  getCharacter: (id: string) => json<CharacterFull>(`/api/characters/${id}`),
  updateCharacter: (id: string, patch: Partial<CardData>) =>
    json<CharacterFull>(`/api/characters/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteCharacter: (id: string) =>
    json<void>(`/api/characters/${id}`, { method: "DELETE" }),

  listPresets: () => json<Preset[]>("/api/presets"),
  deletePreset: (id: string) =>
    json<void>(`/api/presets/${id}`, { method: "DELETE" }),
  prompt: (chatId: string) => json<PromptDump>(`/api/chats/${chatId}/prompt`),

  listChronicles: (chatId: string) =>
    json<Chronicle[]>(`/api/chats/${chatId}/chronicles`),
  createChronicle: (
    chatId: string,
    body: {
      level: ChronicleLevel;
      title: string;
      content: string;
      fromMessageId: string;
      toMessageId: string;
      hideCovered: boolean;
    },
  ) =>
    json<{ id: string }>(`/api/chats/${chatId}/chronicles`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateChronicle: (
    id: string,
    body: { title?: string; content?: string; hideCovered?: boolean },
  ) =>
    json<{ id: string }>(`/api/chronicles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteChronicle: (id: string) =>
    json<void>(`/api/chronicles/${id}`, { method: "DELETE" }),

  listLorebooks: () => json<Lorebook[]>("/api/lorebooks"),
  deleteLorebook: (id: string) =>
    json<void>(`/api/lorebooks/${id}`, { method: "DELETE" }),
  chatLorebooks: (chatId: string) =>
    json<Lorebook[]>(`/api/chats/${chatId}/lorebooks`),
  setChatLorebook: (chatId: string, lorebookId: string, attached: boolean) =>
    json<Lorebook[]>(`/api/chats/${chatId}/lorebooks`, {
      method: "POST",
      body: JSON.stringify({ lorebookId, attached }),
    }),

  listPersonas: () => json<Persona[]>("/api/personas"),
  createPersona: (name: string, description: string) =>
    json<Persona>("/api/personas", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),
  updatePersona: (id: string, name: string, description: string) =>
    json<Persona>(`/api/personas/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, description }),
    }),
  deletePersona: (id: string) =>
    json<void>(`/api/personas/${id}`, { method: "DELETE" }),

  /** Binds a card and/or persona; seeds greetings if the chat is still empty. */
  bind: (
    chatId: string,
    body: {
      characterId?: string | null;
      personaId?: string | null;
      presetId?: string | null;
    },
  ) =>
    json<Branch & { chat: Chat }>(`/api/chats/${chatId}/bind`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** Uploads a card PNG/JSON or a persona avatar as multipart form data. */
export async function upload(url: string, file: File): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(url, { method: "POST", body: form });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `${response.status} ${response.statusText}`);
  }
}

export interface StreamHandlers {
  /** Only a new turn emits this — swipes and continues have no user message. */
  onUser?: (message: Message) => void;
  onDelta: (chunk: string) => void;
  onDone: (message: Message) => void;
  onError: (text: string) => void;
}

/**
 * Consumes an SSE generation. EventSource can't do POST, so we read the
 * response body ourselves and split on the blank-line frame separator.
 */
async function stream(
  url: string,
  body: unknown,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

      if (eventLine === "user") handlers.onUser?.(payload as Message);
      else if (eventLine === "delta") handlers.onDelta(payload as string);
      else if (eventLine === "done") handlers.onDone(payload as Message);
      else if (eventLine === "error") handlers.onError(payload.message);
    }
  }
}

/** A new turn: appends the user message, then streams the reply. */
export const sendMessage = (
  chatId: string,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
) => stream(`/api/chats/${chatId}/messages`, { content }, handlers, signal);

/** A swipe: another reply alongside this one. */
export const swipeMessage = (
  messageId: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
) => stream(`/api/messages/${messageId}/swipe`, {}, handlers, signal);

/** Answers whatever the branch ends with, without a new user message. */
export const generateReply = (
  chatId: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
) => stream(`/api/chats/${chatId}/generate`, {}, handlers, signal);

/** Streams a summary of a message range; nothing is saved until you save it. */
export const generateChronicle = (
  chatId: string,
  body: { level: ChronicleLevel; fromMessageId: string; toMessageId: string },
  handlers: StreamHandlers,
  signal?: AbortSignal,
) => stream(`/api/chats/${chatId}/chronicles/generate`, body, handlers, signal);

/** Continues a reply that stopped mid-sentence, in place. */
export const continueMessage = (
  messageId: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
) => stream(`/api/messages/${messageId}/continue`, {}, handlers, signal);
