import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: `npm run dev` on :5173 proxies /api to the Flask app (PORT, default 5050).
// Build: output goes to dashboard/static/app, which Flask serves at /.
const api = `http://localhost:${process.env.API_PORT ?? "5050"}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dashboard/static/app", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { proxy: { "/api": { target: api, changeOrigin: true } } },
});
