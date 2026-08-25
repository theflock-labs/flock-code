import { describe, it, expect } from "vitest";
import type { ILink, Terminal } from "@xterm/xterm";
import { firstUrl, opensInPlace, registerTerminalLinks } from "./terminalLinks";

// "Copy URL" in the pane menu and clicking the link are two routes to the same
// string, so they share one matcher. These are the cases where the old
// `https?:\/\/\S+` in terminalRegistry disagreed with the link under the cursor.
describe("Copy URL ends a URL where the clickable link ends", () => {
  const cases: [string, string | null][] = [
    ["https://github.com/o/r/pull/42", "https://github.com/o/r/pull/42"],
    ["see https://github.com/o/r/pull/42.", "https://github.com/o/r/pull/42"],
    ["(https://github.com/o/r/pull/42)", "https://github.com/o/r/pull/42"],
    ["[docs](https://example.com/a/b), then", "https://example.com/a/b"],
    ["https://github.com/o/r/blob/main/a.ts#L42", "https://github.com/o/r/blob/main/a.ts#L42"],
    ["https://github.com/o/r/issues?q=is%3Aopen", "https://github.com/o/r/issues?q=is%3Aopen"],
    ["no url here at all", null],
    ["", null],
  ];
  for (const [input, want] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => {
      expect(firstUrl(input)).toBe(want);
    });
  }

  it("is not confused by a second call (the shared regex is global)", () => {
    expect(firstUrl("https://a.example/one")).toBe("https://a.example/one");
    expect(firstUrl("https://b.example/two")).toBe("https://b.example/two");
  });
});

// Terminal output is agent output, and an agent's output is downstream of
// whatever repo it was pointed at. A hostile repo can print any path it likes
// and wait for someone to click it, so "would this click hand a path to
// `open`?" is a security decision, not a UX one.

describe("clickable paths never hand an executable to `open`", () => {
  const EXECUTABLE = [
    "/Applications/Mail.app",
    "/Applications/Mail.app/",       // trailing slash must not evade the check
    "/Users/x/repo/install.command",
    "/Users/x/repo/payload.scpt",
    "/Users/x/repo/payload.applescript",
    "/Users/x/repo/tool.jar",
    "/Users/x/repo/thing.pkg",
    "/Users/x/repo/thing.mpkg",
    "/Users/x/repo/disk.dmg",
    "/Users/x/repo/Evil.prefPane",
    "/Users/x/repo/Evil.saver",
    "/Users/x/repo/Evil.qlgenerator",
    "/Users/x/repo/Evil.workflow",
    "/Users/x/repo/Evil.appex",
    "/Users/x/repo/shortcut.webloc",
    "/Users/x/repo/shortcut.inetloc",
    "/Users/x/repo/run.sh",
    "/Users/x/repo/setup.py",
    // The case no extension blocklist can catch: a Mach-O binary with no
    // extension at all, which `open` executes.
    "/Users/x/repo/build/output",
  ];

  for (const p of EXECUTABLE) {
    it(`reveals rather than opens ${p}`, () => {
      expect(opensInPlace(p)).toBe(false);
    });
  }
});

describe("ordinary source and documents still open", () => {
  const INERT = [
    "/Users/x/repo/src/main.rs",
    "/Users/x/repo/src/App.tsx",
    "/Users/x/repo/src/lib/theme.ts",
    "/Users/x/repo/Cargo.toml",
    "/Users/x/repo/README.md",
    "/Users/x/repo/notes.txt",
    "/Users/x/repo/.gitignore",
    "/Users/x/repo/Makefile",
    "/Users/x/repo/LICENSE",
    "/Users/x/repo/diagram.png",
    "/Users/x/repo/spec.pdf",
  ];

  for (const p of INERT) {
    it(`opens ${p}`, () => {
      expect(opensInPlace(p)).toBe(true);
    });
  }
});

// A path long enough to wrap is the common case, not the edge case — agent
// output is full of them and a pane is rarely wide enough. Two things break
// it: xterm's own soft wrap, and Claude Code hard-wrapping its output itself
// (indent and all) before the terminal ever sees it.

const COLS = 40;

/** Minimal stand-in for the slice of Terminal the provider reads. Rows are
 *  given as visible text; the fake pads them to COLS the way a buffer line
 *  does, and `wrapped` marks a soft wrap. */
function linksOn(rows: { text: string; wrapped?: boolean }[], lineNo: number): ILink[] {
  let provider: {
    provideLinks(y: number, cb: (links: ILink[] | undefined) => void): void;
  } | null = null;
  const term = {
    cols: COLS,
    buffer: {
      active: {
        getLine: (i: number) =>
          rows[i]
            ? {
                isWrapped: !!rows[i].wrapped,
                translateToString: (trim: boolean) => {
                  const padded = rows[i].text.padEnd(COLS, " ").slice(0, COLS);
                  return trim ? padded.replace(/ +$/, "") : padded;
                },
              }
            : undefined,
      },
    },
    registerLinkProvider: (p: typeof provider) => {
      provider = p;
      return { dispose: () => {} };
    },
  } as unknown as Terminal;
  registerTerminalLinks(term);
  let out: ILink[] | undefined;
  provider!.provideLinks(lineNo, (links) => {
    out = links;
  });
  return out ?? [];
}

describe("wrapped paths stay clickable across both halves", () => {
  const PATH = "/Users/remi/proj/scratchpad/goose/neck.png";

  describe("xterm soft wrap", () => {
    // The terminal broke the line itself: no indent, and the second row says so.
    const head = "  Read(";
    const rows = [
      { text: head + PATH.slice(0, COLS - head.length) },
      { text: PATH.slice(COLS - head.length) + ")", wrapped: true },
    ];

    for (const hovered of [1, 2]) {
      it(`links the whole path when hovering row ${hovered}`, () => {
        const [link, ...rest] = linksOn(rows, hovered);
        expect(rest).toEqual([]);
        expect(link.text).toBe(PATH);
        expect(link.range.start).toEqual({ x: head.length + 1, y: 1 });
        expect(link.range.end).toEqual({ x: PATH.length - (COLS - head.length), y: 2 });
      });
    }
  });

  describe("Claude Code hard wrap", () => {
    // Ink wrapped it before the PTY saw it: a real newline, and the block's
    // indent re-emitted at the head of the continuation.
    const head = "  Read(";
    const indent = "    ";
    const rows = [
      { text: head + PATH.slice(0, COLS - head.length) },
      { text: indent + PATH.slice(COLS - head.length) + ")" },
    ];

    for (const hovered of [1, 2]) {
      it(`links the whole path when hovering row ${hovered}`, () => {
        const [link, ...rest] = linksOn(rows, hovered);
        expect(rest).toEqual([]);
        expect(link.text).toBe(PATH);
        expect(link.range.start).toEqual({ x: head.length + 1, y: 1 });
        // The indent is dropped from the assembled text, so the end column has
        // to come from where the character actually sits on screen.
        expect(link.range.end).toEqual({
          x: indent.length + PATH.length - (COLS - head.length),
          y: 2,
        });
      });
    }
  });

  // The wrapped path rarely gets the whole pane: Claude Code prints a
  // right-aligned annotation next to it, and those columns are reserved from
  // every row of the block — so the row a path breaks on ends several columns
  // short of the last one, on whichever row the annotation itself lands.
  describe("Claude Code hard wrap beside a right-aligned annotation", () => {
    const head = "  > [image]";
    const size = "(7.1KB)";
    const part1 = PATH.slice(0, COLS - head.length - size.length - 1);
    const part2 = PATH.slice(part1.length);
    const cont = " ".repeat(head.length) + part2;

    const cases = {
      "on the continuation row": [
        { text: head + part1 },
        { text: cont.padEnd(COLS - size.length - 1) + " " + size },
      ],
      "on the row that breaks": [{ text: head + part1 + " " + size }, { text: cont }],
    };

    for (const [where, rows] of Object.entries(cases)) {
      for (const hovered of [1, 2]) {
        it(`links the whole path with the size ${where}, hovering row ${hovered}`, () => {
          const [link, ...rest] = linksOn(rows, hovered);
          expect(rest).toEqual([]);
          expect(link.text).toBe(PATH);
          expect(link.range.start).toEqual({ x: head.length + 1, y: 1 });
          expect(link.range.end).toEqual({ x: head.length + part2.length, y: 2 });
        });
      }
    }
  });

  it("links a hard-wrapped URL as one link", () => {
    const url = "https://example.com/a/very/long/path/to/a/page.html";
    const rows = [{ text: "  " + url.slice(0, COLS - 2) }, { text: "    " + url.slice(COLS - 2) }];
    for (const hovered of [1, 2]) {
      expect(linksOn(rows, hovered).map((l) => l.text)).toEqual([url]);
    }
  });

  it("does not join a row that broke with room to spare", () => {
    // The next row's first word would have fit, so the break was the agent's
    // own newline — the two rows are separate lines that happen to abut.
    const rows = [{ text: "  Wrote /Users/remi/proj/a.ts" }, { text: "  Next up: the tests" }];
    expect(linksOn(rows, 1).map((l) => l.text)).toEqual(["/Users/remi/proj/a.ts"]);
  });

  it("does not join a row that ends before the last column", () => {
    // Room to spare on row 1 means Ink chose to break there, not that it ran
    // out of width — the rows are unrelated.
    const rows = [{ text: "  Read(/Users/remi/proj/a.ts)" }, { text: "    still/here.ts" }];
    expect(linksOn(rows, 1).map((l) => l.text)).toEqual(["/Users/remi/proj/a.ts"]);
  });

  it("does not join when the next row resumes on a non-path character", () => {
    const rows = [
      { text: ("  Read(" + PATH).slice(0, COLS) },
      { text: '    "unrelated quoted text"' },
    ];
    expect(linksOn(rows, 1).map((l) => l.text)).toEqual([
      ("  Read(" + PATH).slice(0, COLS).slice("  Read(".length),
    ]);
  });
});
