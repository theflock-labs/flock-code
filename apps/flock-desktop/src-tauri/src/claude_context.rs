//! How full a Claude Code pane's context window is, read from that pane's own
//! session transcript.
//!
//! This is deliberately *per-session*, unlike `claude_code_usage.rs`, which
//! sums every transcript on the machine for a lifetime spend figure. Here we
//! want one number for one agent: how much of its context window this
//! conversation is currently sitting on, so the pane topbar can show a meter
//! and you can see which agent is about to auto-compact without clicking into
//! it.
//!
//! Load-bearing notes:
//!
//!   * **We only look at claude panes**, because they are the only ones whose
//!     session id flock imposes (`--session-id`, see `withClaudeSession` in
//!     App.tsx). opencode/codex ids are captured after the fact and their
//!     stores record usage in different shapes — not covered here.
//!
//!   * **The last main-thread assistant turn is the whole answer.** A turn's
//!     `usage` records the prompt that went in (`input` + both cache fields)
//!     and the completion that came out; their sum is what the *next* request
//!     will carry, i.e. the live context. That makes compaction free to track:
//!     a compacted session just writes a much smaller usage block afterwards
//!     and the meter drops on its own, with no need to find the compact
//!     boundary.
//!
//!   * **Sidechains must be skipped.** Subagent turns land in the same
//!     transcript with `isSidechain: true` and carry the *subagent's* context,
//!     which is unrelated to (and usually far smaller than) the main thread's.
//!     Reading the literal last usage block would make the meter collapse
//!     every time a Task tool ran.
//!
//!   * **The window size is inferred, not read.** Transcripts record the model
//!     as `claude-opus-5` even for a 1M-context session (`claude-opus-5[1m]`) —
//!     the suffix is stripped before it is written — and carry no context-window
//!     field at all. Three signals, in order: the recorded model still showing
//!     `[1m]`; claude's own `~/.claude.json`, which keys
//!     `projects.<cwd>.lastModelUsage` by the FULL model id and is the one
//!     place on the host that still knows (see [`long_context_in_config`]);
//!     and finally measured usage passing 200k, which proves it after the
//!     fact. Before the config lookup existed a 1M session read as a 200k one
//!     until it was over 200k full, which is most of a session spent showing
//!     the wrong scale.
//!
//!   * **Jailed panes read the same way, one level deeper.** A secure
//!     workspace's agent used to write its transcript into the container's
//!     `$HOME` volume, where nothing on the host could see it. It now writes to
//!     a per-workspace host directory bind-mounted over the jail's
//!     `~/.claude/projects` (flock-pty `container::run_args`), so the session id
//!     flock imposed is findable — at `projects/flock-secure-<ws>/<slug>/`
//!     rather than `projects/<slug>/`, because it is the whole projects
//!     directory that is remapped. See [`find_transcript_in`].

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

/// Standard Claude Code context window.
const DEFAULT_WINDOW: u64 = 200_000;
/// The long-context variant (`[1m]`), and what we widen to once measured usage
/// proves the session cannot be on the standard window.
const LONG_WINDOW: u64 = 1_000_000;

/// How much of the transcript's tail to read looking for the last main-thread
/// assistant turn. Every turn writes one, so in practice the answer is in the
/// final few KB; this is slack for a turn that wrote a very large tool result
/// after it. Falls back to the whole file if the tail somehow has none.
const TAIL_BYTES: u64 = 512 * 1024;

/// Ceiling on the full-file fallback. A transcript this large means something
/// pathological; better to report nothing than to stall reading it every poll.
const MAX_FULL_READ: u64 = 64 * 1024 * 1024;

/// Ceiling on the `model` string handed back to the frontend, in characters.
/// See where it is applied for why file content on its way to the DOM gets a
/// length bound.
const MAX_MODEL_CHARS: usize = 64;

/// One pane's context occupancy.
#[derive(Clone, Serialize)]
pub struct ContextUsage {
    pub session_id: String,
    /// Prompt + completion of the last main-thread turn: what the next request
    /// carries.
    pub used_tokens: u64,
    /// Inferred — see the module note on why this can't simply be read.
    pub window_tokens: u64,
    /// The model that produced the turn we measured, as recorded.
    pub model: String,
    /// mtime of the transcript, so the UI can tell a live agent's meter from
    /// one frozen since yesterday.
    pub updated_at_ms: u64,
}

/// Which agent wrote the transcript this memo points at, and therefore how to
/// read it. Both agents take a session id flock minted (`--session-id`), so a
/// pane's conversation is findable either way; only the file format and the
/// window differ, and `grok_context` owns that half.
#[derive(Clone, Copy, PartialEq)]
enum Flavor {
    Claude,
    Grok,
}

/// Per-session memo. The transcript path never moves once found, and the parse
/// only has to be redone when the file grows, so both are keyed off mtime+len.
struct Memo {
    flavor: Flavor,
    /// None until the transcript exists. A pane whose agent has not been
    /// spoken to yet has no file at all, and a fresh grid is nothing but those.
    path: Option<PathBuf>,
    /// Polls to skip before scanning `projects/` again for a still-missing
    /// transcript. Without it, every tick re-reads the whole projects
    /// directory once per fileless pane — which is the entire grid for the
    /// first minute after a spawn, and is the one part of this that is not
    /// memoized by mtime.
    rescan_in: u8,
    stamp: Option<(u64, u64)>, // (mtime_ms, len)
    value: Option<ContextUsage>,
}

/// Polls to wait out before looking again for a transcript that wasn't there.
/// At the frontend's 5s cadence this is ~30s, which is far below how long it
/// takes someone to type a first prompt.
const RESCAN_POLLS: u8 = 6;

fn memos() -> &'static Mutex<HashMap<String, Memo>> {
    static M: OnceLock<Mutex<HashMap<String, Memo>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether `s` is a session id, and therefore safe to interpolate into a
/// filename.
///
/// This is a security boundary, not a tidiness check. The id arrives from the
/// webview and is pasted into `format!("{id}.jsonl")`, which is then *joined*
/// onto a directory — so `../../../../etc/passwd` walks straight out of
/// `~/.claude/projects` and this module happily opens whatever it lands on,
/// returning the file's mtime and any string it can read out of a `model`
/// field. That is an arbitrary-file-read oracle handed to the frontend, and
/// this codebase already treats the webview as potentially compromised (see
/// the secure-mode reasoning in `spawn_pane`).
///
/// flock mints these ids itself with `crypto.randomUUID()`, so the shape is
/// known exactly: 8-4-4-4-12 hex with dashes. Anything else is refused rather
/// than sanitized — there is no legitimate id this rejects.
pub fn is_session_id(s: &str) -> bool {
    s.len() == 36
        && s.as_bytes().iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// Locate `<session_id>.jsonl` under any project directory. Callers must have
/// screened `session_id` with [`is_session_id`] first.
///
/// Deliberately not derived from the cwd: claude's cwd→directory mangling has
/// shifted across versions and mirroring it here is what broke resume once
/// already (see `claude_session_exists`). Session ids are UUIDs, so a filename
/// match anywhere under `projects/` is unambiguous.
pub fn find_transcript(session_id: &str) -> Option<PathBuf> {
    find_transcript_in(&flock_core::paths::home_dir().join(".claude/projects"), session_id)
}

/// The lookup itself, against an explicit `projects` root so it can be tested.
///
/// Two layouts, because a secure workspace does not get one project directory
/// mounted into its jail — it gets the whole `projects` directory remapped to a
/// per-workspace host directory (flock-pty `container::run_args`). So a jailed
/// agent's transcript sits one level further down:
///
///   host    `projects/<slug>/<session>.jsonl`
///   jailed  `projects/flock-secure-<ws>/<slug>/<session>.jsonl`
///
/// The flat pass stays the hot path — it reruns for every pane that has no
/// transcript yet, which is the whole grid for the first minute after a spawn —
/// so the secure roots are noted on the way past and only descended into once
/// the flat scan has come up empty. A full recursive walk would instead read
/// every project directory on the machine on each of those polls.
fn find_transcript_in(projects: &std::path::Path, session_id: &str) -> Option<PathBuf> {
    let file = format!("{session_id}.jsonl");
    let mut secure_roots: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(projects).ok()?.flatten() {
        let dir = entry.path();
        let candidate = dir.join(&file);
        if candidate.exists() {
            return Some(candidate);
        }
        if dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(flock_pty::container::SECURE_TRANSCRIPTS_PREFIX))
        {
            secure_roots.push(dir);
        }
    }
    for root in secure_roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join(&file);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn mtime_len(path: &PathBuf) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let ms = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((ms, meta.len()))
}

/// Read the last `TAIL_BYTES` of the file (or all of it, when `whole`), as
/// lossy UTF-8. When we seeked, the first line is almost certainly a fragment,
/// so it is dropped.
///
/// The fragment is trimmed off the *bytes*, before the UTF-8 conversion, so
/// this costs one copy of the tail rather than two. Decoding first and then
/// re-slicing meant every changed transcript allocated a megabyte to read half
/// of one.
fn read_tail(path: &PathBuf, len: u64, whole: bool) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let from = if whole || len <= TAIL_BYTES {
        0
    } else {
        len - TAIL_BYTES
    };
    if from > 0 {
        file.seek(SeekFrom::Start(from)).ok()?;
    }
    let mut buf = Vec::with_capacity((len - from).min(TAIL_BYTES) as usize + 1024);
    file.take(MAX_FULL_READ).read_to_end(&mut buf).ok()?;
    let start = if from == 0 {
        0
    } else {
        match buf.iter().position(|b| *b == b'\n') {
            Some(i) => i + 1,
            None => buf.len(),
        }
    };
    Some(String::from_utf8_lossy(&buf[start..]).into_owned())
}

/// Total tokens the model saw and produced on one turn.
///
/// `usage.iterations` (present when a turn made several model calls) is
/// preferred over the top-level block: the top level aggregates output across
/// iterations while the input side describes only one of them, so summing it
/// double-counts. The last iteration is the one whose prompt reflects the whole
/// turn, which is exactly the context the next request inherits.
fn turn_tokens(usage: &serde_json::Value) -> u64 {
    let block = usage
        .get("iterations")
        .and_then(|v| v.as_array())
        .and_then(|a| a.last())
        .unwrap_or(usage);
    let field = |k: &str| block.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
    field("input_tokens")
        + field("cache_creation_input_tokens")
        + field("cache_read_input_tokens")
        + field("output_tokens")
}

/// Scan backwards for the last main-thread assistant turn carrying a `usage`
/// block. Returns (tokens, model, cwd) — the cwd is what lets the window be
/// looked up in claude's own config; see [`configured_long_context`].
fn last_turn(text: &str) -> Option<(u64, String, String)> {
    for line in text.lines().rev() {
        // Cheap prefilter — parsing every line of a large tail as JSON just to
        // discard user turns and attachments is most of the cost of this scan.
        if !line.contains("\"assistant\"") || !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        if v.get("isSidechain").and_then(|s| s.as_bool()) == Some(true) {
            continue;
        }
        let message = v.get("message")?;
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let tokens = turn_tokens(usage);
        if tokens == 0 {
            continue;
        }
        // Bounded: this is file content on its way to the UI (the meter's
        // tooltip). A model id is a couple of dozen characters; anything
        // longer is not one, and shouldn't be carried across the IPC boundary
        // or pasted into the DOM on the strength of having sat in a `model`
        // field. Sliced on a char boundary so a multi-byte id can't panic.
        let raw = message.get("model").and_then(|m| m.as_str()).unwrap_or("");
        // char_indices, not a byte slice: a multi-byte id must not be cut
        // mid-character (which panics).
        let model = match raw.char_indices().nth(MAX_MODEL_CHARS) {
            Some((i, _)) => raw[..i].to_string(),
            None => raw.to_string(),
        };
        let cwd = v
            .get("cwd")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        return Some((tokens, model, cwd));
    }
    None
}

/// Does claude's own config say this project's `model` is the long-context cut?
///
/// The transcript drops the `[1m]` suffix, but `~/.claude.json` does not: each
/// entry in `projects.<launch-cwd>.lastModelUsage` is keyed by the FULL model
/// id. That is the only place on this machine that still knows, which is why
/// the meter reads a file belonging to another program.
///
/// Two things keep this honest, both because OVERSTATING the window is the
/// dangerous direction — a bar that reads emptier than the session really is
/// walks the user into a compaction they were not expecting, whereas
/// understating it merely looks pessimistic:
///
///   * The suffixed id must match the model actually measured. `lastModelUsage`
///     accumulates every model a directory has seen (one here has three), so
///     "some 1m model was used in this repo" proves nothing about this session.
///   * The plain variant must be ABSENT. If a directory has run both
///     `claude-opus-5` and `claude-opus-5[1m]` there is no way to tell which
///     this session is, so the answer is no and the existing
///     widen-once-usage-passes-200k rule handles it.
///
/// Best-effort throughout: this is a private file of another program and every
/// failure path returns false, which lands on the old behaviour.
fn configured_long_context(cwd: &str, model: &str) -> bool {
    match claude_config() {
        Some(cfg) => long_context_in_config(&cfg, cwd, model),
        None => false,
    }
}

/// The decision itself, split from the file read so it can be tested without a
/// `$HOME` to stage.
fn long_context_in_config(cfg: &serde_json::Value, cwd: &str, model: &str) -> bool {
    if cwd.is_empty() || model.is_empty() || model.contains('[') {
        return false;
    }
    let Some(projects) = cfg.get("projects").and_then(|p| p.as_object()) else {
        return false;
    };

    // The turn's cwd is wherever the agent had cd'd to, but claude keys its
    // projects by the directory it was LAUNCHED in — so walk up until one of
    // the ancestors is a key. Bounded by the path's own depth.
    let mut dir = Some(std::path::Path::new(cwd));
    while let Some(d) = dir {
        if let Some(usage) = projects
            .get(d.to_string_lossy().as_ref())
            .and_then(|p| p.get("lastModelUsage"))
            .and_then(|u| u.as_object())
        {
            let long = format!("{model}[1m]");
            return usage.contains_key(&long) && !usage.contains_key(model);
        }
        dir = d.parent();
    }
    false
}

/// `~/.claude.json`, parsed at most once per change. ~96KB today, and the
/// context meter polls every pane every few seconds, so re-reading it per pane
/// per tick would be the most expensive thing this module does. Keyed on
/// (mtime, len) like the transcript memos above.
fn claude_config() -> Option<serde_json::Value> {
    /// (stamp, parsed) — named so the cache's type is readable at the use site.
    type ConfigCache = Mutex<(Option<(u64, u64)>, Option<serde_json::Value>)>;
    static CACHE: OnceLock<ConfigCache> = OnceLock::new();
    let path = flock_core::paths::home_dir().join(".claude.json");
    let stamp = mtime_len(&path)?;
    let cell = CACHE.get_or_init(|| Mutex::new((None, None)));
    let mut guard = cell.lock().ok()?;
    if guard.0 != Some(stamp) {
        guard.0 = Some(stamp);
        guard.1 = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok());
    }
    guard.1.clone()
}

fn window_for(model: &str, used: u64, cwd: &str) -> u64 {
    if model.contains("[1m]") || used > DEFAULT_WINDOW || configured_long_context(cwd, model) {
        LONG_WINDOW
    } else {
        DEFAULT_WINDOW
    }
}

fn measure(session_id: &str, memo: &mut Memo) -> Option<ContextUsage> {
    let path = memo.path.clone()?;
    let (mtime, len) = mtime_len(&path)?;
    if memo.stamp == Some((mtime, len)) {
        return memo.value.clone();
    }
    memo.stamp = Some((mtime, len));

    // grok's store is read by its own module; everything around it — when to
    // re-read, what to do when a read yields nothing, the row that comes out —
    // is shared, so the two meters can't drift apart in behaviour.
    if memo.flavor == Flavor::Grok {
        let parse = |whole| read_tail(&path, len, whole).and_then(|t| crate::grok_context::last_turn(&t));
        let found = parse(false).or_else(|| {
            if len > TAIL_BYTES && len <= MAX_FULL_READ { parse(true) } else { None }
        });
        let Some((used, model)) = found else {
            memo.value = None;
            return None;
        };
        memo.value = Some(ContextUsage {
            session_id: session_id.to_string(),
            used_tokens: used,
            window_tokens: crate::grok_context::window_for(&model, used),
            model,
            updated_at_ms: mtime,
        });
        return memo.value.clone();
    }

    let mut found = read_tail(&path, len, false).and_then(|t| last_turn(&t));
    if found.is_none() && len > TAIL_BYTES && len <= MAX_FULL_READ {
        found = read_tail(&path, len, true).and_then(|t| last_turn(&t));
    }
    let Some((used, model, cwd)) = found else {
        // The stamp above is already updated, so without this the previous
        // reading would be served as current on every later poll — a meter
        // frozen at a stale count. A file state that yields no turn answers
        // "nothing readable", and keeps answering that until the file changes.
        memo.value = None;
        return None;
    };

    memo.value = Some(ContextUsage {
        session_id: session_id.to_string(),
        used_tokens: used,
        window_tokens: window_for(&model, used, &cwd),
        model,
        updated_at_ms: mtime,
    });
    memo.value.clone()
}

/// Context occupancy for each of `session_ids` that has a readable transcript.
///
/// Batched on purpose: a grid of eight panes should cost one IPC round trip per
/// poll, not eight. Sessions with no transcript yet (a pane whose agent hasn't
/// been talked to) are simply absent from the result rather than reported as
/// zero — an empty meter and a missing meter are different things, and only the
/// caller knows which to draw.
/// `async` so Tauri runs it off the main thread. A synchronous command is
/// dispatched on the UI thread, and this one does real file I/O — a stat per
/// pane every tick, plus a half-megabyte read and parse for each pane whose
/// agent just finished a turn. On a twelve-pane grid that is not something to
/// put in front of the compositor.
#[tauri::command]
pub async fn claude_context_usage(session_ids: Vec<String>) -> Vec<ContextUsage> {
    // No awaits below, so holding the std Mutex across this body is sound.
    let mut memos = memos().lock().unwrap();
    let live: std::collections::HashSet<&String> = session_ids.iter().collect();
    memos.retain(|k, _| live.contains(k));

    let mut out = Vec::with_capacity(session_ids.len());
    for id in &session_ids {
        // Refused, not sanitized — see is_session_id. An id that isn't one
        // never reaches the filesystem.
        if !is_session_id(id) {
            continue;
        }
        let memo = memos.entry(id.clone()).or_insert_with(|| Memo {
            flavor: Flavor::Claude,
            path: None,
            rescan_in: 0,
            stamp: None,
            value: None,
        });
        if memo.path.is_none() {
            if memo.rescan_in > 0 {
                memo.rescan_in -= 1;
                continue;
            }
            // Claude Code first because it is the common case, then grok. The
            // caller passes session ids without saying which agent minted
            // them: a pane's kind lives in the frontend, and threading it
            // through would mean the meter could be asked the wrong question
            // about a restored pane. Ids are UUIDs, so looking in both places
            // cannot mistake one agent's session for another's.
            memo.path = find_transcript(id);
            if memo.path.is_none() {
                memo.path = crate::grok_context::find_transcript(id);
                memo.flavor = Flavor::Grok;
            }
            if memo.path.is_none() {
                memo.flavor = Flavor::Claude;
                memo.rescan_in = RESCAN_POLLS;
                continue;
            }
        }
        if let Some(usage) = measure(id, memo) {
            out.push(usage);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(tokens: &str, sidechain: bool, model: &str) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":{sidechain},"message":{{"model":"{model}","usage":{tokens}}}}}"#
        )
    }

    #[test]
    fn sums_the_four_token_fields() {
        let line = assistant(
            r#"{"input_tokens":2,"cache_creation_input_tokens":3518,"cache_read_input_tokens":81479,"output_tokens":1750}"#,
            false,
            "claude-opus-5",
        );
        let (used, model, _) = last_turn(&line).unwrap();
        assert_eq!(used, 86_749);
        assert_eq!(model, "claude-opus-5");
    }

    #[test]
    fn skips_sidechain_turns() {
        // A subagent turn written after the main thread's must not win: it
        // carries the subagent's context, and reading it collapses the meter.
        let text = format!(
            "{}\n{}\n",
            assistant(
                r#"{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":120000,"output_tokens":500}"#,
                false,
                "claude-opus-5",
            ),
            assistant(
                r#"{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":9000,"output_tokens":100}"#,
                true,
                "claude-sonnet-5",
            ),
        );
        let (used, _, _) = last_turn(&text).unwrap();
        assert_eq!(used, 120_500);
    }

    #[test]
    fn prefers_the_last_iteration_over_the_aggregate() {
        // Top-level output aggregates both iterations while the input side
        // describes only the first — summing it would over-report.
        let line = assistant(
            r#"{"input_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":900,"iterations":[{"input_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":400},{"input_tokens":2,"cache_creation_input_tokens":420,"cache_read_input_tokens":1500,"output_tokens":500}]}"#,
            false,
            "claude-opus-5",
        );
        let (used, _, _) = last_turn(&line).unwrap();
        assert_eq!(used, 2_422);
    }

    #[test]
    fn window_widens_once_usage_passes_the_standard_one() {
        assert_eq!(window_for("claude-opus-5", 86_749, ""), DEFAULT_WINDOW);
        assert_eq!(window_for("claude-opus-5", 240_000, ""), LONG_WINDOW);
        // The suffix survives on the rare transcript that records it.
        assert_eq!(window_for("claude-opus-5[1m]", 10_000, ""), LONG_WINDOW);
    }

    /// The bug these cover: a 1M session showed a 200k meter, because the
    /// transcript records `claude-opus-5` for both cuts and the only host-side
    /// record of the `[1m]` suffix is claude's own `~/.claude.json`.
    #[test]
    fn reads_the_long_window_out_of_claudes_own_config() {
        let cfg = serde_json::json!({
            "projects": {
                "/repo": { "lastModelUsage": { "claude-opus-5[1m]": { "inputTokens": 2 } } }
            }
        });
        assert!(long_context_in_config(&cfg, "/repo", "claude-opus-5"));
        // The agent cd'd deeper mid-session; claude still keys the project by
        // the directory it was launched in, so ancestors have to be tried.
        assert!(long_context_in_config(&cfg, "/repo/apps/desktop", "claude-opus-5"));
    }

    /// Overstating the window is the dangerous direction — a bar that reads
    /// emptier than the session is walks the user into a surprise compaction —
    /// so every ambiguous case has to answer "no" and fall back to the
    /// widen-on-measured-usage rule.
    #[test]
    fn refuses_to_widen_on_ambiguous_or_unrelated_config() {
        let both = serde_json::json!({
            "projects": {
                "/repo": { "lastModelUsage": {
                    "claude-opus-5": { "inputTokens": 1 },
                    "claude-opus-5[1m]": { "inputTokens": 2 }
                } }
            }
        });
        // Both cuts have run here; nothing says which one this session is.
        assert!(!long_context_in_config(&both, "/repo", "claude-opus-5"));

        // A 1m entry for a DIFFERENT model proves nothing about this one.
        let other = serde_json::json!({
            "projects": {
                "/repo": { "lastModelUsage": { "claude-fable-5[1m]": { "inputTokens": 2 } } }
            }
        });
        assert!(!long_context_in_config(&other, "/repo", "claude-opus-5"));

        // No entry for this directory or any ancestor.
        let elsewhere = serde_json::json!({
            "projects": {
                "/other": { "lastModelUsage": { "claude-opus-5[1m]": { "inputTokens": 2 } } }
            }
        });
        assert!(!long_context_in_config(&elsewhere, "/repo", "claude-opus-5"));

        // Malformed or absent config must never panic or widen.
        assert!(!long_context_in_config(&serde_json::json!({}), "/repo", "claude-opus-5"));
        assert!(!long_context_in_config(&serde_json::json!({"projects": 7}), "/repo", "claude-opus-5"));
        assert!(!long_context_in_config(&both, "", "claude-opus-5"));
        assert!(!long_context_in_config(&both, "/repo", ""));
    }

    #[test]
    fn ignores_lines_that_are_not_assistant_turns() {
        let text = format!(
            "{}\n{}\n{}\n",
            assistant(
                r#"{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":50,"output_tokens":9}"#,
                false,
                "claude-opus-5",
            ),
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"system","subtype":"turn_duration","durationMs":42}"#,
        );
        assert_eq!(last_turn(&text).unwrap().0, 60);
    }

    /// The id is interpolated into a filename that gets joined onto a
    /// directory, so this is the whole thing standing between the webview and
    /// an arbitrary-file read. Refusal, not sanitization.
    #[test]
    fn only_real_session_ids_reach_the_filesystem() {
        assert!(is_session_id("2f1c6bb5-d843-400e-a86c-70276cd12c33"));
        assert!(is_session_id("00000000-0000-0000-0000-000000000000"));

        for bad in [
            "../../../../etc/passwd",
            "../../../../../../Users/x/.ssh/id_rsa",
            "2f1c6bb5-d843-400e-a86c-70276cd12c33/../../../etc/hosts",
            "2f1c6bb5-d843-400e-a86c-70276cd12c3",  // too short
            "2f1c6bb5-d843-400e-a86c-70276cd12c333", // too long
            "2f1c6bb5_d843_400e_a86c_70276cd12c33",  // dashes in the wrong place
            "2f1c6bb5-d843-400e-a86c-70276cd12cZZ",  // not hex
            "..",
            "",
        ] {
            assert!(!is_session_id(bad), "must refuse {bad:?}");
        }
    }

    /// The model string is file content on its way to the DOM.
    #[test]
    fn the_model_string_is_length_bounded() {
        let long = "x".repeat(500);
        let line = assistant(
            r#"{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":10,"output_tokens":1}"#,
            false,
            &long,
        );
        let (_, model, _) = last_turn(&line).unwrap();
        assert!(model.chars().count() <= MAX_MODEL_CHARS);
    }

    /// Multi-byte content must be sliced on a char boundary, not panic.
    #[test]
    fn a_multibyte_model_string_does_not_panic() {
        let line = assistant(
            r#"{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":10,"output_tokens":1}"#,
            false,
            &"é".repeat(200),
        );
        let (_, model, _) = last_turn(&line).unwrap();
        assert_eq!(model.chars().count(), MAX_MODEL_CHARS);
    }

    #[test]
    fn no_usage_anywhere_reads_as_absent() {
        assert!(last_turn(r#"{"type":"user","message":{"content":"hi"}}"#).is_none());
        assert!(last_turn("").is_none());
    }

    /// A jailed pane's transcript is a level deeper than a host pane's, because
    /// secure mode remaps the whole `projects` directory rather than one
    /// project. Both layouts have to resolve, and the flat one must still win
    /// without descending anywhere.
    #[test]
    fn finds_transcripts_from_host_and_jailed_panes() {
        let root = std::env::temp_dir().join(format!(
            "flock-find-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        let host = root.join("-Users-x-git-repo");
        let jailed = root
            .join(format!("{}-00000000deadbeef", flock_pty::container::SECURE_TRANSCRIPTS_PREFIX))
            .join("-Users-x-git-other");
        std::fs::create_dir_all(&host).unwrap();
        std::fs::create_dir_all(&jailed).unwrap();

        let a = "2f1c6bb5-d843-400e-a86c-70276cd12c33";
        let b = "00000000-0000-0000-0000-000000000001";
        std::fs::write(host.join(format!("{a}.jsonl")), "").unwrap();
        std::fs::write(jailed.join(format!("{b}.jsonl")), "").unwrap();

        assert_eq!(find_transcript_in(&root, a), Some(host.join(format!("{a}.jsonl"))));
        assert_eq!(find_transcript_in(&root, b), Some(jailed.join(format!("{b}.jsonl"))));
        // A directory that isn't a secure root is never descended into: a
        // session id that exists nowhere must not turn into a tree walk.
        assert_eq!(find_transcript_in(&root, "00000000-0000-0000-0000-000000000002"), None);

        std::fs::remove_dir_all(&root).ok();
    }

    /// The tail read is the part unit-testing the parser can't cover: seeking
    /// into the middle of a huge file has to drop the fragment it lands in
    /// without eating the newest line with it.
    #[test]
    fn reads_the_newest_turn_out_of_a_file_larger_than_the_tail_window() {
        let dir = std::env::temp_dir().join(format!(
            "flock-ctx-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");

        let filler = assistant(
            r#"{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":10,"output_tokens":1}"#,
            false,
            "claude-sonnet-5",
        );
        let newest = assistant(
            r#"{"input_tokens":7,"cache_creation_input_tokens":1000,"cache_read_input_tokens":150000,"output_tokens":993}"#,
            false,
            "claude-opus-5",
        );
        let mut body = String::new();
        while body.len() < (TAIL_BYTES as usize) * 2 {
            body.push_str(&filler);
            body.push('\n');
        }
        body.push_str(&newest);
        body.push('\n');
        std::fs::write(&path, &body).unwrap();

        let mut memo = Memo {
            flavor: Flavor::Claude,
            path: Some(path.clone()),
            rescan_in: 0,
            stamp: None,
            value: None,
        };
        let got = measure("session", &mut memo).expect("a reading");
        assert_eq!(got.used_tokens, 152_000);
        assert_eq!(got.model, "claude-opus-5");
        assert_eq!(got.window_tokens, DEFAULT_WINDOW);

        // Second call with the file untouched must come back off the memo
        // rather than re-reading a megabyte on every poll tick.
        let stamp = memo.stamp;
        let again = measure("session", &mut memo).expect("a cached reading");
        assert_eq!(again.used_tokens, 152_000);
        assert_eq!(memo.stamp, stamp);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A transcript being appended to while we read it ends in a half-written
    /// line. That must not blank the meter — fall back to the turn before.
    #[test]
    fn tolerates_a_partially_written_final_line() {
        let text = format!(
            "{}\n{}",
            assistant(
                r#"{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":4000,"output_tokens":50}"#,
                false,
                "claude-opus-5",
            ),
            r#"{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_to"#,
        );
        assert_eq!(last_turn(&text).unwrap().0, 4_050);
    }
}

