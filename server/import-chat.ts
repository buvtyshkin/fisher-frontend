import {
  appendMessage,
  createChat,
  listCharacters,
  bindChat,
  setActiveLeaf,
} from "./store.js";
import { db } from "./db.js";

/**
 * Imports a SillyTavern chat file (JSONL).
 *
 * Each line is one turn. A turn's alternatives live in `swipes`, with
 * `swipe_id` naming the one that was in play — they become siblings of the same
 * parent, which is the swipe mechanism this app already has, and the active one
 * carries the chain forward.
 *
 * `is_system` in SillyTavern means "kept in the chat, left out of the prompt".
 * Its real chats hide most of their history that way, so the flag has to
 * survive the move: dropping it would send hundreds of summarised messages to
 * the API on the very first turn.
 */

interface StMessage {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  mes?: string;
  send_date?: string;
  swipes?: string[];
  swipe_id?: number;
}

export interface ImportResult {
  chatId: string;
  title: string;
  turns: number;
  nodes: number;
  hidden: number;
  swipes: number;
  characterId: string | null;
}

function parseDate(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function importSillyTavernChat(
  jsonl: string,
  fileName: string,
): ImportResult {
  const lines = jsonl.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("Файл пуст");

  const turns: StMessage[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a half-written line at the end of a log is not fatal
    }
    // The first line is the chat header: it has no `mes`.
    if (parsed && typeof parsed === "object" && "mes" in parsed) {
      turns.push(parsed as StMessage);
    }
  }

  if (turns.length === 0) {
    throw new Error("Это не чат SillyTavern: не найдено ни одного сообщения");
  }

  const title = fileName.replace(/\.jsonl$/i, "").slice(0, 120) || "Импорт";
  const chat = createChat(title);

  let nodes = 0;
  let hidden = 0;
  let swipeTurns = 0;

  db.transaction(() => {
    let parentId: string | null = null;

    turns.forEach((turn, index) => {
      const alternatives =
        Array.isArray(turn.swipes) && turn.swipes.length > 1
          ? turn.swipes
          : [turn.mes ?? ""];
      if (alternatives.length > 1) swipeTurns += 1;

      const active = Math.min(
        Math.max(typeof turn.swipe_id === "number" ? turn.swipe_id : 0, 0),
        alternatives.length - 1,
      );

      const role = turn.is_user ? "user" : "assistant";
      const isHidden = turn.is_system === true;
      const createdAt = parseDate(turn.send_date, Date.now() + index);

      let activeId: string | null = null;
      alternatives.forEach((text, swipe) => {
        const message = appendMessage({
          chatId: chat.id,
          parentId,
          role,
          content: text ?? "",
          hidden: isHidden,
        });
        nodes += 1;
        if (isHidden) hidden += 1;
        if (swipe === active) activeId = message.id;

        // appendMessage stamps "now"; the original timestamps are worth keeping.
        db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(
          createdAt,
          message.id,
        );
      });

      parentId = activeId;
    });

    if (parentId) setActiveLeaf(chat.id, parentId);
  })();

  // The chat's folder in SillyTavern is the character's name; bind it if we
  // already have that card, so the migrated chat is playable immediately.
  const name = title.split(" - ")[0].trim().toLowerCase();
  const character = listCharacters().find(
    (candidate) => candidate.name.trim().toLowerCase() === name,
  );
  if (character) bindChat(chat.id, { characterId: character.id });

  return {
    chatId: chat.id,
    title,
    turns: turns.length,
    nodes,
    hidden,
    swipes: swipeTurns,
    characterId: character?.id ?? null,
  };
}
