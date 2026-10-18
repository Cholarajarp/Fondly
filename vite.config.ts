import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests use fakes: keep the real .env provider keys out (dotenv never overrides a set variable).
    env: { NVIDIA_API_KEY: "", LLM_PROVIDER: "" },
  },
});
