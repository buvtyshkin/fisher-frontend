/**
 * Prints the message tree of a chat straight from the database — the answer to
 * "is my old branch still there?" without trusting the UI.
 *
 *   npm run tree              — list the chats
 *   npm run tree -- <id, начало id или часть названия>
 */
import { db } from "../server/db.js";
import type { Chat, Message } from "../server/db.js";

const argument = process.argv[2];

const chats = db
  .prepare("SELECT * FROM chats ORDER BY updated_at DESC")
  .all() as Chat[];

if (!argument) {
  if (chats.length === 0) {
    console.log("Чатов нет.");
  } else {
    console.log("Чаты (запустите: npm run tree -- <id или часть названия>)\n");
    for (const chat of chats) {
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?")
        .get(chat.id) as { n: number };
      console.log(`  ${chat.id}  ${chat.title}  — сообщений: ${count.n}`);
    }
  }
  process.exit(0);
}

const needle = argument.toLowerCase();
const chat =
  chats.find((c) => c.id === argument) ??
  chats.find((c) => c.id.startsWith(argument)) ??
  chats.find((c) => c.title.toLowerCase().includes(needle));

if (!chat) {
  console.error(`Чат «${argument}» не найден.`);
  process.exit(1);
}

const messages = db
  .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY rowid")
  .all(chat.id) as Message[];

const childrenOf = new Map<string | null, Message[]>();
for (const message of messages) {
  const list = childrenOf.get(message.parent_id) ?? [];
  list.push(message);
  childrenOf.set(message.parent_id, list);
}

// Mark the branch currently in view so the abandoned ones are obvious.
const activePath = new Set<string>();
let cursor = chat.active_leaf_id;
while (cursor) {
  activePath.add(cursor);
  cursor = messages.find((m) => m.id === cursor)?.parent_id ?? null;
}

const ROLE = { user: "вы", assistant: "модель", system: "система" } as const;

function print(message: Message, prefix: string, last: boolean) {
  const children = childrenOf.get(message.id) ?? [];
  const active = activePath.has(message.id);
  const text = message.content.replace(/\s+/g, " ").trim().slice(0, 64);
  const marker = active ? "●" : "○";
  const tip = children.length === 0 ? "  ← конец ветки" : "";

  console.log(
    `${prefix}${last ? "└─ " : "├─ "}${marker} [${ROLE[message.role]}] ${text}${
      text.length === 64 ? "…" : ""
    }${tip}`,
  );

  const nextPrefix = prefix + (last ? "   " : "│  ");
  children.forEach((child, index) =>
    print(child, nextPrefix, index === children.length - 1),
  );
}

const roots = childrenOf.get(null) ?? [];
const leaves = messages.filter((m) => (childrenOf.get(m.id) ?? []).length === 0);

console.log(`\nЧат: ${chat.title}`);
console.log(`Сообщений: ${messages.length} · веток (концов): ${leaves.length}`);
console.log("● — текущая ветка, ○ — сохранённая, но не показанная сейчас\n");
roots.forEach((root, index) => print(root, "", index === roots.length - 1));
console.log();
