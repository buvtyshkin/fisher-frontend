import { useEffect, useState } from "react";
import { api, type CardData, type Character } from "./api.ts";

/** Field name → label, in the order a card is usually written. */
const TEXT_FIELDS: [keyof CardData, string, number][] = [
  ["description", "Описание", 8],
  ["personality", "Характер", 3],
  ["scenario", "Сцена", 3],
  ["first_mes", "Первое сообщение", 6],
  ["mes_example", "Примеры реплик", 5],
  ["system_prompt", "Системный промпт карточки", 4],
  ["post_history_instructions", "Инструкция после истории", 3],
  ["creator_notes", "Заметки автора", 2],
];

interface CardEditorProps {
  character: Character;
  onClose: () => void;
  onSaved: () => void;
}

export function CardEditor({ character, onClose, onSaved }: CardEditorProps) {
  const [data, setData] = useState<CardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getCharacter(character.id)
      .then((full) => setData(full.data))
      .catch((e) => setError(String(e)));
  }, [character.id]);

  const set = (field: keyof CardData, value: unknown) =>
    setData((prev) => (prev ? { ...prev, [field]: value } : prev));

  async function save() {
    if (!data?.name.trim()) {
      setError("Имя не может быть пустым");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateCharacter(character.id, data);
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel wide" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Карточка: {character.name}</h2>
          <button onClick={onClose}>Закрыть</button>
        </header>
        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="hint">Загружаю…</p>}

        {data && (
          <div className="card-form">
            <label>
              <span>Имя</span>
              <input value={data.name} onChange={(e) => set("name", e.target.value)} />
            </label>

            {TEXT_FIELDS.map(([field, label, rows]) => (
              <label key={String(field)}>
                <span>{label}</span>
                <textarea
                  rows={rows}
                  value={(data[field] as string) ?? ""}
                  onChange={(e) => set(field, e.target.value)}
                />
              </label>
            ))}

            <label>
              <span>Альтернативные приветствия — по одному на абзац, разделитель «---»</span>
              <textarea
                rows={5}
                value={(data.alternate_greetings ?? []).join("\n---\n")}
                onChange={(e) =>
                  set(
                    "alternate_greetings",
                    e.target.value
                      .split(/^\s*---\s*$/m)
                      .map((greeting) => greeting.trim())
                      .filter(Boolean),
                  )
                }
              />
            </label>

            <label>
              <span>Теги — через запятую</span>
              <input
                value={(data.tags ?? []).join(", ")}
                onChange={(e) =>
                  set(
                    "tags",
                    e.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  )
                }
              />
            </label>

            <p className="hint small">
              Правки уходят и в экспорт: PNG пересобирается с новой карточкой,
              само изображение остаётся прежним. Поля, которых здесь нет,
              сохраняются как были.
            </p>

            <div className="editor-actions">
              <button disabled={saving} onClick={() => void save()}>
                Сохранить
              </button>
              <button disabled={saving} onClick={onClose}>
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
