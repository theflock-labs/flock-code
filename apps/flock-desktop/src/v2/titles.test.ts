import { describe, expect, it } from "vitest";
import { latestTask, looksLikeTask, sameTitle, titleFromPrompt, TITLE_MAX } from "./titles";

describe("titleFromPrompt", () => {
  it("names a thread after its first task", () => {
    expect(titleFromPrompt("fix the login redirect on safari")).toBe("Fix the login redirect on safari");
  });

  it("keeps the first sentence when there is one", () => {
    expect(
      titleFromPrompt("Make the docs page searchable. Also the header is too tall, and the footer needs work."),
    ).toBe("Make the docs page searchable");
  });

  it("cuts a long first line at a word and says so", () => {
    const t = titleFromPrompt(
      "try to make the font smaller overall so we can fit more on one page also the narrow band for the actual content is troubling me",
    )!;
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(t.endsWith("…")).toBe(true);
    expect(t.startsWith("Try to make the font smaller")).toBe(true);
    expect(t).not.toMatch(/\s…$/);
  });

  it("drops attached images and links", () => {
    expect(titleFromPrompt(".flock/images/img-72.png then we need to find a way to control how it triggers")).toBe(
      "Then we need to find a way to control how it triggers",
    );
    expect(titleFromPrompt("[Image #1] why is this button red")).toBe("Why is this button red");
    expect(titleFromPrompt("look at https://github.com/a/b/pull/12 and review it")).toBe("Look at and review it");
  });

  it("refuses prompts that are not tasks", () => {
    expect(titleFromPrompt("/model opus")).toBeUndefined();
    expect(titleFromPrompt("yes")).toBeUndefined();
    expect(titleFromPrompt("git status")).toBeUndefined();
    expect(titleFromPrompt("  ")).toBeUndefined();
    expect(titleFromPrompt(".flock/images/img-3.png")).toBeUndefined();
  });
});

describe("looksLikeTask", () => {
  it("does not mistake a sentence for a command", () => {
    expect(looksLikeTask("help me fix the login page")).toBe(true);
    expect(looksLikeTask("status of the deploy?")).toBe(true);
    expect(looksLikeTask("continue")).toBe(false);
    expect(looksLikeTask("cd apps && npm test")).toBe(false);
  });
});

describe("latestTask", () => {
  it("follows the agent to the last task you gave it, skipping chatter and commands", () => {
    expect(latestTask(["spin it up", "test something here", "ok", "/clear"])).toBe("Test something here");
    expect(latestTask(["make the docs searchable"])).toBe("Make the docs searchable");
  });

  it("has nothing to say before a task", () => {
    expect(latestTask(undefined)).toBeUndefined();
    expect(latestTask(["yes", "/model opus"])).toBeUndefined();
  });

  it("compares titles the way a reader would", () => {
    expect(sameTitle("Spin it up", "spin it  up")).toBe(true);
    expect(sameTitle("Make the settings page…", "make the settings page")).toBe(true);
    expect(sameTitle("Spin it up", "Test something here")).toBe(false);
  });
});
