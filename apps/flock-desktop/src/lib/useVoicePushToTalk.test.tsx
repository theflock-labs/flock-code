// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./tauri", () => ({
  voiceGetEnabled: vi.fn(), voiceGetInputSource: vi.fn(), voiceModelStatus: vi.fn(),
  voicePrewarm: vi.fn(async () => {}), onVoiceLevel: vi.fn(async () => () => {}),
  voiceStartRecording: vi.fn(), voiceStopRecording: vi.fn(), sendInput: vi.fn(),
}));
vi.mock("./terminalRegistry", () => ({ noteInjectedInput: vi.fn() }));
import * as api from "./tauri";
import { noteInjectedInput } from "./terminalRegistry";
import { useVoicePushToTalk } from "./useVoicePushToTalk";

const key = (type: "keydown" | "keyup") => act(() => {
  window.dispatchEvent(new KeyboardEvent(type, { code: "AltRight", cancelable: true }));
});
const flush = async () => act(async () => { await Promise.resolve(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function open(getTargetPaneId: () => string | null = () => "original-agent") {
  const hook = renderHook(() => useVoicePushToTalk({ getTargetPaneId }));
  await flush();
  return hook;
}

describe("voice capture ownership and insertion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.resetAllMocks();
    vi.mocked(api.voiceGetEnabled).mockResolvedValue(true);
    vi.mocked(api.voiceGetInputSource).mockResolvedValue("desktop");
    vi.mocked(api.voiceModelStatus).mockResolvedValue({ downloaded: true });
    vi.mocked(api.voicePrewarm).mockResolvedValue(undefined);
    vi.mocked(api.onVoiceLevel).mockResolvedValue(() => {});
    vi.mocked(api.voiceStartRecording).mockResolvedValue("desktop");
    vi.mocked(api.voiceStopRecording).mockResolvedValue("Create a greeting test.");
    vi.mocked(api.sendInput).mockResolvedValue(undefined);
  });
  afterEach(async () => { cleanup(); await flush(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("pins the destination before capture and inserts text without submitting", async () => {
    let target = "original-agent";
    await open(() => target); key("keydown"); await flush();
    target = "different-agent";
    act(() => vi.advanceTimersByTime(400)); key("keyup"); await flush();
    expect(api.sendInput).toHaveBeenCalledWith("original-agent", new TextEncoder().encode("Create a greeting test."));
    expect(noteInjectedInput).toHaveBeenCalledWith("original-agent", "Create a greeting test.");
  });

  it("keeps a quick tap recording and uses the next tap to finish", async () => {
    const { result } = await open(); key("keydown"); key("keyup"); await flush();
    expect(result.current.voiceHud).toMatchObject({ status: "recording", source: "desktop", locked: true });
    expect(api.voiceStopRecording).not.toHaveBeenCalled();
    key("keydown"); await flush();
    expect(api.voiceStopRecording).toHaveBeenCalledTimes(1);
  });

  it("waits for native startup before stopping after a blur", async () => {
    const start = deferred<api.VoiceInputSource>();
    vi.mocked(api.voiceStartRecording).mockReturnValue(start.promise);
    await open(); key("keydown");
    act(() => window.dispatchEvent(new Event("blur")));
    expect(api.voiceStopRecording).not.toHaveBeenCalled();
    await act(async () => start.resolve("desktop"));
    expect(api.voiceStopRecording).toHaveBeenCalledTimes(1);
  });

  it("shows permission failures without stopping someone else's recording", async () => {
    vi.mocked(api.voiceStartRecording).mockRejectedValue("Allow Screen & System Audio Recording for flock.");
    const { result } = await open(); key("keydown"); await flush(); key("keyup"); await flush();
    expect(result.current.voiceHud).toMatchObject({ status: "error", error: "Allow Screen & System Audio Recording for flock." });
    expect(api.voiceStopRecording).not.toHaveBeenCalled();
    expect(api.sendInput).not.toHaveBeenCalled();
    act(() => result.current.dismissError()); expect(result.current.voiceHud).toBeNull();
  });

  it("blocks new capture while the previous transcript is pending", async () => {
    const finish = deferred<string>();
    vi.mocked(api.voiceStopRecording).mockReturnValue(finish.promise);
    await open(); key("keydown"); await flush();
    act(() => vi.advanceTimersByTime(400)); key("keyup"); await flush(); key("keydown");
    expect(api.voiceStartRecording).toHaveBeenCalledTimes(1);
    await act(async () => finish.resolve("done")); key("keydown"); await flush();
    expect(api.voiceStartRecording).toHaveBeenCalledTimes(2);
  });

  it("stops an unmounted pending capture without injecting a ghost prompt", async () => {
    const start = deferred<api.VoiceInputSource>();
    vi.mocked(api.voiceStartRecording).mockReturnValue(start.promise);
    const { unmount } = await open(); key("keydown"); unmount();
    await act(async () => start.resolve("desktop"));
    expect(api.voiceStopRecording).toHaveBeenCalledTimes(1);
    expect(api.sendInput).not.toHaveBeenCalled();
  });

  it("auto-stops hands-free capture and strips terminal control characters", async () => {
    vi.mocked(api.voiceStopRecording).mockResolvedValue("add tests\r\nplease\u0003");
    await open(); key("keydown"); key("keyup"); await flush();
    await act(async () => vi.advanceTimersByTime(240_000));
    expect(api.voiceStopRecording).toHaveBeenCalledTimes(1);
    expect(api.sendInput).toHaveBeenCalledWith("original-agent", new TextEncoder().encode("add tests please"));
  });

  it("does not open capture without a destination pane", async () => {
    await open(() => null); key("keydown"); expect(api.voiceStartRecording).not.toHaveBeenCalled();
  });

  it("keeps an insertion failure visible", async () => {
    vi.mocked(api.sendInput).mockRejectedValue("The agent pane closed.");
    const { result } = await open(); key("keydown"); await flush();
    act(() => vi.advanceTimersByTime(400)); key("keyup"); await flush();
    expect(result.current.voiceHud).toMatchObject({ status: "error", error: "The agent pane closed." });
    expect(noteInjectedInput).not.toHaveBeenCalled();
  });
});
