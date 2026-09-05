import type { AgentStatusStr, Workspace } from "../types";

export interface AttentionAgent {
  workspaceId: string;
  paneId: string;
  name: string;
  workspaceName: string;
  task?: string;
  status: "awaiting_input" | "blocked";
  statusChangedAt?: number;
}

const STATUS_LABELS: Record<AgentStatusStr, string> = {
  idle: "Idle",
  working: "Working",
  awaiting_input: "Needs input",
  blocked: "Blocked",
  done: "Finished",
  failed: "Failed",
};

export function paneStatusLabel(status: AgentStatusStr): string {
  return STATUS_LABELS[status];
}

export function collectAttentionAgents(workspaces: readonly Workspace[]): AttentionAgent[] {
  return workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => {
    if (pane.status !== "awaiting_input" && pane.status !== "blocked") return [];
    return [{
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      paneId: pane.id,
      name: pane.displayName ?? pane.kind,
      task: pane.intent?.trim() || undefined,
      status: pane.status,
      statusChangedAt: pane.statusChangedAt,
    }];
  }));
}

/** Only report a duration for a real observed status transition. Restored
 * panes can have no timestamp; never substitute app start or an event log. */
export function attentionDuration(since: number | undefined, now: number): string | null {
  if (since == null || !Number.isFinite(since) || since <= 0 || since > now) return null;
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}
