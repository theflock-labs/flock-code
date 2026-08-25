// Seamless image paste/drop for agent panes.
//
// The agent runs in a raw PTY and fully owns its input line, so we can't reskin
// it into a chip ourselves. We tried leaning on Claude's own clipboard-image
// handling (send Ctrl+V / 0x16 so Claude reads the OS clipboard), but that does
// NOT work over a raw PTY byte — Claude ends up referencing an image path that
// isn't there ("the image isn't present at that path"). So instead we always
// materialize the image ourselves:
//
//   Stage the image into the workspace's `.flock/images/` and hand the short
//   workspace-relative path (`.flock/images/img-1.png`) to the agent instead
//   of a long absolute temp path, plus a floating `[image #N]` pill so the
//   attach is visible. This is deterministic, works for every agent, and works
//   in secure mode (the container bind-mounts the workspace, so the file is
//   right there).
//
// CRUCIAL DETAIL — how the path is delivered: we send it as a *bracketed paste*
// (ESC[200~ … ESC[201~), NOT as raw keystrokes. Claude Code auto-detects an
// image file path and turns it into a native `[Image #N]` attachment, but that
// detection fires on *pasted* input — a real terminal delivers drag-and-drop /
// Cmd+V text bracketed, and that's the signal Claude keys off. Sending the same
// bytes as individual keystrokes is treated as literal typed text and never
// becomes an attachment (the agent then has to `Read` the path by hand — the
// exact clunky round-trip this is meant to avoid). Bracketing degrades safely:
// any agent that doesn't special-case image paths just receives the path text,
// exactly as before, since bracketed paste is universally enabled at an
// interactive prompt (agent TUIs and zsh alike set DECSET 2004).
//
// The staging dir is resolved backend-side from the pane's real spawn cwd (see
// stage_image_* commands), so this needs nothing but the pane id — no fragile
// tracking of the working directory through the DOM.

import { readImageFilesFromPaths, sendInput, stageImageBytes, stageImageFile } from "./tauri";
import { flashPanePill } from "./panePill";
import { noteInjectedInput } from "./terminalRegistry";

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg",
]);

/** Does this path look like an image we should stage rather than type raw? */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}

function extFromMime(mime: string): string {
  const sub = mime.split("/")[1]?.toLowerCase() ?? "";
  if (sub === "jpeg") return "jpg";
  if (sub === "svg+xml") return "svg";
  return IMAGE_EXTS.has(sub) ? sub : "png";
}

/** Quote a path for a POSIX shell — bare when safe, single-quoted otherwise.
 * Staged names (`.flock/images/img-1.png`) never need quoting; this is for
 * the non-image file-drop passthrough that still types raw paths. */
export function shellQuote(p: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;
}

// The N in `[image #N]` — parsed from the staged filename so the pill and the
// file on disk always agree.
function seqFromRel(rel: string): string {
  return rel.match(/img-(\d+)\./)?.[1] ?? "1";
}

/**
 * Handle one or more pasted clipboard images on a focused pane. Returns true if
 * it consumed the paste (so the caller should preventDefault and not let the
 * terminal also process it), false if there was nothing to do.
 */
export async function handleImagePaste(paneId: string, blobs: Blob[]): Promise<boolean> {
  if (blobs.length === 0) return false;
  for (const blob of blobs) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const rel = await stageImageBytes(paneId, bytes, extFromMime(blob.type));
      await typeStagedImage(paneId, rel);
    } catch (e) {
      console.error("stage pasted image failed", e);
      showImagePill(paneId, null);
    }
  }
  return true;
}

/**
 * Handle image files dropped onto a pane from Finder. `paths` are the images
 * only (caller filters non-images out).
 */
export async function handleImageDrop(paneId: string, paths: string[]): Promise<void> {
  for (const src of paths) {
    try {
      const rel = await stageImageFile(paneId, src);
      await typeStagedImage(paneId, rel);
    } catch (e) {
      console.error("stage dropped image failed", e);
      showImagePill(paneId, null);
    }
  }
}

// Send the staged relative path into the PTY as a bracketed paste (so Claude
// Code recognizes it as an attachable image path — see the module header),
// followed by a plain space so the prompt is ready to keep going. Flash the
// pill either way.
async function typeStagedImage(paneId: string, rel: string): Promise<void> {
  const enc = new TextEncoder();
  // The path is bracketed; the trailing space is sent as an ordinary keystroke
  // *outside* the brackets so the pasted token is exactly the path (a clean
  // path is the most reliable thing for Claude's detector to match).
  const paste = `\x1b[200~${shellQuote(rel)}\x1b[201~`;
  await sendInput(paneId, enc.encode(paste)).catch(console.error);
  await sendInput(paneId, enc.encode(" ")).catch(console.error);
  // These bytes go straight to the PTY, never through xterm's onData, so tell
  // the input-line sniffer about them — otherwise "Send to Prompt Queue" drops
  // the image path (and clears the wrong number of characters after it).
  noteInjectedInput(paneId, `${paste} `);
  showImagePill(paneId, seqFromRel(rel));
}

// Staged refs as they appear in an input line: `.flock/images/img-3.png`.
const STAGED_IMAGE_RE =
  /(?:\.\/)?\.flock\/images\/[A-Za-z0-9_.-]+\.(?:png|jpg|jpeg|gif|webp|bmp|tiff?|heic|heif|avif|svg)/gi;

/**
 * Lift staged image refs out of a captured input line into real bytes, so a
 * prompt sent to the queue carries its screenshots the same way a ⌘⇧P capture
 * does. Without this the queue would store a workspace-relative path that only
 * resolves in the workspace it was captured in — and only for as long as the
 * file survives there.
 *
 * `cwd` is the pane's working directory (where `.flock/images/` lives).
 * Falls back to the untouched text if anything can't be read, so a queued
 * prompt is never lost to a missing file.
 */
export async function detachStagedImages(
  text: string,
  cwd: string,
): Promise<{ text: string; images: { data: Uint8Array; ext: string }[] }> {
  const rels = text.match(STAGED_IMAGE_RE);
  if (!rels || rels.length === 0 || !cwd) return { text, images: [] };
  const base = cwd.replace(/\/+$/, "");
  try {
    const images = await readImageFilesFromPaths(
      rels.map((r) => `${base}/${r.replace(/^\.\//, "")}`),
    );
    if (images.length !== rels.length) return { text, images: [] };
    // Collapse only horizontal whitespace — a multi-line prompt keeps its shape.
    const stripped = text.replace(STAGED_IMAGE_RE, " ").replace(/[ \t]+/g, " ").trim();
    return { text: stripped, images };
  } catch (e) {
    console.error("reading staged images for the queue failed", e);
    return { text, images: [] };
  }
}

// A short-lived `[image #N]` chip over the pane, so a staged attach reads like
// Claude's own chip even though the actual reference typed is a path. `seq` null
// means the attach failed — show an error pill instead so it's never silent.
function showImagePill(paneId: string, seq: string | null): void {
  if (seq === null) flashPanePill(paneId, "image attach failed", true);
  else flashPanePill(paneId, `image #${seq}`);
}
