import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ILink, Terminal } from "@xterm/xterm";

// What the disk holds, as far as the provider can ask: the backend's
// existing_paths answers from this set.
const onDisk = new Set<string>();
const asked: string[][] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { paths: string[] }) => {
    if (cmd !== "existing_paths") throw new Error(`unexpected ${cmd}`);
    asked.push(args.paths);
    return args.paths.map((p) => onDisk.has(p));
  }),
}));
const opened: string[] = [];
const revealed: string[] = [];
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(async (p: string) => void opened.push(p)),
  revealItemInDir: vi.fn(async (p: string) => void revealed.push(p)),
  openUrl: vi.fn(async (u: string) => void opened.push(u)),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/sam" }));

const { clearExistsCache, fileUrlPath, openFileUrl, registerTerminalLinks, resolveRelative } = await import("./terminalLinks");

const COLS = 80;
const CWD = "/Users/sam/code/storefront";

/** The links the provider offers for one row, once any disk check is answered. */
async function linksOn(text: string, cwd: string | null = CWD): Promise<ILink[]> {
  let provider: { provideLinks(y: number, cb: (links: ILink[] | undefined) => void): void } | null = null;
  const term = {
    cols: COLS,
    buffer: {
      active: {
        getLine: (i: number) =>
          i === 0
            ? { isWrapped: false, translateToString: () => text.padEnd(COLS, " ").slice(0, COLS) }
            : undefined,
      },
    },
    registerLinkProvider: (p: typeof provider) => {
      provider = p;
      return { dispose: () => {} };
    },
  } as unknown as Terminal;
  registerTerminalLinks(term, () => cwd);
  return new Promise((resolve) => provider!.provideLinks(1, (links) => resolve(links ?? [])));
}

const click = (link: ILink) => link.activate({ preventDefault() {} } as MouseEvent, link.text);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  onDisk.clear();
  asked.length = 0;
  opened.length = 0;
  revealed.length = 0;
  clearExistsCache();
});

describe("paths relative to the agent's directory", () => {
  it("links what Claude Code prints, once the file is there", async () => {
    onDisk.add(`${CWD}/src/settings/theme.ts`);
    onDisk.add(`${CWD}/src/checkout/Steps.tsx`);
    const links = await linksOn("  - src/settings/theme.ts (new): applyTheme() Read(src/checkout/Steps.tsx)");
    expect(links.map((l) => l.text)).toEqual(["src/settings/theme.ts", "src/checkout/Steps.tsx"]);
  });

  it("leaves prose with dots and slashes alone when nothing like it is on disk", async () => {
    const links = await linksOn("Use e.g. node.js or and/or the theflock.sh site, v2.1.319");
    expect(links).toEqual([]);
  });

  it("opens the resolved file, dropping :line for `open`", async () => {
    onDisk.add(`${CWD}/tests/checkout.test.ts`);
    const [link] = await linksOn("  ⎿  tests/checkout.test.ts:12 failed");
    expect(link.text).toBe("tests/checkout.test.ts:12");
    click(link);
    await settle();
    expect(opened).toEqual([`${CWD}/tests/checkout.test.ts`]);
  });

  it("resolves ./ and ../", async () => {
    onDisk.add("/Users/sam/code/api/src/routes/export.ts");
    const [link] = await linksOn("see ../api/src/routes/export.ts.");
    expect(link.text).toBe("../api/src/routes/export.ts");
    click(link);
    await settle();
    expect(opened).toEqual(["/Users/sam/code/api/src/routes/export.ts"]);
  });

  it("reveals rather than opens a relative path that could run", async () => {
    onDisk.add(`${CWD}/scripts/install.sh`);
    const [link] = await linksOn("Run scripts/install.sh first");
    click(link);
    await settle();
    expect(opened).toEqual([]);
    expect(revealed).toEqual([`${CWD}/scripts/install.sh`]);
  });

  it("does not look relative paths up without a directory", async () => {
    onDisk.add(`${CWD}/src/settings/theme.ts`);
    expect(await linksOn("src/settings/theme.ts", null)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("asks the disk once per row and remembers the answer", async () => {
    onDisk.add(`${CWD}/package.json`);
    await linksOn("cat package.json");
    await linksOn("cat package.json");
    expect(asked).toEqual([[`${CWD}/package.json`]]);
  });

  it("keeps absolute paths and URLs as they were", async () => {
    const links = await linksOn("open /Users/sam/notes.md or https://theflock.sh/docs");
    expect(links.map((l) => l.text)).toEqual(["https://theflock.sh/docs", "/Users/sam/notes.md"]);
    expect(asked).toEqual([]);
  });
});

describe("file:// links", () => {
  it("links a printed file:// URL and opens the file it names", async () => {
    const [link] = await linksOn("Report: file:///Users/sam/code/storefront/coverage/index.html.");
    expect(link.text).toBe("file:///Users/sam/code/storefront/coverage/index.html");
    click(link);
    await settle();
    expect(opened).toEqual(["/Users/sam/code/storefront/coverage/index.html"]);
  });

  it("decodes the path and ignores other hosts", () => {
    expect(fileUrlPath("file:///Users/sam/My%20Notes/a.md")).toBe("/Users/sam/My Notes/a.md");
    expect(fileUrlPath("file://localhost/tmp/a.txt")).toBe("/tmp/a.txt");
    expect(fileUrlPath("file://evil.example/share/a.txt")).toBeNull();
  });

  it("an OSC 8 file link follows the same open-or-reveal rule", async () => {
    await openFileUrl("file:///Users/sam/code/storefront/build/output");
    expect(opened).toEqual([]);
    expect(revealed).toEqual(["/Users/sam/code/storefront/build/output"]);
  });
});

describe("resolveRelative", () => {
  it.each([
    ["/a/b", "c.ts", "/a/b/c.ts"],
    ["/a/b/", "./c.ts", "/a/b/c.ts"],
    ["/a/b", "../c/d.ts", "/a/c/d.ts"],
    ["/a", "../../x", "/x"],
  ])("%s + %s → %s", (dir, rel, want) => {
    expect(resolveRelative(dir, rel)).toBe(want);
  });
});
