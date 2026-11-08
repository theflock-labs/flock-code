import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The UI harness (src/dev/harness.ts): the real App in a browser with Tauri's
// IPC mocked and a signed-in identity, for working on the interface without
// the desktop shell. Never bundled into the app.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^\.\/lib\/useFlockId$/, replacement: fileURLToPath(new URL("./src/dev/fakeIdentity.ts", import.meta.url)) },
      { find: /^\.\.\/lib\/flockId$/, replacement: fileURLToPath(new URL("./src/dev/fakeFlockId.ts", import.meta.url)) },
    ],
  },
  // No flock ID backend: nothing in the harness may reach the network.
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(""),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(""),
  },
  server: { port: 1430, strictPort: true },
});
