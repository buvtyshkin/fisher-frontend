import { useEffect, useRef, useState } from "react";
import {
  api,
  generateChronicle,
  type Chronicle,
  type ChronicleLevel,
  type Message,
} from "./api.ts";

const LEVEL_NAME: Record<ChronicleLevel, string> = {
  scene: "Сцена",
  arc: "Арка",
  chapter: "Глава",
};

const preview = (message: Message) =>
  `${message.role === "assistant" ? "модель" : "вы"}: ${message.content
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48)}`;

interface ChroniclesProps {
  chatId: string;
  /** The branch in view — the only messages a chronicle may cover. */
  messages: Message[];
  onClose: () => void;
  onChanged: () => void;
}

export function Chronicles({ chatId, messages, onClose, onChanged }: ChroniclesProps) {
  const [list, setList] = useState<Chronicle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [level, setLevel] = useState<ChronicleLevel>("scene");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [hide, setHide] = useState(false);
  const [editing, setEditing] = useState<Chronicle | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  async function refresh() {
    setList(await api.listChronicles(chatId));
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
    if (messages.length > 0) {
      setFromId(messages[0].id);
      setToId(messages.at(-1)!.id);
    }
  }, [chatId]);

  function reset() {
    setEditing(null);
    setTitle("");
    setText("");
    setHide(false);
  }

  async function generate() {
    if (!fromId || !toId || busy) return;
    setBusy(true);
    setError(null);
    setText("");

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await generateChronicle(
        chatId,
        { level, fromMessageId: fromId, toMessageId: toId },
        {
          onDelta: (chunk) => setText((prev) => prev + chunk),
          onDone: () => {},
          onError: setError,
        },
        controller.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(String(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function save() {
    const content = text.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api.updateChronicle(editing.id, { title, content, hideCovered: hide });
      } else {
        await api.createChronicle(chatId, {
          level,
          title,
          content,
          fromMessageId: fromId,
          toMessageId: toId,
          hideCovered: hide,
        });
      }
      await refresh();
      onChanged();
      reset();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(chronicle: Chronicle) {
    if (!confirm(`Удалить хронику «${chronicle.title || LEVEL_NAME[chronicle.level]}»?`))
      return;
    await api.deleteChronicle(chronicle.id);
    await refresh();
    onChanged();
  }

  async function toggleHide(chronicle: Chronicle) {
    await api.updateChronicle(chronicle.id, { hideCovered: !chronicle.hide_covered });
    await refresh();
    onChanged();
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel wide" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Хроники</h2>
          <button onClick={onClose}>Закрыть</button>
        </header>
        {error && <p className="error">{error}</p>}

        <section className="period">
          <h3>{editing ? "Правка хроники" : "Новая хроника"}</h3>

          <div className="card-form">
            <label>
              <span>Уровень</span>
              <select
                value={level}
                disabled={!!editing}
                onChange={(e) => setLevel(e.target.value as ChronicleLevel)}
              >
                {(["scene", "arc", "chapter"] as ChronicleLevel[]).map((value) => (
                  <option key={value} value={value}>
                    {LEVEL_NAME[value]}
                  </option>
                ))}
              </select>
            </label>

            {!editing && (
              <>
                <label>
                  <span>С какого сообщения</span>
                  <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                    {messages.map((message, index) => (
                      <option key={message.id} value={message.id}>
                        {index + 1}. {preview(message)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>По какое включительно</span>
                  <select value={toId} onChange={(e) => setToId(e.target.value)}>
                    {messages.map((message, index) => (
                      <option key={message.id} value={message.id}>
                        {index + 1}. {preview(message)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            <label>
              <span>Название (необязательно)</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>

            <label>
              <span>Текст хроники</span>
              <textarea
                rows={8}
                value={text}
                placeholder="Напишите сами или нажмите «Сгенерировать»"
                onChange={(e) => setText(e.target.value)}
              />
            </label>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={hide}
                onChange={(e) => setHide(e.target.checked)}
              />
              <span>
                Скрыть суммаризованные сообщения из контекста — они останутся в
                дереве и на экране, но не уйдут в API
              </span>
            </label>

            <div className="editor-actions">
              {!editing && (
                <button disabled={busy} onClick={() => void generate()}>
                  {busy ? "Пишу…" : "Сгенерировать"}
                </button>
              )}
              <button disabled={busy || !text.trim()} onClick={() => void save()}>
                Сохранить
              </button>
              {editing && <button onClick={reset}>Отмена</button>}
            </div>
          </div>
        </section>

        <section className="period">
          <h3>Сохранённые</h3>
          <ul className="library">
            {list.map((chronicle) => (
              <li
                key={chronicle.id}
                className={chronicle.on_branch ? "row active" : "row"}
              >
                <span className="row-name">
                  <span className="tag">{LEVEL_NAME[chronicle.level]}</span>
                  {chronicle.title || "без названия"}
                  {!chronicle.on_branch && <span className="tag">другая ветка</span>}
                  {chronicle.hide_covered && <span className="tag">скрывает</span>}
                </span>
                <span className="row-actions">
                  <button onClick={() => void toggleHide(chronicle)}>
                    {chronicle.hide_covered ? "Показать" : "Скрыть"}
                  </button>
                  <button
                    onClick={() => {
                      setEditing(chronicle);
                      setTitle(chronicle.title);
                      setText(chronicle.content);
                      setHide(chronicle.hide_covered);
                    }}
                  >
                    ✎
                  </button>
                  <button onClick={() => void remove(chronicle)}>✕</button>
                </span>
              </li>
            ))}
            {list.length === 0 && <li className="empty">Хроник пока нет</li>}
          </ul>
          <p className="hint small">
            Хроника видна только тем веткам, что проходят через её последнее
            покрытое сообщение. В соседнюю ветку она не попадёт.
          </p>
        </section>
      </div>
    </div>
  );
}
