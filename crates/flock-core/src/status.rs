use crate::types::AgentStatus;

// ─── What the two resting states mean ────────────────────────────────────────
//
// The distinction the whole cockpit hangs off, and the one every detector below
// has to respect:
//
//   Idle          the agent is sitting at its own prompt with nothing to do.
//                 Nobody is blocked. This is where an agent spends most of its
//                 life, and it must never raise the notification pill.
//   AwaitingInput the agent has stopped mid-task and cannot continue until the
//                 user answers something — a permission dialog, a question, a
//                 "press enter to continue". This is what "N agents need input"
//                 counts, so anything that reaches it must be a real block.
//
// A prompt on screen is Idle, not AwaitingInput: "there is a composer here" and
// "I am waiting on you" are different claims, and only the second one is worth
// interrupting someone for. Every idle-looking prompt below used to report
// AwaitingInput, which is why the pill counted resting agents as blocked ones.

pub trait StatusDetector: Send + Sync {
    fn detect_line(&self, line: &str) -> Option<AgentStatus>;

    /// Detect over a whole coalesced output batch (raw bytes decoded, ANSI still
    /// present). Default is a no-op. This exists for full-screen TUI agents like
    /// opencode: their frames carry *no* newlines — every row is placed with an
    /// absolute cursor-move escape — so the line-oriented `detect_line` (which
    /// splits on `\n` and caps each line) never sees the status footer at the
    /// bottom of the screen. Scanning the flat batch finds it. Returns the
    /// strongest signal present anywhere in the batch.
    fn detect_batch(&self, _batch: &str) -> Option<AgentStatus> {
        None
    }

    fn detect_exit(&self, code: i32) -> AgentStatus {
        if code == 0 { AgentStatus::Done } else { AgentStatus::Failed }
    }
}

// ─── Sentinel JSON layer (highest priority) ───────────────────────────────────

struct SentinelDetector {
    inner: Box<dyn StatusDetector>,
}

impl StatusDetector for SentinelDetector {
    fn detect_line(&self, line: &str) -> Option<AgentStatus> {
        let trimmed = line.trim();
        if trimmed.starts_with('{') {
            if let Some(status) = parse_sentinel(trimmed) {
                return Some(status);
            }
        }
        self.inner.detect_line(line)
    }

    fn detect_batch(&self, batch: &str) -> Option<AgentStatus> {
        self.inner.detect_batch(batch)
    }

    fn detect_exit(&self, code: i32) -> AgentStatus {
        self.inner.detect_exit(code)
    }
}

fn parse_sentinel(s: &str) -> Option<AgentStatus> {
    let s = s.trim_start_matches('{').trim_end_matches('}').trim();
    for part in s.split(',') {
        let mut kv = part.splitn(2, ':');
        let key = match kv.next() {
            Some(k) => k.trim().trim_matches('"'),
            None => continue,
        };
        let val = match kv.next() {
            Some(v) => v.trim().trim_matches('"'),
            None => continue,
        };
        if key == "status" {
            return match val {
                "idle" | "working" | "awaiting_input" | "blocked" | "done" | "failed" => {
                    Some(AgentStatus::from_str(val))
                }
                _ => None,
            };
        }
    }
    None
}

// ─── Claude Code heuristic detector ──────────────────────────────────────────
//
// Principle: prefer precision over recall. False positives (showing "working"
// when idle) are worse UX than false negatives (showing "idle" when briefly
// working). The spinner is the only reliable real-time Working signal;
// everything else is AwaitingInput or unknown.
//
// Claude Code v2 is a full-screen TUI that repaints *differentially*: a running
// turn emits a few bytes at a time — cursor-move, one spinner glyph, colour
// reset — and almost never a newline. So `detect_line` is blind here for the
// same reason it is blind to opencode's footer: with no `\n` the line buffer
// fills to its cap on the startup frame and never sees another thing. Every
// Claude pane therefore sat at Idle for its whole life, however hard it was
// working. `detect_batch` is what actually carries this agent.
//
// Two signals were rejected before settling on the spinner:
//   * "esc to interrupt" — the differential repaint rewrites only the cells
//     that changed, so the hint arrives down the wire as "es to interrup" or
//     "esc o interrupt" and a substring match misses it. It is also painted in
//     the *idle* footer when bypass-permissions mode is on.
//   * the OSC window title — its icon is `✳` when idle and a braille frame
//     while working, i.e. exactly backwards from the screen. It is stripped
//     out below rather than read.

struct ClaudeCodeDetector;

/// Braille spinner frames, which older Claude Code builds emitted on a line of
/// their own. Kept for those, and because the v2 window title animates through
/// them (that title is stripped before matching — see `spinner_on_screen`).
const SPINNERS: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// Claude Code v2's spinner: a five-pointed star cycle, one glyph repainted in
/// place several times a second for as long as a turn is running — including
/// every second it spends waiting on a tool or on a subagent, which is the only
/// reason flock can tell "thinking for two minutes" from "idle". The sixth
/// frame of the cycle is a bare `·`, deliberately not listed: it is the most
/// common separator in terminal output and would report half the world as busy.
const STAR_SPINNERS: &[char] = &['✢', '✳', '✶', '✻', '✽', '∗'];

/// The hint Claude Code shows next to an empty composer, and only there.
const SHORTCUT_HINT: &str = "for shortcuts";

/// The deny option of Claude Code's permission dialog ("No, and tell Claude
/// what to do differently"). It is the one string that appears when — and only
/// when — a decision box is on screen holding the turn: the question line
/// itself varies per tool ("Do you want to make this edit to…", "Do you want to
/// allow this connection?"), and every one of those phrasings also shows up in
/// ordinary assistant prose, where it means nothing. This does not.
const PERMISSION_DIALOG: &str = "tell Claude what to do differently";

/// Whether a spinner frame is painted on the *screen* somewhere in this batch.
/// OSC sequences (`ESC ] … BEL`/`ST`) are skipped because the window title
/// carries `✳` while the session is idle. No allocation: this runs on every
/// batch of every Claude pane.
fn spinner_on_screen(batch: &str) -> bool {
    let mut chars = batch.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&']') {
                chars.next();
                // Runs to BEL or to ST (ESC \).
                while let Some(c2) = chars.next() {
                    if c2 == '\x07' {
                        break;
                    }
                    if c2 == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            continue;
        }
        if STAR_SPINNERS.contains(&c) || SPINNERS.contains(&c) {
            return true;
        }
    }
    false
}

impl StatusDetector for ClaudeCodeDetector {
    fn detect_line(&self, line: &str) -> Option<AgentStatus> {
        let trimmed = line.trim();

        // ── Working: spinner at start of line ─────────────────────────────
        // Only reachable on newline-delimited output (older builds, or the
        // `--print` transcript). v2's in-place spinner is caught by
        // detect_batch below.
        if trimmed.starts_with(|c| SPINNERS.contains(&c) || STAR_SPINNERS.contains(&c)) {
            return Some(AgentStatus::Working);
        }

        // ── Idle: the agent is back at its own prompt ────────────────────
        // An empty composer, the `?` shortcut hint, a fresh human turn: the
        // agent has nothing left to do and nothing to ask. Resting, not
        // blocked — see the note at the top of this file.
        if trimmed == ">" || trimmed == "> " {
            return Some(AgentStatus::Idle);
        }
        if trimmed.starts_with("? ") && trimmed.contains('·') {
            return Some(AgentStatus::Idle);
        }
        if trimmed == "Human:" || trimmed.starts_with("Human: ") {
            return Some(AgentStatus::Idle);
        }

        // ── AwaitingInput: the turn is held open on the user ─────────────
        if trimmed.contains("Press Enter") || trimmed.contains("press enter") {
            return Some(AgentStatus::AwaitingInput);
        }
        if normalize_for_match(trimmed).contains(PERMISSION_DIALOG) {
            return Some(AgentStatus::AwaitingInput);
        }

        // ── Done: explicit completion markers ─────────────────────────────
        if trimmed.starts_with('✓') || trimmed == "Done" || trimmed.starts_with("Done ") {
            return Some(AgentStatus::Done);
        }

        None
    }

    fn detect_batch(&self, batch: &str) -> Option<AgentStatus> {
        // A decision box outranks everything else on the screen: the composer
        // hint is painted underneath it and the spinner can still be turning
        // in the same frame, but the turn is stopped until the user answers.
        // Normalized because the box draws its options across padded cells.
        if normalize_for_match(batch).contains(PERMISSION_DIALOG) {
            return Some(AgentStatus::AwaitingInput);
        }
        // Idle next: the batch that ends a turn carries both the composer's
        // shortcut hint *and* the grey summary line ("✻ Worked for 44s"),
        // whose bullet is a spinner glyph. Checking the hint before the
        // spinner hands the pane straight back to Idle instead of leaving it
        // Working until the 3s spinner timeout in pty_bridge notices silence.
        if batch.contains(SHORTCUT_HINT) {
            return Some(AgentStatus::Idle);
        }
        if spinner_on_screen(batch) {
            return Some(AgentStatus::Working);
        }
        None
    }
}

// ─── opencode heuristic detector ─────────────────────────────────────────────
//
// opencode renders a full-screen TUI. Its footer shows a key-hint bar whose
// contents change with state; the tell is the interrupt hint:
//   Working → footer contains "esc interrupt" (only shown while a task runs)
//
// Crucially, opencode paints the screen with *absolute cursor-move escapes and
// no newlines* — a whole frame is one continuous byte stream. So the footer
// (bottom of the screen) is unreachable from `detect_line`, which splits on
// `\n` and caps line length: the footer falls past the cap and is dropped.
// `detect_batch` scans the flat frame instead, where the hint survives. The
// line-level checks below are kept as a cheap belt-and-braces for any
// newline-delimited output but are not what carries opencode.

struct OpencodeDetector;

/// Whether an ANSI-stripped, whitespace-collapsed haystack shows opencode's
/// running-task interrupt hint. Accepts the "esc to interrupt" phrasing too, in
/// case the label wording shifts across versions.
fn has_interrupt_hint(plain: &str) -> bool {
    let norm = normalize_for_match(plain);
    norm.contains("esc interrupt") || norm.contains("esc to interrupt")
}

impl StatusDetector for OpencodeDetector {
    fn detect_line(&self, line: &str) -> Option<AgentStatus> {
        let trimmed = line.trim();

        if has_interrupt_hint(trimmed) {
            return Some(AgentStatus::Working);
        }

        // opencode's input prompt — resting at the composer, not blocked.
        if trimmed == "›" || trimmed.starts_with("› ") {
            return Some(AgentStatus::Idle);
        }

        None
    }

    fn detect_batch(&self, batch: &str) -> Option<AgentStatus> {
        // The footer is drawn far down the frame, so scan the whole batch. The
        // hint re-appears on every repaint of the footer (the elapsed-time
        // counter ticks), which keeps refreshing the Working state and its
        // spinner timeout for as long as the task runs.
        if has_interrupt_hint(batch) {
            return Some(AgentStatus::Working);
        }
        None
    }
}

// ─── grok (Grok Build) heuristic detector ────────────────────────────────────
//
// grok is a full-screen TUI like the two above, so everything here runs on
// `detect_batch`. What it is *not* is a spinner agent: grok repaints
// differentially and only redraws the digits of its elapsed counter, so the
// working footer's text arrives once, at the start of a turn, and is never
// repainted for the rest of it. Measured on a real 40×120 pty recording: over
// ten 8 KiB batches of a single turn, the footer hint appeared in exactly one.
//
// That is why this detector is deliberately thin and why grok's status is
// carried by its hooks (desktop `hooks.rs`, which grok speaks natively —
// same event names, same JSON). What is here is the edge: the frame that
// opens a turn and the frame that closes one. `pty_bridge`'s spinner timeout
// then does the rest, and a hook correction always outranks a guess.
//
// Two things were rejected before settling on the footer:
//   * the braille spinner — grok's startup splash is braille block-art
//     (⣿⣶⡿…), so any pane would read as working for the length of its boot,
//     and the OSC window title animates braille too. Same trap as Claude
//     Code's `✳` title, which is stripped rather than read.
//   * "Waiting for response…" — it is the label of one phase of a turn, and
//     a turn spends most of its life in others ("Retrying", tool calls).

struct GrokDetector;

/// grok's footer while a turn is running: `[stop] Esc:cancel`. It is painted
/// only while there is something to cancel, and (unlike the elapsed counter
/// beside it) it is written in one run, so it survives the batch intact.
const GROK_CANCEL_HINT: &str = "Esc:cancel";

/// grok's footer at the composer: `Shift+Tab:mode │ Ctrl+x:shortcuts`. Matched
/// on the truncated stem because the label is elided to `Shift+Tab:mod` when
/// the pane is narrow.
const GROK_IDLE_HINT: &str = "Shift+Tab:mod";

impl StatusDetector for GrokDetector {
    fn detect_line(&self, _line: &str) -> Option<AgentStatus> {
        // Nothing: grok places every row with a cursor move and emits no
        // newlines, so the line path only ever sees the top of one frame.
        None
    }

    fn detect_batch(&self, batch: &str) -> Option<AgentStatus> {
        let norm = normalize_for_match(batch);
        // Idle first, for the reason Claude Code checks its composer hint
        // first: the batch that ends a turn carries the working footer being
        // erased *and* the composer being drawn, and the composer is the one
        // that describes where the pane ends up.
        if norm.contains(GROK_IDLE_HINT) {
            return Some(AgentStatus::Idle);
        }
        if norm.contains(GROK_CANCEL_HINT) {
            return Some(AgentStatus::Working);
        }
        None
    }
}

// ─── Shell / generic heuristic detector ──────────────────────────────────────

struct ShellDetector;

impl StatusDetector for ShellDetector {
    fn detect_line(&self, line: &str) -> Option<AgentStatus> {
        let trimmed = line.trim();
        // Shell prompts end with $ % or # (possibly after path). A shell
        // sitting at its prompt is idle — nothing is waiting on the user, and
        // this fallback covers every agent without bespoke heuristics, so
        // reporting it as a block lit the pill for whole panes of nothing.
        if trimmed.ends_with('$') || trimmed.ends_with('%') || trimmed.ends_with('#') {
            return Some(AgentStatus::Idle);
        }
        None
    }
}

// ─── ANSI strip + whitespace collapse (single pass) ──────────────────────────

/// Strip ANSI escape sequences AND collapse whitespace in one pass into one
/// buffer — every run of whitespace becomes a single space and the ends are
/// trimmed, so a hint whose key and label are separated by cursor-positioning
/// padding still matches a plain "esc interrupt" needle. This is the hot
/// opencode path: a full-screen frame repaints continuously, so the old
/// strip_ansi()+collapse_ws() pair (two Strings plus a Vec<&str> per call, over
/// batches up to 64 KB) was pure allocator churn. Same output, one allocation.
fn normalize_for_match(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    // Owe a space before the next real char (collapses runs; never leads/trails
    // because it's only flushed immediately before pushing a non-space char).
    let mut pending_space = false;
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // consume ESC [ ... final-byte (0x40–0x7e)
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c2) { break; }
                }
            }
            continue;
        }
        if c.is_whitespace() {
            if !out.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    out
}

// ─── Factory ─────────────────────────────────────────────────────────────────

pub fn detector_for(kind: &str) -> Box<dyn StatusDetector> {
    let inner: Box<dyn StatusDetector> = match kind {
        "claude" | "claude-code" => Box::new(ClaudeCodeDetector),
        "opencode" => Box::new(OpencodeDetector),
        "grok" | "grok-build" => Box::new(GrokDetector),
        // codex and pi have no bespoke heuristics yet: the shell fallback plus
        // the sentinel wrapper (a {"status":…} line always wins) covers them.
        _ => Box::new(ShellDetector),
    };
    Box::new(SentinelDetector { inner })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spinner_is_the_only_working_signal() {
        let d = detector_for("claude");
        // Spinner chars → Working
        for ch in SPINNERS {
            let line = format!("{} Working...", ch);
            assert_eq!(d.detect_line(&line), Some(AgentStatus::Working), "spinner char {ch} should be Working");
        }
        // "Working" text alone is NOT a Working signal (too many false positives)
        assert_eq!(d.detect_line("Working on it"), None);
        assert_eq!(d.detect_line("I was working earlier"), None);
    }

    #[test]
    fn a_prompt_on_screen_is_idle_not_a_block() {
        // The pill counts AwaitingInput panes as "agents need input". An agent
        // resting at its composer is not one of them.
        let d = detector_for("claude");
        assert_eq!(d.detect_line(">"), Some(AgentStatus::Idle));
        assert_eq!(d.detect_line("> "), Some(AgentStatus::Idle));
        assert_eq!(d.detect_line("? for shortcuts · ← for agents"), Some(AgentStatus::Idle));
        assert_eq!(d.detect_line("Human:"), Some(AgentStatus::Idle));
    }

    #[test]
    fn awaiting_input_is_reserved_for_real_blocks() {
        let d = detector_for("claude");
        assert_eq!(d.detect_line("Press Enter to continue"), Some(AgentStatus::AwaitingInput));
        // The permission dialog, on the line path and on the batch path.
        let deny = "  3. No, and tell Claude what to do differently (esc)";
        assert_eq!(d.detect_line(deny), Some(AgentStatus::AwaitingInput));
        // A box opening: each row placed with a cursor move, its text written
        // in one run. That is all the marker needs — the frame that first
        // paints the dialog carries the whole option line.
        let dialog = "\u{1b}[H\r╭─────╮\u{1b}[3;3HDo you want to make this edit to status.rs?\u{1b}[5;5H❯ 1. Yes\u{1b}[6;5H  2. No, and tell Claude what to do differently (esc)\u{1b}[39m";
        assert_eq!(d.detect_batch(dialog), Some(AgentStatus::AwaitingInput));
    }

    #[test]
    fn a_question_in_prose_is_not_a_block() {
        // The dialog's own question line ("Do you want to …") is also something
        // an agent says mid-answer. Only the box's deny option counts.
        let d = detector_for("claude");
        assert_eq!(d.detect_batch("\u{1b}[H\rDo you want to see the diff first?"), None);
        assert_eq!(d.detect_line("Would you like to proceed with the rename?"), None);
    }

    #[test]
    fn done_patterns() {
        let d = detector_for("claude");
        assert_eq!(d.detect_line("✓ Task complete"), Some(AgentStatus::Done));
        assert_eq!(d.detect_line("Done"), Some(AgentStatus::Done));
        assert_eq!(d.detect_line("Done processing"), Some(AgentStatus::Done));
    }

    #[test]
    fn welcome_screen_text_is_not_working() {
        let d = detector_for("claude");
        // Claude Code's startup welcome text should NOT trigger Working
        assert_eq!(d.detect_line("Welcome back! Working in /users/remi"), None);
        assert_eq!(d.detect_line("Tips for getting started"), None);
        assert_eq!(d.detect_line("Claude Code v2.1.153"), None);
        assert_eq!(d.detect_line("What's new"), None);
    }

    // The four tests below are cut from a real recording of Claude Code
    // v2.1.220 driving a PTY (spawn → prompt → subagent → done), so they are
    // the wire format and not a guess at it.

    #[test]
    fn claude_v2_spinner_frame_is_working() {
        let d = detector_for("claude");
        // One repaint of the spinner cell: cursor home, down 38, colour, glyph.
        // No newline anywhere, which is why detect_line cannot see it.
        let frame = "\u{1b}[?25l\u{1b}[H\r\u{1b}[38B\u{1b}[38;5;174m✻\u{1b}[6G\u{1b}[38;5;216mr\u{1b}[9G\u{1b}[38;5;174mi\u{1b}[39m\u{1b}[45;1H\u{1b}[42;3H\u{1b}[?25h";
        assert_eq!(d.detect_batch(frame), Some(AgentStatus::Working));
        assert_eq!(d.detect_line(frame), None, "no newline: the line path is blind here");
    }

    #[test]
    fn claude_v2_keeps_working_while_a_subagent_runs() {
        let d = detector_for("claude");
        // Mid-flight through a Task tool call: the parent paints the subagent's
        // tool block and keeps its own spinner turning. This is the case that
        // used to read as idle for minutes at a time.
        let frame = "\u{1b}[H\r  ◯ general-purpose  Run sleep 25   \u{1b}[38;5;174m✽\u{1b}[39m Working… (42s · ↓ 1.8k tokens)";
        assert_eq!(d.detect_batch(frame), Some(AgentStatus::Working));
        // Every frame of the cycle counts except the bare `·`, which is too
        // common in ordinary output to trust.
        for ch in STAR_SPINNERS {
            let f = format!("\u{1b}[H\r\u{1b}[38B\u{1b}[38;5;174m{ch}\u{1b}[39m");
            assert_eq!(d.detect_batch(&f), Some(AgentStatus::Working), "frame {ch}");
        }
        assert_eq!(d.detect_batch("\u{1b}[H\r· 1 shell · ↓ to manage"), None);
    }

    #[test]
    fn claude_idle_window_title_is_not_working() {
        let d = detector_for("claude");
        // The OSC title's idle icon is `✳` — the same glyph the screen uses as
        // a spinner frame, with the opposite meaning. Reading it would pin
        // every resting pane to Working forever.
        assert_eq!(d.detect_batch("\u{1b}]0;✳ Claude Code\u{7}\u{1b}[?25l\u{1b}[H"), None);
        // …and the title's own spinner is braille, so it must not leak either.
        assert_eq!(d.detect_batch("\u{1b}]0;⠂ Claude Code\u{7}"), None);
        // ST-terminated form of the same sequence.
        assert_eq!(d.detect_batch("\u{1b}]0;✳ Claude Code\u{1b}\\"), None);
    }

    #[test]
    fn claude_shortcut_hint_ends_the_turn() {
        let d = detector_for("claude");
        // The batch that closes a turn carries the grey "✻ Worked for 1s"
        // summary and the composer hint together. The hint has to win, or the
        // pane sits at Working until the spinner timeout fires.
        let frame = "\u{1b}[H\r\u{1b}[10B\u{1b}[38;5;246m✻\u{1b}[3GWorked for 1s\r\u{1b}[3B❯\u{a0}\r\u{1b}[21C\u{1b}[3B\u{1b}[38;5;246m? for shortcuts\u{1b}[39m";
        assert_eq!(d.detect_batch(frame), Some(AgentStatus::Idle));
    }

    #[test]
    fn opencode_working() {
        let d = detector_for("opencode");
        // Status bar line while running
        assert_eq!(
            d.detect_line("· ▌████████  esc interrupt  11.5K (6%)  ctrl+p commands"),
            Some(AgentStatus::Working)
        );
        // With ANSI escape codes around it
        assert_eq!(
            d.detect_line("\x1b[1mesc interrupt\x1b[0m"),
            Some(AgentStatus::Working)
        );
    }

    #[test]
    fn opencode_working_batch_no_newlines() {
        let d = detector_for("opencode");
        // A realistic full-screen frame: absolute cursor moves, no newlines, the
        // footer (with the interrupt hint) far past a 4096-char line cap. This is
        // exactly what `detect_line` cannot catch and `detect_batch` must.
        let top = "\x1b[1m \x1b[0m".repeat(2000); // >4096 chars of top-of-screen
        let footer = "\x1b[39;3H\x1b[2m●\x1b[0m \x1b[1mesc\x1b[0m \x1b[2minterrupt\x1b[0m  12s";
        let frame = format!("\x1b[2J\x1b[H{top}{footer}");
        // detect_batch scans the whole frame and finds the footer.
        assert_eq!(d.detect_batch(&frame), Some(AgentStatus::Working));
        // pty_bridge caps a newline-less "line" at 4096 chars, so the line path
        // only ever sees the top of the screen — never the footer. Simulate that
        // truncation to show the bug this fixes.
        let capped: String = frame.chars().take(4096).collect();
        assert!(!capped.contains("interrupt"), "footer must fall past the cap");
        assert_eq!(d.detect_line(&capped), None);
    }

    #[test]
    fn opencode_idle_batch_is_not_working() {
        let d = detector_for("opencode");
        // Idle footer shows other hints but never the interrupt one.
        let frame = "\x1b[HAsk anything...\x1b[40;1Htab agents   ctrl+p commands";
        assert_eq!(d.detect_batch(frame), None);
    }

    #[test]
    fn opencode_prompt_is_idle() {
        let d = detector_for("opencode");
        assert_eq!(d.detect_line("›"), Some(AgentStatus::Idle));
        assert_eq!(d.detect_line("› "), Some(AgentStatus::Idle));
        // Regular output should not trigger
        assert_eq!(d.detect_line("Building project..."), None);
        assert_eq!(d.detect_line("Build · MiMo V2.5 Free"), None);
    }

    // The three below are cut from a real recording of grok 1.0.3 driving a
    // 40×120 pty (spawn → prompt → answer), so they are the wire format and
    // not a guess at it.

    #[test]
    fn grok_running_turn_is_working() {
        let d = detector_for("grok");
        // The footer of a turn in flight. Note `Esc` and `:cancel` arrive in
        // separate SGR runs and `Waiting`/`for response` are separated by a
        // cursor move — the needle only survives normalization.
        let frame = "2;20;20;20m⠴ Waiting\u{1b}[28;15Hfor response…\u{1b}[38;2;108;108;108;48;2;20;20;20m 0.0s\u{1b}[39;48;2;20;20;20m               \u{1b}[28;101H\u{1b}[38;2;108;108;108;48;2;20;20;20m0.0s ⇣4.54k [stop]\u{1b}[39;22H\u{1b}[1m\u{1b}[38;2;200;200;200;48;2;20;20;20mEsc\u{1b}[22m\u{1b}[38;2;108;108;108;48;2;20;20;20m:cancel\u{1b}[2m  ";
        assert_eq!(d.detect_batch(frame), Some(AgentStatus::Working));
        assert_eq!(d.detect_line(frame), None, "no newline: the line path is blind here");
    }

    #[test]
    fn grok_composer_footer_is_idle() {
        let d = detector_for("grok");
        let frame = "\u{1b}[39;3H\u{1b}[1m\u{1b}[38;2;200;200;200;48;2;20;20;20mShift+Tab\u{1b}[22m\u{1b}[38;2;108;108;108;48;2;20;20;20m:mode\u{1b}[2m  │  \u{1b}[22m\u{1b}[1mCtrl+x\u{1b}[22m:shortcuts";
        assert_eq!(d.detect_batch(frame), Some(AgentStatus::Idle));
        // A pane resting at its composer is not a pane asking for something —
        // the pill counts AwaitingInput, and grok's real asks arrive as a
        // Notification hook with a `permission_prompt` matcher instead.
        assert_ne!(d.detect_batch(frame), Some(AgentStatus::AwaitingInput));
    }

    #[test]
    fn groks_braille_splash_is_not_working() {
        let d = detector_for("grok");
        // grok's startup logo is braille block-art, and its window title
        // animates braille spinner frames. Reading either as a spinner would
        // pin every pane to Working for the length of its boot.
        let splash = "\u{1b}[48;2;20;20;20m  \u{1b}[38;2;108;108;108m⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀\u{1b}[39m   Grok 4.6 is here, try it out";
        assert_eq!(d.detect_batch(splash), None);
        assert_eq!(d.detect_batch("\u{1b}]0;⠧ - Waiting for response… - grok\u{7}"), None);
    }

    #[test]
    fn shell_detector() {
        let d = detector_for("bash");
        assert_eq!(d.detect_line("user@host:~$"), Some(AgentStatus::Idle));
        assert_eq!(d.detect_line("% "), Some(AgentStatus::Idle));
        assert_eq!(d.detect_line("random output"), None);
    }

    #[test]
    fn sentinel_overrides_heuristic() {
        let d = detector_for("claude");
        assert_eq!(d.detect_line(r#"{"status":"working"}"#), Some(AgentStatus::Working));
        assert_eq!(d.detect_line(r#"{"status":"blocked"}"#), Some(AgentStatus::Blocked));
    }
}
