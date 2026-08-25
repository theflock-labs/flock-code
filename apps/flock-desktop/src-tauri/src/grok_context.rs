//! How full a grok pane's context window is, read from that pane's own session
//! store.
//!
//! The sibling of `claude_context`, and deliberately only the parts that
//! differ: the poller, the memo, the rescan policy, the session-id guard and
//! the `ContextUsage` row are all that module's, because two meters that
//! disagree about *when* they refresh are two meters that disagree.
//!
//! What grok does differently, and why each difference is a simplification:
//!
//!   * **The store is a directory, not a file.** grok keys sessions by working
//!     directory — `~/.grok/sessions/<percent-encoded cwd>/<session id>/` —
//!     and writes several files into it. The one worth reading is
//!     `updates.jsonl`, an append-only feed of session updates; a
//!     `turn_completed` entry carries the turn's `usage`.
//!
//!   * **Subagents are a subdirectory, not a flag.** Claude Code writes
//!     subagent turns into the same transcript with `isSidechain: true`, and
//!     reading the literal last usage block there makes the meter collapse
//!     every time a Task tool runs. grok puts them under `subagents/<id>/`, so
//!     not recursing is the whole of the fix.
//!
//!   * **The cwd is in the path, so nothing has to be inferred from it.** The
//!     scan is one level deep over the sessions root; a session id is a UUID
//!     and cannot collide across directories, so a pane whose worktree moved
//!     still finds its own conversation.
//!
//! The window is the one thing that is *less* knowable than Claude Code's. The
//! store records `current_model_id` but no window size, and xAI's models do not
//! share one: grok-4.6 is 500k, the 4.20/4.3 family 1M, Grok Build 0.1 256k. So
//! there is a table, and an unknown model starts at the SMALLEST tier and
//! widens once measured usage passes it. That direction is deliberate, for the
//! reason `claude_context` gives about overstating a window: a bar that reads
//! emptier than the session really is walks the user into a compaction they
//! were not expecting. A pessimistic bar merely looks pessimistic.

use std::path::{Path, PathBuf};

/// Where grok keeps its sessions. `GROK_HOME` overrides it, and someone who
/// sets that has moved the whole store, meter included.
fn sessions_root() -> PathBuf {
    match std::env::var_os("GROK_HOME") {
        Some(home) => PathBuf::from(home).join("sessions"),
        None => flock_core::paths::home_dir().join(".grok/sessions"),
    }
}

/// The file inside a session directory that carries turn usage.
const UPDATES: &str = "updates.jsonl";

/// Window tiers, smallest first. An unknown model starts at the smallest and
/// widens through these as measured usage proves each one wrong — the same
/// widen-once-usage-passes-it rule the Claude meter uses for `[1m]` sessions.
const TIERS: &[u64] = &[256_000, 500_000, 1_000_000];

/// Known windows, matched as a prefix so a dated or suffixed id still lands.
/// A model missing from here is not a bug — it starts pessimistic and widens.
const WINDOWS: &[(&str, u64)] = &[
    ("grok-4.6", 500_000),
    ("grok-4.5", 256_000),
    ("grok-4.3", 1_000_000),
    ("grok-4.20", 1_000_000),
    ("grok-build", 256_000),
];

/// Cap on the `model` string handed back to the frontend, in characters —
/// mirroring `claude_context::MAX_MODEL_CHARS`, and for the same reason: this
/// is file content on its way to the DOM.
const MAX_MODEL_CHARS: usize = 64;

/// This session's `updates.jsonl`, if grok has started writing one.
///
/// One `read_dir` over the sessions root (one entry per working directory this
/// machine has ever run grok in), then a direct `join`. The caller only reaches
/// here for panes with no reading yet and rate-limits the retry, so this is not
/// a hot path — but it is also not a recursive walk, and `subagents/` is never
/// descended into, which is what keeps a subagent's context out of the meter.
pub fn find_transcript(session_id: &str) -> Option<PathBuf> {
    find_transcript_in(&sessions_root(), session_id)
}

/// The lookup itself, against an explicit root so it can be tested.
fn find_transcript_in(root: &Path, session_id: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let candidate = entry.path().join(session_id).join(UPDATES);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Whether this session has a conversation worth resuming.
///
/// `grok --resume` on an id that was minted but never spoken to is an error, so
/// this gates the restore path exactly as `claude_session_exists` does. A
/// directory with an `updates.jsonl` is enough: grok writes it as soon as the
/// session does anything at all.
pub fn session_exists(session_id: &str) -> bool {
    find_transcript(session_id).is_some_and(|p| p.metadata().is_ok_and(|m| m.len() > 0))
}

/// The last main-thread turn's usage, and the model that produced it.
///
/// Read as: what the *next* request will carry. `inputTokens` already includes
/// the cached prefix in grok's accounting, so the cache fields are not added
/// again — doing so double-counts the prompt and reads as a session twice as
/// full as it is. Compaction needs no special handling for the same reason it
/// doesn't in the Claude meter: a compacted session simply writes a smaller
/// block afterwards and the bar falls.
pub fn last_turn(text: &str) -> Option<(u64, String)> {
    for line in text.lines().rev() {
        let line = line.trim();
        if !line.contains("turn_completed") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let update = v.pointer("/params/update")?;
        if update.get("sessionUpdate").and_then(|s| s.as_str()) != Some("turn_completed") {
            continue;
        }
        let usage = update.get("usage")?;
        let num = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
        let used = num("inputTokens") + num("outputTokens");
        if used == 0 {
            continue;
        }
        // `modelUsage` is keyed by model id; a turn that fell back mid-flight
        // has more than one, and the largest is the one that did the work.
        let model = usage
            .get("modelUsage")
            .and_then(|m| m.as_object())
            .and_then(|m| {
                m.iter()
                    .max_by_key(|(_, v)| v.get("totalTokens").and_then(|t| t.as_u64()).unwrap_or(0))
                    .map(|(k, _)| k.clone())
            })
            .unwrap_or_default();
        let model = match model.char_indices().nth(MAX_MODEL_CHARS) {
            Some((i, _)) => model[..i].to_string(),
            None => model,
        };
        return Some((used, model));
    }
    None
}

/// The context window to measure `used` against. See the module note on why an
/// unknown model starts small and widens rather than the other way round.
pub fn window_for(model: &str, used: u64) -> u64 {
    let base = WINDOWS
        .iter()
        .find(|(prefix, _)| model.starts_with(prefix))
        .map(|(_, w)| *w)
        .unwrap_or(TIERS[0]);
    if used <= base {
        return base;
    }
    TIERS.iter().copied().find(|t| *t > used).unwrap_or(*TIERS.last().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim from a real `updates.jsonl` (grok 1.0.3), trimmed to the two
    /// fields this reads. The shape is the wire format, not a guess at it.
    const TURN: &str = r#"{"timestamp":1786565320,"method":"_x.ai/session/update","params":{"sessionId":"019ff797-5d17-7dd0-ab9b-e62429d37f55","update":{"sessionUpdate":"turn_completed","prompt_id":"98294e19","stop_reason":"end_turn","usage":{"inputTokens":58598,"outputTokens":1278,"totalTokens":59876,"cachedReadTokens":34688,"cacheCreationTokens":0,"reasoningTokens":385,"modelCalls":2,"apiDurationMs":11086,"modelUsage":{"grok-4.6":{"inputTokens":58598,"outputTokens":1278,"totalTokens":59876}}}}}}"#;

    #[test]
    fn reads_the_last_turns_usage() {
        let (used, model) = last_turn(TURN).expect("a turn_completed line");
        // Prompt + completion. NOT plus the cache fields: grok's inputTokens
        // already counts the cached prefix, and adding it again would report
        // 94k for a 60k session.
        assert_eq!(used, 58_598 + 1_278);
        assert_eq!(model, "grok-4.6");
    }

    #[test]
    fn the_latest_turn_wins_and_a_smaller_one_lowers_the_bar() {
        // What compaction looks like from here: the next turn writes less, and
        // nothing has to find the compaction boundary for the meter to fall.
        let smaller = TURN.replace("58598", "9000").replace("59876", "10278");
        let text = format!("{TURN}\n{smaller}\n");
        assert_eq!(last_turn(&text).unwrap().0, 9_000 + 1_278);
    }

    #[test]
    fn non_turn_lines_are_skipped() {
        let noise = r#"{"params":{"update":{"sessionUpdate":"agent_message_chunk"}}}"#;
        let text = format!("{TURN}\n{noise}\n{noise}\n");
        assert_eq!(last_turn(&text).unwrap().0, 58_598 + 1_278);
        assert!(last_turn(noise).is_none());
        assert!(last_turn("not json at all").is_none());
    }

    #[test]
    fn an_unknown_model_starts_pessimistic_and_widens() {
        // Overstating the window is the dangerous direction: it draws a bar
        // that is emptier than the session, right up until an unexpected
        // compaction.
        assert_eq!(window_for("grok-9-unreleased", 1_000), 256_000);
        assert_eq!(window_for("grok-9-unreleased", 300_000), 500_000);
        assert_eq!(window_for("grok-9-unreleased", 900_000), 1_000_000);
        // A known model is measured against its own window from the first turn.
        assert_eq!(window_for("grok-4.6", 1_000), 500_000);
        assert_eq!(window_for("grok-4.6", 600_000), 1_000_000);
    }

    /// A subagent's turns live in `subagents/<id>/`, and the meter must show
    /// the main thread's context — not whatever the last subagent happened to
    /// be carrying. Here that is structural: the lookup never descends.
    #[test]
    fn a_subagents_session_is_not_found_as_a_pane_session() {
        let root = std::env::temp_dir().join(format!("flock-grok-ctx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let cwd_dir = root.join("%2Ftmp%2Fproject");
        let main = "019ff797-5d17-7dd0-ab9b-e62429d37f55";
        let sub = "019ff797-f0ba-7860-b995-e30b242ec65e";
        std::fs::create_dir_all(cwd_dir.join(main).join("subagents").join(sub)).unwrap();
        std::fs::write(cwd_dir.join(main).join(UPDATES), TURN).unwrap();
        std::fs::write(cwd_dir.join(main).join("subagents").join(sub).join(UPDATES), TURN).unwrap();

        assert!(find_transcript_in(&root, main).is_some());
        assert!(find_transcript_in(&root, sub).is_none(), "subagents are not panes");
        let _ = std::fs::remove_dir_all(&root);
    }
}
