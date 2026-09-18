# Voice input in flock

flock is a macOS desktop app for working with coding agents in terminal panes.
Voice dictation turns captured speech into editable input for an agent. The user
may dictate personally or capture another person's speech during a Teams or
similar call.

This feature extends the existing Voice settings and recording bar. The two
sources are Microphone (the default) and Desktop audio (macOS 13+). Desktop audio
captures other applications, including notifications, and excludes flock's own
audio. It does not mix in the microphone and does not offer per-app filtering.

Capture starts only with the user's existing voice hotkey while flock is
focused. Hold to capture, or tap for hands-free capture and tap again to finish.
Switching apps stops capture; a four-minute timer bounds unattended dictation.
macOS permission is requested on first capture. No screen output is registered.
Transcription runs locally with the selected Whisper model, using in-memory
audio. No audio file is saved or uploaded by this feature.

The destination is pinned when recording starts. Text is inserted for review;
the user presses Enter to submit it. Automatic prompt submission and continuous
meeting transcription are outside this feature.

The Operate-mode UI inherits existing settings controls and theme tokens. The
source is visible in the recording bar. Permission and capture errors explain
how to recover and remain visible until dismissed or retried. Microphone device
selection is preserved when switching sources.

Scope and direction:
[Voice surface brief](../../../.impeccable/surfaces/ps-flock-desktop-src-components-settingsdialog-tsx.md).
Usage and verification: [Desktop audio dictation](../../desktop-audio.md).
