// Watches every ceiling and pushes a notification when one is approached or
// crossed.
//
// The decision of *whether* to shout is `dueAlerts` in budgets.ts — pure, and
// tested there. This is the glue: it turns the polled spend into per-watch
// figures, hands them over, and persists the fired-log so a restart inside the
// same day does not replay the day's alerts.
//
// Notifications go through `pushNotification` like every other domain watcher
// in App.tsx, under the existing "agent" category, carrying `workspaceId` so
// clicking one jumps to the workspace that is burning the money. A budget
// alert is not a new kind of event needing a new surface; it is the same
// "something needs your attention" the badge already exists for.

import { useEffect, useRef } from "react";
import type { Notification } from "../components/NotificationsBadge";
import {
  alertText,
  dueAlerts,
  getDailyBudget,
  getFiredLog,
  hasCeiling,
  pruneFired,
  setFiredLog,
  type BudgetWatch,
} from "./budgets";
import { attributeSpend, spendFor, type PaneRef, type WorkspaceRef } from "./spendAttribution";
import { useSpendWindows } from "./spendStore";
import type { Workspace } from "../types";

/** Key for the machine-wide daily ceiling in the fired-log. Not a workspace
 * id, and stable across restarts. */
const DAILY_KEY = "budget:daily";

interface WorkspaceLike extends Pick<Workspace, "id" | "name" | "repo_path" | "panes" | "budget"> {}

export function useBudgetAlerts(
  workspaces: WorkspaceLike[],
  pushNotification: (n: Omit<Notification, "id" | "time">) => void,
): void {
  const spend = useSpendWindows();
  // The watcher must re-run when the *spend* moves, not when React happens to
  // re-render App — but it needs the current workspaces when it does. A ref
  // keeps them out of the dependency list, so a keystroke in a pane cannot
  // trigger a budget evaluation.
  const wsRef = useRef(workspaces);
  wsRef.current = workspaces;
  const pushRef = useRef(pushNotification);
  pushRef.current = pushNotification;

  useEffect(() => {
    // An unavailable scan means "we do not know", and a budget must never fire
    // on not knowing — nor read it as $0 and stay quiet forever after a real
    // breach. Skip the tick entirely.
    if (!spend.available || !spend.day) return;

    const ws = wsRef.current;
    const panes: PaneRef[] = ws.flatMap((w) =>
      w.panes.map((p) => ({ id: p.id, workspaceId: w.id, sessionId: p.sessionId, cwd: p.cwd })),
    );
    const refs: WorkspaceRef[] = ws.map((w) => ({ id: w.id, repoPath: w.repo_path }));
    const today = attributeSpend(spend.day, panes, refs);
    const month = attributeSpend(spend.month, panes, refs);

    const watches: BudgetWatch[] = [];
    const daily = getDailyBudget();
    if (hasCeiling(daily) && daily) {
      watches.push({ key: DAILY_KEY, label: "all agents", budget: daily, spent: today.total });
    }
    for (const w of ws) {
      if (!hasCeiling(w.budget) || !w.budget) continue;
      const from = w.budget.period === "month" ? month.perWorkspace : today.perWorkspace;
      watches.push({ key: `budget:ws:${w.id}`, label: w.name, budget: w.budget, spent: spendFor(from, w.id) });
    }
    if (watches.length === 0) return;

    const { alerts, nextFired } = dueAlerts(watches, getFiredLog(), Date.now());
    if (alerts.length === 0) return;

    const periodOf = new Map(watches.map((w) => [w.key, w.budget.period]));
    for (const a of alerts) {
      pushRef.current({
        // "over" is a priority event (it trips the unread dot); the 80% warning
        // is not — it is information, and a badge that shouts at 80% every day
        // is a badge people stop reading.
        status: a.level === "over" ? "failure" : "info",
        category: "agent",
        priority: a.level === "over",
        text: alertText(a, periodOf.get(a.key) ?? "day"),
        detail: "Estimated from local transcripts — not a bill.",
        workspaceId: a.key.startsWith("budget:ws:") ? a.key.slice("budget:ws:".length) : undefined,
      });
    }
    setFiredLog(pruneFired(nextFired, watches.map((w) => w.key)));
    // Keyed on the scan, not on the workspace array: one evaluation per poll.
  }, [spend.day, spend.month, spend.available, spend.fetchedAtMs]);
}
