//! Telling "flock is still getting this pane ready" apart from "the agent is
//! drawing in it", on the backend.
//!
//! This used to live only in the webview (`src/lib/agentBoot.ts`), fed from a
//! terminal's output subscription. That tied the boot card to a mounted
//! terminal: a pane in a workspace you were not looking at still had to stream
//! every byte into the webview just so its card could lift. v2 mounts terminals
//! only for the panes on screen, so the decision moves here, next to the
//! output loop that sees every byte anyway, and reaches the UI as one
//! `agent://started` event per pane.
//!
//! The launch line writes [`flock_pty::AGENT_START_MARKER`] on the tty in the
//! instant before the agent runs. The marker only *arms* the scanner: an agent
//! then spends up to a second probing the terminal before its first frame, and
//! lifting the card on the marker would trade the boot noise for a blank
//! screen. The agent's first real paint is the signal.

/// Entering the alternate screen: how a full-screen TUI announces it is taking
/// the terminal over. Claude Code and opencode both do this first.
const ALT_SCREEN: &[u8] = b"\x1b[?1049h";

/// Printable bytes in a row that mean the agent is writing something a person
/// can read, rather than negotiating capabilities with the terminal.
const PAINT_RUN: usize = 8;

/// How long to wait for a paint that never comes before showing the terminal
/// anyway, counted from the marker. Enforced by the caller on its own clock:
/// the case it covers is the one where no further bytes arrive at all.
pub const PAINT_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// What one `feed` saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootSignal {
    None,
    /// The marker: flock is done, the agent is launched, the grace clock starts.
    Armed,
    /// The agent is drawing.
    Start,
}

/// Watches one pane's byte stream and reports the moment the agent's own output
/// starts. Stateful because PTY output arrives in arbitrary chunks and the
/// marker can straddle two of them.
#[derive(Debug, Default)]
pub struct BootScanner {
    tail: Vec<u8>,
    armed: bool,
    done: bool,
}

impl BootScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the start has already been reported.
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// Whether the marker has been seen (and the start not yet reported).
    #[cfg(test)]
    pub fn is_armed(&self) -> bool {
        self.armed && !self.done
    }

    /// Mark the pane started without a paint: the grace ran out, or the process
    /// died first. Returns true the first time only.
    pub fn force_start(&mut self) -> bool {
        if self.done {
            return false;
        }
        self.done = true;
        self.tail.clear();
        true
    }

    /// Reports the marker and, later, the agent's first painting — each once.
    pub fn feed(&mut self, chunk: &[u8]) -> BootSignal {
        if self.done {
            return BootSignal::None;
        }
        let marker = flock_pty::AGENT_START_MARKER.as_bytes();
        let mut armed_now = false;
        let rest: Vec<u8>;
        let rest_slice: &[u8] = if !self.armed {
            let hay: Vec<u8> = if self.tail.is_empty() {
                chunk.to_vec()
            } else {
                let mut h = std::mem::take(&mut self.tail);
                h.extend_from_slice(chunk);
                h
            };
            match find(&hay, marker) {
                None => {
                    let keep = marker.len().saturating_sub(1);
                    let from = hay.len().saturating_sub(keep);
                    self.tail = hay[from..].to_vec();
                    return BootSignal::None;
                }
                Some(at) => {
                    self.armed = true;
                    armed_now = true;
                    self.tail.clear();
                    // Whatever followed the marker in this same chunk is the agent's.
                    rest = hay[at + marker.len()..].to_vec();
                    &rest
                }
            }
        } else {
            chunk
        };
        if !rest_slice.is_empty()
            && (find(rest_slice, ALT_SCREEN).is_some()
                || has_erase_display(rest_slice)
                || has_printable_run(rest_slice, PAINT_RUN))
        {
            self.done = true;
            return BootSignal::Start;
        }
        if armed_now {
            BootSignal::Armed
        } else {
            BootSignal::None
        }
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Whether `buf` contains an erase-in-display (`CSI [params] J`): a terminal
/// saying "this screen is mine now". Not erase-in-line (`CSI K`), which is
/// what a shell redrawing its prompt emits.
fn has_erase_display(buf: &[u8]) -> bool {
    let mut i = 0;
    while i + 2 < buf.len() {
        if buf[i] == 0x1b && buf[i + 1] == b'[' {
            let mut j = i + 2;
            while j < buf.len() && (0x20..=0x3f).contains(&buf[j]) {
                j += 1;
            }
            if j < buf.len() && buf[j] == b'J' {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Whether `buf` holds `n` printable bytes in a row. Anything from 0x80 up
/// counts: an agent's first frame is mostly box-drawing characters.
fn has_printable_run(buf: &[u8], n: usize) -> bool {
    let mut run = 0;
    for &b in buf {
        if (b >= 0x20 && b != 0x7f) || b >= 0x80 {
            run += 1;
            if run >= n {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = flock_pty::AGENT_START_MARKER;
    const ALT: &str = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h";
    const PROBES: [&str; 5] = [
        "\x1b7\x1b[r\x1b8\x1b[?25h",
        "\x1b[?25l\x1b[?2004h",
        "\x1b[?1004h\x1b[?2031h",
        "\x1b]11;?\x07\x1b[c",
        "\x1b[>0q\x1b[c",
    ];

    /// 1-based index of the chunk that revealed the pane, or 0 if none did.
    fn reveals_on(chunks: &[&str]) -> usize {
        let mut s = BootScanner::new();
        let mut at = 0;
        for (i, c) in chunks.iter().enumerate() {
            if s.feed(c.as_bytes()) == BootSignal::Start && at == 0 {
                at = i + 1;
            }
        }
        at
    }

    #[test]
    fn waits_for_the_agent_not_the_marker() {
        assert_eq!(reveals_on(&["shell prompt", MARKER]), 0);
        assert_eq!(reveals_on(&["shell prompt", MARKER, ALT]), 3);
    }

    #[test]
    fn sits_through_capability_probes() {
        let mut chunks = vec![MARKER];
        chunks.extend(PROBES);
        chunks.push(ALT);
        assert_eq!(reveals_on(&chunks), PROBES.len() + 2);
    }

    #[test]
    fn lifts_on_printed_output_for_an_inline_agent() {
        assert_eq!(
            reveals_on(&[MARKER, "\x1b[?2004h\x1b[>4;0m\x1b[>7u", "\x1b[?2026h  ▌ Codex  v0.5"]),
            3
        );
    }

    #[test]
    fn lifts_on_the_same_chunk_as_the_marker() {
        let both = format!("{MARKER}{ALT}");
        assert_eq!(reveals_on(&[both.as_str()]), 1);
    }

    #[test]
    fn finds_a_marker_split_across_chunks() {
        let half = MARKER.len() / 2;
        assert_eq!(reveals_on(&["· flock: npm ci\r\n", &MARKER[..half], &MARKER[half..], ALT]), 4);
    }

    #[test]
    fn finds_a_marker_split_one_byte_at_a_time() {
        let mut chunks: Vec<String> = MARKER.chars().map(|c| c.to_string()).collect();
        chunks.push(ALT.to_string());
        let refs: Vec<&str> = chunks.iter().map(String::as_str).collect();
        assert_eq!(reveals_on(&refs), MARKER.len() + 1);
    }

    #[test]
    fn ignores_everything_before_the_marker() {
        let noise = "added 402 packages\n".repeat(500);
        assert_eq!(reveals_on(&[noise.as_str()]), 0);
    }

    #[test]
    fn reports_the_marker_for_the_grace_clock() {
        let mut s = BootScanner::new();
        assert_eq!(s.feed(b"shell prompt"), BootSignal::None);
        assert_eq!(s.feed(MARKER.as_bytes()), BootSignal::Armed);
        assert!(s.is_armed());
        assert_eq!(s.feed(b"\x1b[?25l"), BootSignal::None);
    }

    #[test]
    fn fires_once_and_only_once() {
        let mut s = BootScanner::new();
        s.feed(MARKER.as_bytes());
        assert_eq!(s.feed(b"the first frame"), BootSignal::Start);
        assert_eq!(s.feed(b"the second frame"), BootSignal::None);
        let again = format!("{MARKER}again, from the ring");
        assert_eq!(s.feed(again.as_bytes()), BootSignal::None);
        assert!(!s.force_start(), "already started");
    }

    #[test]
    fn force_start_covers_a_silent_agent() {
        let mut s = BootScanner::new();
        s.feed(MARKER.as_bytes());
        assert!(s.force_start());
        assert!(s.is_done());
        assert_eq!(s.feed(b"late output"), BootSignal::None);
    }
}
