// Where each arrangeable sidebar section lives: the classic left rail, or the
// opt-in right rail. Two ordered columns that together partition the known
// section ids, so a section is in exactly one place and its position within
// that rail is remembered. Persisted globally (like section collapse/order)
// under one key, migrating the older single-column `section-order`.

export const KNOWN_SECTIONS = ["agents", "git", "prs", "merge-queue", "graph", "queue"] as const;
export type SectionId = (typeof KNOWN_SECTIONS)[number];
export type DockSide = "left" | "right";

export interface Docks {
  left: string[];
  right: string[];
}

// Bumped to :v2 when the default arrangement changed (git + prs moved to the
// right rail). A new key means the old saved layout is ignored once, so the new
// default actually lands instead of being masked by a stale value.
const DOCKS_KEY = "flock:sidebar:docks:v2";
const LEGACY_ORDER_KEY = "flock:sidebar:section-order";
// Default split: agents + the ambient graph stay on the left; the repo
// surfaces (git, PRs, merge queue) live on the right rail out of the box.
// (Existing saved layouts get newly-added sections appended to the left rail
// by `normalize` instead — the layout itself is never wiped.)
const DEFAULT_LEFT: string[] = ["agents", "graph"];
const DEFAULT_RIGHT: string[] = ["git", "prs", "merge-queue"];

const isKnown = (id: string): id is SectionId => (KNOWN_SECTIONS as readonly string[]).includes(id);

/** Keep only known ids, drop duplicates, and make sure every known section
 *  appears exactly once — any missing one lands at the end of the left rail so
 *  a section newly added in an update shows up without wiping a saved layout. */
function normalize(d: Partial<Docks>): Docks {
  const seen = new Set<string>();
  const clean = (arr: string[] | undefined): string[] => {
    const out: string[] = [];
    for (const id of arr ?? []) {
      if (isKnown(id) && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  };
  const left = clean(d.left);
  const right = clean(d.right);
  for (const id of KNOWN_SECTIONS) {
    if (!seen.has(id)) left.push(id);
  }
  return { left, right };
}

export function loadDocks(): Docks {
  try {
    const raw = localStorage.getItem(DOCKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.left) && Array.isArray(parsed.right)) {
        return normalize(parsed);
      }
    }
    // Migrating from the old single-column order: keep the user's ordering for
    // whatever stays left, but honour the new default and seat git + PRs right.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_ORDER_KEY) ?? "null");
    if (Array.isArray(legacy)) {
      const left = legacy.filter((id) => isKnown(id) && !DEFAULT_RIGHT.includes(id));
      return normalize({ left, right: [...DEFAULT_RIGHT] });
    }
  } catch {
    /* corrupted state falls back to the default arrangement */
  }
  return normalize({ left: [...DEFAULT_LEFT], right: [...DEFAULT_RIGHT] });
}

export function saveDocks(d: Docks): void {
  try {
    localStorage.setItem(DOCKS_KEY, JSON.stringify(d));
  } catch {
    /* storage full / disabled — the in-memory layout still applies this session */
  }
}

/** Move a section to the given rail, dropping it in at the end. */
export function moveSection(d: Docks, id: string, to: DockSide): Docks {
  const left = d.left.filter((s) => s !== id);
  const right = d.right.filter((s) => s !== id);
  const next: Docks = { left, right };
  next[to] = [...next[to], id];
  return next;
}

/** Reorder within a single rail. */
export function reorderSide(d: Docks, side: DockSide, from: number, to: number): Docks {
  const arr = [...d[side]];
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return d;
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  return { ...d, [side]: arr };
}
