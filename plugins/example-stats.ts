import type { FisherPlugin } from "../server/plugins.js";

/**
 * Пример плагина — он же документация к трём хукам.
 *
 * Плагин — это файл в папке plugins/, который экспортирует по умолчанию объект
 * с именем и любыми из хуков. Ядро его не знает: чтобы добавить свой, положите
 * рядом такой же файл и перезапустите сервер.
 *
 * Этот плагин ничего не меняет в промпте — он только считает. Удалять его
 * не нужно: без кнопки «Статистика» он ничего не делает.
 */

/** Слова считаем грубо: для оценки объёма этого достаточно. */
const countWords = (text: string) =>
  text.split(/\s+/).filter((word) => word.length > 0).length;

const plugin: FisherPlugin = {
  name: "example-stats",

  /**
   * Вызывается перед отправкой запроса. Здесь можно дописать или переписать
   * `system` и `messages` — например, подмешать заметку режиссёра сюжета.
   * Мы ничего не меняем, только смотрим, что уходит.
   */
  beforePromptBuild(context) {
    const size = context.messages.reduce(
      (sum, message) => sum + String(message.content).length,
      0,
    );
    console.log(
      `[example-stats] уходит ${context.messages.length} сообщений, ${size} символов`,
    );
  },

  /**
   * Вызывается после того, как ответ сохранён. Асинхронный — сюда встанут
   * хронисты и аудиторы, которым нужно сходить в модель ещё раз.
   */
  afterResponse(context) {
    console.log(
      `[example-stats] ответ сохранён: ${countWords(context.text)} слов`,
    );
  },

  /**
   * Вызывается для каждого сообщения по пути в интерфейс. Должен быть быстрым
   * и не иметь побочных эффектов: он выполняется на каждой отрисовке ветки.
   * Возвращать нужно сообщение — изменённое или то же самое.
   */
  onMessageRender(message) {
    return message;
  },

  /**
   * Кнопка в шапке чата и модальное окно с результатом.
   */
  action: {
    label: "Статистика",
    title: "Статистика ветки",
    run({ branch }) {
      const mine = branch.filter((message) => message.role === "user");
      const theirs = branch.filter((message) => message.role === "assistant");
      const words = (messages: typeof branch) =>
        messages.reduce((sum, message) => sum + countWords(message.content), 0);

      const hidden = branch.filter((message) => message.hidden_from_prompt === 1);
      const spent = branch.reduce((sum, message) => sum + (message.cost_usd ?? 0), 0);

      return [
        `Сообщений в ветке: ${branch.length}`,
        `  ваших: ${mine.length}, слов: ${words(mine)}`,
        `  модели: ${theirs.length}, слов: ${words(theirs)}`,
        `Скрыто из промпта: ${hidden.length}`,
        `Потрачено на эту ветку: $${spent.toFixed(4)}`,
      ].join("\n");
    },
  },
};

export default plugin;
