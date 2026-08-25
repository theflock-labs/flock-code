// Text size. TWO independent settings, both in Settings → Appearance:
//
//   1. App text size  — the chrome: sidebar, rails, pane topbars, dialogs.
//      A coarse four-notch scale applied as CSS `zoom` via the --ui-scale
//      variable set below. Coarse on purpose: `zoom` reflows the whole
//      layout, and the rail widths are stated in unzoomed px (see
//      RailResizer), so arbitrary factors buy nothing but jitter.
//   2. Agent pane text size — the font size, in px, of every xterm the app
//      opens. A plain px value stepped one point at a time, because this is
//      the text people actually read all day and "Medium / Large" is not a
//      unit a terminal has.
//
// They are separate because they scale different things for different
// reasons: chrome is sized for the room, an agent pane for the eyes on it.
// Yoking them meant that making agent output readable inflated a sidebar
// nobody was reading.
//
// xterm.js is deliberately excluded from the zoomed subtree, and that is not
// a style choice: WebKit has a well-known bug where canvas-backed elements
// (exactly what xterm's renderer is) stop repainting once a zoom-affected
// ancestor's layout settles, recovering only on the next forced reflow. So
// panes never inherit `zoom`; they get their fontSize set directly instead —
// see the onPaneFontSizeChange subscription in Terminal.tsx.

export type UiScaleId = "sm" | "md" | "lg" | "xl";

export const UI_SCALES: { id: UiScaleId; label: string; factor: number }[] = [
  { id: "sm", label: "Small", factor: 1.0 },
  { id: "md", label: "Medium", factor: 1.08 },
  { id: "lg", label: "Large", factor: 1.23 },
  { id: "xl", label: "Extra Large", factor: 1.38 },
];

const STORAGE_KEY = "flock:ui-scale";
const SCALE_EVENT = "flock:ui-scale-changed";
const DEFAULT_SCALE: UiScaleId = "md";

const PANE_KEY = "flock:pane-font-size";
const PANE_EVENT = "flock:pane-font-size-changed";

/** xterm's font size at scale 1 — the size every pane opened before this
 *  setting existed, and the anchor the legacy migration below multiplies. */
export const BASE_PANE_FONT_SIZE = 13;
export const PANE_FONT_MIN = 8;
export const PANE_FONT_MAX = 28;

export function getStoredUiScale(): UiScaleId {
  const v = localStorage.getItem(STORAGE_KEY);
  return UI_SCALES.some((s) => s.id === v) ? (v as UiScaleId) : DEFAULT_SCALE;
}

export function getScaleFactor(id: UiScaleId): number {
  return UI_SCALES.find((s) => s.id === id)?.factor ?? 1;
}

function clampPaneFont(px: number): number {
  return Math.max(PANE_FONT_MIN, Math.min(PANE_FONT_MAX, Math.round(px)));
}

/** The agent pane font size in px.
 *
 *  When nothing has been stored under the pane key this falls back to the
 *  size the single old setting produced (BASE × the app scale factor), so an
 *  install upgrading into the split sees its panes at exactly the size it
 *  left them — and only then decouples, because main.tsx persists what this
 *  returns at boot. Without that write, later changing the *app* scale would
 *  still move pane text for anyone who never opened the new control. */
export function getStoredPaneFontSize(): number {
  const raw = localStorage.getItem(PANE_KEY);
  // `Number("")` is 0, which would clamp to the minimum and shrink every pane
  // to 8px off an empty string — so a blank value counts as unset, not as a
  // size. Same for anything that does not parse.
  const n = raw === null || raw.trim() === "" ? NaN : Number(raw);
  if (Number.isFinite(n)) return clampPaneFont(n);
  return clampPaneFont(BASE_PANE_FONT_SIZE * getScaleFactor(getStoredUiScale()));
}

function reflectUiScale(id: UiScaleId) {
  document.documentElement.style.setProperty("--ui-scale", String(getScaleFactor(id)));
  window.dispatchEvent(new CustomEvent<UiScaleId>(SCALE_EVENT, { detail: id }));
}

export function applyUiScale(id: UiScaleId) {
  localStorage.setItem(STORAGE_KEY, id);
  reflectUiScale(id);
}

/** Set the agent pane font size (clamped) and notify every live xterm. */
export function applyPaneFontSize(px: number): number {
  const size = clampPaneFont(px);
  localStorage.setItem(PANE_KEY, String(size));
  window.dispatchEvent(new CustomEvent<number>(PANE_EVENT, { detail: size }));
  return size;
}

/**
 * Step the app scale one notch up (delta +1) or down (delta -1) through
 * UI_SCALES, clamped at the ends, and apply it. Backs the ⌥⌘+ / ⌥⌘-
 * shortcuts. Returns the resulting scale id (unchanged if already clamped).
 */
export function stepUiScale(delta: number): UiScaleId {
  const idx = UI_SCALES.findIndex((s) => s.id === getStoredUiScale());
  const next = Math.max(0, Math.min(UI_SCALES.length - 1, (idx < 0 ? 0 : idx) + delta));
  const id = UI_SCALES[next].id;
  applyUiScale(id);
  return id;
}

/** Step the agent pane font size by one point. Backs ⌘+ / ⌘- — the bare
 *  shortcut goes to the panes, since that is the text the app is for. */
export function stepPaneFontSize(delta: number): number {
  return applyPaneFontSize(getStoredPaneFontSize() + delta);
}

/** Subscribe to app scale changes made via applyUiScale(). Returns unsubscribe. */
export function onUiScaleChange(handler: (id: UiScaleId) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<UiScaleId>).detail);
  window.addEventListener(SCALE_EVENT, listener);
  return () => window.removeEventListener(SCALE_EVENT, listener);
}

/** Subscribe to pane font size changes. Returns unsubscribe. */
export function onPaneFontSizeChange(handler: (px: number) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<number>).detail);
  window.addEventListener(PANE_EVENT, listener);
  return () => window.removeEventListener(PANE_EVENT, listener);
}

// Popped-out agent windows are separate webviews on the same origin, so they
// hear neither window's CustomEvents — but they do get `storage`, which fires
// only in the *other* documents. Re-emit locally so ⌘+ in the cockpit resizes
// a popped-out pane too, and never write back (that would be a loop).
window.addEventListener?.("storage", (e) => {
  if (e.key === PANE_KEY && e.newValue !== null) {
    const n = Number(e.newValue);
    if (Number.isFinite(n)) {
      window.dispatchEvent(new CustomEvent<number>(PANE_EVENT, { detail: clampPaneFont(n) }));
    }
  } else if (e.key === STORAGE_KEY && e.newValue !== null) {
    if (UI_SCALES.some((s) => s.id === e.newValue)) reflectUiScale(e.newValue as UiScaleId);
  }
});
