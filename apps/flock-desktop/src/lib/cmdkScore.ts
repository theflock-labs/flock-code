// Ranking for the ⌘K command bar.
//
// A module rather than a closure in CommandBar, because the previous scorer was
// wrong in ways only measurement showed and this one has to stay measurable.
// The old rule was: concatenate label + hint + keywords into one string, take
// `indexOf`, fall back to an unbounded subsequence, and score by absolute
// character index. Run against a real session, the old scorer
// produced, for the query "git":
//
//     1. Merge queue   2. Pull requests   3-5. three workspaces
//     6. Show uncommitted changes          ← the actual git command
//
// The workspaces matched on their repo path containing `/git/`, and every one
// of them outranked the row the user wanted, because a short label makes an
// early index and an early index was the whole score.
//
// Two ideas fix it, and both are about *where* a match landed rather than how
// clever the matcher is:
//
//  1. **Fields are tiers, a thousand apart.** A match in the visible label
//     always beats a match in the hint, which always beats a curated keyword,
//     which always beats `context` — machine identifiers (repo paths, ids) that
//     must stay findable without ever being competitive. Nothing inside a tier
//     can climb out of it, so "found in a path" can no longer outrank "found in
//     the name".
//  2. **Tokens, not offsets.** Within a tier, a whole-token hit beats a token
//     prefix beats a mid-token substring beats a subsequence. That is what
//     separates the keyword `git` (a token of "diff git status") from the `git`
//     inside "github", which is the rest of the "git" bug.

/** Which field a match came from. Ordered; the array index is the tier. */
export const FIELDS = ["label", "hint", "keywords", "context"] as const;
export type MatchField = (typeof FIELDS)[number];

/** A thousand per tier. Wide enough that no within-tier bonus, and no frecency
 *  bonus (capped at FRECENCY_MAX), can ever promote a row past a better-placed
 *  one. That containment is the point of the number, not the number itself. */
const TIER = 1000;

export interface Match {
  /** Lower is better. */
  score: number;
  field: MatchField;
  /** Character ranges within the *label* to highlight, as [start, end). Empty
   *  when the match came from another field — which is exactly when the caller
   *  should say so instead, or the row looks like it matched for no reason. */
  ranges: [number, number][];
  /** The token that matched, when it wasn't in the label. Rendered as the
   *  "why is this here" note. */
  note?: string;
}

export interface Scorable {
  label: string;
  hint?: string;
  /** Curated synonyms — verbs the user might reach for. Competitive. */
  keywords?: string;
  /** Machine identifiers: repo paths, branches, ids. Searchable, never
   *  competitive. Splitting these out of `keywords` is what stops every
   *  workspace under ~/git from winning the query "git". */
  context?: string;
}

/** Word boundaries for tokenising. Paths split on their separators too, so
 *  `/Users/remi/git/flock` yields `git` as a token rather than burying it. */
const SPLIT = /[\s/\\._:,()[\]{}<>|+—–-]+/;

const tokenize = (s: string): string[] => s.toLowerCase().split(SPLIT).filter(Boolean);

/** Initials of a label's words, for acronym matching: "New workspace" → "nw". */
function initials(label: string): string {
  return tokenize(label).map((w) => w[0]).join("");
}

/**
 * Rank `query` against one field's text. Lower is better, null for no match.
 * The ladder, best to worst — every rung is a claim about intent:
 *
 *   0   the whole field is the query          ("settings" → Settings)
 *   2   the field starts with the query       ("set" → Settings)
 *   6   the initials are the query            ("nw" → New workspace)
 *   10  a whole token is the query            ("git" → …keywords "diff git…")
 *   20  a token starts with the query         ("git" → …keywords "github…")
 *   40  the query is inside a token           ("it" → "github")
 *   120 the characters appear in order        ("nwspc" → "New workspace")
 *
 * The `+ index` terms inside a rung break ties by how early the hit is, so
 * ordering within a rung is still sensible. Length normalisation is a
 * hundredth of a point per character, which decides only exact ties and never
 * reorders across a rung.
 */
function rankField(q: string, text: string, phrase: boolean): { score: number; at: number; len: number } | null {
  const hay = text.toLowerCase();
  if (!hay) return null;
  const norm = hay.length / 100;

  // The whole-field rungs are only meaningful for a *phrase* — a label or a
  // hint, which someone wrote in an order. `keywords` and `context` are
  // unordered bags, and there the first entry happening to start with the
  // query says nothing. Applying these rungs to a bag is what let "Merge
  // queue" (keywords "github merge") beat "Show uncommitted changes"
  // (keywords "diff git status") for the query "git": "github merge" starts
  // with "git", so it scored as a prefix of the whole field.
  if (phrase) {
    if (hay === q) return { score: 0 + norm, at: 0, len: q.length };
    if (hay.startsWith(q)) return { score: 2 + norm, at: 0, len: q.length };
    if (q.length >= 2 && initials(text) === q) {
      return { score: 6 + norm, at: 0, len: 0 };
    }
  }

  const tokens = tokenize(text);
  let best: { score: number; at: number; len: number } | null = null;
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Walk the original string so highlight offsets are real offsets, not
    // offsets into a re-joined token list.
    const at = hay.indexOf(t, cursor);
    if (at < 0) continue;
    cursor = at + t.length;
    let s: number | null = null;
    let hitAt = at;
    if (t === q) s = 10 + i;
    else if (t.startsWith(q)) s = 20 + i;
    else {
      const inner = t.indexOf(q);
      if (inner > 0) { s = 40 + i; hitAt = at + inner; }
    }
    if (s !== null && (!best || s < best.score)) best = { score: s + norm, at: hitAt, len: q.length };
  }
  if (best) return best;

  // Subsequence, with a spread floor. Unbounded subsequence is what made a
  // single vowel match 100% of the list; requiring the characters to land
  // within a bounded window keeps "nwspc" working and drops the accidents.
  let qi = 0, first = -1, last = -1;
  for (let i = 0; i < hay.length && qi < q.length; i++) {
    if (hay[i] === q[qi]) { if (first < 0) first = i; last = i; qi++; }
  }
  if (qi < q.length) return null;
  const spread = last - first + 1;
  if (q.length >= 2 && spread > q.length * 6 + 8) return null;
  return { score: 120 + first + spread + norm, at: first, len: 0 };
}

/** Highlight ranges for a label hit. One contiguous range for substring hits;
 *  per-character ranges for a subsequence, so the user sees which letters the
 *  matcher actually used. */
function labelRanges(q: string, label: string, at: number, len: number): [number, number][] {
  if (len > 0) return [[at, at + len]];
  const hay = label.toLowerCase();
  const out: [number, number][] = [];
  let qi = 0;
  for (let i = 0; i < hay.length && qi < q.length; i++) {
    if (hay[i] === q[qi]) { out.push([i, i + 1]); qi++; }
  }
  return qi === q.length ? out : [];
}

/** Score one command. Empty query matches everything at 0 — the empty-query
 *  list is a roster, not a search result, and its order belongs to the caller. */
export function matchCommand(query: string, item: Scorable): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, field: "label", ranges: [] };

  let best: Match | null = null;
  for (let tier = 0; tier < FIELDS.length; tier++) {
    const field = FIELDS[tier];
    const text = field === "label" ? item.label : item[field];
    if (!text) continue;
    const r = rankField(q, text, field === "label" || field === "hint");
    if (!r) continue;
    const score = tier * TIER + r.score;
    if (best && score >= best.score) continue;
    best = {
      score,
      field,
      ranges: field === "label" ? labelRanges(q, item.label, r.at, r.len) : [],
      // The matched token, so a row that matched on something invisible can
      // say what. Without this, typing "cl" surfaced four agent names whose
      // rows contained no c and no l.
      note: field === "label" ? undefined : matchedToken(q, text),
    };
  }
  return best;
}

/** The token of `text` that `q` hit, for the "why is this here" note. Falls
 *  back to the field's first token so the note is never empty. */
function matchedToken(q: string, text: string): string {
  const tokens = tokenize(text);
  return (
    tokens.find((t) => t === q) ??
    tokens.find((t) => t.startsWith(q)) ??
    tokens.find((t) => t.includes(q)) ??
    tokens[0]
  );
}

// ─── Frecency ────────────────────────────────────────────────────────────────
//
// The cheapest thing on the list that makes a palette feel like it knows you.
// Deliberately a *tiebreak within a tier*: it reorders rows that matched the
// same way, and can never lift a keyword match above a label match. A palette
// that reorders on history alone stops being predictable, and predictable is
// the only reason anyone types blind into one.

const FRECENCY_KEY = "flock:cmdk-frecency";
/** Bounded well below TIER so history can never cross a field boundary. */
const FRECENCY_MAX = 90;
/** Ids beyond this are dropped, least-used first. Pane and workspace ids are
 *  regenerated on every restore (`remapLayoutTree`), so without a cap this
 *  grows forever with entries that can never match anything again. */
const FRECENCY_KEEP = 60;
const HALF_LIFE_MS = 14 * 24 * 3600 * 1000;

interface Use { n: number; last: number }

function readUses(): Record<string, Use> {
  try {
    const raw = localStorage.getItem(FRECENCY_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Use>) : {};
  } catch { return {}; }
}

/** Record a run. Called from the palette's own run path, so anything invoked
 *  another way (a button, a dedicated shortcut) does not train it — the
 *  ranking should reflect how you use *this surface*. */
export function noteCommandRun(id: string, now = Date.now()): void {
  try {
    const uses = readUses();
    const prev = uses[id];
    uses[id] = { n: (prev?.n ?? 0) + 1, last: now };
    const ids = Object.keys(uses);
    if (ids.length > FRECENCY_KEEP) {
      ids
        .sort((a, b) => weight(uses[a], now) - weight(uses[b], now))
        .slice(0, ids.length - FRECENCY_KEEP)
        .forEach((k) => delete uses[k]);
    }
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(uses));
  } catch { /* private mode / quota — ranking degrades, nothing breaks */ }
}

function weight(u: Use | undefined, now: number): number {
  if (!u) return 0;
  const age = Math.max(0, now - u.last);
  return u.n * Math.pow(0.5, age / HALF_LIFE_MS);
}

/** Bonus to subtract from a score, in [0, FRECENCY_MAX]. Halves every two
 *  weeks, so a command you used constantly last quarter stops outranking the
 *  one you reached for this morning. */
export function frecencyBonus(id: string, uses = readUses(), now = Date.now()): number {
  const w = weight(uses[id], now);
  if (w <= 0) return 0;
  // log so the tenth use is worth much less than the second; a command run
  // once should already be visibly preferred to one never run.
  return Math.min(FRECENCY_MAX, Math.round(30 * Math.log2(1 + w)));
}

/** Snapshot for one render pass, so ranking a few dozen rows parses
 *  localStorage once rather than once per row. */
export function frecencySnapshot(): Record<string, Use> {
  return readUses();
}

export function clearFrecency(): void {
  try { localStorage.removeItem(FRECENCY_KEY); } catch { /* ignore */ }
}
