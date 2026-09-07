import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  continueMessage,
  sendMessage,
  swipeMessage,
  type Branch,
  type Character,
  type Chat,
  type Message,
} from "./api.ts";
import { Library } from "./Library.tsx";
import { Markdown } from "./Markdown.tsx";
import { Usage } from "./Usage.tsx";

/** What is currently being generated, so the right message shows the stream. */
type Generation =
  | { kind: "idle" }
  | { kind: "turn" }
  | { kind: "swipe"; fromId: string }
  | { kind: "continue"; messageId: string };

export function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [branch, setBranch] = useState<Branch>({ messages: [], leaves: 0 });
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [generation, setGeneration] = useState<Generation>({ kind: "idle" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const busy = generation.kind !== "idle";
  const messages = branch.messages;

  const refreshChats = useCallback(async () => {
    const [nextChats, nextCharacters] = await Promise.all([
      api.listChats(),
      api.listCharacters(),
    ]);
    setChats(nextChats);
    setCharacters(nextCharacters);
  }, []);

  const reload = useCallback(async (chatId: string) => {
    setBranch(await api.listMessages(chatId));
  }, []);

  useEffect(() => {
    refreshChats().catch((e) => setError(String(e)));
  }, [refreshChats]);

  useEffect(() => {
    setEditingId(null);
    if (!activeId) {
      setBranch({ messages: [], leaves: 0 });
      return;
    }
    reload(activeId).catch((e) => setError(String(e)));
  }, [activeId, reload]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  async function newChat() {
    const chat = await api.createChat("Новый чат");
    await refreshChats();
    setActiveId(chat.id);
    setSidebarOpen(false);
  }

  async function removeChat(id: string) {
    if (!confirm("Удалить чат вместе со всеми сообщениями?")) return;
    await api.deleteChat(id);
    if (activeId === id) setActiveId(null);
    await refreshChats();
  }

  async function rename(chat: Chat) {
    const title = prompt("Название чата", chat.title);
    if (title === null) return;
    await api.renameChat(chat.id, title);
    await refreshChats();
  }

  /** Runs any of the three generation kinds through the same plumbing. */
  async function generate(
    kind: Generation,
    run: (handlers: Parameters<typeof sendMessage>[2], signal: AbortSignal) => Promise<void>,
  ) {
    if (!activeId || busy) return;
    setStreaming("");
    setGeneration(kind);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await run(
        {
          onDelta: (chunk) => setStreaming((prev) => prev + chunk),
          onDone: () => {},
          onError: setError,
        },
        controller.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(String(e));
    } finally {
      abortRef.current = null;
      // Reload first, then drop the stream — otherwise the text blinks out
      // for a frame between the last delta and the saved message.
      await reload(activeId).catch(() => {});
      setGeneration({ kind: "idle" });
      setStreaming("");
      refreshChats().catch(() => {});
    }
  }

  async function submit() {
    const content = draft.trim();
    if (!content || !activeId || busy) return;
    setDraft("");
    await generate({ kind: "turn" }, (handlers, signal) =>
      sendMessage(activeId, content, handlers, signal),
    );
  }

  const swipe = (message: Message) =>
    generate({ kind: "swipe", fromId: message.id }, (handlers, signal) =>
      swipeMessage(message.id, handlers, signal),
    );

  const continueReply = (message: Message) =>
    generate({ kind: "continue", messageId: message.id }, (handlers, signal) =>
      continueMessage(message.id, handlers, signal),
    );

  async function switchSibling(message: Message, direction: -1 | 1) {
    if (!activeId || busy) return;
    const next = message.sibling_ids[message.sibling_index + direction];
    if (!next) return;
    // Switching follows the chosen branch down to its own tip.
    setBranch(await api.setLeaf(activeId, next));
  }

  async function fork(message: Message) {
    if (!activeId || busy) return;
    setBranch(await api.setLeaf(activeId, message.id, false));
  }

  async function saveEdit(message: Message) {
    const content = editDraft.trim();
    if (!content || content === message.content) {
      setEditingId(null);
      return;
    }
    setBranch(await api.editMessage(message.id, content));
    setEditingId(null);
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }

  const activeChat = chats.find((c) => c.id === activeId) ?? null;
  const character = characters.find((c) => c.id === activeChat?.character_id);
  const characterName = character?.name;
  const lastMessage = messages.at(-1);

  // A swipe replaces the message it started from, so hide it while streaming.
  const swipedFrom =
    generation.kind === "swipe"
      ? messages.findIndex((m) => m.id === generation.fromId)
      : -1;
  const visible = swipedFrom === -1 ? messages : messages.slice(0, swipedFrom);

  return (
    <div className="app">
      <aside className={sidebarOpen ? "sidebar open" : "sidebar"}>
        <div className="sidebar-head">
          <span className="brand">Fisher</span>
          <button onClick={newChat}>+ Чат</button>
        </div>
        <ul className="chat-list">
          {chats.map((chat) => (
            <li
              key={chat.id}
              className={chat.id === activeId ? "chat active" : "chat"}
              onClick={() => {
                setActiveId(chat.id);
                setSidebarOpen(false);
              }}
            >
              <span className="chat-title">{chat.title}</span>
              <span className="chat-actions">
                <button title="Переименовать" onClick={(e) => { e.stopPropagation(); void rename(chat); }}>✎</button>
                <button title="Удалить" onClick={(e) => { e.stopPropagation(); void removeChat(chat.id); }}>✕</button>
              </span>
            </li>
          ))}
          {chats.length === 0 && <li className="empty">Чатов пока нет</li>}
        </ul>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="burger" onClick={() => setSidebarOpen((v) => !v)}>☰</button>
          <span className="title">{activeChat?.title ?? "Fisher"}</span>
          {activeChat && (
            <button className="usage-button" onClick={() => setLibraryOpen(true)}>
              {characterName ?? "Персонаж"}
            </button>
          )}
          {activeId && branch.leaves > 1 && (
            <span className="leaves" title="Веток в этом чате">
              веток: {branch.leaves}
            </span>
          )}
          <button className="usage-button" onClick={() => setUsageOpen(true)}>
            Расходы
          </button>
        </header>

        <div className="messages">
          {!activeId && <p className="hint">Создайте чат слева, чтобы начать.</p>}

          {visible.map((message) => {
            const continuing =
              generation.kind === "continue" && generation.messageId === message.id;

            return (
              <article key={message.id} className={`message ${message.role}`}>
                {message.role === "assistant" && character && (
                  <img
                    className="portrait"
                    src={`/api/characters/${character.id}/avatar`}
                    alt=""
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                )}
                {editingId === message.id ? (
                  <div className="editor">
                    <textarea
                      value={editDraft}
                      autoFocus
                      rows={Math.min(20, editDraft.split("\n").length + 2)}
                      onChange={(e) => setEditDraft(e.target.value)}
                    />
                    <div className="editor-actions">
                      <button onClick={() => void saveEdit(message)}>Сохранить</button>
                      <button onClick={() => setEditingId(null)}>Отмена</button>
                      <span className="hint small">
                        Старый вариант останется в дереве соседней веткой.
                      </span>
                    </div>
                  </div>
                ) : (
                  <Markdown text={message.content + (continuing ? streaming : "")} />
                )}

                {message.output_tokens !== null && <Meta message={message} />}

                {editingId !== message.id && (
                  <Controls
                    message={message}
                    busy={busy}
                    isLast={message.id === lastMessage?.id}
                    onSwitch={switchSibling}
                    onEdit={() => {
                      setEditDraft(message.content);
                      setEditingId(message.id);
                    }}
                    onSwipe={() => void swipe(message)}
                    onContinue={() => void continueReply(message)}
                    onFork={() => void fork(message)}
                  />
                )}
              </article>
            );
          })}

          {streaming && generation.kind !== "continue" && (
            <article className="message assistant">
              <Markdown text={streaming} />
            </article>
          )}
          {busy && !streaming && <p className="hint">Claude думает…</p>}
          {error && <p className="error">{error}</p>}
          <div ref={bottomRef} />
        </div>

        <footer className="composer">
          <textarea
            value={draft}
            placeholder={activeId ? "Ваш ход… (Ctrl+Enter — отправить)" : "Сначала создайте чат"}
            disabled={!activeId || busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
          />
          {busy ? (
            <button className="stop" onClick={stop}>Стоп</button>
          ) : (
            <button onClick={submit} disabled={!activeId || !draft.trim()}>Отправить</button>
          )}
        </footer>
      </main>

      {usageOpen && <Usage onClose={() => setUsageOpen(false)} />}
      {libraryOpen && activeChat && (
        <Library
          chat={activeChat}
          onClose={() => setLibraryOpen(false)}
          onBound={() => {
            void refreshChats();
            if (activeId) void reload(activeId);
          }}
        />
      )}
    </div>
  );
}

/** Token and cost line under an assistant reply. */
function Meta({ message }: { message: Message }) {
  const cost =
    message.cost_usd === null
      ? "цена не задана"
      : message.cost_usd >= 0.01
        ? `$${message.cost_usd.toFixed(2)}`
        : `$${message.cost_usd.toFixed(4)}`;

  return (
    <div className="meta">
      {message.model} · вход {message.input_tokens} · выход {message.output_tokens}
      {" · кэш-запись "}
      {message.cache_creation_input_tokens ?? 0}
      {" · кэш-чтение "}
      {message.cache_read_input_tokens ?? 0}
      {" · "}
      <span className="cost">{cost}</span>
    </div>
  );
}

interface ControlsProps {
  message: Message;
  busy: boolean;
  isLast: boolean;
  onSwitch: (message: Message, direction: -1 | 1) => void;
  onEdit: () => void;
  onSwipe: () => void;
  onContinue: () => void;
  onFork: () => void;
}

function Controls(props: ControlsProps) {
  const { message, busy, isLast } = props;
  const siblingCount = message.sibling_ids.length;

  return (
    <div className="controls">
      {siblingCount > 1 && (
        <span className="swiper">
          <button
            disabled={busy || message.sibling_index === 0}
            title="Предыдущая ветка"
            onClick={() => props.onSwitch(message, -1)}
          >
            ‹
          </button>
          <span className="counter">
            {message.sibling_index + 1}/{siblingCount}
          </span>
          <button
            disabled={busy || message.sibling_index === siblingCount - 1}
            title="Следующая ветка"
            onClick={() => props.onSwitch(message, 1)}
          >
            ›
          </button>
        </span>
      )}
      <button disabled={busy} onClick={props.onEdit}>Править</button>
      {message.role === "assistant" && (
        <button disabled={busy} title="Ещё один вариант ответа" onClick={props.onSwipe}>
          Свайп
        </button>
      )}
      {message.role === "assistant" && isLast && (
        <button disabled={busy} title="Дописать оборванный ответ" onClick={props.onContinue}>
          Продолжить
        </button>
      )}
      {!isLast && (
        <button disabled={busy} title="Продолжить историю отсюда" onClick={props.onFork}>
          Ветвиться
        </button>
      )}
    </div>
  );
}
