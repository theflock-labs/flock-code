// Drop files onto a terminal pane → their shell-quoted paths are typed into
// that pane's PTY, exactly like dropping a file on Terminal.app or iTerm2.
// This is how you hand a screenshot to an agent: drag it from the screenshot
// preview / Finder onto the agent's pane.
//
// Native file drags never reach the DOM in Tauri (the webview intercepts
// them for security — HTML5 drop events carry no real paths), so this uses
// Tauri's drag-drop event stream and hit-tests the hover position against
// [data-pane-id] elements manually.

import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { sendInput } from "./tauri";
import { handleImageDrop, isImagePath, shellQuote } from "./imageAttach";
import { noteInjectedInput } from "./terminalRegistry";

/**
 * Enable file-drop-to-PTY for every [data-pane-id] element in this webview.
 * Mounted once per window (main + each popout). The hovered pane gets a
 * .drop-target class for the highlight ring while a drag is over it.
 */
export function usePtyFileDrop() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let hovered: HTMLElement | null = null;

    const clearHover = () => {
      hovered?.classList.remove("drop-target");
      hovered = null;
    };

    // The event's position is typed PhysicalPosition, but on macOS the value
    // is a lie: wry passes NSView's draggingLocation through raw, which is
    // already logical (CSS) points, and tauri-runtime-wry just relabels the
    // tuple as physical. Dividing by devicePixelRatio there halves correct
    // coordinates on Retina, so every hit-test landed in the window's
    // top-left quadrant — drop on pane 2, paste into pane 1. Windows/Linux
    // genuinely deliver physical pixels and do need the divide.
    const isMac = navigator.userAgent.includes("Mac");
    const paneAt = (pos: { x: number; y: number }): HTMLElement | null => {
      // Read devicePixelRatio per event — it changes when the window moves
      // to a monitor with a different scale.
      const scale = isMac ? 1 : window.devicePixelRatio || 1;
      const el = document.elementFromPoint(pos.x / scale, pos.y / scale);
      return (el?.closest?.("[data-pane-id]") as HTMLElement | null) ?? null;
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          const el = paneAt(payload.position);
          if (el !== hovered) {
            clearHover();
            hovered = el;
            el?.classList.add("drop-target");
          }
        } else if (payload.type === "drop") {
          const el = paneAt(payload.position) ?? hovered;
          clearHover();
          const paneId = el?.dataset.paneId;
          if (paneId && payload.paths.length > 0) {
            // Split image drops out: those get copied into the workspace and
            // referenced by a short relative path (+ a `[image #N]` pill), so a
            // dropped screenshot reads cleanly and works even in a container.
            // Everything else keeps the Terminal.app convention — the raw
            // shell-quoted path typed straight into the PTY.
            const images = payload.paths.filter(isImagePath);
            const others = payload.paths.filter((p) => !isImagePath(p));
            if (images.length > 0) {
              handleImageDrop(paneId, images).catch(console.error);
            }
            if (others.length > 0) {
              // Trailing space so the agent's prompt is ready for the user (or
              // the next drop) to continue — same convention as Terminal.app.
              const text = others.map(shellQuote).join(" ") + " ";
              sendInput(paneId, new TextEncoder().encode(text)).catch(console.error);
              noteInjectedInput(paneId, text); // keep the input-line sniffer in sync
            }
          }
        } else {
          clearHover(); // leave / cancelled
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      clearHover();
      unlisten?.();
    };
  }, []);
}
