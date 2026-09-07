import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { chatRoutes } from "./routes/chats.js";

const app = Fastify({ logger: { level: "info" } });

await app.register(chatRoutes);

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
