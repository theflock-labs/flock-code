---
version: 1
slug: "lock-desktop-src-components-newworkspacedialog-tsx"
primary_target: "apps/flock-desktop/src/components/NewWorkspaceDialog.tsx"
related_targets: ["apps/flock-desktop/src/styles/newWorkspace.css","apps/flock-desktop/src/lib/workspacePresets.ts","apps/flock-desktop/src/App.tsx"]
---

# New workspace launcher

Mode: Operate. Scope: the existing desktop New Workspace dialog and its launch path.

Developers choose a project folder and an exact lineup of agents, inspect the working-directory consequences, then launch. The user's pinned reference is `.flock/images/img-2.png`: preset cards, a compact provider grid, visible session counts, explicit isolation choices and a numbered launch preview. Inherit flock's existing theme, typography, provider marks and security behavior.

Keep the primary order: folder → presets → agent → count → isolation → editable sessions → optional customization → secure mode → launch. The bulk provider selector replaces the whole lineup; each numbered session can change independently. Changing the count keeps existing seats. Presets persist only ordered agent kinds, never project paths, branch plans or permissions. Supported counts are 1–6, 8 and 12; use only existing providers. All selected providers participate in readiness checks.

Use the existing branch preferences. Non-Git folders share their directory; Git projects can share a checkout or create worktrees. Preserve branch/ref/setup controls in Customize and explain the resulting plan before launch. Preserve explicit host execution warnings and Docker readiness handling. Preset selection never launches; a separate anchored action does.

The modal is 760px wide before UI scaling. Its body scrolls independently of the header and footer; use an outer scrolling element around the disabled fieldset. Three-column grids reduce to two on narrow windows and one at the smallest width. Selection follows the active theme's action token. No new raster assets or global visual-system changes.

Verification: complete frontend test suite, full App mixed-launch regression, production build, browser preset save/reload/launch checks and desktop/narrow/light/larger-text captures. Native Rust paths are unchanged. No unresolved product decisions.
