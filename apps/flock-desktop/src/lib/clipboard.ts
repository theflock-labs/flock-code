// Clipboard writes routed through the native pasteboard (Tauri's
// clipboard-manager plugin) instead of navigator.clipboard. WKWebView rejects
// navigator.clipboard.writeText whenever the document isn't focused — select
// text, Cmd+Tab away before the async write lands, and the copy silently
// fails, leaving the *previous* clipboard content to come out of the next
// paste. The plugin writes NSPasteboard directly with no focus requirement.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Copy text to the OS clipboard. Rejects if both the native write and the
 * web-API fallback fail — callers surface that instead of swallowing it. */
export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
