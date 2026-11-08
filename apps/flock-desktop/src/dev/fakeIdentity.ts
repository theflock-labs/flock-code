// The harness's flock ID: signed in, with a handle and a few friends. Swapped
// in for lib/useFlockId by vite.harness.config.ts; never part of the app.
import type { Friend } from "../types";

const now = Math.floor(Date.now() / 1000);
const FRIENDS: Friend[] = [
  { id: "f1", handle: "hazel", avatarUrl: "", friendStatus: "accepted", presence: "online", agentCount: 3, lastSeen: null, windowId: "w-hazel" },
  { id: "f2", handle: "ozzy", avatarUrl: "", friendStatus: "accepted", presence: "online", agentCount: 0, lastSeen: null, windowId: "w-ozzy" },
  { id: "f3", handle: "rhea", avatarUrl: "", friendStatus: "accepted", presence: "offline", agentCount: 0, lastSeen: now - 2 * 3600 },
  { id: "f4", handle: "kiwi", avatarUrl: "", friendStatus: "pending_in", presence: "offline", agentCount: 0, lastSeen: null },
];

export function useFlockIdentity() {
  const empty = new URLSearchParams(location.search).get("friends") === "0";
  return {
    idProfile: { id: "harness", handle: "remi", display_name: "Remi Minnebo", avatar_url: null, usage_sharing: false, presence_sharing: true },
    idChecked: true,
    refreshIdentity: async () => {},
    friends: empty ? [] : FRIENDS,
    setFriends: () => {},
    addFriend: async () => "requested" as const,
    acceptFriend: async () => {},
    removeFriend: async () => {},
  };
}
