---
version: 1
slug: "ps-flock-desktop-src-components-settingsdialog-tsx"
primary_target: "apps/flock-desktop/src/components/SettingsDialog.tsx"
related_targets: ["apps/flock-desktop/src/components/VoiceOverlay.tsx"]
---

# Voice audio source

Operate mode. Extend the existing Voice tab and in-window recording bar, preserving the current settings rows, controls, type, spacing and themes.

Job: while on a call, select Desktop audio and use the existing hold/tap dictation key to insert the other person's speech into the agent selected at capture start. Microphone remains the default. Transcription stays local; text is reviewed before Enter submits it.

The source picker names Microphone/Desktop audio; microphone selection remains available when relevant. Explain all-app audio scope, first-use macOS Screen & System Audio Recording access and no screen-image recording. Disable unsupported desktop capture on macOS before13. Show the source in the voice bar and visible recoverable errors in main/popout windows.

Constraints: no new visual identity, app-wide redesign, per-app capture, automatic sending or background listening. Keep hands-free and blur/timeout stop behavior. Verify regular/scaled settings, light/dark, and narrow popout errors.
