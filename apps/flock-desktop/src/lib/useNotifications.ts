import { useCallback, useState } from "react";
import type { Notification } from "../components/NotificationsBadge";

// A chronological log (not just a snapshot) of PR/agent events, shown by the
// always-visible NotificationsBadge. Persisted to localStorage so it survives
// restarts. Capped so it can't grow unbounded. The watcher effects that decide
// WHEN to notify (PR check transitions, new PRs, agent hook events) stay in
// App — they're glue between domains; this owns only the log itself.
export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>(() => {
    try { return JSON.parse(localStorage.getItem("flock:notifications") ?? "[]"); } catch { return []; }
  });

  const pushNotification = useCallback((n: Omit<Notification, "id" | "time">) => {
    setNotifications((prev) => {
      const next = [{ ...n, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: Date.now() }, ...prev].slice(0, 50);
      try { localStorage.setItem("flock:notifications", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { notifications, pushNotification };
}
