import { useCallback, useEffect, useState } from "react";
import {
  acceptFriendRequest,
  addFriendOrInvite,
  getMyProfile,
  getSession,
  isIdConfigured,
  listIdFriends,
  onAuthChange,
  removeFriendship,
  subscribeFriendEvents,
  subscribeFriendships,
  supabase,
  type IdProfile,
} from "./flockId";
import { startUsageSync, stopUsageSync } from "./usageStats";
import { isWindowActive, onWindowActiveChange } from "./windowActive";
import type { Notification } from "../components/NotificationsBadge";
import type { Friend } from "../types";

/** flock ID session state: the signed-in profile and the friend graph.
 * Friends and presence key off this; GitHub stays a repo-scoped integration.
 * `setFriends` is exposed because live presence events (Ably, wired in App)
 * overlay online/agent-count state onto the server-side friendship list. */
export function useFlockId(pushNotification: (n: Omit<Notification, "id" | "time">) => void) {
  const [idProfile, setIdProfile] = useState<IdProfile | null>(null);
  // Distinguishes "session check hasn't resolved yet" from "signed out" so
  // the welcome dialog never flashes for a signed-in user on launch.
  const [idChecked, setIdChecked] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);

  /** Load the signed-in profile and friend list from flock ID. Presence
   * state from Ably events that already fired is preserved via the
   * functional updater; the friendships themselves live server-side. */
  const refreshIdFriends = useCallback(async () => {
    if (!isIdConfigured()) {
      setIdProfile(null);
      setFriends([]);
      setIdChecked(true);
      return;
    }
    const profile = await getMyProfile().catch(() => null);
    // Heal a rotated/stale Google avatar. The handle_new_user trigger seeds
    // profiles.avatar_url once at first sign-up and never refreshes it, so a
    // changed Google photo (or a since-rotated avatar URL) would stay stale
    // forever. If the live OAuth session carries a different avatar, push it to
    // the profile row (via the existing "own profile is editable" RLS policy)
    // and use it immediately. getSession() is a local read; the DB write only
    // fires when the value actually drifted, so after the first heal this is a
    // string compare and no-ops on every later refresh.
    let synced = profile;
    if (profile) {
      const meta = (await getSession().catch(() => null))?.user?.user_metadata as
        | { avatar_url?: string; picture?: string }
        | undefined;
      const live = meta?.avatar_url || meta?.picture;
      if (live && live !== profile.avatar_url) {
        await supabase().from("profiles").update({ avatar_url: live }).eq("id", profile.id)
          .then(() => {}, () => { /* best-effort; UI still uses the live value */ });
        synced = { ...profile, avatar_url: live };
      }
    }
    setIdProfile(synced);
    setIdChecked(true);
    if (!synced) {
      setFriends([]);
      return;
    }
    const list = await listIdFriends().catch(() => []);
    setFriends((prev) => {
      const live = new Map(prev.map((f) => [f.handle, f]));
      const merge = (handle: string, base: Friend): Friend => {
        const existing = live.get(handle);
        return existing
          ? { ...base, presence: existing.presence, agentCount: existing.agentCount, windowId: existing.windowId ?? base.windowId }
          : base;
      };
      // Friends only — the signed-in user is intentionally excluded from the
      // list (their own identity lives in the profile footer, not here).
      return list.map((f) =>
        merge(f.profile.handle ?? "", {
          id: f.profile.id,
          handle: f.profile.handle ?? "(no handle yet)",
          avatarUrl: f.profile.avatar_url ?? "",
          friendStatus: f.state,
          presence: "offline" as const,
          agentCount: 0,
          lastSeen: null,
        }),
      );
    });
  }, []);

  useEffect(() => {
    refreshIdFriends();
    // Live: Supabase realtime pushes friendship changes (requests, accepts).
    const unsubAuth = onAuthChange(() => refreshIdFriends());
    const unsubFriendships = subscribeFriendships(() => refreshIdFriends());
    // Fallback for when realtime isn't enabled on the project, so an incoming
    // request never sits invisible until the next reload. The realtime
    // subscription above is the primary path, so this is only a safety net —
    // 60s (not 20s), paused while hidden, with a refresh on return.
    const poll = setInterval(() => { if (isWindowActive()) refreshIdFriends(); }, 60000);
    const unsubActive = onWindowActiveChange((active) => { if (active) refreshIdFriends(); });
    return () => { unsubAuth(); unsubFriendships(); clearInterval(poll); unsubActive(); };
  }, [refreshIdFriends]);

  // Who-did-what friend notifications for the status bar (the coarse
  // subscription above already refreshes the sidebar).
  useEffect(() => {
    if (!idProfile?.id) return;
    return subscribeFriendEvents(idProfile.id, (e) => {
      if (e.kind === "request_in") {
        pushNotification({ status: "info", category: "agent", priority: true, text: `@${e.from.handle ?? "someone"} sent you a friend request` });
      } else {
        pushNotification({ status: "success", category: "agent", priority: true, text: `@${e.by.handle ?? "someone"} accepted your friend request` });
      }
    });
  }, [idProfile?.id, pushNotification]);

  // Once signed in, keep the cumulative Claude Code token/USD totals synced to
  // flock ID so friends can see them alongside the other social stats.
  // Torn down when the session ends — the scan is I/O-heavy and writes to the
  // signed-in profile, so it has no business running signed-out.
  useEffect(() => {
    if (!idProfile?.id) return;
    startUsageSync();
    return () => stopUsageSync();
  }, [idProfile?.id]);

  const addIdFriend = useCallback(async (input: string) => {
    const result = await addFriendOrInvite(input);
    await refreshIdFriends();
    return result;
  }, [refreshIdFriends]);

  const acceptIdFriend = useCallback(async (profileId: string) => {
    await acceptFriendRequest(profileId);
    await refreshIdFriends();
  }, [refreshIdFriends]);

  const removeIdFriend = useCallback(async (profileId: string) => {
    await removeFriendship(profileId);
    await refreshIdFriends();
  }, [refreshIdFriends]);

  return {
    idProfile,
    idChecked,
    friends,
    setFriends,
    refreshIdFriends,
    addIdFriend,
    acceptIdFriend,
    removeIdFriend,
  };
}
