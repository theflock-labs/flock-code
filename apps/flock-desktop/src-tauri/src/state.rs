use crate::voice::VoiceState;
use flock_core::{AgentStatus, WorkspaceManager};
use flock_pty::PtyHandle;
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::RwLock;

/// Live application state shared with all Tauri commands via `tauri::State`.
pub struct AppState {
    /// SQLite-backed workspace persistence (workspaces table, agents table).
    pub wm: Arc<WorkspaceManager>,

    /// All live panes keyed by their UUID. Each pane owns its PTY handle.
    pub panes: Arc<RwLock<HashMap<String, PaneEntry>>>,

    /// Push-to-talk recording session + loaded Whisper model, if any.
    pub voice: Arc<VoiceState>,

    /// Where captured prompt-queue screenshots are staged, keyed by item id
    /// (`queue_images_dir/{id}/img-N.ext`). Instance-scoped alongside the DB
    /// (respects FLOCK_DATA_DIR / dev-release isolation), unlike the shared
    /// ~/.flock dir voice/github/graph use.
    pub queue_images_dir: PathBuf,
}

/// One PTY-backed pane (a live process the user is steering).
pub struct PaneEntry {
    pub workspace_id: String,
    pub kind: String,
    /// Canonical working directory the pane was spawned in (workspace repo, or
    /// a per-agent worktree). `None` when spawned without an explicit cwd.
    /// Authoritative source for staging pasted/dropped images into the right
    /// place — the frontend needn't (and shouldn't) track it.
    pub cwd: Option<String>,
    pub pty: PtyHandle,
    pub status: Arc<RwLock<AgentStatus>>,
    pub rows: u16,
    pub cols: u16,
    /// This pane's output fan-out: the replay ring plus the live subscriber
    /// channels the emit loop broadcasts each batch to. See PaneOutput.
    pub output: Arc<std::sync::Mutex<PaneOutput>>,
    /// Handle on this pane's durable activity record (crate `provenance`).
    ///
    /// Living here is the whole attribution story: this map holds only panes
    /// *this* process spawned, so a hook line from another flock on the same
    /// machine — they all tail one shared `~/.flock/hooks.jsonl` — finds no
    /// entry, therefore no recorder, therefore touches nothing. `None` when the
    /// row could not be opened; a pane must still run when its audit trail
    /// cannot be written.
    pub provenance: Option<crate::provenance::Recorder>,
}

/// A pane's output fan-out. Holds the replay ring (recent bytes, so a freshly
/// mounted terminal can paint the current screen immediately instead of
/// staying blank until the agent redraws) and the set of live subscribers —
/// one binary IPC channel per mounted terminal watching this pane.
///
/// Both live under one mutex so that *subscribing* (snapshot the ring, then
/// join the live set) is atomic against the emit loop's *push-then-broadcast*:
/// any output batch is either included in the snapshot a new subscriber
/// receives or delivered to it live — never both, and never neither.
pub struct PaneOutput {
    pub ring: OutputRing,
    pub subscribers: Vec<Channel<InvokeResponseBody>>,
    /// Value of `ring.total_pushed` at the last successful persist snapshot.
    /// The periodic persist skips a pane whose ring hasn't advanced since, so
    /// idle panes aren't re-serialized and re-written to SQLite every 15s.
    pub persisted_pushed: u64,
}

impl PaneOutput {
    pub fn new() -> Self {
        Self { ring: OutputRing::new(), subscribers: Vec::new(), persisted_pushed: 0 }
    }
}

/// Bounded tail of PTY output. Replayed into a freshly mounted terminal so the
/// current screen appears immediately; also snapshotted to SQLite so pane
/// content survives an app restart.
pub struct OutputRing {
    pub data: std::collections::VecDeque<u8>,
    /// Monotonic count of bytes ever pushed. A cheap dirty signal: if this is
    /// unchanged since the last persist, the pane produced no new output and
    /// its snapshot can be skipped.
    pub total_pushed: u64,
}

/// ~2 full-screen TUI repaints of a large terminal with colors. Enough for
/// a mounting terminal to reconstruct the visible screen; deliberately not
/// full scrollback (xterm caps its own scrollback anyway).
pub const OUTPUT_RING_CAP: usize = 128 * 1024;

impl OutputRing {
    pub fn new() -> Self {
        // Allocate the cap up front rather than growing into it. A VecDeque
        // grown by doubling lands on the first power of two past the cap and
        // keeps it forever (drain never shrinks capacity), so every busy pane
        // permanently held ~2× what it can actually use, in exactly the
        // large-allocation size class that showed up as fragmentation in
        // `vmmap`. One allocation of a known size, reused for the pane's life.
        Self {
            data: std::collections::VecDeque::with_capacity(OUTPUT_RING_CAP),
            total_pushed: 0,
        }
    }

    /// Append a chunk, trimming the front to stay under OUTPUT_RING_CAP.
    ///
    /// Trims BEFORE appending, so the deque never exceeds the capacity
    /// reserved in `new()` and therefore never reallocates for the pane's
    /// whole life. Appending first (as this used to) meant every push past the
    /// cap grew the allocation and then immediately drained back down — churn
    /// in the large-allocation size class, and for a chunk bigger than the ring
    /// itself, a transient allocation the size of that chunk.
    pub fn push(&mut self, chunk: &[u8]) {
        self.total_pushed = self.total_pushed.wrapping_add(chunk.len() as u64);
        // A chunk larger than the whole ring: only its tail can survive.
        let keep = chunk.len().min(OUTPUT_RING_CAP);
        let overflow = (self.data.len() + keep).saturating_sub(OUTPUT_RING_CAP);
        if overflow > 0 {
            self.data.drain(..overflow);
        }
        self.data.extend(&chunk[chunk.len() - keep..]);
    }

    /// Contiguous copy of the current ring contents, avoiding the per-byte
    /// `iter().copied().collect()` the persist path used to do.
    pub fn snapshot_bytes(&self) -> Vec<u8> {
        let (a, b) = self.data.as_slices();
        let mut out = Vec::with_capacity(a.len() + b.len());
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_stays_within_cap_and_never_reallocates() {
        let mut ring = OutputRing::new();
        let reserved = ring.data.capacity();
        assert!(reserved >= OUTPUT_RING_CAP);

        // Push several times the cap in realistic-sized chunks.
        let chunk = vec![b'x'; 8 * 1024];
        for _ in 0..64 {
            ring.push(&chunk);
            assert!(ring.data.len() <= OUTPUT_RING_CAP);
        }
        // The whole point of reserving up front: no growth, ever.
        assert_eq!(ring.data.capacity(), reserved, "ring reallocated");
        assert_eq!(ring.data.len(), OUTPUT_RING_CAP);
        assert_eq!(ring.total_pushed, 64 * 8 * 1024);
    }

    #[test]
    fn ring_keeps_the_tail_not_the_head() {
        let mut ring = OutputRing::new();
        ring.push(b"oldest");
        let filler = vec![b'.'; OUTPUT_RING_CAP];
        ring.push(&filler);
        ring.push(b"NEWEST");

        let snap = ring.snapshot_bytes();
        assert_eq!(snap.len(), OUTPUT_RING_CAP);
        assert!(snap.ends_with(b"NEWEST"), "most recent output must survive");
        assert!(!snap.starts_with(b"oldest"), "stale head must be trimmed");
    }

    /// A single chunk bigger than the entire ring used to balloon the
    /// allocation before draining back down.
    #[test]
    fn ring_absorbs_a_chunk_larger_than_itself() {
        let mut ring = OutputRing::new();
        let reserved = ring.data.capacity();

        let mut huge = vec![b'a'; OUTPUT_RING_CAP * 3];
        huge.extend_from_slice(b"TAIL");
        ring.push(&huge);

        assert_eq!(ring.data.capacity(), reserved, "ring reallocated on a huge chunk");
        assert_eq!(ring.data.len(), OUTPUT_RING_CAP);
        assert!(ring.snapshot_bytes().ends_with(b"TAIL"));
        assert_eq!(ring.total_pushed, huge.len() as u64);
    }

    #[test]
    fn ring_snapshot_matches_contents_across_wraparound() {
        let mut ring = OutputRing::new();
        // Fill, then push more so the deque's head/tail wrap its buffer and
        // `as_slices` returns two segments.
        ring.push(&vec![b'A'; OUTPUT_RING_CAP]);
        ring.push(b"0123456789");
        let snap = ring.snapshot_bytes();
        assert_eq!(snap.len(), OUTPUT_RING_CAP);
        assert!(snap.ends_with(b"0123456789"));
        assert_eq!(snap.iter().filter(|b| **b == b'A').count(), OUTPUT_RING_CAP - 10);
    }
}
