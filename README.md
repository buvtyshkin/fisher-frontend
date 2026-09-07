# Fisher Frontend

Персональный фронтенд для длинных литературных ролевых игр с Claude через
прямой Anthropic API. Техзадание — в `SPEC.md`, правила работы — в `CLAUDE.md`.

## Стек

- **Сервер:** Node.js + TypeScript + Fastify
- **База:** SQLite (`better-sqlite3`), один файл в `data/fisher.db`
- **Интерфейс:** React + Vite, тёмная тема
- **Порт:** 8787 (SillyTavern на 8000 не трогаем)

## Запуск

```bash
npm install
cp .env.example .env    # и вписать ANTHROPIC_API_KEY
npm run dev             # сервер :8787 + интерфейс :5173
```

Открыть http://localhost:5173

Боевой режим (один процесс, отдаёт и API, и интерфейс):

```bash
npm run build
npm start               # http://localhost:8787
```

## Тесты

```bash
npm test
```

## Структура

```
server/        API и работа с базой
  config.ts      настройки из .env
  db.ts          схема SQLite
  store.ts       чтение/запись чатов и дерева сообщений
  provider.ts    адаптер Anthropic (интерфейс ProviderAdapter)
  routes/        HTTP-маршруты
web/           интерфейс (React)
test/          тесты
data/          база (в git не попадает)
```
