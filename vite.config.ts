import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the UI on 5173 and proxies /api to the Fastify server.
// Prod: `vite build` emits dist-web/, which Fastify serves as static files.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist-web", emptyOutDir: true },
  server: {
    port: 5173,
    host: true,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
});
