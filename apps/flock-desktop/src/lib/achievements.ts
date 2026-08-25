// The achievement catalog and the pure logic that resolves a set of lifetime
// stats into earned/locked seals with rank + progress. Kept framework-free so
// it's trivially testable and reused by both your own wall and a friend's.
//
// Two scopes:
//  - "shared"  → driven by Supabase user_stats (prompts/agents/workspaces/
//                tokens) + member-since, so it resolves for you AND any friend.
//  - "self"    → driven by the local knowledge graph (decisions/notes/files),
//                which only holds data about you, so these show on your wall
//                only. A friend's stats simply omit them.

export type GlyphKey =
  | "formation" | "squadron" | "compass" | "streak" | "seal"
  | "graph" | "quill" | "archive";

export interface AchievementStats {
  prompts: number;
  agents: number;
  workspaces: number;
  tokens: number;
  memberSince: string | null;
  // Graph-derived (present only for your own wall):
  decisions?: number;
  notes?: number;
  files?: number;
}

export interface Achievement {
  id: string;
  name: string;
  /** Short line under the name; describes what it takes. */
  desc: string;
  glyph: GlyphKey;
  /** A CSS custom-property name from the app palette, e.g. "--violet". */
  hue: string;
  scope: "shared" | "self";
  /** Ascending thresholds. One entry = a single-shot badge. */
  tiers: number[];
  /** Names shown per rank, parallel to tiers. */
  rankNames: string[];
  unit: string;
  /** Pulls this achievement's running total out of the stats. */
  value: (s: AchievementStats) => number;
}

export interface ResolvedAchievement {
  def: Achievement;
  earned: boolean;
  /** 1-based rank reached (0 = locked). */
  rank: number;
  /** Highest rank reached => renders in gold. */
  maxed: boolean;
  have: number;
  /** Threshold for the next rank (or the final one when maxed). */
  need: number;
  /** 0..1 toward `need`. */
  progress: number;
  /** Label for the current rank (or the next one to chase, when locked). */
  rankName: string;
}

// Charter members: anyone whose account predates this cutoff earns Founder.
const FOUNDER_CUTOFF = Date.parse("2026-10-01T00:00:00Z");

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: "first-flight",
    name: "First Flight",
    desc: "Prompts flown to your agents.",
    glyph: "formation",
    hue: "--yellow",
    scope: "shared",
    tiers: [1, 100, 1000, 10000],
    rankNames: ["Fledgling", "Wingbeat", "Migration", "Skyfarer"],
    unit: "prompts",
    value: (s) => s.prompts,
  },
  {
    id: "squadron",
    name: "Squadron",
    desc: "Agents launched into formation.",
    glyph: "squadron",
    hue: "--orange",
    scope: "shared",
    tiers: [5, 50, 500],
    rankNames: ["Pair", "Flight", "Squadron"],
    unit: "agents",
    value: (s) => s.agents,
  },
  {
    id: "trailblazer",
    name: "Trailblazer",
    desc: "Workspaces opened and mapped.",
    glyph: "compass",
    hue: "--violet",
    scope: "shared",
    tiers: [1, 5, 25],
    rankNames: ["Settler", "Pathfinder", "Trailblazer"],
    unit: "workspaces",
    value: (s) => s.workspaces,
  },
  {
    id: "marathoner",
    name: "Marathoner",
    desc: "Tokens spent going the distance.",
    glyph: "streak",
    hue: "--ok",
    scope: "shared",
    tiers: [1_000_000, 10_000_000, 100_000_000],
    rankNames: ["Miler", "Long-hauler", "Marathoner"],
    unit: "tokens",
    value: (s) => s.tokens,
  },
  {
    id: "founder",
    name: "Founder",
    desc: "Flying with flock from the first season.",
    glyph: "seal",
    hue: "--yellow",
    scope: "shared",
    tiers: [1],
    rankNames: ["Charter member"],
    unit: "",
    value: (s) =>
      s.memberSince && Date.parse(s.memberSince) < FOUNDER_CUTOFF ? 1 : 0,
  },
  {
    id: "cartographer",
    name: "Cartographer",
    desc: "Decisions charted into the graph.",
    glyph: "graph",
    hue: "--blue",
    scope: "self",
    tiers: [10, 100, 500],
    rankNames: ["Scout", "Cartographer", "Loremaster"],
    unit: "decisions",
    value: (s) => s.decisions ?? 0,
  },
  {
    id: "lorekeeper",
    name: "Lorekeeper",
    desc: "Facts and conventions remembered.",
    glyph: "quill",
    hue: "--violet",
    scope: "self",
    tiers: [10, 100],
    rankNames: ["Scribe", "Lorekeeper"],
    unit: "notes",
    value: (s) => s.notes ?? 0,
  },
  {
    id: "archivist",
    name: "Archivist",
    desc: "Files the graph knows the history of.",
    glyph: "archive",
    hue: "--ok",
    scope: "self",
    tiers: [10, 100],
    rankNames: ["Keeper", "Archivist"],
    unit: "files",
    value: (s) => s.files ?? 0,
  },
];

/** Resolve one achievement against a stats snapshot. */
export function resolveOne(def: Achievement, stats: AchievementStats): ResolvedAchievement {
  const have = Math.max(0, def.value(stats));
  let rank = 0;
  for (let i = 0; i < def.tiers.length; i++) if (have >= def.tiers[i]) rank = i + 1;
  const maxed = rank === def.tiers.length;
  const earned = rank > 0;
  const need = maxed ? def.tiers[def.tiers.length - 1] : def.tiers[rank];
  const progress = maxed ? 1 : Math.min(1, have / need);
  // Earned → the rank you're at; locked → the rank you're chasing.
  const rankName = earned ? def.rankNames[rank - 1] : def.rankNames[0];
  return { def, earned, rank, maxed, have, need, progress, rankName };
}

/** Resolve the whole catalog. `includeSelf` gates the graph-only seals. */
export function resolveAll(stats: AchievementStats, includeSelf: boolean): ResolvedAchievement[] {
  return ACHIEVEMENTS
    .filter((a) => a.scope === "shared" || includeSelf)
    .map((a) => resolveOne(a, stats));
}
