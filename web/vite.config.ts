import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "../internal/panel/ui/dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:18080" } },
});
