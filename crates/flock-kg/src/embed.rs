//! Local embeddings for the graph's hybrid search.
//!
//! bge-small-en-v1.5 via fastembed — 384 dimensions, matching the
//! `kg_node.embedding vector(384)` column. Model weights download on first
//! use into ~/.flock/embed-models and load from there afterwards.
//!
//! Everything here is best-effort by contract. The model warms on a
//! background thread (first warm downloads ~30 MB, later warms load from
//! disk in well under a second); until it's ready, [`try_embed`] returns
//! None and callers proceed exactly as if embeddings didn't exist — node
//! writes never wait, searches degrade to pure FTS, and an init failure
//! (offline first run, unsupported platform) permanently disables the
//! semantic leg for the process without surfacing an error.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

/// Output dimensionality of bge-small-en-v1.5. Must match the vector(384)
/// column in schema.sql / ensure_event_schema.
pub const EMBED_DIM: usize = 384;

/// Cap on embedding input, in chars. bge-small truncates at 512 tokens
/// anyway, so anything past ~1000 chars is tokenization cost for no signal.
pub const MAX_EMBED_CHARS: usize = 1000;

enum State {
    /// No warm requested yet.
    Cold,
    /// A background thread is downloading/loading the model.
    Warming,
    /// Model loaded. Mutex because fastembed's embed() takes &mut self.
    Ready(Arc<Mutex<fastembed::TextEmbedding>>),
    /// Init failed; stays failed for the life of the process.
    Failed,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::Cold))
}

/// Model cache under the flock home dir, next to the graph infra.
///
/// Through `shared_data_dir`, never a hand-built `~/.flock`: this crate is
/// reached by `flock-mcp`, which Claude Code spawns from a hook on every
/// prompt, with no desktop app involved. Creating the directory here by hand
/// would make `~/.flock` exist before anything had a chance to migrate
/// `~/.clarence` into it, and `resolve_dir` treats an existing `~/.flock` as a
/// finished migration — the user's workspaces would be stranded for good.
fn cache_dir() -> PathBuf {
    flock_core::paths::shared_data_dir().join("embed-models")
}

/// Start loading the model on a plain background thread (no runtime needed).
/// Idempotent and non-blocking; called from KnowledgeGraph construction so
/// the model is usually warm by the time the first search or write lands.
pub fn warm() {
    {
        let mut st = state().lock().unwrap();
        if !matches!(*st, State::Cold) {
            return;
        }
        *st = State::Warming;
    }
    let spawned = std::thread::Builder::new()
        .name("kg-embed-warm".into())
        .spawn(|| {
            let opts = fastembed::InitOptions::new(fastembed::EmbeddingModel::BGESmallENV15)
                .with_cache_dir(cache_dir())
                .with_show_download_progress(false);
            let next = match fastembed::TextEmbedding::try_new(opts) {
                Ok(model) => State::Ready(Arc::new(Mutex::new(model))),
                Err(e) => {
                    tracing::warn!("kg embedder init failed — semantic search off, FTS only: {e}");
                    State::Failed
                }
            };
            *state().lock().unwrap() = next;
        });
    if spawned.is_err() {
        *state().lock().unwrap() = State::Failed;
    }
}

/// The model, only if it's ready right now. Never blocks; a miss kicks off
/// (or continues) the background warm so a later call can hit.
fn ready() -> Option<Arc<Mutex<fastembed::TextEmbedding>>> {
    if let State::Ready(m) = &*state().lock().unwrap() {
        return Some(Arc::clone(m));
    }
    warm();
    None
}

/// Turn the semantic leg off for the life of this process, before anything can
/// warm it. For one-shot binaries — the `ground` / `brief` / `endturn` hooks —
/// where warming is worse than useless in two separate ways.
///
/// **It never finishes.** [`try_embed`] returns immediately and only kicks off
/// the warm; a process that exists to answer one prompt and exit is gone long
/// before an ONNX session is built. So the semantic half of `context_pack` was
/// already dead in the exact place it was written for — every grounding pass
/// was FTS-only, and paid a 30 MB model load per prompt to establish that.
///
/// **It crashes on the way out.** Measured at 6 of 20 runs on macOS: the warm
/// thread is inside ort's session init when `main` returns, and the teardown
/// takes the process with it (SIGSEGV). A `UserPromptSubmit` hook that exits
/// non-zero has its stdout discarded and its stderr shown to the user, so
/// roughly a third of grounding passes injected nothing and reported a hook
/// failure instead — on a path whose whole contract is to fail silently.
///
/// Restoring semantic grounding means a warm embedder that outlives one prompt
/// (a resident sidecar, or embedding the query in the long-lived MCP server
/// process), not warming one per prompt.
pub fn disable() {
    let mut st = state().lock().unwrap();
    if matches!(*st, State::Cold) {
        *st = State::Failed;
    }
}

pub fn is_ready() -> bool {
    matches!(*state().lock().unwrap(), State::Ready(_))
}

pub fn is_failed() -> bool {
    matches!(*state().lock().unwrap(), State::Failed)
}

/// Embed one text. None when the model isn't warm yet, failed to init, or
/// the forward pass errors — callers treat all three identically (no
/// semantic leg). The CPU-bound pass runs on the blocking pool; with a warm
/// model a short query embeds in single-digit milliseconds.
pub async fn try_embed(text: &str) -> Option<Vec<f32>> {
    let vecs = try_embed_batch(vec![truncate_chars(text, MAX_EMBED_CHARS)]).await?;
    vecs.into_iter().next()
}

/// Batch variant for the backfill path. Inputs are assumed pre-capped via
/// [`embed_input`]. None under the same conditions as [`try_embed`].
pub async fn try_embed_batch(texts: Vec<String>) -> Option<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Some(vec![]);
    }
    let model = ready()?;
    let out = tokio::task::spawn_blocking(move || {
        let mut m = model.lock().unwrap();
        m.embed(&texts, None)
    })
    .await
    .ok()?
    .ok()?;
    if out.iter().any(|v| v.len() != EMBED_DIM) {
        tracing::warn!("kg embedder returned unexpected dimensionality; dropping batch");
        return None;
    }
    Some(out)
}

/// The canonical embedding input for a node: label + "\n" + body, capped at
/// [`MAX_EMBED_CHARS`]. The same shape is used at write time, in backfill,
/// and (conceptually) for queries, so vectors stay comparable.
pub fn embed_input(label: &str, body: Option<&str>) -> String {
    let mut text = label.trim().to_string();
    if let Some(b) = body.map(str::trim).filter(|b| !b.is_empty()) {
        text.push('\n');
        text.push_str(b);
    }
    truncate_chars(&text, MAX_EMBED_CHARS)
}

/// Char-boundary-safe prefix truncation (byte slicing would panic mid-UTF-8).
pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => s[..byte_idx].to_string(),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_shorter_than_cap_is_identity() {
        assert_eq!(truncate_chars("hello", 10), "hello");
        assert_eq!(truncate_chars("", 10), "");
    }

    #[test]
    fn truncate_caps_at_char_count() {
        assert_eq!(truncate_chars("abcdef", 3), "abc");
    }

    #[test]
    fn truncate_respects_multibyte_boundaries() {
        // Each char is multibyte; slicing at a byte offset would panic.
        let s = "héllo wörld — ünïcode";
        let t = truncate_chars(s, 7);
        assert_eq!(t.chars().count(), 7);
        assert!(s.starts_with(&t));
    }

    #[test]
    fn embed_input_joins_label_and_body() {
        assert_eq!(embed_input("label", Some("body")), "label\nbody");
    }

    #[test]
    fn embed_input_label_only_when_body_missing_or_empty() {
        assert_eq!(embed_input("label", None), "label");
        assert_eq!(embed_input("label", Some("")), "label");
        assert_eq!(embed_input("label", Some("   ")), "label");
    }

    #[test]
    fn embed_input_caps_length() {
        let body = "x".repeat(5000);
        let out = embed_input("label", Some(&body));
        assert_eq!(out.chars().count(), MAX_EMBED_CHARS);
    }

    /// Actually downloads (first run) and loads bge-small, then embeds.
    /// Run manually: cargo test -p flock-kg -- --ignored embedder
    #[tokio::test]
    #[ignore]
    async fn embedder_loads_and_embeds_384_dims() {
        // The database-backed tests in lib.rs call `disable()` so their process
        // can exit without ort's teardown crashing it, and state is per-process
        // and one-way. Running the whole ignored set at once therefore lands
        // here already disabled — skip rather than report a failure that says
        // nothing about the embedder.
        if is_failed() {
            eprintln!("embedder disabled by a sibling test; run this one on its own");
            return;
        }
        warm();
        // First warm may download the model; poll generously.
        for _ in 0..600 {
            if is_ready() || is_failed() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        assert!(is_ready(), "embedder did not warm (offline? init failure?)");

        let v = try_embed("terminal panes keep their content across workspace switches")
            .await
            .expect("warm embedder should embed");
        assert_eq!(v.len(), EMBED_DIM);
        assert!(v.iter().any(|x| *x != 0.0));

        // Cosine sanity: related sentences should sit closer than unrelated.
        let a = try_embed("agent status detection heuristics").await.unwrap();
        let b = try_embed("detecting whether the agent is busy or idle").await.unwrap();
        let c = try_embed("the quarterly marketing budget spreadsheet").await.unwrap();
        let cos = |x: &[f32], y: &[f32]| -> f32 {
            let dot: f32 = x.iter().zip(y).map(|(p, q)| p * q).sum();
            let nx: f32 = x.iter().map(|p| p * p).sum::<f32>().sqrt();
            let ny: f32 = y.iter().map(|p| p * p).sum::<f32>().sqrt();
            dot / (nx * ny)
        };
        assert!(cos(&a, &b) > cos(&a, &c));
    }
}
