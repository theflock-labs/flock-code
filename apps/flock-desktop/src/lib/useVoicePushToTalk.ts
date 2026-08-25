import { useCallback, useEffect, useRef, useState } from "react";
import {
  voiceGetEnabled,
  voiceModelStatus,
  voicePrewarm,
  onVoiceLevel,
  voiceStartRecording,
  voiceStopRecording,
  sendInput,
} from "./tauri";
import { getStoredVoiceHotkey, getVoiceHotkeyOption, onVoiceHotkeyChange } from "./voiceHotkey";
import { noteInjectedInput } from "./terminalRegistry";

export type VoiceHudState = { status: "recording" | "transcribing"; locked?: boolean } | null;

/**
 * How long a single recording may run before stopping itself.
 *
 * An open mic costs ~375 KB/s of audio in the backend and is recording the
 * room; the hands-free lock has nothing forcing it to end, so a forgotten one
 * used to run until the app was quit. Auto-stopping transcribes what was
 * captured exactly as a manual stop does, so nothing is thrown away.
 *
 * Deliberately under the backend's own 300s capture ceiling
 * (`MAX_RECORDING_SECS` in voice.rs), so a recording always ends by choice with
 * a complete transcript rather than being silently truncated at the cap.
 */
const AUTO_STOP_MS = 240_000;

interface Options {
  /** Which pane the transcribed text is typed into on release. */
  getTargetPaneId: () => string | null;
  /** Optional extra gate (e.g. "no dialog open"); defaults to always allowed. */
  guard?: () => boolean;
}

/**
 * Push-to-talk voice dictation, self-contained so it works in *any* window —
 * the main cockpit and popped-out agent windows alike. Each window that mounts
 * this owns its own hotkey listeners; since only the focused window receives
 * keyboard events, whichever window you're in is the one that records and
 * receives the text. Returns the HUD state to render a <VoiceOverlay>, plus a
 * `preview` (for the Settings test button) and a `refresh` (to re-read the
 * enabled/model prefs after they change in Settings).
 */
export function useVoicePushToTalk({ getTargetPaneId, guard }: Options) {
  const [voiceHud, setVoiceHud] = useState<VoiceHudState>(null);
  const [voiceLevel, setVoiceLevel] = useState(0);

  const enabledRef = useRef(false);
  const modelRef = useRef(false);
  const recordingRef = useRef(false);
  // Hands-free lock: a quick tap (<300ms) keeps recording until the next tap.
  const lockedRef = useRef(false);
  const keyDownAtRef = useRef(0);
  // Pending auto-stop, armed for the lifetime of any recording.
  const autoStopRef = useRef<number | null>(null);
  const hotkeyRef = useRef(getVoiceHotkeyOption(getStoredVoiceHotkey()));
  const startPromiseRef = useRef<Promise<unknown>>(Promise.resolve());
  const optsRef = useRef({ getTargetPaneId, guard });
  optsRef.current = { getTargetPaneId, guard };

  const refresh = useCallback(async () => {
    const [enabled, status] = await Promise.all([
      voiceGetEnabled().catch(() => false),
      voiceModelStatus().catch(() => ({ downloaded: false })),
    ]);
    enabledRef.current = enabled;
    modelRef.current = status.downloaded;
    // Pre-load the model so the first dictation transcribes instantly instead
    // of blocking on a multi-second load inside "Transcribing…".
    if (enabled && status.downloaded) voicePrewarm().catch(() => {});
  }, []);

  // Refresh on mount and whenever this window regains focus (covers enabling
  // voice in the main window's Settings while a popout is open).
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  useEffect(() => onVoiceHotkeyChange((id) => { hotkeyRef.current = getVoiceHotkeyOption(id); }), []);

  // Live mic level (0–1) drives the HUD soundwave. `voice://level` is emitted
  // to all windows; only the recording one shows the bar.
  useEffect(() => {
    let un: (() => void) | undefined;
    onVoiceLevel(setVoiceLevel).then((fn) => (un = fn));
    return () => un?.();
  }, []);

  useEffect(() => {
    const clearAutoStop = () => {
      if (autoStopRef.current !== null) {
        clearTimeout(autoStopRef.current);
        autoStopRef.current = null;
      }
    };

    const stop = () => {
      clearAutoStop();
      if (!recordingRef.current) return;
      recordingRef.current = false;
      lockedRef.current = false;
      setVoiceHud((h) => (h ? { status: "transcribing" } : h));
      // Chain the stop off the start promise so a quick tap can't stop before
      // the backend has registered the recording (which would orphan the mic).
      startPromiseRef.current
        .catch(() => {})
        .then(() => voiceStopRecording())
        .then((text) => {
          setVoiceHud(null);
          if (!text) return;
          const paneId = optsRef.current.getTargetPaneId();
          if (!paneId) return;
          sendInput(paneId, new TextEncoder().encode(text)).catch(console.error);
          // Dictated text bypasses xterm's onData, so the input-line sniffer
          // has to be told about it or "Send to Prompt Queue" misses it.
          noteInjectedInput(paneId, text);
        })
        .catch((err) => {
          console.error("voice: failed to transcribe", err);
          setVoiceHud(null);
        });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!hotkeyRef.current.matches(e)) return;
      if (!enabledRef.current || !modelRef.current) return;
      if (optsRef.current.guard && !optsRef.current.guard()) return;
      if (recordingRef.current) {
        // Hands-free lock active: a fresh press (not OS key-repeat) ends it.
        if (lockedRef.current && !e.repeat) {
          e.preventDefault();
          stop();
        }
        return; // otherwise ignore key-repeat while held
      }
      recordingRef.current = true;
      lockedRef.current = false;
      keyDownAtRef.current = Date.now();
      e.preventDefault();
      setVoiceHud({ status: "recording" });
      // Nothing else guarantees a recording ends: the hands-free lock runs
      // until the next tap, and a key the OS never reports releasing leaves
      // push-to-talk held forever. Blur covers switching away, but not walking
      // away with this window focused. Arm the backstop at the same moment the
      // mic opens, whichever mode this turns into.
      clearAutoStop();
      autoStopRef.current = window.setTimeout(() => {
        autoStopRef.current = null;
        if (!recordingRef.current) return;
        console.warn(`voice: auto-stopping after ${AUTO_STOP_MS / 1000}s`);
        stop();
      }, AUTO_STOP_MS);
      startPromiseRef.current = voiceStartRecording().catch((err) => {
        console.error("voice: failed to start recording", err);
        recordingRef.current = false;
        clearAutoStop();
        setVoiceHud(null);
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!hotkeyRef.current.matches(e)) return;
      e.preventDefault();
      // Quick tap = hands-free: keep recording until the next tap. A held
      // key releasing after the threshold is classic push-to-talk.
      if (
        recordingRef.current &&
        !lockedRef.current &&
        Date.now() - keyDownAtRef.current < 300
      ) {
        lockedRef.current = true;
        setVoiceHud({ status: "recording", locked: true });
        return;
      }
      stop();
    };
    // Cmd-Tab / switch away while holding the key: the keyup fires in another
    // window/app and this one never sees it, so stop on blur to avoid a hung
    // recording. Safe because the HUD is in-window (no window is spawned that
    // could blur this one spuriously).
    const onBlur = () => stop();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      clearAutoStop();
    };
  }, []);

  const preview = useCallback(() => {
    setVoiceHud({ status: "recording" });
    setTimeout(() => setVoiceHud((h) => (h ? { status: "transcribing" } : h)), 2200);
    setTimeout(() => setVoiceHud(null), 3200);
  }, []);

  return { voiceHud, voiceLevel, preview, refresh };
}
