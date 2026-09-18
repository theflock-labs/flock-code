# Desktop audio dictation

On macOS 13 or later, open **Settings → Voice**, enable dictation, download a
speech model if needed, and choose **Audio source → Desktop audio**.

Keep your Teams call running and focus the agent pane in flock. Hold the voice
hotkey while the other person speaks, then release it. Or tap once to listen
hands-free and tap again to finish. Review the inserted text and press Enter to
submit it. The destination is the pane selected when recording starts.

Desktop audio includes other applications, including notification sounds. It
does not include your microphone or flock's own audio. Select **Microphone** to
return to normal dictation; your selected microphone is preserved. There is no
per-app filter or mixed microphone/desktop mode in this version.

macOS requests Screen & System Audio Recording permission on the first capture.
If denied, allow flock under **System Settings → Privacy & Security → Screen &
System Audio Recording**, then restart flock if macOS requests it and try again.
Older macOS versions keep microphone dictation but cannot select Desktop audio.

The recording bar shows the active source. Switching away from flock stops
recording, including hands-free capture. Recordings automatically stop after
four minutes. This is deliberate dictation, not continuous meeting transcription
or automatic prompt submission.

## Implementation

`src-tauri/native/desktop_audio.m` uses Apple's ScreenCaptureKit audio output,
configured as 48 kHz mono Float32. No screen output handler is registered; screen
images and audio files are not recorded. Audio samples feed the existing bounded,
local Whisper pipeline. The app captures and transcribes in memory.

The Objective-C bridge is compiled with the already-resolved `cc` build tool.
ScreenCaptureKit is weak-linked and calls are guarded with macOS availability
checks, preserving the app's macOS 12.0 minimum for microphone use. Capture runs
on a dedicated thread. Native stop drains callbacks and clears the borrowed Rust
context before freeing it; a timed-out start also stops a late-starting stream.
Desktop capture errors never fall back to the microphone.

The frontend pins the destination at start, waits for pending startup before
stopping, blocks overlapping dictations in a window, and strips terminal control
characters before inserting text without Return. Errors are visible in both main
and popped-out windows.

## Verification

Frontend coverage includes source selection/save failures, settings search,
permission failures, pending-start blur/unmount, hands-free auto-stop,
transcription overlap, destination changes, insertion failures, and control
character removal. Rust tests cover bounded sample buffering and existing
transcription buffer handling.

A manual native probe is available at
`apps/flock-desktop/src-tauri/native/desktop_audio_probe.m`. It captures a known
997 Hz tone played by another process and checks the received frequency component.
It does not save captured audio. It exits 77 if capture permission was not already
granted, so running it never requests permission or changes privacy settings.

From the repository root:

```sh
xcrun clang -fobjc-arc -fblocks -mmacosx-version-min=12.0 \
  apps/flock-desktop/src-tauri/native/desktop_audio.m \
  apps/flock-desktop/src-tauri/native/desktop_audio_probe.m \
  -framework Foundation -framework CoreGraphics -framework CoreMedia \
  -Wl,-weak_framework,ScreenCaptureKit -o /tmp/flock-desktop-audio-probe
python3 - <<'PY'
import math, struct, wave
with wave.open('/tmp/flock-desktop-audio-tone.wav', 'w') as audio:
    audio.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
    audio.writeframes(b''.join(struct.pack('<h', int(5000 * math.sin(2 * math.pi * 997 * i / 48000)))
                              for i in range(48000 * 3)))
PY
/tmp/flock-desktop-audio-probe /tmp/flock-desktop-audio-tone.wav
```

The native probe verifies the new system-audio transport. It does not certify a
real Teams call or complete signed-app permission onboarding; exercise those on
the packaged app before release.
