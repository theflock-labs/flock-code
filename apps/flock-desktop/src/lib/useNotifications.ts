// The shape every domain watcher (PR checks, merges, agent hooks, budgets)
// reports an event in. v1 kept these as a persisted log behind a titlebar
// pill; v2 shows the ones worth interrupting for as toasts (see App's
// pushNotification) and keeps no log.

export type NotificationStatus = "success" | "failure" | "running" | "info";

/** "pr" = pull-request / CI events; "agent" = an agent's session events. */
export type NotificationCategory = "pr" | "agent";

export interface Notification {
  id: string;
  time: number;
  status: NotificationStatus;
  category: NotificationCategory;
  /** Worth interrupting for. Non-priority events are dropped. */
  priority: boolean;
  text: string;
  /** Secondary context line under the title. */
  detail?: string;
  url?: string;
  /** Present on agent events: lets the toast jump to the pane. */
  workspaceId?: string;
  paneId?: string;
}

export type NotificationInput = Omit<Notification, "id" | "time">;
