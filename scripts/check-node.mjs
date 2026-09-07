// Runs before dev/build/start/test. Must stay plain, dependency-free ES modules
// so it works on whatever old Node the user happens to have active — otherwise
// they get NODE_MODULE_VERSION gibberish from better-sqlite3 instead of advice.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wanted = Number(
  fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "").split(".")[0],
);
const actual = Number(process.versions.node.split(".")[0]);

if (actual !== wanted) {
  const line = "─".repeat(58);
  process.stderr.write(
    `\n${line}\n` +
      `  Нужен Node ${wanted}, а сейчас запущен Node ${process.versions.node}\n\n` +
      `  Выполните в этой же папке:\n\n` +
      `      nvm use\n\n` +
      `  Версия берётся из файла .nvmrc.\n` +
      `  Если команда nvm не найдена — откройте новый терминал\n` +
      `  или выполните сначала:  source ~/.nvm/nvm.sh\n` +
      `${line}\n\n`,
  );
  process.exit(1);
}
