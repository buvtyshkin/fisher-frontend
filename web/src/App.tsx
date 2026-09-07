import { useCallback, useEffect, useRef, useState } from "react";
import { api, sendMessage, type Chat, type Message } from "./api.ts";
import { Markdown } from "./Markdown.tsx";
import { Usage } from "./Usage.tsx";

export function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshChats = useCallback(async () => {
    setChats(await api.listChats());
  }, []);

  useEffect(() => {
    refreshChats().catch((e) => setError(String(e)));
  }, [refreshChats]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    api.listMessages(activeId).then(setMessages).catch((e) => setError(String(e)));
  }, [activeId]);

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

  async function submit() {
    const content = draft.trim();
    if (!content || !activeId || busy) return;

    setDraft("");
    setStreaming("");
    setBusy(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await sendMessage(
        activeId,
        content,
        {
          onUser: (message) => setMessages((prev) => [...prev, message]),
          onDelta: (chunk) => setStreaming((prev) => prev + chunk),
          onDone: (message) => {
            setMessages((prev) => [...prev, message]);
            setStreaming("");
          },
          onError: setError,
        },
        controller.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(String(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStreaming("");
      if (activeId) {
        api.listMessages(activeId).then(setMessages).catch(() => {});
      }
      refreshChats().catch(() => {});
    }
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
          <button className="usage-button" onClick={() => setUsageOpen(true)}>
            Расходы
          </button>
        </header>

        <div className="messages">
          {!activeId && <p className="hint">Создайте чат слева, чтобы начать.</p>}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <Markdown text={message.content} />
              {message.output_tokens !== null && <Meta message={message} />}
            </article>
          ))}
          {streaming && (
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
    </div>
  );
}

/** Token and cost line under an assistant reply. */
function Meta({ message }: { message: Message }) {
  const cost =
    message.cost === null
      ? "цена не задана"
      : message.cost >= 0.01
        ? `$${message.cost.toFixed(2)}`
        : `$${message.cost.toFixed(4)}`;

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
