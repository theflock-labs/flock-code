// Configurable push-to-talk key for flock Voice (Settings → flock
// Voice → Hotkey). All options are lone modifier keys so holding them
// doesn't collide with normal typing.

export type VoiceHotkeyId = "fn" | "altRight" | "controlRight" | "metaRight";

export interface VoiceHotkeyOption {
  id: VoiceHotkeyId;
  label: string;
  matches: (e: KeyboardEvent) => boolean;
}

export const VOICE_HOTKEYS: VoiceHotkeyOption[] = [
  { id: "altRight", label: "right ⌥", matches: (e) => e.code === "AltRight" },
  { id: "controlRight", label: "right ⌃", matches: (e) => e.code === "ControlRight" },
  { id: "metaRight", label: "right ⌘", matches: (e) => e.code === "MetaRight" },
  {
    id: "fn",
    label: "fn (unreliable)",
    // Confirmed by testing: WKWebView on this macOS build never dispatches
    // a keydown/keyup for fn at all — macOS intercepts it before it reaches
    // web content. Kept selectable in case a future macOS/WebKit version
    // changes this, but no longer the default.
    matches: (e) =>
      e.key === "Fn" || (typeof e.getModifierState === "function" && e.getModifierState("Fn")),
  },
];

const STORAGE_KEY = "flock:voice-hotkey";
const HOTKEY_EVENT = "flock:voice-hotkey-changed";
const DEFAULT_HOTKEY: VoiceHotkeyId = "altRight";

export function getStoredVoiceHotkey(): VoiceHotkeyId {
  const v = localStorage.getItem(STORAGE_KEY);
  return VOICE_HOTKEYS.some((h) => h.id === v) ? (v as VoiceHotkeyId) : DEFAULT_HOTKEY;
}

export function getVoiceHotkeyOption(id: VoiceHotkeyId): VoiceHotkeyOption {
  return VOICE_HOTKEYS.find((h) => h.id === id) ?? VOICE_HOTKEYS[0];
}

export function setStoredVoiceHotkey(id: VoiceHotkeyId) {
  localStorage.setItem(STORAGE_KEY, id);
  window.dispatchEvent(new CustomEvent<VoiceHotkeyId>(HOTKEY_EVENT, { detail: id }));
}

export function onVoiceHotkeyChange(handler: (id: VoiceHotkeyId) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<VoiceHotkeyId>).detail);
  window.addEventListener(HOTKEY_EVENT, listener);
  return () => window.removeEventListener(HOTKEY_EVENT, listener);
}
