import { useEffect, useState } from "react";
import { api, type PromptDump } from "./api.ts";

const ROLE_LABEL: Record<string, string> = {
  system: "system",
  user: "user",
  assistant: "assistant",
};

/** The assembled prompt, block by block — so it can be diffed against ST. */
export function PromptDebug({
  chatId,
  onClose,
}: {
  chatId: string;
  onClose: () => void;
}) {
  const [dump, setDump] = useState<PromptDump | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    api.prompt(chatId).then(setDump).catch((e) => setError(String(e)));
  }, [chatId]);

  const asText = (dump: PromptDump) =>
    [
      `=== system ===\n${dump.system}`,
      ...dump.messages.map((m) => `=== ${m.role} ===\n${m.content}`),
    ].join("\n\n");

  const sampling = Object.entries(dump?.samplingIgnored ?? {});

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel wide" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Промпт</h2>
          <span className="row-actions">
            <button onClick={() => setRaw((v) => !v)}>
              {raw ? "По блокам" : "Сплошным текстом"}
            </button>
            <button onClick={onClose}>Закрыть</button>
          </span>
        </header>

        {error && <p className="error">{error}</p>}
        {!dump && !error && <p className="hint">Собираю…</p>}

        {dump && (
          <>
            <p className="hint small">
              Пресет: <b>{dump.preset}</b>
              {dump.maxTokens !== null && ` · max_tokens: ${dump.maxTokens}`}
              {` · символов: ${(dump.system + dump.messages.map((m) => m.content).join("")).length}`}
            </p>

            {dump.warnings.length > 0 && (
              <ul className="warnings">
                {dump.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}

            {dump.emptyBlocks.length > 0 && (
              <p className="hint small">
                Включены, но вышли пустыми:{" "}
                {dump.emptyBlocks.map((b) => b.name).join(", ")}
              </p>
            )}

            {sampling.length > 0 && (
              <p className="warn">
                Не отправляется — текущие модели Claude не принимают параметры
                сэмплинга: {sampling.map(([k, v]) => `${k}=${v}`).join(", ")}
              </p>
            )}

            {raw ? (
              <pre className="dump">{asText(dump)}</pre>
            ) : (
              <ol className="parts">
                {dump.parts.map((part, index) => (
                  <li key={index} className={`part ${part.role}`}>
                    <div className="part-head">
                      <span className="part-name">{part.name}</span>
                      <span className="tag">{ROLE_LABEL[part.role]}</span>
                      <span className="tag">{part.identifier}</span>
                      {part.injectedAt && (
                        <span className="tag inject">
                          глубина {part.injectedAt.depth} · порядок{" "}
                          {part.injectedAt.order}
                        </span>
                      )}
                    </div>
                    <pre className="part-body">{part.content}</pre>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  );
}
