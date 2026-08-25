// Prompt-queue capture helpers (logic only, no JSX).
//
// A small clipboard-image scan parallel to Terminal.tsx's `onPaste`, kept
// deliberately separate from imageAttach.ts's `handleImagePaste`: that function
// is pane-scoped end to end (stages into a live pane's cwd + types + shows a DOM
// pill). The capture overlay has no pane yet — it only accumulates bytes into
// React state until `queueAdd` ships them at save time.

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg",
]);

function extFromMime(mime: string): string {
  const sub = mime.split("/")[1]?.toLowerCase() ?? "";
  if (sub === "jpeg") return "jpg";
  if (sub === "svg+xml") return "svg";
  return IMAGE_EXTS.has(sub) ? sub : "png";
}

export interface PastedImage {
  data: Uint8Array;
  ext: string;
}

/** Synchronously collect any image Files from a paste event. This MUST run
 * during the event dispatch (before any await): both `getAsFile()` and the
 * `DataTransferItemList` are only valid then — read bytes afterwards.
 *
 * Two sources, because they disagree by app: a screenshot on the OS clipboard
 * comes through `items` as `kind: "file"`, but an image copied out of Apple
 * Notes (and some other native apps) shows up only in `clipboardData.files`,
 * frequently as `image/tiff`. Scan both so either path attaches. */
export function pastedImageFiles(e: ClipboardEvent): File[] {
  const dt = e.clipboardData;
  if (!dt) return [];
  const files: File[] = [];
  const items = dt.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  // Fallback: some apps (Notes) populate .files but not the items list.
  if (files.length === 0 && dt.files) {
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files[i];
      if (f.type.startsWith("image/")) files.push(f);
    }
  }
  return files;
}

/** Read collected image Files into raw bytes + normalized ext. Safe to await —
 * the Files are already detached from the (transient) clipboard event. */
export function readImageFiles(files: File[]): Promise<PastedImage[]> {
  return Promise.all(
    files.map(async (f) => ({
      data: new Uint8Array(await f.arrayBuffer()),
      ext: extFromMime(f.type),
    })),
  );
}
