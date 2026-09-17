import { AGENT_KINDS, AGENT_META } from "./agents";
import type { AgentKind } from "../types";

export interface WorkspacePreset {
  id: string;
  name: string;
  agents: AgentKind[];
}

export const SESSION_COUNTS = [1, 2, 3, 4, 5, 6, 8, 12] as const;
export const MAX_PRESETS = 12;
const STORAGE_KEY = "flock.workspace-presets.v1";

export const STARTER_PRESETS: WorkspacePreset[] = [
  { id: "starter-claude", name: "Claude", agents: ["claude", "claude", "claude"] },
  { id: "starter-mixed", name: "Mixed team", agents: ["claude", "claude", "claude", "codex", "codex", "codex"] },
];

export function lineupLabel(agents: readonly AgentKind[]): string {
  const counts = new Map<AgentKind, number>();
  for (const agent of agents) counts.set(agent, (counts.get(agent) ?? 0) + 1);
  return [...counts].map(([agent, count]) => `${AGENT_META[agent].label} ×${count}`).join(" · ");
}

export function resizeLineup(agents: readonly AgentKind[], count: number, fill: AgentKind): AgentKind[] {
  return Array.from({ length: count }, (_, index) => agents[index] ?? fill);
}

/** Treat storage as untrusted. One broken entry must not hide valid presets. */
export function readWorkspacePresets(): WorkspacePreset[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    const seen = new Set(STARTER_PRESETS.map((preset) => preset.id));
    return value.filter((entry): entry is WorkspacePreset => {
      if (!entry || typeof entry !== "object") return false;
      const { id, name, agents } = entry;
      if (typeof id !== "string" || !id || seen.has(id)
        || typeof name !== "string" || !name.trim() || name.length > 40
        || !Array.isArray(agents) || !SESSION_COUNTS.some((count) => count === agents.length)
        || !agents.every((agent) => AGENT_KINDS.includes(agent))) return false;
      seen.add(id);
      return true;
    }).slice(0, MAX_PRESETS).map(({ id, name, agents }) => ({ id, name: name.trim(), agents: [...agents] }));
  } catch {
    return [];
  }
}

/** Return an error rather than pretending a preset survived a storage failure. */
export function writeWorkspacePresets(presets: readonly WorkspacePreset[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}
