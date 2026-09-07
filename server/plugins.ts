import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyBaseLogger } from "fastify";
import type { Message } from "./db.js";

/**
 * Server-side plugins, loaded from plugins/ at startup.
 *
 * Three hooks, as in the spec. Everything future — a plot director, a
 * chronicler, an auditor — is meant to sit in one of these rather than in the
 * core. A throwing plugin is logged and skipped: an extension must never be
 * able to take a generation down with it.
 */

export interface PromptContext {
  chatId: string;
  branch: Message[];
  /** Mutable: a plugin may rewrite what is about to be sent. */
  system: string | Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
}

export interface ResponseContext {
  chatId: string;
  /** The stored reply, or null when generation failed before saving. */
  message: Message | null;
  text: string;
}

export interface PluginAction {
  /** Button label in the chat toolbar. */
  label: string;
  /** Title of the modal its result opens in. */
  title: string;
  run(context: { chatId: string; branch: Message[] }): Promise<string> | string;
}

export interface FisherPlugin {
  name: string;
  /** Runs before the request leaves; may mutate `system` and `messages`. */
  beforePromptBuild?(context: PromptContext): void | Promise<void>;
  /** Runs after a reply is stored. Awaited but never blocks the stream. */
  afterResponse?(context: ResponseContext): void | Promise<void>;
  /** Transforms a message on its way to the UI. Must be pure and fast. */
  onMessageRender?(message: Message): Message;
  /** A toolbar button plus the modal its result lands in. */
  action?: PluginAction;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Dev runs server/*.ts, production runs dist/server/*.js; plugins sit beside.
const PLUGIN_DIR = path.resolve(here, "../plugins");

let loaded: FisherPlugin[] = [];

export function loadedPlugins(): FisherPlugin[] {
  return loaded;
}

export async function loadPlugins(log: FastifyBaseLogger): Promise<void> {
  loaded = [];
  if (!fs.existsSync(PLUGIN_DIR)) {
    log.info({ dir: PLUGIN_DIR }, "папки плагинов нет — пропускаю");
    return;
  }

  const files = fs
    .readdirSync(PLUGIN_DIR)
    .filter((file) => /\.(ts|js|mjs)$/.test(file) && !file.endsWith(".d.ts"))
    .sort();

  for (const file of files) {
    try {
      const module = (await import(path.join(PLUGIN_DIR, file))) as {
        default?: FisherPlugin;
      };
      const plugin = module.default;
      if (!plugin?.name) {
        log.warn({ file }, "плагин без default-экспорта или без имени — пропущен");
        continue;
      }
      loaded.push(plugin);
      log.info({ plugin: plugin.name, file }, "плагин загружен");
    } catch (error) {
      log.error({ file, err: error }, "плагин не загрузился");
    }
  }
}

/** A hook must not be able to break a generation, so failures are logged only. */
async function safely(
  log: FastifyBaseLogger,
  plugin: FisherPlugin,
  hook: string,
  run: () => void | Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log.error({ plugin: plugin.name, hook, err: error }, "хук плагина упал");
  }
}

export async function runBeforePromptBuild(
  log: FastifyBaseLogger,
  context: PromptContext,
): Promise<PromptContext> {
  for (const plugin of loaded) {
    if (!plugin.beforePromptBuild) continue;
    await safely(log, plugin, "beforePromptBuild", () =>
      plugin.beforePromptBuild!(context),
    );
  }
  return context;
}

export async function runAfterResponse(
  log: FastifyBaseLogger,
  context: ResponseContext,
): Promise<void> {
  for (const plugin of loaded) {
    if (!plugin.afterResponse) continue;
    await safely(log, plugin, "afterResponse", () => plugin.afterResponse!(context));
  }
}

export function runOnMessageRender(
  log: FastifyBaseLogger,
  messages: Message[],
): Message[] {
  const renderers = loaded.filter((plugin) => plugin.onMessageRender);
  if (renderers.length === 0) return messages;

  return messages.map((message) => {
    let current = message;
    for (const plugin of renderers) {
      try {
        current = plugin.onMessageRender!(current) ?? current;
      } catch (error) {
        log.error({ plugin: plugin.name, err: error }, "onMessageRender упал");
      }
    }
    return current;
  });
}
