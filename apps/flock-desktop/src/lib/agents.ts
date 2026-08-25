import type { AgentKind } from "../types";

/** Single source of truth for how each agent kind is presented across the
 * app — dialogs, pane topbars, the sidebar, and popout windows all used to
 * derive this independently (some showing raw command names like "claude",
 * others a display label like "Claude Code", with no shared color/glyph),
 * which is what made agent kind look inconsistent from one corner of the UI
 * to another. */
export const AGENT_META: Record<AgentKind, { label: string; cmd: string; color: string }> = {
  opencode: { label: "OpenCode", cmd: "opencode -c", color: "var(--blue)" },
  codex: { label: "Codex", cmd: "codex --dangerously-skip-permissions", color: "var(--yellow)" },
  claude: { label: "Claude Code", cmd: "claude --dangerously-skip-permissions", color: "var(--orange)" },
  // pi runs its tools without permission prompts by design — no bypass flag
  // exists or is needed; secure mode is the jail, same as the others.
  pi: { label: "Pi", cmd: "pi", color: "var(--violet)" },
  // xAI's mark is monochrome, so grok takes the ink tier rather than a hue —
  // which also leaves the four coloured agents telling each other apart at a
  // glance in a mixed workspace.
  grok: { label: "Grok", cmd: "grok --permission-mode bypassPermissions", color: "var(--text-hi)" },
};

/** Display order used by every agent picker (New Workspace, Spawn Layout, …). */
export const AGENT_KINDS: AgentKind[] = ["claude", "grok", "opencode", "codex", "pi"];

/** Human label for an agent kind. Accepts a plain string (not just
 *  AgentKind) because popout windows read it back out of URL params —
 *  falls back to the raw value for anything unrecognized. */
export function agentLabel(kind: string): string {
  return AGENT_META[kind as AgentKind]?.label ?? kind;
}

export function agentColor(kind: string): string {
  return AGENT_META[kind as AgentKind]?.color ?? "var(--text-mid)";
}
