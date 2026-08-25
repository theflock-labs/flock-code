// Parser for unified-diff text (the output of `git diff` and GitHub's
// `application/vnd.github.v3.diff` media type) into a structured shape the
// DiffViewer can render — files, hunks, and per-line old/new line numbers.

export type DiffLineKind = "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line text without the leading +/-/space marker. */
  text: string;
  /** Line number in the old file, or null for added lines / hunk headers. */
  oldN: number | null;
  /** Line number in the new file, or null for deleted lines / hunk headers. */
  newN: number | null;
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@ context` header line. */
  header: string;
  lines: DiffLine[];
}

export type DiffStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffFile {
  /** The file's current path (new side); for deletes, the old path. */
  path: string;
  /** The pre-rename path, when the file was renamed. */
  oldPath: string | null;
  status: DiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

/** Strip git's `a/` or `b/` path prefix (and normalise `/dev/null`). */
function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Unquote a git path like `"src/\305\204.ts"` — git octal-escapes paths with
 * unusual bytes and wraps them in quotes. Best-effort; falls back to the raw
 * string. Line numbers/content don't depend on this, only the display path. */
function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  try {
    return inner.replace(/\\([0-7]{3}|.)/g, (_, esc: string) => {
      if (/^[0-7]{3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
      const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
      return map[esc] ?? esc;
    });
  } catch {
    return inner;
  }
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse raw unified-diff text into a list of files. Tolerant of the two
 * dialects we feed it: `git diff` (with `diff --git` headers) and GitHub's
 * PR diff (identical format). */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldN = 0;
  let newN = 0;

  const finishFile = () => {
    if (file) files.push(file);
    file = null;
    hunk = null;
  };

  const lines = raw.split("\n");
  for (const line of lines) {
    // A truly empty string is only ever structural (the trailing element from
    // splitting on "\n"); real diff lines always carry a leading marker char
    // (space/+/-), so an empty context line is " ", never "".
    if (line === "") continue;
    if (line.startsWith("diff --git")) {
      finishFile();
      // `diff --git a/foo b/foo` — grab both paths as a fallback; the +++/---
      // lines below refine them (and handle spaces in names better).
      const m = line.match(/^diff --git (.+) (.+)$/);
      const path = m ? unquotePath(stripPrefix(m[2])) : "";
      file = { path, oldPath: null, status: "modified", additions: 0, deletions: 0, binary: false, hunks: [] };
      continue;
    }
    if (!file) continue;

    if (line.startsWith("new file")) { file.status = "added"; continue; }
    if (line.startsWith("deleted file")) { file.status = "deleted"; continue; }
    if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquotePath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = unquotePath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4).trim());
      if (p !== "/dev/null" && file.status !== "renamed") file.oldPath = unquotePath(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4).trim());
      if (p !== "/dev/null" && file.status !== "renamed") file.path = unquotePath(p);
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("old mode") || line.startsWith("new mode") ||
        line.startsWith("similarity index") || line.startsWith("dissimilarity index") ||
        line.startsWith("copy from") || line.startsWith("copy to")) {
      continue;
    }

    const hm = line.match(HUNK_RE);
    if (hm) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldN = parseInt(hm[1], 10);
      newN = parseInt(hm[3], 10);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — attach as context, no line numbers.
      hunk.lines.push({ kind: "meta", text: line.slice(2), oldN: null, newN: null });
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text, oldN: null, newN: newN++ });
      file.additions++;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text, oldN: oldN++, newN: null });
      file.deletions++;
    } else {
      // Context line (leading space), or a stray blank line inside the hunk.
      hunk.lines.push({ kind: "ctx", text, oldN: oldN++, newN: newN++ });
    }
  }
  finishFile();
  return files;
}

/** Total additions/deletions across a set of files. */
export function diffTotals(files: DiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );
}
