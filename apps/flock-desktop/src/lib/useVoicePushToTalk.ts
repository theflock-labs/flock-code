import { useCallback, useEffect, useRef, useState } from "react";
import {
  voiceGetEnabled, voiceGetInputSource, voiceModelStatus, voicePrewarm,
  onVoiceLevel, voiceStartRecording, voiceStopRecording, sendInput,
  type VoiceInputSource,
} from "./tauri";
import { getStoredVoiceHotkey, getVoiceHotkeyOption, onVoiceHotkeyChange } from "./voiceHotkey";
import { noteInjectedInput } from "./terminalRegistry";

export type VoiceHudState = {
  status: "starting" | "recording" | "transcribing" | "error";
  source: VoiceInputSource;
  locked?: boolean;
  error?: string;
} | null;

// Under the backend's 300s ceiling. Applies to either source and hands-free mode.
const AUTO_STOP_MS = 240_000;
interface Options {
  getTargetPaneId: () => string | null;
  guard?: () => boolean;
}

/** In-window push-to-talk: one capture, one pinned destination, local transcription. */
export function useVoicePushToTalk({ getTargetPaneId, guard }: Options) {
  const [voiceHud, setVoiceHud] = useState<VoiceHudState>(null);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const enabledRef = useRef(false);
  const modelRef = useRef(false);
  const sourceRef = useRef<VoiceInputSource>("microphone");
  const recordingRef = useRef(false);
  const busyRef = useRef(false);
  const lockedRef = useRef(false);
  const keyDownAtRef = useRef(0);
  const autoStopRef = useRef<number | null>(null);
  const targetRef = useRef<string | null>(null);
  const hotkeyRef = useRef(getVoiceHotkeyOption(getStoredVoiceHotkey()));
  const startPromiseRef = useRef<Promise<boolean>>(Promise.resolve(false));
  const optsRef = useRef({ getTargetPaneId, guard });
  optsRef.current = { getTargetPaneId, guard };

  const refresh = useCallback(async () => {
    const [enabled, status, source] = await Promise.all([
      voiceGetEnabled().catch(() => false),
      voiceModelStatus().catch(() => ({ downloaded: false })),
      voiceGetInputSource().catch(() => "microphone" as const),
    ]);
    enabledRef.current = enabled;
    modelRef.current = status.downloaded;
    sourceRef.current = source;
    if (enabled && status.downloaded) voicePrewarm().catch(() => {});
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  useEffect(() => onVoiceHotkeyChange((id) => { hotkeyRef.current = getVoiceHotkeyOption(id); }), []);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onVoiceLevel(setVoiceLevel).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch(console.error);
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    const clearAutoStop = () => {
      if (autoStopRef.current !== null) clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    };
    const showError = (error: unknown) => {
      if (!disposed) setVoiceHud({ status: "error", source: sourceRef.current, error: String(error) });
    };
    const stop = (insert = true) => {
      clearAutoStop();
      if (!recordingRef.current) return;
      recordingRef.current = false;
      lockedRef.current = false;
      const paneId = targetRef.current;
      if (!disposed) setVoiceHud((hud) => hud ? { ...hud, status: "transcribing", locked: false } : null);
      // A quick release/blur can precede capture startup or its permission prompt.
      // Only stop a capture we successfully started; another window may own one.
      void startPromiseRef.current.then(async (started) => {
        if (!started) return;
        const text = await voiceStopRecording();
        if (disposed) return;
        if (insert && paneId && text.trim()) {
          // A transcript is editable input, never an implicit Return/terminal escape.
          const input = text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
          if (input) {
            await sendInput(paneId, new TextEncoder().encode(input));
            noteInjectedInput(paneId, input);
          }
        }
        setVoiceHud(null);
      }).catch(showError).finally(() => { busyRef.current = false; });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!hotkeyRef.current.matches(event)) return;
      if (recordingRef.current) {
        if (lockedRef.current && !event.repeat) { event.preventDefault(); stop(); }
        return;
      }
      if (busyRef.current || event.repeat || !enabledRef.current || !modelRef.current) return;
      if (optsRef.current.guard && !optsRef.current.guard()) return;
      const paneId = optsRef.current.getTargetPaneId();
      if (!paneId) return;
      event.preventDefault();
      targetRef.current = paneId;
      recordingRef.current = true;
      busyRef.current = true;
      lockedRef.current = false;
      keyDownAtRef.current = Date.now();
      setVoiceLevel(0);
      setVoiceHud({ status: "starting", source: sourceRef.current });
      clearAutoStop();
      autoStopRef.current = window.setTimeout(() => stop(), AUTO_STOP_MS);
      startPromiseRef.current = voiceStartRecording().then((source) => {
        sourceRef.current = source;
        if (!disposed && recordingRef.current) setVoiceHud({ status: "recording", source, locked: lockedRef.current });
        return true;
      }, (error) => {
        // If stop already owns completion, it also owns clearing busy.
        if (recordingRef.current) busyRef.current = false;
        recordingRef.current = false;
        lockedRef.current = false;
        clearAutoStop();
        showError(error);
        return false;
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!hotkeyRef.current.matches(event) || !recordingRef.current) return;
      event.preventDefault();
      if (!lockedRef.current && Date.now() - keyDownAtRef.current < 300) {
        lockedRef.current = true;
        setVoiceHud((hud) => hud ? { ...hud, locked: true } : null);
      } else stop();
    };
    // No global capture: changing apps stops even a hands-free dictation.
    const onBlur = () => stop();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      clearAutoStop();
      stop(false);
    };
  }, []);

  const preview = useCallback(() => {
    if (busyRef.current) return;
    setVoiceHud({ status: "recording", source: sourceRef.current });
    setTimeout(() => setVoiceHud((hud) => busyRef.current ? hud : hud ? { ...hud, status: "transcribing" } : null), 2200);
    setTimeout(() => { if (!busyRef.current) setVoiceHud(null); }, 3200);
  }, []);
  const dismissError = useCallback(() => setVoiceHud((hud) => hud?.status === "error" ? null : hud), []);
  return { voiceHud, voiceLevel, preview, refresh, dismissError };
}
