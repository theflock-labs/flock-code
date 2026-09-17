---
name: Flock workspace launcher
description: Scoped lineup controls within flock's existing desktop modal system.
colors:
  action: "#5b8cff"
  bg-window: "#0b1524"
  bg-card: "#0f1b2e"
  text-hi: "#ece9e2"
  text-mid: "#c9ceda"
  border-subtle: "rgba(236, 233, 226, 0.07)"
  bg-hover: "rgba(236, 233, 226, 0.06)"
typography:
  body:
    fontFamily: '"Outfit", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif'
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: '"Outfit", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif'
    fontSize: "13px"
    fontWeight: 500
  helper:
    fontFamily: '"Outfit", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif'
    fontSize: "12px"
    lineHeight: 1.45
  metadata:
    fontFamily: '"IBM Plex Mono", "SF Mono", ui-monospace, Menlo, Monaco, "Hack", monospace'
    fontSize: "11px"
rounded:
  control: "6px"
  row: "7px"
spacing:
  dense: "7px"
  compact: "8px"
  row: "12px"
  section: "20px"
components:
  button-primary:
    backgroundColor: "var(--action-fill)"
    textColor: "{colors.bg-window}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-mid}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  input:
    backgroundColor: "{colors.bg-window}"
    textColor: "{colors.text-hi}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
  preset:
    backgroundColor: "{colors.bg-window}"
    textColor: "{colors.text-hi}"
    rounded: "8px"
    padding: "13px"
  choice:
    backgroundColor: "{colors.bg-window}"
    textColor: "{colors.text-hi}"
    rounded: "{rounded.row}"
  choice-selected:
    backgroundColor: "color-mix(in srgb, var(--action) 10%, var(--bg-window))"
    textColor: "{colors.text-hi}"
    rounded: "{rounded.row}"
  session-seat:
    backgroundColor: "{colors.bg-window}"
    textColor: "{colors.text-hi}"
    rounded: "{rounded.control}"
    padding: "0 10px"
---

# Design System: Flock workspace launcher

## Overview

**Creative North Star: "Flock’s workspace lineup"**

This scoped record describes the finished New Workspace extension and the modal primitives it reuses. It inherits flock’s established desktop world: Outfit labels, IBM Plex Mono machine details, theme-aware selection outlines, restrained borders and official provider marks. It does not establish a new app-wide identity.

The authority is the shipped [launcher stylesheet](../../../apps/flock-desktop/src/styles/newWorkspace.css), [shared dialog stylesheet](../../../apps/flock-desktop/src/styles/spawnDialog.css) and [global theme](../../../apps/flock-desktop/src/styles/global.css), with behavior in [NewWorkspaceDialog.tsx](../../../apps/flock-desktop/src/components/NewWorkspaceDialog.tsx). [PRODUCT.md](PRODUCT.md) records the confirmed product scope; the [surface brief](../../../.impeccable/surfaces/lock-desktop-src-components-newworkspacedialog-tsx.md) owns the task sequence and reference. Frontmatter colors are the inherited Nightfall baseline, not a replacement theme. Runtime global tokens, theme overrides and UI scaling remain authoritative. The sidecar’s generated tonal ramps are panel previews, not additional runtime tokens.

**Key Characteristics:**

- Compact, readable controls within the incumbent modal frame.
- Shared selection treatment across lineup choices.
- Numbered sessions with visible individual editing.

## Colors

The launcher uses flock’s cool neutral surfaces and interaction accent; it adds no palette.

### Primary

- **Action:** selection borders, focus outlines and interactive text use `--action`. The launch button uses `--action-fill` so light-theme contrast follows the incumbent theme.

### Neutral

- **Window and card grounds:** controls use `--bg-window` inside the dialog’s `--bg-card` surface.
- **High and middle text:** names and values use `--text-hi`; explanatory copy uses `--text-mid`.
- **Subtle edge and hover wash:** borders use `--border-subtle`; hover uses `--bg-hover` with `--text-low` borders. Existing warning, failure and readiness colors retain their global semantic roles.

**The Shared Selection Rule.** Presets, provider choices, counts and isolation choices use the active theme’s action border and a 10% action mix over the window ground. Provider identity stays in its official mark.

## Typography

**Body and labels:** Outfit through `--font-sans`. **Machine details:** IBM Plex Mono through `--font-mono`.

The compact ramp separates the panel title (`--fs-xl`) from control text and session-count buttons (`--fs-base`), helper copy (`--fs-sm`) and preset count metadata/session numbers (`--fs-xs`). The title inherits the shared dialog title styling. Labels use sentence case; repeated choice labels use medium weight. Helpers use comfortable short-paragraph leading (1.4–1.45). Paths, refs and keystrokes retain the shared modal’s mono treatment.

**The Reading Roles Rule.** Use sans for choices, including session-count buttons, and explanations; use mono for paths, refs, preset count metadata and session numbers. Inherit the app’s type scale and UI-size setting.

## Layout

The scoped dialog is 760px before UI scaling. Width and height limits divide by `--ui-scale` so the frame fits the viewport. Its header and footer remain outside the scrolling body; the disabled configuration fieldset sits inside that body, preserving scrolling while launch preparation freezes controls.

Repeated sections use the section spacing step, with tighter field and grid gaps. Desktop body insets are 24px. Presets, providers and session seats use equal three-column grids; at 600px they become two columns with 16px side insets and 18px section gaps, then one column at 360px. Count and isolation rows wrap. Shared dialog behavior at 480px also wraps the footer and branch controls and hides the keyboard hint.

## Elevation & Depth

The shared frame uses `--lift-3`, `--radius-modal`, a theme-aware border and the existing blurred overlay. Theme changes, including High Contrast’s removal of shadows, come from global CSS. Choice cards and session seats remain flat; their ground, edge and selected fill establish hierarchy. No additional card shadow is introduced.

## Shapes

Repeated inputs, buttons and session seats use the control corner; selectable rows use the row corner. Preset cards retain their observed slightly broader corner. Small checks are circular, while inherited readiness badges remain pills. The modal frame keeps the existing global modal radius.

## Components

### Buttons and fields

Reuse the shared launch, ghost and input primitives. Launch uses the action fill, dims on hover and becomes visibly disabled during unavailable or preparing states. Ghost buttons strengthen their edge and text on hover. Inputs use the window ground, a subtle border and an action-colored focus border; validation uses the existing failure token.

### Presets and choice controls

Preset cards expose a name, count and readable lineup description. Provider tiles pair the existing SVG mark with the provider name, readiness text where needed and a selected check. Counts use tabular figures. Isolation choices share the same selection treatment; unavailable worktree choice uses a dashed edge. Hover does not erase selection. Keyboard focus uses an action outline (2px with a 3px offset).

### Numbered session seats

Each seat has its number, official provider mark and a native select. The row uses the window ground without an additional border. Focus surrounds the whole seat (2px action outline with a 2px offset), and long content can shrink within its grid column.

### Customization and readiness

The existing disclosure exposes branch, name and setup controls. Secure-mode and recovery content retain the shared dialog’s checkbox rows, semantic readiness badge and caution panel. Helpers wrap rather than truncate working-directory consequences. These are inherited modal patterns, not new navigation or notification systems.

## Do's and Don'ts

### Do:

- **Do** bind color and type to the existing global tokens and theme overrides.
- **Do** keep the shared selection treatment and visible keyboard focus across launcher choices.
- **Do** preserve readable labels through wrapping grids and the independently scrolling body.

### Don't:

- **Don't** promote this launcher’s composition into a global layout rule.
- **Don't** introduce new palette values or substitute provider identity for the common selection accent.

Not canonized: the unused shared eyebrow class, any unrelated app patterns, and one-off ornament dimensions are outside this record. No eyebrow is rendered by this launcher; no craft-floor violation is promoted into a reusable rule.
