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
import { setUsageConsent } from "./usageStats";
import { getAblyClient, refreshAuthorization } from "./presence";
import { isWindowActive, onWindowActiveChange } from "./windowActive";
import type { NotificationInput } from "./useNotifications";
import type { Friend } from "../types";

/** The signed-in flock ID and its friends.
 *
 *  The profile is what the app gates on. Friends are the server-side
 *  friendship list (Supabase), kept live by a realtime subscription with a
 *  one-minute fallback poll while the window is in use; live presence (Ably,
 *  wired in App) is laid over it through `setFriends`, and a refresh keeps
 *  whatever presence already arrived. */
export function useFlockIdentity(notify?: (n: NotificationInput) => void) {
  const [idProfile, setIdProfile] = useState<IdProfile | null>(null);
  // "Not checked yet" is not "signed out": the gate must not flash.
  const [idChecked, setIdChecked] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);

  const refreshIdentity = useCallback(async (options?: { requireProfile?: boolean }) => {
    if (!isIdConfigured()) {
      setIdProfile(null);
      setFriends([]);
      setIdChecked(true);
      return;
    }
    const profile = await getMyProfile().catch((error) => {
      if (options?.requireProfile) throw error;
      return null;
    });
    if (options?.requireProfile && !profile?.handle) {
      throw new Error("Your handle was saved, but your profile couldn’t be loaded. Try again.");
    }
    // Heal a rotated Google avatar: the profile row is seeded once at sign-up.
    let synced = profile;
    if (profile) {
      const meta = (await getSession().catch(() => null))?.user?.user_metadata as
        | { avatar_url?: string; picture?: string }
        | undefined;
      const live = meta?.avatar_url || meta?.picture;
      if (live && live !== profile.avatar_url) {
        await supabase()
          .from("profiles")
          .update({ avatar_url: live })
          .eq("id", profile.id)
          .then(() => {}, () => { /* best-effort; the live value is used either way */ });
        synced = { ...profile, avatar_url: live };
      }
    }
    setUsageConsent(!!synced?.id && synced.usage_sharing === true);
    setIdProfile(synced);
    setIdChecked(true);
    if (!synced) {
      setFriends([]);
      return;
    }
    const list = await listIdFriends().catch(() => []);
    setFriends((prev) => {
      const live = new Map(prev.map((f) => [f.handle, f]));
      return list.map((f) => {
        const handle = f.profile.handle ?? "";
        const base: Friend = {
          id: f.profile.id,
          handle: handle || "(no handle yet)",
          avatarUrl: f.profile.avatar_url ?? "",
          friendStatus: f.state,
          presence: "offline",
          agentCount: 0,
          lastSeen: null,
        };
        const existing = live.get(handle);
        return existing
          ? { ...base, presence: existing.presence, agentCount: existing.agentCount, windowId: existing.windowId ?? base.windowId, lastSeen: existing.lastSeen }
          : base;
      });
    });
  }, []);

  useEffect(() => {
    void refreshIdentity();
    const offAuth = onAuthChange(() => {
      setUsageConsent(false);
      void refreshIdentity();
    });
    // Settings → Account → Privacy changed what this account shares.
    const privacyChanged = () => {
      setUsageConsent(false);
      void refreshIdentity();
      if (getAblyClient()) void refreshAuthorization().catch(() => {});
    };
    window.addEventListener("flock:social-privacy-changed", privacyChanged);
    const offFriendships = subscribeFriendships(() => void refreshIdentity());
    // A safety net for projects without realtime: a minute, only while the
    // window is in use, and once more on coming back to it.
    const poll = setInterval(() => {
      if (isWindowActive()) void refreshIdentity();
    }, 60_000);
    const offActive = onWindowActiveChange((active) => {
      if (active) void refreshIdentity();
    });
    return () => {
      offAuth();
      offFriendships();
      clearInterval(poll);
      offActive();
      window.removeEventListener("flock:social-privacy-changed", privacyChanged);
    };
  }, [refreshIdentity]);

  // A request in, or one of yours accepted: a note in the corner.
  useEffect(() => {
    if (!idProfile?.id || !notify) return;
    return subscribeFriendEvents(idProfile.id, (e) => {
      if (e.kind === "request_in") {
        notify({ status: "info", category: "agent", priority: true, text: `@${e.from.handle ?? "someone"} sent you a friend request` });
      } else {
        notify({ status: "success", category: "agent", priority: true, text: `@${e.by.handle ?? "someone"} accepted your friend request` });
      }
    });
  }, [idProfile?.id, notify]);

  // Usage counts sync only for an account that chose to share them.
  useEffect(() => {
    setUsageConsent(!!idProfile?.id && idProfile.usage_sharing === true);
    return () => setUsageConsent(false);
  }, [idProfile?.id, idProfile?.usage_sharing]);

  const addFriend = useCallback(
    async (input: string) => {
      const result = await addFriendOrInvite(input);
      await refreshIdentity();
      return result;
    },
    [refreshIdentity],
  );

  const acceptFriend = useCallback(
    async (profileId: string) => {
      await acceptFriendRequest(profileId);
      await refreshIdentity();
    },
    [refreshIdentity],
  );

  const removeFriend = useCallback(
    async (profileId: string) => {
      await removeFriendship(profileId);
      await refreshIdentity();
    },
    [refreshIdentity],
  );

  return { idProfile, idChecked, refreshIdentity, friends, setFriends, addFriend, acceptFriend, removeFriend };
}
