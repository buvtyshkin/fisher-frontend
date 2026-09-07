import { useEffect, useRef, useState } from "react";
import { api, upload, type Character, type Chat, type Persona } from "./api.ts";
import { CardEditor } from "./CardEditor.tsx";

interface LibraryProps {
  chat: Chat;
  onClose: () => void;
  /** Called after a bind so the chat can pick up seeded greetings. */
  onBound: () => void;
}

export function Library({ chat, onClose, onBound }: LibraryProps) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [characterId, setCharacterId] = useState(chat.character_id);
  const [personaId, setPersonaId] = useState(chat.persona_id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);
  const [editingCard, setEditingCard] = useState<Character | null>(null);
  const [personaName, setPersonaName] = useState("");
  const [personaText, setPersonaText] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const [nextCharacters, nextPersonas] = await Promise.all([
      api.listCharacters(),
      api.listPersonas(),
    ]);
    setCharacters(nextCharacters);
    setPersonas(nextPersonas);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, []);

  async function importCard(file: File) {
    setBusy(true);
    setError(null);
    try {
      await upload("/api/characters/import", file);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function bind(next: { characterId?: string | null; personaId?: string | null }) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.bind(chat.id, next);
      setCharacterId(result.chat.character_id);
      setPersonaId(result.chat.persona_id);
      onBound();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeCharacter(character: Character) {
    if (!confirm(`Удалить карточку «${character.name}»? Чаты останутся.`)) return;
    await api.deleteCharacter(character.id);
    if (characterId === character.id) setCharacterId(null);
    await refresh();
  }

  async function savePersona() {
    const name = personaName.trim();
    if (!name) return;
    if (editing) await api.updatePersona(editing.id, name, personaText);
    else await api.createPersona(name, personaText);
    setEditing(null);
    setPersonaName("");
    setPersonaText("");
    await refresh();
  }

  async function removePersona(persona: Persona) {
    if (!confirm(`Удалить персону «${persona.name}»?`)) return;
    await api.deletePersona(persona.id);
    if (personaId === persona.id) setPersonaId(null);
    await refresh();
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel wide" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Персонаж и персона</h2>
          <button onClick={onClose}>Закрыть</button>
        </header>
        {error && <p className="error">{error}</p>}

        <section className="period">
          <h3>
            Карточки
            <button disabled={busy} onClick={() => fileRef.current?.click()}>
              Импорт PNG или JSON
            </button>
          </h3>
          <input
            ref={fileRef}
            type="file"
            accept=".png,.json,image/png,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importCard(file);
            }}
          />
          <ul className="library">
            {characters.map((character) => (
              <li
                key={character.id}
                className={character.id === characterId ? "row active" : "row"}
              >
                <img
                  className="avatar"
                  src={`/api/characters/${character.id}/avatar`}
                  alt=""
                  onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                />
                <span className="row-name">
                  {character.name}
                  <span className="tag">{character.spec.replace("chara_card_", "")}</span>
                </span>
                <span className="row-actions">
                  <button
                    disabled={busy || character.id === characterId}
                    onClick={() => void bind({ characterId: character.id })}
                  >
                    {character.id === characterId ? "Выбран" : "Выбрать"}
                  </button>
                  <button disabled={busy} onClick={() => setEditingCard(character)}>
                    ✎
                  </button>
                  <a
                    className="button"
                    href={`/api/characters/${character.id}/export`}
                    title="Скачать обратно в формате SillyTavern"
                  >
                    Экспорт
                  </a>
                  <button disabled={busy} onClick={() => void removeCharacter(character)}>
                    ✕
                  </button>
                </span>
              </li>
            ))}
            {characters.length === 0 && <li className="empty">Карточек пока нет</li>}
          </ul>
          {characterId && (
            <p className="hint small">
              Приветствия карточки подставляются в пустой чат: первое — активное,
              остальные лежат рядом свайпами.
              <button className="linkish" disabled={busy} onClick={() => void bind({ characterId: null })}>
                Отвязать
              </button>
            </p>
          )}
        </section>

        <section className="period">
          <h3>Персоны</h3>
          <ul className="library">
            {personas.map((persona) => (
              <li key={persona.id} className={persona.id === personaId ? "row active" : "row"}>
                <span className="row-name">{persona.name}</span>
                <span className="row-actions">
                  <button
                    disabled={busy || persona.id === personaId}
                    onClick={() => void bind({ personaId: persona.id })}
                  >
                    {persona.id === personaId ? "Выбрана" : "Выбрать"}
                  </button>
                  <button
                    onClick={() => {
                      setEditing(persona);
                      setPersonaName(persona.name);
                      setPersonaText(persona.description);
                    }}
                  >
                    ✎
                  </button>
                  <button onClick={() => void removePersona(persona)}>✕</button>
                </span>
              </li>
            ))}
            {personas.length === 0 && <li className="empty">Персон пока нет</li>}
          </ul>

          <div className="persona-form">
            <input
              value={personaName}
              placeholder="Имя персоны"
              onChange={(e) => setPersonaName(e.target.value)}
            />
            <textarea
              value={personaText}
              rows={3}
              placeholder="Описание — попадёт в системный промпт"
              onChange={(e) => setPersonaText(e.target.value)}
            />
            <div className="editor-actions">
              <button disabled={!personaName.trim()} onClick={() => void savePersona()}>
                {editing ? "Сохранить" : "Добавить"}
              </button>
              {editing && (
                <button
                  onClick={() => {
                    setEditing(null);
                    setPersonaName("");
                    setPersonaText("");
                  }}
                >
                  Отмена
                </button>
              )}
            </div>
          </div>
          {personaId && (
            <p className="hint small">
              <button className="linkish" disabled={busy} onClick={() => void bind({ personaId: null })}>
                Отвязать персону
              </button>
            </p>
          )}
        </section>
      </div>

      {editingCard && (
        <CardEditor
          character={editingCard}
          onClose={() => setEditingCard(null)}
          onSaved={() => {
            void refresh();
            // A renamed or re-greeted card changes what the chat shows.
            onBound();
          }}
        />
      )}
    </div>
  );
}
