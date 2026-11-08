// The demo's presence: never connects, never reaches the network. Swapped in
// for lib/presence by vite.demo.config.ts; never part of the app.
export { MY_WINDOW_ID } from "../lib/windowId";
export type PresenceStatus = "connecting" | "connected" | "failed";
export type PresenceEvent =
  | { kind: "online" | "update"; login: string; agentCount: number; windowId?: string }
  | { kind: "offline"; login: string };
export const connectPresence = (): Promise<void> => new Promise(() => {});
export const disconnectPresence = (): void => {};
export const refreshAuthorization = (): Promise<void> => Promise.reject(new Error("no presence in the demo"));
export const updateAgentCount = async (): Promise<void> => {};
export const updateFriends = (): void => {};
export const resyncFriendPresence = async (): Promise<void> => {};
export const getAblyClient = (): null => null;
export const getPresenceChannel = (): null => null;
export const getRealtimeIdentity = (): null => null;
export const peerId = (): null => null;
export const verifiedHandle = (): null => null;
export const getStreamGrant = (): null => null;
export const onRealtimeContext = (): (() => void) => () => {};
