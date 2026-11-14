// What the new-agent composer can carry besides its text: screenshots and
// files, pasted, dropped or picked.
//
// The first prompt rides on the agent's command line (see launch.ts), so an
// attachment has to be on disk, inside the folder the agent starts in, before
// the agent exists. Images are staged into that folder's `.flock/images/` —
// the same place an image pasted into a terminal goes, so a jailed agent can
// read it too — and named in the prompt by their short relative path, which
// Claude Code reads like any image path you give it. Other files are named by
// their own path, the way a file dropped on a terminal is typed.

import { readImageFilesFromPaths, stageComposerImage } from "../lib/tauri";
import { isImagePath } from "../lib/imageAttach";

export interface ComposerImage {
  id: string;
  kind: "image";
  name: string;
  data: Uint8Array;
  ext: string;
}

export interface ComposerFile {
  id: string;
  kind: "file";
  name: string;
  path: string;
}

export type ComposerAttachment = ComposerImage | ComposerFile;

/** More than this in one prompt is a mistake, not a task. */
export const MAX_ATTACHMENTS = 12;

let seq = 0;
const nextId = () => `att-${Date.now().toString(36)}-${++seq}`;

export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export function imageAttachment(data: Uint8Array, ext: string, name?: string): ComposerImage {
  return { id: nextId(), kind: "image", name: name ?? `Screenshot.${ext}`, data, ext };
}

/** Dropped or picked paths as attachments: images read into bytes (so they
 *  can be previewed and staged like a paste), anything else kept as a path. */
export async function attachmentsFromPaths(paths: string[]): Promise<ComposerAttachment[]> {
  const out: ComposerAttachment[] = [];
  for (const path of paths) {
    if (isImagePath(path)) {
      const [img] = await readImageFilesFromPaths([path]).catch(() => []);
      if (img) {
        out.push(imageAttachment(img.data, img.ext, baseName(path)));
        continue;
      }
    }
    out.push({ id: nextId(), kind: "file", name: baseName(path), path });
  }
  return out;
}

/** The line that hands the attachments to the agent. */
export function attachmentLine(refs: string[]): string {
  return refs.length === 0 ? "" : `Attached: ${refs.join(", ")}`;
}

/** The text and its attachments as one first prompt. */
export function joinPrompt(text: string, refs: string[]): string {
  const line = attachmentLine(refs);
  if (!line) return text;
  return text ? `${text}\n\n${line}` : line;
}

/**
 * The first prompt for an agent starting in `cwd`, with its attachments
 * staged there and named at the end. An image that cannot be staged is left
 * out and counted, so the agent still starts with everything else.
 */
export async function promptWithAttachments(
  text: string,
  attachments: ComposerAttachment[] | undefined,
  workspaceId: string,
  cwd: string,
): Promise<{ prompt: string; failed: number }> {
  if (!attachments || attachments.length === 0) return { prompt: text, failed: 0 };
  const refs: string[] = [];
  let failed = 0;
  for (const a of attachments) {
    if (a.kind === "file") {
      refs.push(a.path);
      continue;
    }
    try {
      refs.push(await stageComposerImage(workspaceId, cwd, a.data, a.ext));
    } catch (e) {
      console.error("staging a composer image failed", e);
      failed++;
    }
  }
  return { prompt: joinPrompt(text, refs), failed };
}
