import React from "react";
import { copyText } from "../lib/clipboard";
import { debugLog } from "../lib/tauri";

// The cockpit is one React tree. Without a boundary, one thrown render
// anywhere in it unmounts everything and leaves a black window — no sidebar,
// no terminals, no way back except quitting the app.
//
// The recovery is better than it looks: agents are PTYs owned by Rust, not by
// this webview. They keep running through a render crash, and remounting the
// tree re-subscribes to their live output and replays the ring buffer. So the
// honest instruction here is "reload", not "restart" and not "sorry".

interface Props {
  children: React.ReactNode;
  /** Names the failing region in the copy, e.g. "flock" or "this pane". */
  label?: string;
}

interface State {
  error: Error | null;
  /** Component stack from React, which is what actually locates the bug. */
  stack: string | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ stack: info.componentStack ?? null });
    // Into ~/.flock/desktop.log alongside the Rust side, so a crash report is
    // one file rather than a screenshot of a webview console the user cannot
    // open (the native context menu is suppressed in main.tsx).
    debugLog(
      `[ui-crash] ${error.name}: ${error.message}\n${error.stack ?? ""}\n` +
        `component stack:${info.componentStack ?? " (none)"}`,
    );
  }

  private details(): string {
    const e = this.state.error;
    return [
      `${e?.name ?? "Error"}: ${e?.message ?? "unknown"}`,
      e?.stack ?? "",
      this.state.stack ? `component stack:${this.state.stack}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  render() {
    if (!this.state.error) return this.props.children;
    const label = this.props.label ?? "flock";
    return (
      <div className="crash" role="alert">
        <div className="crash-box">
          <div className="crash-title">{label} hit an error and stopped drawing</div>
          <p className="crash-body">
            Your agents are still running — they live outside this window, and reloading
            reattaches to them with their scrollback intact.
          </p>
          <pre className="crash-detail">{this.details()}</pre>
          <div className="crash-actions">
            <button type="button" className="crash-btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button
              type="button"
              className="crash-btn"
              onClick={() => copyText(this.details()).catch(() => {})}
            >
              Copy details
            </button>
          </div>
          <div className="crash-foot">Also written to ~/.flock/desktop.log</div>
        </div>
      </div>
    );
  }
}
