// The demo's flock ID: a made-up person and a few made-up friends. Swapped in
// for lib/useFlockId by vite.demo.config.ts; never part of the app.
import type { Friend } from "../types";

const FRIENDS: Friend[] = [
  { id: "f1", handle: "hazel", avatarUrl: "", friendStatus: "accepted", presence: "online", agentCount: 3, lastSeen: null, windowId: "w-hazel" },
  { id: "f2", handle: "ozzy", avatarUrl: "", friendStatus: "accepted", presence: "online", agentCount: 1, lastSeen: null, windowId: "w-ozzy" },
  { id: "f3", handle: "rhea", avatarUrl: "", friendStatus: "accepted", presence: "offline", agentCount: 0, lastSeen: Math.floor(Date.now() / 1000) - 3 * 3600 },
];

export function useFlockIdentity() {
  return {
    idProfile: { id: "demo", handle: "sam", display_name: "Sam Rivera", avatar_url: null, usage_sharing: false, presence_sharing: true },
    idChecked: true,
    refreshIdentity: async () => {},
    friends: FRIENDS,
    setFriends: () => {},
    addFriend: async () => "requested" as const,
    acceptFriend: async () => {},
    removeFriend: async () => {},
  };
}
