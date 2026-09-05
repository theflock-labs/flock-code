import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handler: null as null | ((message: any) => Promise<void>),
  grant: null as any,
  rpc: vi.fn(async () => ({ error: null })),
  refresh: vi.fn(async () => {}),
  publish: vi.fn(async () => {}),
}));
const peers: Record<string, string> = { me: "me-id", partner: "partner-id", third: "third-id" };
vi.mock("./presence", () => ({
  getAblyClient: () => ({ channels: { get: () => ({
    subscribe: (_: string, handler: any) => { mocks.handler = handler; },
    unsubscribe() {}, detach: async () => {}, publish: mocks.publish,
  }) } }),
  getStreamGrant: () => mocks.grant,
  getRealtimeIdentity: () => ({ id: "me-id" }),
  peerId: (handle: string) => peers[handle] ?? null,
  verifiedHandle: (id: string) => Object.keys(peers).find(k => peers[k] === id) ?? null,
  refreshAuthorization: mocks.refresh,
}));
vi.mock("./flockId", () => ({ supabase: () => ({ rpc: mocks.rpc }) }));
vi.mock("./streamPublisher", () => ({ stopSessionStreams: vi.fn() }));
vi.mock("./windowId", () => ({ MY_WINDOW_ID: "my-window" }));
const { initSessions, requestObserve, inviteCopilot } = await import("./session");
beforeEach(() => { vi.clearAllMocks(); mocks.publish.mockResolvedValue(undefined); mocks.grant = null; });
function message(type: string, session_id: string, from = "partner") {
  return { clientId: peers[from], data: { type, session_id, from, to: "me", to_wid: "my-window", from_wid: "peer-window", pane_label: "pane" } };
}
describe("session control authorization", () => {
  it("rejects third-party termination of a session with another accepted friend", async () => {
    const receive = vi.fn(); initSessions("me", receive);
    const id = requestObserve("partner", "peer-window");
    await mocks.handler!(message("observe_end", id, "third"));
    expect(receive).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires a server-owned grant from the expected output publisher", async () => {
    const receive = vi.fn(); initSessions("me", receive);
    const id = requestObserve("partner", "peer-window");
    mocks.grant = { owner_id: "third-id", viewer_id: "me-id", session_id: id };
    await mocks.handler!(message("observe_accept", id));
    expect(receive).not.toHaveBeenCalled();
    mocks.grant = { owner_id: "partner-id", viewer_id: "me-id", session_id: id };
    await mocks.handler!(message("observe_accept", id));
    expect(receive).toHaveBeenCalledTimes(1);
  });
  it("rejects a forged from handle despite a valid friend's token", async () => {
    const receive = vi.fn(); initSessions("me", receive);
    const id = requestObserve("partner", "peer-window");
    const spoof = message("observe_accept", id); spoof.clientId = "third-id";
    await mocks.handler!(spoof);
    expect(receive).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("rejects unsolicited accept messages and malformed panes", async () => {
    const receive = vi.fn(); initSessions("me", receive);
    await mocks.handler!(message("observe_accept", crypto.randomUUID()));
    const invite: any = message("copilot_invite", crypto.randomUUID());
    invite.data.panes = [{ id: "pane", label: null }];
    await mocks.handler!(invite);
    expect(receive).not.toHaveBeenCalled();
  });
});

it("propagates denied invitation delivery and revokes any partial sharing", async () => {
  initSessions("me", vi.fn());
  mocks.publish.mockRejectedValueOnce(new Error("inbox denied"));
  await expect(inviteCopilot("partner", "peer-window", [])).rejects.toThrow("inbox denied");
  expect(mocks.rpc).toHaveBeenCalledWith("end_stream_session", { p_session_id: expect.any(String) });
});
