import { beforeEach, describe, expect, it, vi } from "vitest";

const stage = vi.fn();
const readImages = vi.fn();
vi.mock("../lib/tauri", () => ({
  stageComposerImage: (...a: unknown[]) => stage(...a),
  readImageFilesFromPaths: (...a: unknown[]) => readImages(...a),
}));

import { attachmentsFromPaths, imageAttachment, joinPrompt, promptWithAttachments } from "./attachments";

describe("composer attachments", () => {
  beforeEach(() => {
    stage.mockReset();
    readImages.mockReset();
  });

  it("names the attachments on a line after the text", () => {
    expect(joinPrompt("Fix the header", [".flock/images/img-1.png"])).toBe("Fix the header\n\nAttached: .flock/images/img-1.png");
    expect(joinPrompt("", [".flock/images/img-1.png", "/tmp/spec.pdf"])).toBe("Attached: .flock/images/img-1.png, /tmp/spec.pdf");
    expect(joinPrompt("Just text", [])).toBe("Just text");
  });

  it("stages images into the agent's folder and keeps files as paths", async () => {
    stage.mockResolvedValueOnce(".flock/images/img-3.png");
    const img = imageAttachment(new Uint8Array([1, 2, 3]), "png");
    const out = await promptWithAttachments(
      "Make it match",
      [img, { id: "f", kind: "file", name: "spec.pdf", path: "/Users/sam/spec.pdf" }],
      "ws-1",
      "/Users/sam/storefront",
    );
    expect(stage).toHaveBeenCalledWith("ws-1", "/Users/sam/storefront", img.data, "png");
    expect(out).toEqual({ prompt: "Make it match\n\nAttached: .flock/images/img-3.png, /Users/sam/spec.pdf", failed: 0 });
  });

  it("starts with the rest when an image cannot be staged", async () => {
    stage.mockRejectedValueOnce(new Error("that folder is not part of this project"));
    const out = await promptWithAttachments("Look", [imageAttachment(new Uint8Array([1]), "png")], "ws-1", "/x");
    expect(out).toEqual({ prompt: "Look", failed: 1 });
  });

  it("reads dropped images into bytes and keeps other files as paths", async () => {
    readImages.mockResolvedValueOnce([{ data: new Uint8Array([9]), ext: "png" }]);
    const out = await attachmentsFromPaths(["/Users/sam/Desktop/Bug.png", "/Users/sam/notes.md"]);
    expect(out.map((a) => [a.kind, a.name])).toEqual([["image", "Bug.png"], ["file", "notes.md"]]);
  });
});
