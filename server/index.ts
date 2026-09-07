import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { config } from "./config.js";
import { chatRoutes } from "./routes/chats.js";
import { libraryRoutes } from "./routes/library.js";
import { chronicleRoutes } from "./routes/chronicles.js";
import { loadPlugins } from "./plugins.js";
import { startCacheRefresher } from "./cache-refresher.js";

const app = Fastify({ logger: { level: "info" } });

// Character cards are PNGs; a big portrait can legitimately be a few megabytes.
await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });
await loadPlugins(app.log);
await app.register(chatRoutes);
await app.register(libraryRoutes);
await app.register(chronicleRoutes);

app.get("/api/health", async () => ({
  ok: true,
  model: config.model,
  thinking: config.thinking,
}));

// In production the built UI is served from dist-web/. In dev, Vite serves it.
const webRoot = path.resolve(process.cwd(), "dist-web");
if (fs.existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

await app.listen({ port: config.port, host: config.host });

startCacheRefresher(app.log);
