import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The website's demo (src/dev/demo.ts): the real App, built as a static page
// that plays a short story with made-up projects, agents and people. Tauri's
// IPC is mocked, and nothing in it may reach the network: no flock ID, no
// presence. Never bundled into the app. Build: npm run demo:build.
const dev = (f: string) => fileURLToPath(new URL(`./src/dev/${f}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Served from theflock.sh/demo, which Vercel answers without the trailing
  // slash (trailingSlash: false): relative asset URLs would resolve against
  // the site root there, so they are absolute.
  base: "/demo/",
  resolve: {
    alias: [
      { find: /^\.\/lib\/useFlockId$/, replacement: dev("demoIdentity.ts") },
      { find: /^\.\.\/lib\/flockId$/, replacement: dev("fakeFlockId.ts") },
      { find: /^(\.\/|\.\.\/)(lib\/)?presence$/, replacement: dev("fakePresence.ts") },
      { find: /^\.\/lib\/agentNames$/, replacement: dev("demoAgentNames.ts") },
    ],
  },
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(""),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(""),
  },
  build: {
    // The entry awaits the app's import at the top level.
    target: "es2022",
    outDir: "dist-demo",
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./demo.html", import.meta.url)) },
  },
  server: { port: 1431, strictPort: true },
});
