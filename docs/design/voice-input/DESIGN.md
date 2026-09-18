---
name: Flock Voice input
description: Source selection and capture feedback within flock's existing desktop controls.
colors:
  action: "#5b8cff"
  bg-window: "#0b1524"
  bg-card: "#0f1b2e"
  text-hi: "#ece9e2"
  text-mid: "#c9ceda"
  text-low: "#a7b2c4"
  border-subtle: "rgba(236, 233, 226, 0.07)"
  group: "rgba(255, 255, 255, 0.045)"
  bad: "#ff8f84"
typography:
  label:
    fontFamily: '"Outfit", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif'
    fontSize: "13px"
  helper:
    fontFamily: '"Outfit", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif'
    fontSize: "12px"
    lineHeight: 1.4
  control:
    fontFamily: '"IBM Plex Mono", "SF Mono", ui-monospace, Menlo, Monaco, "Hack", monospace'
    fontSize: "12px"
  metadata:
    fontFamily: '"IBM Plex Mono", "SF Mono", ui-monospace, Menlo, Monaco, "Hack", monospace'
    fontSize: "11px"
rounded:
  chip: "4px"
  control: "6px"
  surface: "10px"
  modal: "14px"
spacing:
  compact: "8px"
  row: "12px"
components:
  button-primary:
    backgroundColor: "var(--action-fill)"
    textColor: "{colors.bg-window}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-mid}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  source-select:
    backgroundColor: "{colors.bg-window}"
    textColor: "{colors.text-hi}"
    typography: "{typography.control}"
    rounded: "{rounded.chip}"
    padding: "4px 8px"
  settings-tab:
    textColor: "{colors.text-mid}"
    rounded: "{rounded.chip}"
    padding: "4px 9px"
  settings-group:
    backgroundColor: "{colors.group}"
    rounded: "{rounded.surface}"
    padding: "11px 14px"
  switch:
    backgroundColor: "var(--bg-chrome)"
    rounded: "{rounded.surface}"
    width: "34px"
    height: "19px"
---

# Design System: Flock Voice input

## Overview

**Creative North Star: "Flock’s existing desktop controls"**

This scoped record captures the Voice settings and in-window capture feedback. It inherits flock’s compact grouped settings, Outfit labels, IBM Plex Mono values and theme-aware controls. Source selection extends that established interface.

Authority is the [global stylesheet](../../../apps/flock-desktop/src/styles/global.css), [SettingsDialog](../../../apps/flock-desktop/src/components/SettingsDialog.tsx) and [VoiceOverlay](../../../apps/flock-desktop/src/components/VoiceOverlay.tsx). [PRODUCT.md](PRODUCT.md) and the [surface brief](../../../.impeccable/surfaces/ps-flock-desktop-src-components-settingsdialog-tsx.md) own product behavior and scope. Frontmatter records the inherited Nightfall baseline; runtime theme overrides and UI scaling remain authoritative. Generated sidecar ramps are panel previews, not runtime tokens.

**Key Characteristics:**

- Compact grouped controls with adjacent explanation.
- Shared theme colors and native form controls.
- Visible source, capture state and recoverable errors.

## Colors

Cool neutral grounds and the existing interaction accent carry hierarchy without a Voice-specific palette.

### Primary

- **Action:** input focus uses `--action`; enabled switches, the model-download button and active recording use `--action-fill`. Inverted labels use `--bg-window`.

### Neutral

- **Window and dialog grounds:** fields use `--bg-window` inside `--bg-card`; grouped rows use `--group` with inset `--rule-faint` separators.
- **Text tiers:** labels use `--text-mid`, field values use `--text-hi`, explanations use `--text-low`. Starting and transcribing use `--blue`, the existing slate alias.
- **Edges and selection:** fields use `--border-subtle`; selected model/hotkey buttons and navigation use `--sel-neutral`.

Settings errors retain the semantic `--orange` alias of `--bad`. Capture errors use the recording bar’s action fill, with explicit error text and a Dismiss control; that fill is not a new global failure color.

**The Inherited Theme Rule.** Bind controls to global semantic variables so every theme supplies its own readable surfaces, text and action fill.

## Typography

Outfit carries labels and explanatory sentences. IBM Plex Mono carries field values, recording state, source and transcript. The inherited ramp runs from metadata (`--fs-xs`) through helpers and compact selects (`--fs-sm`), row labels and transcript (`--fs-base`) to the existing dialog title and statistics (`--fs-lg`). Settings buttons use the compact metadata size with medium sans weight. No display face is added.

**The Reading Roles Rule.** Keep explanatory sentences in sans and capture values in mono; use the existing type scale and UI-size setting.

## Layout

The existing settings frame is 680px wide before UI scaling, with a 172px navigation rail and an independently scrolling body. Height is capped at 600px and accounts for `--ui-scale` and viewport height. The centered header remains separate from content scrolling.

Grouped rows pair a left label with a right control and use a shared 12px gap. Their repeated inset is 11px vertically and 14px horizontally; hints sit outside the group fill. Hotkey and model choices wrap with 8px gaps. The source select is 180px wide, capped at 60% of its row, and its explanation wraps below it.

The capture strip spans the content area at the window bottom, starting after the scaled sidebar; popouts span the full width. Its normal height is 46px. Errors grow vertically from a 48px minimum, wrap long content and keep Dismiss from shrinking. The strip stays below dialogs and menus.

## Elevation & Depth

Settings inherits the modal’s `--lift-3`, theme-aware edge and blurred backdrop. Grouped rows and controls rely on tonal fill and fine separators. The bottom capture strip uses solid color without a new shadow. High Contrast retains the global removal of shadows.

## Shapes

Compact fields and navigation use the chip corner; buttons, including Dismiss, use the control corner. Groups and switches use the surface corner, with circular switch knobs. The modal retains its broader modal corner. The capture strip remains a full-width rectangle.

## Components

### Settings controls

The source picker is a labelled native select with associated help text. Saving temporarily disables it; the committed selection changes after persistence succeeds, and a failure displays the existing settings error. The unsupported Desktop audio option remains visible and disabled. The microphone picker is shown for Microphone. These states reuse the existing field surface and action-colored focus border.

Ghost buttons gain a stronger background and text on hover; selected model/hotkey choices use neutral fill. The solid model-download button uses action fill and opacity feedback. Switches pair a filled track with a moving, inverted knob. Navigation keeps its existing monochrome SVG icons and neutral selected row.

### Capture feedback

The strip names the source beneath STARTING, LISTENING or TRANSCRIBING. Recording retains the existing audio-reactive waveform and live transcript; the trailing instruction reflects hold or hands-free capture. Text identifies the state in addition to color. Errors replace the strip content with a wrapping `role="alert"` message and Dismiss. Dismiss uses a current-color border, a subtle hover wash and a visible current-color keyboard outline (2px with a 2px offset).

**The Paired Feedback Rule.** Keep the source next to capture state, and pair a capture error with readable recovery text and an explicit dismissal control.

## Do's and Don'ts

### Do:

- **Do** inherit theme variables, shared controls and the existing type scale.
- **Do** keep source help adjacent to its labelled control and allow it to wrap.
- **Do** preserve visible source and capture state, wrapping errors and keyboard focus.

### Don't:

- **Don't** turn this scoped recording-bar treatment into a global notification rule.
- **Don't** add a Voice-specific palette or display typography.

Not canonized: legacy inline font-size literals and decorative waveform/noise dimensions are implementation details, not new tokens. No craft-floor refusal is promoted into a reusable rule.
