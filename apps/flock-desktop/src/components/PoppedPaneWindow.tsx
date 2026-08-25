import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Terminal from "./Terminal";
import VoiceOverlay from "./VoiceOverlay";
import AgentKindBadge from "./AgentKindBadge";
import ContextMeter from "./ContextMeter";
import { useVoicePushToTalk } from "../lib/useVoicePushToTalk";
import { usePtyFileDrop } from "../lib/usePtyFileDrop";
import { stepPaneFontSize } from "../lib/uiScale";
import { summonPalette } from "../lib/paletteBridge";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

interface Props {
  paneId: string;
  workspaceId: string;
  name: string;
  kind: string;
  accent: string;
  /** claude only, and only once the pane has one — feeds the context meter. */
  sessionId?: string;
}

/** Standalone single-agent window opened via "pop out" — a lightweight
 * chrome (name/kind label + return button) wrapping one Terminal, loosely
 * coupled from the main app window.
 *
 * A popout window can never *lose* the agent: every way of closing it
 * (traffic-light button, the "return to workspace" button, ⌘W) just
 * detaches the window — the agent keeps running, and the main window's
 * Rust-side on_window_event hook (see src-tauri/src/lib.rs) notices the
 * window was destroyed while the pane is still alive and folds it back
 * into the tab it came from. Terminating an agent is deliberately only
 * possible from the main grid, where the pane's × button lives — a
 * destructive action doesn't belong on a window whose entire semantic is
 * "temporarily elsewhere".
 *
 * The return goes through the Rust Destroyed hook rather than this window
 * emitting an event from inside its own close-requested handler — doing it
 * from there risked contending with Tauri's own close-negotiation state
 * for this same window, which used to hang the whole app. */
export default function PoppedPaneWindow({ paneId, name, kind, accent, sessionId }: Props) {
  const returnToWorkspace = () => {
    getCurrentWindow().close().catch(console.error);
  };

  // Push-to-talk dictation travels with the popped-out agent — the text goes
  // into this window's pane.
  const { voiceHud, voiceLevel } = useVoicePushToTalk({ getTargetPaneId: () => paneId });

  // Files dropped anywhere on this window land in this pane's PTY.
  usePtyFileDrop();

  // ⌘+ / ⌘- resize agent panes here too, and ⌘K reaches the cockpit's command
  // bar. A popped-out window is its own webview and never sees the cockpit's
  // keydown handler, so this is a second (small) copy rather than a shared
  // hook; the text size is one global preference, so stepping it here also
  // resizes the panes back in the main window — see the storage bridge in
  // lib/uiScale.ts, which is the same mechanism lib/paletteBridge.ts uses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === "k" && !e.shiftKey) {
        // Every command acts on cockpit state, so the palette opens there and
        // takes focus with it rather than being mirrored into this window.
        e.preventDefault();
        summonPalette();
        WebviewWindow.getByLabel("main").then((w) => w?.setFocus()).catch(() => {});
        return;
      }
      const grow = e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd";
      const shrink = e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract";
      if (!grow && !shrink) return;
      e.preventDefault();
      stepPaneFontSize(grow ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="popout-shell" style={{ ["--accent" as never]: accent }}>
      {/* Empty draggable strip so the traffic-light overlay has clear space
       * above the real content — same pattern as the main window's .titlebar,
       * otherwise the buttons sit on top of the name/kind text. */}
      {/* See the titlebar in App.tsx: on macOS this attribute is the only
          window-drag mechanism — the CSS -webkit-app-region below it is a
          Windows-only path and does nothing under WKWebView. */}
      <div className="popout-titlebar" data-tauri-drag-region />
      <div className="popout-topbar" data-tauri-drag-region>
        <span className="popout-accent" />
        {name && <span className="popout-name">{name}</span>}
        <AgentKindBadge kind={kind} />
        <ContextMeter kind={kind} sessionId={sessionId} />
        <div className="spacer" />
        <span
          className="popout-return-btn"
          title="Fold this agent back into its workspace"
          onClick={returnToWorkspace}
        >
          ⇥ return to workspace
        </span>
      </div>
      <div className="popout-body" data-pane-id={paneId}>
        {/* Sole resizePty driver while this window is live: every grid
            Terminal for this paneId is marked not-visible (see poppedOutIds
            in App / PaneArea), so this instance can keep visible={true}
            without fighting a tile that still lays the id out. `primary`
            is not what does that — it is the default, and it gates stream
            mirroring and registry ownership, which in this webview are its
            own. Left off so nothing reads it as the mechanism. */}
        <Terminal paneId={paneId} focused={true} visible={true} />
      </div>
      {voiceHud && <VoiceOverlay status={voiceHud.status} level={voiceLevel} locked={voiceHud.locked} />}
    </div>
  );
}
