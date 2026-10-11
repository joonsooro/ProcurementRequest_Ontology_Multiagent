/**
 * Frontend build/dev configuration. Read root environment values, inject DEMO_NOW,
 * and proxy local API calls to the ontology server during development.
 */
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  // Read the workspace .env, but inject only the demo date into the browser bundle.
  const env = loadEnv(mode, repoRoot, "");
  return {
    plugins: [react()],
    optimizeDeps: {
      // Bundle the supplied locale up front instead of Blueprint's dynamic import.
      include: ["date-fns/locale/en-US/index.js"],
    },
    // Browser calculations use this fixed build/dev value; the server maintains its own advancing demo clock.
    define: {
      "import.meta.env.DEMO_NOW": JSON.stringify(env.DEMO_NOW ?? ""),
    },
    server: {
      // Bind consistently to loopback IPv4 so browser reconnects survive config reloads.
      host: '127.0.0.1', port: 5174, strictPort: true,
      // Relative /api requests share the frontend origin while the dev server forwards them to Hono.
      proxy: {
        "/api": `http://localhost:${env.PORT ?? "3010"}`,
      },
    },
  };
});
