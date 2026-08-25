import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import PoppedPaneWindow from "./components/PoppedPaneWindow";
import "@xterm/xterm/css/xterm.css";
import "./styles/global.css";
import { initTheme } from "./lib/theme";
import { debugLog } from "./lib/tauri";
import { applyPaneFontSize, applyUiScale, getStoredPaneFontSize, getStoredUiScale } from "./lib/uiScale";

// Anything that escapes React's own boundaries: a throw inside an event
// handler, a rejected promise nobody awaited. These do not unmount the tree, so
// they are invisible on screen and were previously invisible everywhere else
// too — the native context menu is suppressed below, so there is no way to open
// the webview console and read them. Log them where the Rust side logs, and let
// the tree keep running.
window.addEventListener("error", (e) => {
  debugLog(`[ui-error] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ""}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  debugLog(`[ui-unhandled-rejection] ${r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r)}`);
});

// Apply the saved theme/text size before the first paint to avoid a flash
// of the defaults. initTheme also wires the OS-appearance listener so
// "inherit from system" tracks light/dark changes live.
initTheme();
applyUiScale(getStoredUiScale());
// Writes as well as applies: on the first launch after app and pane text size
// split apart, this is what freezes the pane size at whatever the old single
// setting produced, so the two stop moving together. See lib/uiScale.ts.
applyPaneFontSize(getStoredPaneFontSize());

// Block the native WebView context menu (Reload / Inspect Element).
// Our app renders its own context menu instead.
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// Popped-out agent windows load this same entry point with ?pane=<id> —
// render the lightweight single-pane shell instead of the full cockpit.
const params = new URLSearchParams(window.location.search);
const poppedPaneId = params.get("pane");

const root = (
  <React.StrictMode>
    {poppedPaneId ? (
      <ErrorBoundary label="This pane">
        <PoppedPaneWindow
          paneId={poppedPaneId}
          workspaceId={params.get("workspaceId") ?? ""}
          name={params.get("name") ?? ""}
          kind={params.get("kind") ?? ""}
          accent={params.get("accent") ?? "#7fb4f0"}
          sessionId={params.get("session") || undefined}
        />
      </ErrorBoundary>
    ) : (
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    )}
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById("root")!).render(root);
