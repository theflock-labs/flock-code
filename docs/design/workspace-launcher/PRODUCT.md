# Product: New workspace launcher

<!-- impeccable:product-schema 1 -->

This record covers the desktop New Workspace dialog and its launch path. It does not establish app-wide product or brand policy. Its confirmed source is the [surface brief](../../../.impeccable/surfaces/lock-desktop-src-components-newworkspacedialog-tsx.md).

## Platform

web

The interface runs inside the existing flock desktop app.

## Users

Developers choosing a project folder and an exact lineup of agents to work in it.

## Product Purpose

Let developers reuse or assemble an agent lineup, inspect its working-directory and execution consequences, then launch it deliberately.

## Capabilities and Constraints

- The bulk provider selector replaces the whole lineup. Each numbered session can change independently; count changes preserve existing seats. Supported counts are 1–6, 8 and 12, using existing providers.
- Presets persist only ordered agent kinds. They do not save project paths, branch plans or permissions. Selecting a preset does not launch it.
- Non-Git folders share their directory. Git projects support shared checkouts or worktrees, preserving existing branch preferences and branch/ref/setup controls. The preview explains the resulting plan before launch.
- All selected providers participate in readiness checks. Preserve Docker readiness handling, secure-mode behavior and explicit host execution warnings.

## Brand Commitments

Inherit flock’s existing theme, typography and provider marks. The user’s pinned [reference](../../../.flock/images/img-2.png) informs this surface’s presets, provider grid, visible counts, isolation choices and numbered lineup; it does not replace flock’s visual identity.

## Evidence on Hand

The [confirmed surface brief](../../../.impeccable/surfaces/lock-desktop-src-components-newworkspacedialog-tsx.md) contains the agreed scope and surface sequence. The [implementation](../../../apps/flock-desktop/src/components/NewWorkspaceDialog.tsx) is the behavioral evidence; [DESIGN.md](DESIGN.md) records its visual extension. No new raster assets ship with this surface. No unresolved product decisions were recorded in the brief.
