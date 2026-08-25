//! Docker-container confinement for agent panes — the "secure mode" jail.
//!
//! The Seatbelt sandbox (see [`crate::sandbox`]) reduces blast radius but
//! leaves the agent on the host: network-adjacent daemons, the process table,
//! and anything not on its deny list are still reachable. Secure mode goes the
//! other way: the agent runs inside a Linux container that contains *nothing*
//! of the host except the workspace directory. Full-permission flags
//! (`--dangerously-skip-permissions`, `--yolo`) become safe because the agent
//! cannot reach host processes, credentials, or the filesystem outside the
//! bind-mounted workspace.
//!
//! The workspace mount is read-write, and that includes its `.git` (commits
//! must work), so treat the repo as untrusted on the host after a secure
//! session: an agent could have rewritten any tracked file. The one part of
//! `.git` it CANNOT touch is the hooks directory, which is masked with an
//! empty read-only mount so a jailed agent cannot plant a `post-checkout` /
//! `pre-commit` / etc. that the HOST's git would later execute as the host
//! user. Everything else in the checkout the agent can rewrite freely.
//!
//! What the container gets:
//!   * the pane's workspace directory, bind-mounted read-write at the *same
//!     absolute path* as on the host, so file paths the agent prints match the
//!     host and stay clickable;
//!   * for git worktrees, the main repository too (the worktree's `.git` file
//!     points into it by absolute path — without it every git command fails),
//!     but only once the worktree link is verified genuine and bidirectional,
//!     so a repo can't name an arbitrary host path to get it mounted;
//!   * a per-workspace named volume as `$HOME`, isolated from other
//!     workspaces, so agent logins done once inside the jail persist across
//!     relaunches without leaking one workspace's credentials into another;
//!   * a per-workspace host directory bind-mounted over the jail's
//!     `~/.claude/projects`, so Claude Code's session transcripts land where
//!     the app's readers already look (see [`run_args`]);
//!   * git identity (user.name/email) lifted from the host's `~/.gitconfig`
//!     into env vars — the file itself is NOT mounted (it can reference
//!     credential helpers and includes that leak host paths);
//!   * its own pane's hook log — one file per pane under `~/.flock/hooks.d`,
//!     never the machine-wide `~/.flock/hooks.jsonl` every host pane shares;
//!   * the host API key its own agent needs, and only that one
//!     (see [`passthrough_env`]), sparing an in-container login.
//!
//! What it never gets: SSH keys, keychains, cloud credentials, the host's
//! `~/.flock` (only its own pane's hook log, see [`run_args`]), the host
//! filesystem, host processes.
//!
//! Network egress is the jail's weakest wall and it has two settings. By
//! default it stays open — the agent needs its API, and a coding agent with no
//! registry and no git forge is not a coding agent — so treat the mounted repo
//! as exfiltratable, the same honest caveat as the Seatbelt profile. Turning on
//! the restriction (`~/.flock/egress.json`, Settings → Security) moves the pane
//! onto an internal network with an allowlist proxy as its only route out; see
//! [`crate::egress`] for what that does and does not buy. The security model
//! section of the README is the operator-facing version of both.
//!
//! The image is built locally from the embedded [`DOCKERFILE`] on first spawn
//! (inside the pane, so progress is visible) and tagged with a content hash —
//! editing the Dockerfile automatically triggers a rebuild, no version bumps.

use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Image recipe, embedded so the app is self-contained. The pane's container
/// runs `bash --init-file` which evals `FLOCK_LAUNCH` — the same
/// launch-rides-in-env trick as host panes (see `spawn` in lib.rs), so the
/// agent starts as the first foreground job of an interactive shell and
/// Ctrl+C drops to a *container* prompt, never the host.
pub const DOCKERFILE: &str = r#"FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq less openssh-client procps python3 make g++ \
    ripgrep unzip \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai @earendil-works/pi-coding-agent \
 && npm cache clean --force

# Bind-mounted repos arrive owned by a foreign uid; without this git refuses
# to touch them ("dubious ownership").
RUN git config --system safe.directory '*'

# Hook config generated next to this Dockerfile by write_build_context()
# (mirrors the desktop app's hooks.rs): the agent appends lifecycle events to
# ~/.flock/hooks.jsonl, which run_args() bind-mounts from the HOST — this pane's
# own file under ~/.flock/hooks.d, not the shared log — so the app's watcher
# sees jailed agents and the sidebar status works.
COPY claude-hook-settings.json /etc/flock/claude-hook-settings.json

# The egress allowlist proxy (see the `egress` module). Baked into the same
# image so restricting a jail's network needs no second base image and nothing
# pulled; it only ever runs in its own container, never inside a pane's.
COPY egress-proxy.js /etc/flock/egress-proxy.js

# flock's Claude Code custom themes (one per app theme), written into the
# build context by write_build_context() and copied into the jail's
# ~/.claude/themes by init.bash so an agent's Claude Code UI matches the
# workspace. See the `themes` module.
COPY themes /etc/flock/themes

COPY <<'EOF' /etc/flock/init.bash
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
# Every FLOCK_* var the app exports is still mirrored under its pre-rebrand
# CLARENCE_* name, so read the new name first and fall back. That way dropping
# the mirror a few releases out is a deletion here, not a rewrite.
_flock_pane_id="${FLOCK_PANE_ID:-$CLARENCE_PANE_ID}"
if [ -n "$_flock_pane_id" ]; then
  mkdir -p "$HOME/.flock" "$HOME/.claude"
  if [ ! -s "$HOME/.claude/settings.json" ]; then
    cp /etc/flock/claude-hook-settings.json "$HOME/.claude/settings.json"
  elif ! grep -q flock-managed-hook "$HOME/.claude/settings.json" 2>/dev/null; then
    jq -s '.[0] as $u | .[1] as $f | $u | .hooks = (($u.hooks // {}) + $f.hooks)' \
      "$HOME/.claude/settings.json" /etc/flock/claude-hook-settings.json \
      > "$HOME/.claude/settings.json.new" \
      && mv "$HOME/.claude/settings.json.new" "$HOME/.claude/settings.json" \
      || rm -f "$HOME/.claude/settings.json.new"
  fi
  # Ship flock's Claude Code themes into the jail so /theme lists them.
  # Overwrite our own files so a newer app version's palette propagates; other
  # theme files in the folder are left untouched.
  mkdir -p "$HOME/.claude/themes"
  cp -f /etc/flock/themes/*.json "$HOME/.claude/themes/" 2>/dev/null || true
  # On a fresh home (no theme chosen yet) default Claude Code to the theme
  # matching the workspace, passed in via FLOCK_CLAUDE_THEME. Gated on the
  # absence of a "theme" key so a theme the user later picks is never clobbered.
  _flock_theme="${FLOCK_CLAUDE_THEME:-$CLARENCE_CLAUDE_THEME}"
  if [ -n "$_flock_theme" ] \
     && ! grep -q '"theme"' "$HOME/.claude/settings.json" 2>/dev/null; then
    jq --arg t "$_flock_theme" '.theme = $t' \
      "$HOME/.claude/settings.json" > "$HOME/.claude/settings.json.new" \
      && mv "$HOME/.claude/settings.json.new" "$HOME/.claude/settings.json" \
      || rm -f "$HOME/.claude/settings.json.new"
  fi
  unset _flock_theme
  # One-shot transcript migration. Workspaces jailed before flock mounted
  # ~/.claude/projects out to the host wrote their conversations into the $HOME
  # volume, which that bind-mount now shadows: /resume in the jail would come up
  # empty and the tokens they cost would never be counted. run_args mounts the
  # same volume a second time, read-only, at /mnt/flock-legacy-home — and only
  # until the marker below exists, so this costs one extra mount on one spawn
  # per workspace and nothing afterwards. Best-effort by design: a copy that
  # fails leaves the user exactly where the no-migration option would have, so
  # the marker is written either way rather than retrying on every launch.
  if [ -d /mnt/flock-legacy-home ] \
     && [ ! -e "$HOME/.claude/projects/.flock-transcripts-migrated" ]; then
    if [ -d /mnt/flock-legacy-home/.claude/projects ]; then
      cp -Rn /mnt/flock-legacy-home/.claude/projects/. \
        "$HOME/.claude/projects/" 2>/dev/null
    fi
    touch "$HOME/.claude/projects/.flock-transcripts-migrated" 2>/dev/null
  fi
fi
unset _flock_pane_id
_flock_launch="${FLOCK_LAUNCH:-$CLARENCE_LAUNCH}"
unset FLOCK_LAUNCH CLARENCE_LAUNCH
if [ -n "$_flock_launch" ]; then
  eval "$_flock_launch"
  unset _flock_launch
fi
EOF

# $HOME/.claude MUST exist, owned by node, before the container ever starts.
#
# run_args bind-mounts the workspace's transcript directory at
# $HOME/.claude/projects. Docker creates any missing intermediate directory for
# a mount destination ITSELF, as root — so on a workspace whose $HOME volume is
# fresh, /home/node/.claude was materialised root-owned and the unprivileged
# `node` user could then write nothing inside it. init.bash's `mkdir -p` does
# not help: the directory already exists, so mkdir succeeds and every write
# after it fails. That is three "Permission denied" lines at the top of a jailed
# pane (settings.json, themes/, settings.json.new) and, worse, a Claude Code
# with no settings and no credentials store, which falls back to asking the user
# to log in even when a key was passed in.
#
# Creating it here fixes it because a NAMED VOLUME is initialised from the
# image's contents at its mount point the first time it is used: the volume
# comes up already containing a node-owned .claude/projects, so the bind lands
# on an existing directory and leaves the parent's ownership alone.
#
# Workspaces created before the transcripts mount existed are unaffected either
# way — their volumes got a node-owned .claude from init.bash back when nothing
# was mounted under it. Volumes FIRST USED while the mount existed but before
# this RUN did (0.7.33–0.7.37) are not: a named volume is initialised from the
# image only while empty, so this line cannot reach them. Those are repaired
# host-side by `owner_repair_script` — a one-shot root container per workspace,
# since the pane itself (`node` under --cap-drop ALL, no CAP_CHOWN) cannot fix
# an ownership mistake after the fact.
RUN mkdir -p /home/node/.claude/projects /home/node/.flock \
 && chown -R node:node /home/node/.claude /home/node/.flock

USER node
WORKDIR /workspace
# CLARENCE_CONTAINER is the deprecated mirror of FLOCK_CONTAINER, kept so a
# user's own rc files and scripts that branch on "am I in the jail?" survive
# the rename. Drop it a few releases out.
ENV FLOCK_CONTAINER=1 \
    CLARENCE_CONTAINER=1
CMD ["bash", "--init-file", "/etc/flock/init.bash", "-i"]
"#;

/// Prefix for the per-workspace `$HOME` volume. Each workspace gets its own
/// volume (see [`home_volume`]) so one workspace's stored agent logins and rc
/// files are never visible to another workspace's jail.
const HOME_VOLUME_PREFIX: &str = "flock-sandbox-home";

/// The persistent `$HOME` volume for a given workspace. Derived from the
/// workspace id so the same workspace re-attaches its volume across relaunches
/// (logins persist) while different workspaces stay isolated. The name is a
/// stable, docker-safe string (lowercase hex + dashes).
fn home_volume(workspace_id: &str) -> String {
    format!("{HOME_VOLUME_PREFIX}-{:016x}", fnv1a(workspace_id))
}

/// The jail user's home, fixed by the image (node:22's `node` user).
const CONTAINER_HOME: &str = "/home/node";

/// Prefix for the per-workspace host directory that backs a jail's
/// `~/.claude/projects`. Public because the desktop app's transcript readers
/// have to recognise these directories: everything under one of them sits a
/// level deeper than a host session does (`<root>/<slug>/<session>.jsonl`),
/// because it is the whole `projects` directory that is remapped, not one
/// project. See [`secure_transcripts_name`].
pub const SECURE_TRANSCRIPTS_PREFIX: &str = "flock-secure";

/// Marker written inside a workspace's transcript directory by the image's
/// init script once the legacy in-volume transcripts have been copied out.
/// Its presence is what stops [`run_args`] from mounting the `$HOME` volume a
/// second time; the same literal appears in [`DOCKERFILE`] and a test pins the
/// two together.
const TRANSCRIPTS_MIGRATED_MARKER: &str = ".flock-transcripts-migrated";

/// Where the pre-mount transcripts are exposed for that one-shot copy.
/// Mirrored in [`DOCKERFILE`]; pinned by the same test.
const LEGACY_HOME_MOUNT: &str = "/mnt/flock-legacy-home";

/// Name of the host directory holding one secure workspace's Claude Code
/// transcripts. Per-workspace for the same reason [`home_volume`] is: a jailed
/// agent can read everything mounted into it, and a transcript is a verbatim
/// record of another repo's source. Derived from the same fnv1a of the
/// workspace id, so the pairing survives relaunches.
pub fn secure_transcripts_name(workspace_id: &str) -> String {
    format!("{SECURE_TRANSCRIPTS_PREFIX}-{:016x}", fnv1a(workspace_id))
}

/// The host path of that directory. It lives *inside* `~/.claude/projects`
/// rather than under `~/.flock` so that both readers keep working with no
/// second scan root to remember: `claude_code_usage` already walks everything
/// under `projects/` recursively, and `claude_context` only has to look one
/// level further down. Nothing else in `~/.claude` — credentials, settings,
/// other projects' transcripts — is reachable from the jail; the mount is this
/// one directory, which flock creates for it.
fn secure_transcripts_dir(workspace_id: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(
        Path::new(&home)
            .join(".claude")
            .join("projects")
            .join(secure_transcripts_name(workspace_id)),
    )
}

/// Marker on the host (inside [`secure_transcripts_dir`]) recording that the
/// workspace's `$HOME` volume has had its ownership repaired — see
/// [`owner_repair_script`]. Host-side so the check costs a `stat`, not a
/// container start, on every later spawn. The jail can write the directory it
/// sits in, but the worst a hostile agent gets from touching or deleting it is
/// a skipped or repeated `chown node:node` — a repair it wants anyway.
const OWNER_REPAIRED_MARKER: &str = ".flock-owner-repaired";

/// One-shot repair for `$HOME` volumes first used under 0.7.33–0.7.37.
///
/// In that window `run_args` mounted the transcripts directory at
/// `~/.claude/projects` before the image pre-created it, so on a fresh volume
/// Docker materialised `/home/node/.claude` (and `.flock`, for the hook-log
/// mount) as root. The image `RUN mkdir … && chown` added since only helps
/// volumes that do not exist yet — a named volume is initialised from the
/// image exactly once, when it is empty — so those workspaces stayed broken
/// across upgrades: settings, themes and the credentials store all
/// permission-denied, forever, invisibly.
///
/// The pane itself cannot fix it (`node` under `--cap-drop ALL` has no
/// CAP_CHOWN), but the host can: one throwaway root container per workspace,
/// spliced into the pane script after the image is ensured and before the
/// exec. Best-effort — the marker is only written when the chown succeeded,
/// so a daemon hiccup retries on the next spawn, and a failure leaves the
/// user exactly where doing nothing would have.
pub fn owner_repair_script(docker: &Path, image: &str, workspace_id: &str) -> String {
    let Some(dir) = secure_transcripts_dir(workspace_id) else {
        return String::new();
    };
    let marker = dir.join(OWNER_REPAIRED_MARKER);
    if marker.exists() {
        return String::new();
    }
    let _ = std::fs::create_dir_all(&dir);
    let dq = crate::shell_quote(&docker.to_string_lossy());
    let iq = crate::shell_quote(image);
    let vol = crate::shell_quote(&format!("{}:{CONTAINER_HOME}", home_volume(workspace_id)));
    let mq = crate::shell_quote(&marker.to_string_lossy());
    // The inner `|| true` scopes to the chown: a path missing from an old
    // volume must not block the marker, while a daemon that could not run the
    // container at all still exits non-zero and retries on the next spawn.
    format!(
        "{dq} run --rm -u root -v {vol} {iq} \
           sh -c 'chown -R node:node {CONTAINER_HOME}/.claude {CONTAINER_HOME}/.flock 2>/dev/null || true' \
           >/dev/null 2>&1 && touch {mq} 2>/dev/null; "
    )
}

/// Lifecycle events the in-jail Claude Code hooks report. Must stay in sync
/// with the host-side hook installer (desktop `hooks.rs` EVENTS) — the
/// frontend maps exactly these onto pane statuses.
const HOOK_EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "Stop", "Notification"];

/// Claude Code hook config installed inside the jail by the image's init
/// script (same command shape as desktop `hooks.rs::hook_command`). Each hook
/// appends a JSON line to `~/.flock/hooks.jsonl`; [`run_args`] bind-mounts
/// that path from the host, so the app's watcher tails jailed agents exactly
/// like host ones. Without this every jailed pane reads "idle" forever.
///
/// The pane id is read as `${FLOCK_PANE_ID:-$CLARENCE_PANE_ID}` because this
/// settings file outlives the app version that wrote it: it is merged into a
/// persistent per-workspace `$HOME` volume, so it has to keep working while
/// both names are exported and after the legacy one is dropped.
fn claude_hook_settings() -> String {
    let mut hooks = serde_json::Map::new();
    for event in HOOK_EVENTS {
        // Notification also forwards its `message`, exactly as the host
        // installer does: it is the only way to tell "Claude needs your
        // permission…" (a real block) from the idle nudge Claude Code fires 60
        // seconds after any quiet agent. See desktop `hooks.rs::hook_body` —
        // the classifier reading these lines is shared by both paths.
        let capture_message = if *event == "Notification" {
            "_m=$(cat | tr -d \"\\n\" | sed -n \"s/.*\\\"message\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p\" | tr -d \"\\\\\\\\\"); "
        } else {
            ""
        };
        let message_field = if *event == "Notification" { ",\\\"message\\\":\\\"$_m\\\"" } else { "" };
        let command = format!(
            "sh -c '_p=\"${{FLOCK_PANE_ID:-$CLARENCE_PANE_ID}}\"; [ -n \"$_p\" ] || exit 0; {capture_message}printf \"%s\\n\" \"{{\\\"time\\\":$(date +%s),\\\"agent\\\":\\\"claude\\\",\\\"event\\\":\\\"{event}\\\",\\\"pane_id\\\":\\\"$_p\\\"{message_field}}}\"' >> ~/.flock/hooks.jsonl; true # flock-managed-hook"
        );
        hooks.insert(
            event.to_string(),
            serde_json::json!([{ "hooks": [{ "type": "command", "command": command }] }]),
        );
    }
    serde_json::to_string_pretty(&serde_json::json!({ "hooks": hooks }))
        .expect("static hook settings always serialize")
}

/// The host's shared data directory — `~/.flock`, or `~/.clarence` when the
/// migration failed.
///
/// This crate cannot call `paths::shared_data_dir()`: `flock-core` depends on
/// `flock-pty`, so the arrow only goes one way. Inventing `$HOME/.flock` here
/// is the bug that strands a failed migration: the first `create_dir_all` of
/// `sandbox/` makes `resolve_dir` treat `~/.flock` as finished and leave the
/// real workspaces, token and graph under the old name.
///
/// Call [`set_shared_dir`] once after `shared_data_dir()` and before any
/// container path is created. `flock-core` does that inside the resolver.
static SHARED_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Inject the directory `shared_data_dir()` resolved. Idempotent: the first
/// call wins, so a late caller cannot point hook logs and the build context
/// at a different tree than the rest of the process.
pub fn set_shared_dir(dir: impl Into<PathBuf>) {
    let _ = SHARED_DIR.set(dir.into());
}

pub(crate) fn host_flock_dir() -> Option<PathBuf> {
    if let Some(dir) = SHARED_DIR.get() {
        return Some(dir.clone());
    }
    #[cfg(test)]
    {
        Some(SHARED_DIR.get_or_init(test_shared_dir).clone())
    }
    #[cfg(not(test))]
    None
}

#[cfg(test)]
fn test_shared_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("flock-pty-test-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Directory of per-pane hook logs written by jailed agents. Mirrored in the
/// desktop app's watcher, which tails every file in it.
pub const JAIL_HOOKS_DIR: &str = "hooks.d";

/// Host-side path of the hook event log for ONE jailed pane.
///
/// Every host pane appends to the single shared `~/.flock/hooks.jsonl`, and a
/// jail used to have that same file bind-mounted in, read-write. That handed
/// each jailed agent the machine's whole lifecycle feed: every other pane's id
/// and every `Notification` message, from workspaces it has nothing to do with
/// and from unjailed host sessions — plus a write handle to forge status events
/// for those panes, or to truncate the file the app's own status depends on.
///
/// So each jailed pane gets its own file instead, named after the pane and
/// mounted at the path the in-jail hook writes. It can still write whatever it
/// likes about *itself* — it is the agent, that is the point of the channel —
/// but it cannot read another pane's events and cannot speak for one: the
/// watcher rejects any line whose `pane_id` is not the file's own name.
fn host_pane_hooks_log(pane_id: &str) -> Option<PathBuf> {
    // The pane id reaches this from IPC. It becomes a filename, so strip it to
    // the character class a uuid uses — a `../` here would put the mount, and
    // whatever the jail writes into it, anywhere under $HOME.
    let safe: String = pane_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    if safe.is_empty() {
        return None;
    }
    Some(host_flock_dir()?.join(JAIL_HOOKS_DIR).join(format!("{safe}.jsonl")))
}

/// Host API keys forwarded into the container when set, so an API-key user
/// never sees an in-container login prompt.
///
/// Scoped to the agent that needs them. These are the *host user's* keys, live
/// billing credentials, and the jail can read its own environment — so a codex
/// pane used to be handed the Anthropic key and a claude pane the OpenAI one,
/// for nothing. Neither the jail's `$HOME` volume nor its transcripts are
/// shared across workspaces, but the environment was shared across agents.
///
/// opencode and pi are provider-agnostic (the user points them at whichever
/// model they pay for), so they still get both; narrowing those would mean
/// reading their config, and a pane that silently cannot reach its model is a
/// worse failure than a key one process wide.
fn passthrough_env(agent: &str) -> &'static [&'static str] {
    match agent {
        "claude" => &CLAUDE_ENV,
        "codex" => &CODEX_ENV,
        _ => &AGNOSTIC_ENV,
    }
}

/// A KEY ON ITS OWN IS NOT A CREDENTIAL WHEN THE ENDPOINT IS NOT ANTHROPIC.
///
/// Forwarding only `ANTHROPIC_API_KEY` works for someone billing Anthropic
/// directly and fails silently for everyone behind a gateway: the endpoint
/// lives in `ANTHROPIC_BASE_URL`, and gateways typically authenticate with
/// `ANTHROPIC_AUTH_TOKEN` (a bearer token) rather than an API key at all. A
/// jailed pane therefore came up with no usable credentials and did the only
/// thing left to it, which was to ask the user to log in — on a machine where
/// they had already configured one.
///
/// These are still the host user's live billing credentials and the jail can
/// read its own environment, so the list stays scoped per agent for the same
/// reason it was scoped in the first place.
///
/// Note for anyone adding to this: an `ANTHROPIC_BASE_URL` pointing at a
/// gateway is a hostname the egress allowlist has never heard of. With egress
/// control on (off by default) a restricted pane will reach the proxy and be
/// refused, which reads as the gateway being down. That belongs in the
/// allowlist, not here.
const CLAUDE_ENV: [&str; 5] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL",
];

const CODEX_ENV: [&str; 3] = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"];

/// opencode and pi are provider-agnostic (the user points them at whichever
/// model they pay for), so they get both families.
const AGNOSTIC_ENV: [&str; 8] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
];

/// Where `docker` hides when the app is launched from Finder and inherits the
/// bare system PATH.
const DOCKER_CANDIDATES: &[&str] = &[
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
];

/// Locate the docker CLI: $PATH first, then the usual install locations.
pub fn docker_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = Path::new(dir).join("docker");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    for candidate in DOCKER_CANDIDATES {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Content-addressed tag: editing [`DOCKERFILE`], the generated hook config,
/// any bundled theme, or the egress proxy changes the tag, so the next secure
/// spawn builds the new image instead of reusing a stale one. The proxy has to
/// be in the hash even though it never runs inside a pane — it is baked into
/// this same image, and a stale copy of it is a stale allowlist enforcer.
pub fn image_tag() -> String {
    let content = format!(
        "{DOCKERFILE}\n{}\n{}\n{}",
        claude_hook_settings(),
        crate::themes::fingerprint(),
        crate::egress::PROXY_SCRIPT,
    );
    format!("flock-sandbox:{:08x}", fnv1a(&content) as u32)
}

pub(crate) fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Docker-safe container name derived from the pane id.
pub fn container_name(pane_id: &str) -> String {
    let safe: String = pane_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(24)
        .collect();
    format!("flock-{safe}")
}

/// Runtime readiness snapshot for the UI (New Workspace dialog). Blocking —
/// call from a blocking task, not the async runtime directly.
#[derive(Debug, Clone)]
pub struct Status {
    pub available: bool,
    pub daemon_running: bool,
    pub image_ready: bool,
    pub image_tag: String,
}

pub fn status() -> Status {
    let tag = image_tag();
    let Some(docker) = docker_path() else {
        return Status { available: false, daemon_running: false, image_ready: false, image_tag: tag };
    };
    let daemon_running = std::process::Command::new(&docker)
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let image_ready = daemon_running
        && std::process::Command::new(&docker)
            .args(["image", "inspect", &tag])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    Status { available: true, daemon_running, image_ready, image_tag: tag }
}

/// Write the embedded Dockerfile and the generated hook config to
/// `~/.flock/sandbox/` (the build context) and return that directory.
/// Idempotent; called on every secure spawn so the on-disk copies always
/// match the binary.
pub fn write_build_context() -> Result<PathBuf> {
    // Lands under the injected shared dir, never a hand-built `$HOME/.flock`
    // that would look like a finished migration.
    let dir = host_flock_dir()
        .ok_or_else(|| anyhow::anyhow!("shared data dir not set"))?
        .join("sandbox");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("Dockerfile"), DOCKERFILE)?;
    std::fs::write(dir.join("claude-hook-settings.json"), claude_hook_settings())?;
    std::fs::write(dir.join("egress-proxy.js"), crate::egress::PROXY_SCRIPT)?;
    crate::themes::write_into_build_context(&dir)?;
    Ok(dir)
}

/// A persistent, empty directory used as the read-only source that masks a
/// repo's git hooks dir inside the jail (see [`run_args`]). Bind-mounting this
/// over `<repo>/.git/hooks` means a jailed agent cannot create or modify any
/// hook file, so nothing it writes can be executed by the HOST's git on the
/// user's next git operation. Kept empty and reused across spawns.
fn empty_hooks_dir() -> Option<PathBuf> {
    let dir = host_flock_dir()?.join("sandbox").join("empty-hooks");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Parse a worktree `.git` file's `gitdir:` line into `(main_repo, admin_dir)`,
/// where `admin_dir` is `<main>/.git/worktrees/<name>` and `main_repo` is the
/// `<main>` the worktree belongs to. Pure string parsing with a shape check;
/// it does NOT establish that the link is real — [`worktree_main_repo`] must
/// still verify the reciprocal file before the path is trusted for a mount.
fn parse_worktree_gitdir(contents: &str) -> Option<(PathBuf, PathBuf)> {
    let gitdir = contents.strip_prefix("gitdir:")?.trim();
    let admin_dir = Path::new(gitdir); // …/.git/worktrees/<name>
    let worktrees_dir = admin_dir.parent()?; // …/.git/worktrees
    let git_dir = worktrees_dir.parent()?; // …/.git
    if git_dir.file_name()? != ".git" || worktrees_dir.file_name()? != "worktrees" {
        return None;
    }
    Some((git_dir.parent()?.to_path_buf(), admin_dir.to_path_buf()))
}

/// True for the filesystem root or the user's `$HOME` itself — paths we must
/// never bind-mount into a jail no matter what a repo's `.git` file claims.
fn is_root_or_home(path: &Path) -> bool {
    if path == Path::new("/") {
        return true;
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            let home = Path::new(&home);
            if path == home || path.canonicalize().ok() == home.canonicalize().ok() {
                return true;
            }
        }
    }
    false
}

/// For a git *worktree* checkout, the main repository root it belongs to.
///
/// A worktree's `.git` is a file containing `gitdir: <main>/.git/worktrees/<x>`;
/// git resolves that absolute path on every command, so the main repo must be
/// mounted too or the pane is unusable.
///
/// The path in that `gitdir:` line is attacker-controlled: a malicious repo can
/// ship a `.git` file pointing anywhere (e.g. `gitdir: /Users/victim/.git/…`)
/// to trick us into bind-mounting the victim's home read-write. So we do NOT
/// trust it on shape alone. A genuine worktree is bidirectional: the main repo
/// holds `<main>/.git/worktrees/<name>/gitdir` whose contents point back at
/// THIS checkout's `.git` file. An attacker who controls only the workspace
/// cannot forge that reciprocal file inside the victim's home, so we require it
/// to exist and resolve back to `<cwd>/.git` (or `<cwd>`); otherwise we mount
/// nothing. As a hard backstop we also refuse to return `/` or `$HOME`.
pub fn worktree_main_repo(cwd: &Path) -> Option<PathBuf> {
    let dotgit = cwd.join(".git");
    if !dotgit.is_file() {
        return None;
    }
    let contents = std::fs::read_to_string(&dotgit).ok()?;
    let (main, admin_dir) = parse_worktree_gitdir(&contents)?;

    // Reciprocal-link check: the admin dir's own `gitdir` file must name this
    // workspace's `.git` file. Compare canonically so symlinks/`..` can't slip
    // a mismatch through.
    let back = std::fs::read_to_string(admin_dir.join("gitdir")).ok()?;
    let back = PathBuf::from(back.trim());
    let back_canon = back.canonicalize().ok()?;
    let points_back = back_canon == dotgit.canonicalize().ok()?
        || Some(&back_canon) == cwd.canonicalize().ok().as_ref();
    if !points_back {
        return None;
    }

    let main = main.canonicalize().ok()?;
    if is_root_or_home(&main) {
        return None;
    }
    Some(main)
}

/// Git identity from the host's `~/.gitconfig`, exported as
/// GIT_AUTHOR/COMMITTER env so in-container commits are attributed correctly
/// without mounting the config file itself (it can name credential helpers
/// and include paths that don't exist in the jail).
fn host_git_identity() -> Vec<(String, String)> {
    let Ok(home) = std::env::var("HOME") else { return vec![] };
    let Ok(cfg) = std::fs::read_to_string(Path::new(&home).join(".gitconfig")) else {
        return vec![];
    };
    let (mut name, mut email) = (None, None);
    let mut in_user = false;
    for line in cfg.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_user = line == "[user]";
            continue;
        }
        if !in_user {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "name" => name = Some(v.trim().to_string()),
                "email" => email = Some(v.trim().to_string()),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    if let Some(n) = name {
        out.push(("GIT_AUTHOR_NAME".into(), n.clone()));
        out.push(("GIT_COMMITTER_NAME".into(), n));
    }
    if let Some(e) = email {
        out.push(("GIT_AUTHOR_EMAIL".into(), e.clone()));
        out.push(("GIT_COMMITTER_EMAIL".into(), e));
    }
    out
}

/// Everything [`run_args`] needs about the pane being jailed. A struct rather
/// than eight positional parameters because two of them (`workspace_id`,
/// `pane_id`) are opaque strings of the same shape, and swapping them silently
/// crosses one workspace's `$HOME` volume with another's.
pub struct RunSpec<'a> {
    /// Container name, from [`container_name`].
    pub name: &'a str,
    pub image: &'a str,
    /// The agent binary this pane runs (`claude`, `codex`, …). Decides which
    /// host API keys are forwarded — see [`passthrough_env`].
    pub agent: &'a str,
    pub cwd: Option<&'a Path>,
    /// The agent command line the in-container bash will eval (rides in via
    /// `-e FLOCK_LAUNCH`, immune to tty line limits).
    pub launch: &'a str,
    pub extra_env: &'a [(&'a str, &'a str)],
    /// Selects the per-workspace `$HOME` volume, transcript directory and —
    /// when restricted — the network and egress proxy.
    pub workspace_id: &'a str,
    /// Selects this pane's own hook log. See [`host_pane_hooks_log`].
    pub pane_id: &'a str,
    /// Whether this pane's network is restricted to the allowlist.
    pub egress: crate::egress::Egress,
}

/// Applied to every secure-pane container so leftovers can be found after a
/// force-quit. `PtyHandle::kill` is the only live-path `docker rm -f`, and
/// `--rm` only fires when the container itself exits.
pub const SECURE_PANE_LABEL: &str = "flock.secure-pane=1";

/// Host pid of the flock process that started the jail. See [`run_args`].
const OWNER_PID_KEY: &str = "flock.owner-pid";

/// Assemble the full `docker run` argument vector for a secure pane.
pub fn run_args(spec: &RunSpec) -> Vec<String> {
    let RunSpec { name, image, agent, cwd, launch, extra_env, workspace_id, pane_id, egress } = *spec;
    let mut a: Vec<String> = vec![
        "run".into(),
        "--rm".into(),
        "-it".into(),
        "--init".into(),
        "--name".into(),
        name.into(),
        "--hostname".into(),
        "flock-sandbox".into(),
        "--label".into(),
        SECURE_PANE_LABEL.into(),
        // Host pid of the flock that started this jail. Startup reap uses it
        // to leave another instance's live panes alone; `--rm` does not fire
        // when the docker *client* is killed, so leftovers are otherwise
        // indistinguishable from a neighbour's running jail.
        "--label".into(),
        format!("{OWNER_PID_KEY}={}", std::process::id()),
        // The jail proper: no capabilities, no privilege re-escalation, and a
        // pid ceiling so a runaway agent can't fork-bomb the VM.
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges".into(),
        "--pids-limit".into(),
        "4096".into(),
        "-v".into(),
        format!("{}:{CONTAINER_HOME}", home_volume(workspace_id)),
        "-e".into(),
        "TERM=xterm-256color".into(),
    ];
    // Network. Restricted panes go on the workspace's internal network, whose
    // only other member is the allowlist proxy the env below points at; the
    // pane script has already brought both up and refused to launch if it
    // could not (see `egress::ensure_script`). Open panes keep the default
    // bridge, which reaches the internet, the LAN, and — Docker Desktop
    // injects the name into every container — services bound to 127.0.0.1 on
    // the host. The README's security model says so in as many words.
    if egress == crate::egress::Egress::Restricted {
        a.push("--network".into());
        a.push(crate::egress::network_name(workspace_id));
        for (k, v) in crate::egress::proxy_env(workspace_id) {
            a.push("-e".into());
            a.push(format!("{k}={v}"));
        }
    }
    // Status bridge: the jail's hooks append lifecycle events to
    // ~/.flock/hooks.jsonl *inside the container*, which is this pane's own
    // file on the host — not the machine-wide log every host pane shares. See
    // `host_pane_hooks_log` for why that distinction is the fix and not a
    // detail. Pre-create the host file: docker materializes a missing bind
    // source as a directory, and a directory mounted over the log leaves the
    // pane reading "idle" forever.
    if let Some(log) = host_pane_hooks_log(pane_id) {
        if let Some(dir) = log.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log);
        if log.is_file() {
            a.push("-v".into());
            a.push(format!("{}:{CONTAINER_HOME}/.flock/hooks.jsonl", log.display()));
        }
    }
    // Telemetry bridge: Claude Code's session transcripts. Without this they
    // are written into the $HOME volume and never seen again — the pane's
    // context meter stays blank and the jail's token spend is missing from the
    // usage totals, so secure mode reads as the second-class option precisely
    // where it is meant to be the strongest one. A per-workspace host
    // directory mounted over the jail's ~/.claude/projects puts them where
    // `claude_context.rs` and `claude_code_usage.rs` already look.
    //
    // The new attack surface is one directory, created by flock and named from
    // a hash of the workspace id: the jail gets write access to it and to
    // nothing else in ~/.claude (no credentials, no settings, no other
    // workspace's or host session's transcripts). What flows back is
    // agent-authored JSON that the app parses, so a hostile agent can inflate
    // its own reported token spend — a counter it could already move by
    // spending the tokens for real, and not a path out of the jail.
    //
    // Pre-created on the host: docker materializes a missing bind source as a
    // root-owned directory, which the jail's unprivileged `node` user then
    // cannot write to.
    if let Some(dir) = secure_transcripts_dir(workspace_id) {
        let _ = std::fs::create_dir_all(&dir);
        if dir.is_dir() {
            // Layered inside the $HOME volume mount above. Docker mounts by
            // destination depth, so the volume lands first and this is applied
            // on top of it; the rest of $HOME (agent logins, rc files) stays on
            // the volume.
            a.push("-v".into());
            a.push(format!("{}:{CONTAINER_HOME}/.claude/projects", dir.display()));
            // Until the one-shot copy has run for this workspace, expose the
            // volume's shadowed transcripts read-only so the image's init
            // script can lift them onto the host. See the migration block in
            // DOCKERFILE.
            if !dir.join(TRANSCRIPTS_MIGRATED_MARKER).exists() {
                a.push("-v".into());
                a.push(format!("{}:{LEGACY_HOME_MOUNT}:ro", home_volume(workspace_id)));
            }
        }
    }
    if let Some(dir) = cwd {
        let d = dir.to_string_lossy();
        a.push("-v".into());
        a.push(format!("{d}:{d}"));
        a.push("-w".into());
        a.push(d.into_owned());

        // For a git worktree, its main repo must be mounted too (git resolves
        // the worktree's `.git` gitdir into it). Validated as a genuine,
        // bidirectional worktree so a repo can't name an arbitrary host path.
        let main = worktree_main_repo(dir);
        if let Some(m) = &main {
            let m = m.to_string_lossy();
            a.push("-v".into());
            a.push(format!("{m}:{m}"));
        }

        // Mask every git hooks directory the HOST would execute with an empty
        // read-only mount, so a jailed agent cannot plant a hook (post-checkout,
        // pre-commit, …) that the host's git runs as the host user on the next
        // git operation. These layer ON TOP of the writable repo/main mounts
        // above, so they must be appended after them; the rest of `.git` stays
        // writable so commits still work. Covers both the normal-repo layout
        // (`<cwd>/.git/hooks`) and the worktree layout (shared hooks under the
        // validated `<main>/.git/hooks`).
        if let Some(empty) = empty_hooks_dir() {
            let empty = empty.to_string_lossy();
            let mut hook_dirs: Vec<PathBuf> = Vec::new();
            if dir.join(".git").is_dir() {
                hook_dirs.push(dir.join(".git").join("hooks"));
            }
            if let Some(m) = &main {
                hook_dirs.push(m.join(".git").join("hooks"));
            }
            for hd in hook_dirs {
                a.push("-v".into());
                a.push(format!("{}:{}:ro", empty, hd.display()));
            }
        }
    }
    // Caller env first. Docker's last `-e` wins, so identity and launch must
    // come after anything the webview (or a confused caller) stuffed in here.
    for (k, v) in extra_env {
        if is_launch_key(k) {
            continue;
        }
        a.push("-e".into());
        a.push(format!("{k}={v}"));
    }
    // Pane/workspace identity is this spec's, not extra_env's. A caller
    // FLOCK_PANE_ID would otherwise increment someone else's provenance.
    a.push("-e".into());
    a.push(format!("FLOCK_PANE_ID={pane_id}"));
    a.push("-e".into());
    a.push(format!("CLARENCE_PANE_ID={pane_id}"));
    a.push("-e".into());
    a.push(format!("FLOCK_WORKSPACE_ID={workspace_id}"));
    a.push("-e".into());
    a.push(format!("CLARENCE_WORKSPACE_ID={workspace_id}"));
    for (k, v) in host_git_identity() {
        a.push("-e".into());
        a.push(format!("{k}={v}"));
    }
    for key in passthrough_env(agent) {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                a.push("-e".into());
                a.push(format!("{key}={v}"));
            }
        }
    }
    // Last `-e` wins. Host spawn already sets FLOCK_LAUNCH after extra_env;
    // the jail path used to invert that and eval a caller FLOCK_LAUNCH.
    a.push("-e".into());
    a.push(format!("FLOCK_LAUNCH={launch}"));
    // Deprecated mirror, kept for the same reason as ENV CLARENCE_CONTAINER
    // in the image: a user's own rc files inside the persistent $HOME volume
    // may branch on the pre-rebrand name. init.bash reads FLOCK_LAUNCH first
    // and unsets both. Drop this pair a few releases out.
    a.push("-e".into());
    a.push(format!("CLARENCE_LAUNCH={launch}"));
    a.push(image.into());
    a
}

fn is_launch_key(k: &str) -> bool {
    k.eq_ignore_ascii_case("FLOCK_LAUNCH") || k.eq_ignore_ascii_case("CLARENCE_LAUNCH")
}

/// `docker ps` argv that lists leftover secure-pane containers. The filter
/// string is the spawn `--label`, so a rename in one place cannot silently
/// miss the other.
pub fn orphan_pane_list_args() -> [String; 4] {
    [
        "ps".into(),
        "-aq".into(),
        "--filter".into(),
        format!("label={SECURE_PANE_LABEL}"),
    ]
}

/// Remove leftover secure-pane containers from a previous run.
///
/// `--rm` removes a container when *it* exits, not when the docker client is
/// killed, so a force-quit leaves the jail running. Restore then mints a new
/// pane id and starts a second agent on the same bind-mount and `$HOME`
/// volume. Only collects jails whose owner process is gone, so a second
/// flock's live panes (and a spawn that raced this reap) stay up.
///
/// Blocking; call from a blocking task. Best-effort: a docker that is not
/// running simply leaves the containers for the next launch.
pub fn reap_orphan_panes(docker: &Path) {
    reap_secure_panes(docker, false);
}

/// Same as [`reap_orphan_panes`], but also removes jails this process owns.
/// Best-effort on the way out: once we exit, our live jails become leftovers.
pub fn reap_owned_panes(docker: &Path) {
    reap_secure_panes(docker, true);
}

fn reap_secure_panes(docker: &Path, reap_ours: bool) {
    let run = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new(docker).args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let list_args = orphan_pane_list_args();
    let list_args = [
        list_args[0].as_str(),
        list_args[1].as_str(),
        list_args[2].as_str(),
        list_args[3].as_str(),
    ];
    let Some(list) = run(&list_args) else {
        return;
    };
    let us = std::process::id();
    let owner_fmt = format!("{{{{index .Config.Labels \"{OWNER_PID_KEY}\"}}}}");
    for id in list.lines().filter(|l| !l.trim().is_empty()) {
        // A failed inspect is not "no owner" — removing on it would kill a
        // neighbour's jail whose label we simply could not read.
        let Some(raw) = run(&["inspect", "-f", &owner_fmt, id]) else {
            continue;
        };
        let owner = raw.parse::<u32>().ok();
        let owner_alive = owner.map(pid_is_alive).unwrap_or(false);
        if !should_reap_secure_pane(owner, us, owner_alive, reap_ours) {
            continue;
        }
        let _ = run(&["rm", "-f", id]);
    }
}

/// Whether a listed secure-pane container should be `docker rm -f`'d.
///
/// A live owner that is not us is another flock's jail. A live owner that
/// *is* us is a pane this process still has (or just spawned); those are
/// only collected on the way out (`reap_ours`). A missing or unparseable
/// owner is treated like a failed inspect: skip. Pre-label leftovers
/// (0.7.39 and earlier have the pane label but no owner pid) cannot be
/// told from a neighbour flock that has not upgraded yet.
///
/// Pids are recycled, so across a reboot a leftover's owner number can name
/// some unrelated live process and the jail is left standing. That is the
/// direction this errs in everywhere: a leftover costs memory until the next
/// launch that happens to see the pid free, whereas reaping a neighbour's jail
/// kills a running agent mid-task. `docker rm -f` from the pane's own
/// `PtyHandle::kill` remains the path that removes almost all of them.
pub(crate) fn should_reap_secure_pane(
    owner: Option<u32>,
    us: u32,
    owner_alive: bool,
    reap_ours: bool,
) -> bool {
    match owner {
        None => false,
        Some(pid) if owner_alive && pid != us => false,
        Some(pid) if owner_alive && pid == us && !reap_ours => false,
        Some(_) => true,
    }
}

#[cfg(unix)]
pub(crate) fn pid_is_alive(pid: u32) -> bool {
    // kill(0, …) is the process group; kill(-1, …) is every process we may
    // signal. u32::MAX as i32 is -1. Neither is a pid.
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    // EPERM: the pid exists but we cannot signal it. Treat as live — reaping
    // another user's jail is worse than leaving a leftover.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn pid_is_alive(_pid: u32) -> bool {
    false
}

/// The `sh -c` script that is the pane's actual PTY child: verify the daemon,
/// build the image if this Dockerfile revision hasn't been built yet (visibly,
/// inside the pane), bring up the egress network and proxy when the pane is
/// restricted, then exec docker with the full [`run_args`] vector (which
/// already begins with the `run` subcommand). `exec` keeps the docker client
/// as the process-group member `PtyHandle::kill` signals.
///
/// `egress_prelude` is spliced in after the build and before the exec. Its
/// egress half exits non-zero on every failure branch rather than continuing:
/// a restricted pane that could not get its proxy must not fall through to a
/// `docker run` whose `--network` is the default bridge. The ownership-repair
/// half ([`owner_repair_script`]) that may precede it is best-effort and never
/// blocks the launch.
pub fn build_pane_script(
    docker: &Path,
    image: &str,
    context_dir: &Path,
    run_args: &[String],
    egress_prelude: &str,
) -> String {
    let dq = crate::shell_quote(&docker.to_string_lossy());
    let iq = crate::shell_quote(image);
    let cq = crate::shell_quote(&context_dir.to_string_lossy());
    let run = run_args
        .iter()
        .map(|s| crate::shell_quote(s))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "if ! {dq} version --format x >/dev/null 2>&1; then \
           printf 'flock secure mode: the Docker daemon is not running.\\n\
Start Docker Desktop and reopen this pane.\\n'; exit 1; fi; \
         if ! {dq} image inspect {iq} >/dev/null 2>&1; then \
           printf 'flock secure mode: building the sandbox image (first run only, a few minutes)...\\n\\n'; \
           {dq} build -t {iq} {cq} || {{ printf '\\nSandbox image build failed; the agent was not started.\\n'; exit 1; }}; \
           clear; fi; \
         {egress_prelude}\
         exec {dq} {run}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_tag_is_content_addressed() {
        let tag = image_tag();
        assert!(tag.starts_with("flock-sandbox:"));
        assert_eq!(tag.len(), "flock-sandbox:".len() + 8);
    }

    #[test]
    fn worktree_gitdir_parses_shape() {
        let (main, admin) =
            parse_worktree_gitdir("gitdir: /Users/x/git/repo/.git/worktrees/agent-1\n").unwrap();
        assert_eq!(main, PathBuf::from("/Users/x/git/repo"));
        assert_eq!(admin, PathBuf::from("/Users/x/git/repo/.git/worktrees/agent-1"));
        // A regular checkout's .git is a directory, not a file — but even a
        // file with a non-worktree gitdir must not parse to a bogus main repo.
        assert!(parse_worktree_gitdir("gitdir: /somewhere/else\n").is_none());
    }

    #[test]
    fn worktree_main_repo_requires_reciprocal_link() {
        // Build a genuine worktree layout in a temp dir and confirm it resolves,
        // then a forged one (attacker-controlled gitdir with no reciprocal
        // `gitdir` file pointing back) and confirm it is refused.
        let base = std::env::temp_dir().join(format!(
            "flock-wt-test-{}-{}",
            std::process::id(),
            fnv1a(&format!("{:?}", std::time::SystemTime::now()))
        ));
        let main = base.join("repo");
        let wt = base.join("wt");
        let admin = main.join(".git").join("worktrees").join("agent-1");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::create_dir_all(&wt).unwrap();

        // The worktree's .git file points at the admin dir…
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", admin.display()),
        )
        .unwrap();
        // …and, for a genuine worktree, the admin dir points back at it.
        std::fs::write(admin.join("gitdir"), format!("{}\n", wt.join(".git").display())).unwrap();
        assert_eq!(
            worktree_main_repo(&wt).map(|p| p.canonicalize().unwrap()),
            Some(main.canonicalize().unwrap())
        );

        // Now forge a workspace whose .git names the victim's repo but with no
        // reciprocal file: it must resolve to nothing.
        let evil = base.join("evil");
        std::fs::create_dir_all(&evil).unwrap();
        let victim_admin = main.join(".git").join("worktrees").join("nonexistent");
        std::fs::write(
            evil.join(".git"),
            format!("gitdir: {}\n", victim_admin.display()),
        )
        .unwrap();
        assert_eq!(worktree_main_repo(&evil), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A [`RunSpec`] with the fields a test does not care about filled in, so
    /// each test below states only what it is about.
    fn spec<'a>(workspace_id: &'a str, pane_id: &'a str, egress: crate::egress::Egress) -> RunSpec<'a> {
        RunSpec {
            name: "flock-abc",
            image: "img",
            agent: "claude",
            cwd: None,
            launch: "claude",
            extra_env: &[],
            workspace_id,
            pane_id,
            egress,
        }
    }

    /// Docker's last `-e` wins. A caller FLOCK_LAUNCH used to ride in via
    /// extra_env after the real one and become the jail's command.
    #[test]
    fn flock_launch_is_the_last_env() {
        let launch = "claude --dangerously-skip-permissions";
        let args = run_args(&RunSpec {
            extra_env: &[
                ("FLOCK_LAUNCH", "rm -rf /"),
                ("CLARENCE_LAUNCH", "rm -rf /"),
                ("FLOCK_PANE_ID", "evil"),
            ],
            launch,
            ..spec("ws-1", "real-pane", crate::egress::Egress::Open)
        });
        assert_eq!(args.last().map(String::as_str), Some("img"));
        assert_eq!(args[args.len() - 2], format!("CLARENCE_LAUNCH={launch}"));
        assert_eq!(args[args.len() - 3], "-e");
        assert_eq!(args[args.len() - 4], format!("FLOCK_LAUNCH={launch}"));
        assert_eq!(args[args.len() - 5], "-e");
        // The caller's launch was dropped, not merely overridden.
        assert!(!args.iter().any(|s| s == "FLOCK_LAUNCH=rm -rf /"));
        assert!(!args.iter().any(|s| s == "CLARENCE_LAUNCH=rm -rf /"));

        let _ = std::fs::remove_file(
            host_flock_dir().unwrap().join(JAIL_HOOKS_DIR).join("real-pane.jsonl"),
        );
    }

    /// extra_env may name a pane; the spec's pane_id is what the jail inherits.
    #[test]
    fn caller_flock_pane_id_does_not_appear_after_identity() {
        let args = run_args(&RunSpec {
            extra_env: &[("FLOCK_PANE_ID", "evil"), ("CLARENCE_PANE_ID", "evil")],
            ..spec("ws-1", "real-pane", crate::egress::Egress::Open)
        });
        let last_flock = args
            .iter()
            .rev()
            .find(|s| s.starts_with("FLOCK_PANE_ID="))
            .map(String::as_str);
        let last_clarence = args
            .iter()
            .rev()
            .find(|s| s.starts_with("CLARENCE_PANE_ID="))
            .map(String::as_str);
        assert_eq!(last_flock, Some("FLOCK_PANE_ID=real-pane"));
        assert_eq!(last_clarence, Some("CLARENCE_PANE_ID=real-pane"));
        // A caller value may appear earlier (extra_env is dumped first) but
        // nothing after identity may still name it.
        let ident_at = args
            .iter()
            .position(|s| s == "FLOCK_PANE_ID=real-pane")
            .expect("identity pane id");
        assert!(!args[ident_at + 1..].iter().any(|s| s.contains("=evil")));

        let _ = std::fs::remove_file(
            host_flock_dir().unwrap().join(JAIL_HOOKS_DIR).join("real-pane.jsonl"),
        );
    }

    /// The build context and hook-log root are the injected shared dir, never
    /// a hand-built `$HOME/.flock` that would look like a finished migration.
    #[test]
    fn host_flock_dir_and_build_context_use_the_injected_shared_dir() {
        let dir = host_flock_dir().expect("test shared dir");
        if let Ok(home) = std::env::var("HOME") {
            assert_ne!(
                dir,
                Path::new(&home).join(".flock"),
                "must not invent $HOME/.flock"
            );
        }
        let ctx = write_build_context().expect("write build context");
        assert_eq!(ctx, dir.join("sandbox"));
        assert!(ctx.starts_with(&dir));
    }

    #[test]
    fn run_args_confine_and_mount_workspace() {
        let args = run_args(&RunSpec {
            name: "flock-abc",
            image: "flock-sandbox:deadbeef",
            agent: "claude",
            cwd: Some(Path::new("/Users/x/git/repo")),
            launch: "claude --dangerously-skip-permissions",
            extra_env: &[("FLOCK_PANE_ID", "p1")],
            workspace_id: "ws-123",
            pane_id: "p1",
            egress: crate::egress::Egress::Open,
        });
        let joined = args.join(" ");
        assert!(joined.contains("--cap-drop ALL"));
        assert!(joined.contains("--security-opt no-new-privileges"));
        assert!(joined.contains("--pids-limit 4096"));
        assert!(joined.contains("-v /Users/x/git/repo:/Users/x/git/repo"));
        assert!(joined.contains("-w /Users/x/git/repo"));
        assert!(joined.contains("-e FLOCK_PANE_ID=p1"));
        assert!(joined.contains("FLOCK_LAUNCH=claude --dangerously-skip-permissions"));
        // The legacy mirror rides along until the compatibility window closes.
        assert!(joined.contains("CLARENCE_LAUNCH=claude --dangerously-skip-permissions"));
        // Status bridge: hook events must flow back to the host's log file.
        assert!(joined.contains(":/home/node/.flock/hooks.jsonl"));
        // Per-workspace home volume, isolated from other workspaces.
        assert!(joined.contains(&format!("{}:{CONTAINER_HOME}", home_volume("ws-123"))));
        assert!(joined.contains(HOME_VOLUME_PREFIX));
        assert!(
            args.windows(2).any(|w| w[0] == "--label" && w[1] == SECURE_PANE_LABEL),
            "spawn must label the jail so leftover reap can find it: {joined}"
        );
        // Nothing that would hand the jail the daemon: a mounted docker socket
        // is a root shell on the host in one `docker run -v /:/host`.
        assert!(!joined.contains("docker.sock"));
        assert!(!joined.contains("--privileged"));
        assert!(!joined.contains("--cap-add"));
        assert!(!joined.contains("--network host"));
        // The image must come last so docker doesn't eat trailing flags.
        assert_eq!(args.last().map(String::as_str), Some("flock-sandbox:deadbeef"));

        // run_args pre-creates the mount source in the real ~/.flock, so the
        // test tidies up after itself rather than littering a user's data dir.
        let _ = std::fs::remove_file(
            host_flock_dir().unwrap().join(JAIL_HOOKS_DIR).join("p1.jsonl"),
        );
    }

    /// The jail's hook log is the pane's own file, not the machine-wide one.
    /// Mounting the shared `~/.flock/hooks.jsonl` gave every jailed agent read
    /// access to every other pane's lifecycle events — across workspaces, and
    /// including unjailed host sessions — plus a write handle it could use to
    /// forge their statuses or truncate the file the app's status depends on.
    #[test]
    fn the_jail_sees_only_its_own_pane_hook_log() {
        let args = run_args(&spec("ws-1", "pane-aaa", crate::egress::Egress::Open));
        let joined = args.join(" ");
        let host_dir = host_flock_dir().expect("HOME is set under test");
        assert!(joined.contains(&format!(
            "{}:{CONTAINER_HOME}/.flock/hooks.jsonl",
            host_dir.join(JAIL_HOOKS_DIR).join("pane-aaa.jsonl").display()
        )));
        // The shared log, which every host pane appends to, is not a mount
        // source any more.
        assert!(!joined.contains(&format!("{}:", host_dir.join("hooks.jsonl").display())));
        // Two panes never share a file, so one cannot read or rewrite the
        // other's events.
        let other = run_args(&spec("ws-1", "pane-bbb", crate::egress::Egress::Open)).join(" ");
        assert!(other.contains("pane-bbb.jsonl") && !other.contains("pane-aaa.jsonl"));

        for pane in ["pane-aaa", "pane-bbb"] {
            let _ = std::fs::remove_file(host_dir.join(JAIL_HOOKS_DIR).join(format!("{pane}.jsonl")));
        }
    }

    /// The pane id arrives over IPC and becomes a filename. A traversal in it
    /// would place the mount — and everything the jail writes into it —
    /// anywhere under the user's home.
    #[test]
    fn a_traversing_pane_id_cannot_move_the_hook_log() {
        let dir = host_flock_dir().expect("HOME is set under test").join(JAIL_HOOKS_DIR);
        let log = host_pane_hooks_log("../../.ssh/authorized_keys").expect("still yields a path");
        assert_eq!(log.parent(), Some(dir.as_path()));
        assert_eq!(log.file_name().unwrap().to_str(), Some("sshauthorizedkeys.jsonl"));
        // An id with nothing usable in it yields no mount at all rather than a
        // file named after the empty string.
        assert!(host_pane_hooks_log("../..").is_none());
        assert!(host_pane_hooks_log("").is_none());
        let _ = std::fs::remove_file(log);
    }

    /// A pane is handed the credentials its own agent bills against, and no
    /// other's. Both families used to go to every jail, so a codex pane carried
    /// the user's Anthropic key — readable by anything running in it, for
    /// nothing.
    ///
    /// Asserted as an invariant rather than an exact list: the list grows
    /// whenever an agent gains a way to be pointed somewhere, and a test that
    /// pins the membership fails on every such addition while proving nothing.
    /// What must never change is which family reaches which pane.
    #[test]
    fn a_pane_only_gets_its_own_agents_credentials() {
        let claude = passthrough_env("claude");
        assert!(claude.iter().all(|v| v.starts_with("ANTHROPIC_")));
        let codex = passthrough_env("codex");
        assert!(codex.iter().all(|v| v.starts_with("OPENAI_")));

        // opencode and pi are pointed at whichever provider the user pays for,
        // so narrowing them would break panes rather than protect anything.
        for agent in ["opencode", "pi"] {
            let both = passthrough_env(agent);
            assert!(both.iter().any(|v| v.starts_with("ANTHROPIC_")));
            assert!(both.iter().any(|v| v.starts_with("OPENAI_")));
        }
    }

    /// An API key alone is not a credential when the endpoint is not Anthropic.
    /// A gateway user sets ANTHROPIC_BASE_URL and usually authenticates with a
    /// bearer token rather than an API key, so forwarding only the key left the
    /// jail with nothing usable and Claude Code asked them to log in.
    #[test]
    fn a_jailed_pane_can_reach_a_gateway() {
        for agent in ["claude", "opencode", "pi"] {
            let env = passthrough_env(agent);
            for needed in ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] {
                assert!(env.contains(&needed), "{agent} pane cannot reach a gateway: no {needed}");
            }
        }
        assert!(passthrough_env("codex").contains(&"OPENAI_BASE_URL"));
    }

    /// Restricted panes: the network flag and the proxy env are what make the
    /// allowlist real. Without `--network` the pane sits on the default bridge
    /// and the proxy env is a suggestion the agent can ignore.
    #[test]
    fn a_restricted_pane_gets_the_internal_network_and_the_proxy() {
        let args = run_args(&spec("ws-1", "pane-ccc", crate::egress::Egress::Restricted));
        let joined = args.join(" ");
        assert!(joined.contains(&format!("--network {}", crate::egress::network_name("ws-1"))));
        for (k, v) in crate::egress::proxy_env("ws-1") {
            assert!(joined.contains(&format!("-e {k}={v}")), "missing {k}");
        }
        // An open pane keeps today's behaviour exactly: no network flag at all,
        // so it lands on the default bridge as it always has.
        let open = run_args(&spec("ws-1", "pane-ccc", crate::egress::Egress::Open)).join(" ");
        assert!(!open.contains("--network"));
        assert!(!open.contains("HTTPS_PROXY"));

        let _ = std::fs::remove_file(
            host_flock_dir().unwrap().join(JAIL_HOOKS_DIR).join("pane-ccc.jsonl"),
        );
    }

    /// The transcript bridge, which is what makes the context meter and the
    /// token totals work for a jailed pane at all.
    #[test]
    fn run_args_mount_transcripts_out_to_the_host() {
        let ws = "ws-transcripts-test";
        let dir = secure_transcripts_dir(ws).expect("HOME is set under test");
        let _ = std::fs::remove_file(dir.join(TRANSCRIPTS_MIGRATED_MARKER));

        let args = run_args(&spec(ws, "pane-t", crate::egress::Egress::Open));
        let joined = args.join(" ");
        // Mounted over the jail's projects dir, not somewhere the readers would
        // never look.
        assert!(joined.contains(&format!(
            "-v {}:{CONTAINER_HOME}/.claude/projects",
            dir.display()
        )));
        // Inside ~/.claude/projects, so `claude_code_usage`'s recursive walk and
        // `claude_context`'s lookup both reach it with no second scan root.
        assert!(dir.starts_with(
            Path::new(&std::env::var("HOME").unwrap()).join(".claude").join("projects")
        ));
        assert!(dir.file_name().unwrap().to_str().unwrap().starts_with(SECURE_TRANSCRIPTS_PREFIX));
        // Nothing above that directory is exposed. A mount landing on
        // ~/.claude itself would hand the jail the host's Claude Code
        // credentials and every other session on the machine.
        assert!(!args.iter().any(|s| s.ends_with(&format!(":{CONTAINER_HOME}/.claude"))));
        // First spawn for this workspace also exposes the volume's shadowed
        // transcripts, read-only, for the one-shot copy.
        assert!(joined.contains(&format!(
            "-v {}:{LEGACY_HOME_MOUNT}:ro",
            home_volume(ws)
        )));

        // Once the jail has reported the copy done, that second mount is gone
        // for good — this is the whole point of the marker.
        std::fs::write(dir.join(TRANSCRIPTS_MIGRATED_MARKER), "").unwrap();
        let after = run_args(&spec(ws, "pane-t", crate::egress::Egress::Open)).join(" ");
        assert!(after.contains(&format!("{CONTAINER_HOME}/.claude/projects")));
        assert!(!after.contains(LEGACY_HOME_MOUNT));

        let _ = std::fs::remove_file(dir.join(TRANSCRIPTS_MIGRATED_MARKER));
        let _ = std::fs::remove_dir(&dir);
        let _ = std::fs::remove_file(
            host_flock_dir().unwrap().join(JAIL_HOOKS_DIR).join("pane-t.jsonl"),
        );
    }

    #[test]
    fn transcripts_dir_is_stable_and_per_workspace() {
        // Two workspaces must never share one: a transcript is a verbatim
        // record of a repo's source, and every jail can read what it mounts.
        assert_eq!(secure_transcripts_name("ws-a"), secure_transcripts_name("ws-a"));
        assert_ne!(secure_transcripts_name("ws-a"), secure_transcripts_name("ws-b"));
        let n = secure_transcripts_name("copilot:weird/id");
        assert!(n.starts_with(SECURE_TRANSCRIPTS_PREFIX));
        // A path component, not a path: an id with slashes must not escape
        // ~/.claude/projects.
        assert!(n
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    }

    /// The migration is split across Rust (which decides whether to mount the
    /// volume again) and the image's init script (which does the copy and
    /// writes the marker). They agree only by string, so pin the strings.
    #[test]
    fn the_migration_marker_and_mount_match_the_image() {
        assert!(DOCKERFILE.contains(TRANSCRIPTS_MIGRATED_MARKER));
        assert!(DOCKERFILE.contains(LEGACY_HOME_MOUNT));
        // And the copy must be into the mounted-out directory, not the volume.
        assert!(DOCKERFILE.contains("\"$HOME/.claude/projects/\""));
    }

    #[test]
    fn home_volume_is_stable_and_per_workspace() {
        assert_eq!(home_volume("ws-a"), home_volume("ws-a"));
        assert_ne!(home_volume("ws-a"), home_volume("ws-b"));
        // Docker-safe: prefix + lowercase hex + dashes only.
        let v = home_volume("copilot:weird/id");
        assert!(v.starts_with(HOME_VOLUME_PREFIX));
        assert!(v
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    }

    #[test]
    fn hook_settings_are_valid_and_managed() {
        let s = claude_hook_settings();
        let v: serde_json::Value = serde_json::from_str(&s).expect("hook settings must be valid JSON");
        for event in HOOK_EVENTS {
            let cmd = v["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap_or_else(|| panic!("missing hook command for {event}"));
            // Same contract as desktop hooks.rs: marker for idempotent
            // installs, pane-id guard, and the jsonl the host watcher tails.
            assert!(cmd.contains("flock-managed-hook"));
            // The pane-id guard reads the new name first and falls back: this
            // file outlives the app version that wrote it (it is merged into a
            // persistent $HOME volume), so it has to work under both.
            assert!(cmd.contains("${FLOCK_PANE_ID:-$CLARENCE_PANE_ID}"));
            assert!(cmd.contains("~/.flock/hooks.jsonl"));
            assert!(cmd.contains(&format!("\\\"event\\\":\\\"{event}\\\"")));
            // Only Notification reads stdin, and it must carry the message —
            // that field is how a jailed agent's permission ask is told apart
            // from the idle nudge, same as on the host.
            assert_eq!(
                cmd.contains("\\\"message\\\":\\\"$_m\\\""),
                *event == "Notification",
                "{event} message field"
            );
        }
    }

    /// The jailed command is a hand-mirrored copy of desktop `hooks.rs`, so it
    /// gets the same proof the host one does: run it against a real payload.
    #[test]
    fn the_jailed_notification_hook_forwards_its_message() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let v: serde_json::Value = serde_json::from_str(&claude_hook_settings()).unwrap();
        let cmd = v["hooks"]["Notification"][0]["hooks"][0]["command"].as_str().unwrap();
        // Strip the `sh -c '…' >> log; true # marker` wrapper the image installs
        // and run the body straight, capturing what would have been logged.
        let body = cmd
            .split_once("sh -c '")
            .and_then(|(_, rest)| rest.rsplit_once("' >> "))
            .map(|(body, _)| body.to_string())
            .expect("command keeps its sh -c wrapper");

        let mut child = Command::new("sh")
            .arg("-c")
            .arg(&body)
            .env("FLOCK_PANE_ID", "pane-1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("sh is available");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(br#"{"message":"Claude needs your permission to use Bash"}"#)
            .unwrap();
        let out = child.wait_with_output().unwrap();
        let line = String::from_utf8(out.stdout).unwrap();
        let logged: serde_json::Value =
            serde_json::from_str(line.trim()).unwrap_or_else(|e| panic!("invalid JSON ({e}): {line}"));
        assert_eq!(logged["message"], "Claude needs your permission to use Bash");
        assert_eq!(logged["pane_id"], "pane-1");
    }

    #[test]
    fn pane_script_builds_then_execs() {
        let s = build_pane_script(
            Path::new("/usr/local/bin/docker"),
            "flock-sandbox:deadbeef",
            Path::new("/Users/x/.flock/sandbox"),
            &run_args(&spec("ws-123", "pane-s", crate::egress::Egress::Open)),
            "",
        );
        assert!(s.contains("image inspect"));
        assert!(s.contains("build -t"));
        // The run_args vector already carries the `run` subcommand; the 0.4.25
        // script prepended a second one, so docker read the literal word
        // "run" as the image name and every jailed spawn died with
        // "Unable to find image 'run:latest'".
        assert!(s.contains("exec /usr/local/bin/docker run --rm"));
        assert!(!s.contains("docker run run"));
        assert!(!s.contains(" run run "));
        let _ = std::fs::remove_file(
            host_flock_dir().unwrap().join(JAIL_HOOKS_DIR).join("pane-s.jsonl"),
        );
    }

    /// The egress prelude has to land between the image build and the exec: in
    /// front of the build it would run before the image it needs exists, and
    /// after the exec it would never run at all. And it must be sequenced so a
    /// failure inside it stops the pane instead of falling through to a
    /// `docker run` on the default bridge.
    #[test]
    fn the_egress_prelude_runs_before_the_pane_and_can_stop_it() {
        let docker = Path::new("/usr/local/bin/docker");
        let prelude = crate::egress::ensure_script(docker, "img", "ws-123", &[".anthropic.com".into()]);
        let s = build_pane_script(
            docker,
            "img",
            Path::new("/Users/x/.flock/sandbox"),
            &run_args(&spec("ws-123", "pane-s2", crate::egress::Egress::Restricted)),
            &prelude,
        );
        let build_at = s.find("build -t").expect("build step");
        let net_at = s.find("network create --internal").expect("egress prelude");
        let exec_at = s.find("exec /usr/local/bin/docker run").expect("exec");
        assert!(build_at < net_at && net_at < exec_at, "{s}");
        // Sequenced with `;`, so the prelude's own `exit 1` is the only thing
        // standing between a failed proxy and an unrestricted pane.
        assert!(s.contains("fi; exec /usr/local/bin/docker run"), "{s}");
        assert!(prelude.contains("exit 1"));
        let _ = std::fs::remove_file(
            host_flock_dir().unwrap().join(JAIL_HOOKS_DIR).join("pane-s2.jsonl"),
        );
    }

    /// Reap lists by the same label `run_args` stamps. A rename in one place
    /// that missed the other would leave every leftover jail running.
    #[test]
    fn reap_lists_by_the_label_run_args_sets() {
        let args = run_args(&spec("ws-1", "pane-reap", crate::egress::Egress::Open));
        assert!(
            args.windows(2).any(|w| w[0] == "--label" && w[1] == SECURE_PANE_LABEL),
            "spawn label missing: {}",
            args.join(" ")
        );
        let list = orphan_pane_list_args();
        assert_eq!(list[0], "ps");
        assert_eq!(list[2], "--filter");
        assert_eq!(list[3], format!("label={SECURE_PANE_LABEL}"));
        // Built from the same const `run_args` stamps, not a second literal.
        let _ = std::fs::remove_file(
            host_flock_dir().unwrap().join(JAIL_HOOKS_DIR).join("pane-reap.jsonl"),
        );
    }

    #[test]
    fn leftover_jails_are_reaped_and_a_neighbours_are_not() {
        let us = 42;
        // Previous run, owner gone.
        assert!(should_reap_secure_pane(Some(7), us, false, false));
        // Missing or unparseable owner: a pre-label 0.7.39 neighbour looks
        // the same as an unlabeled leftover. Skip, same as a failed inspect.
        assert!(!should_reap_secure_pane(None, us, false, false));
        assert!(!should_reap_secure_pane(None, us, false, true));
        // Another flock still running.
        assert!(!should_reap_secure_pane(Some(99), us, true, false));
        assert!(!should_reap_secure_pane(Some(99), us, true, true));
        // Ours, still running: leave it on startup, take it on the way out.
        assert!(!should_reap_secure_pane(Some(us), us, true, false));
        assert!(should_reap_secure_pane(Some(us), us, true, true));
    }

    #[cfg(unix)]
    #[test]
    fn pid_is_alive_refuses_unusable_pids() {
        assert!(!pid_is_alive(0), "pid 0 is the process group, not a process");
        assert!(!pid_is_alive(u32::MAX), "u32::MAX as i32 is -1 (every process)");
        assert!(pid_is_alive(std::process::id()));
        let mut child = std::process::Command::new("true").spawn().expect("true");
        let dead = child.id();
        let _ = child.wait();
        assert!(!pid_is_alive(dead), "reaped child {dead} must not look live");
    }
}
