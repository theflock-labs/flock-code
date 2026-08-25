use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Comment appended to every command we install, so re-install/uninstall can
/// find-and-replace exactly our own entries without touching hooks the user
/// configured themselves for the same event.
const MANAGED_MARKER: &str = "flock-managed-hook";

/// Pre-rebrand marker. Still matched when deciding what is ours, so the hook
/// group a Clarence build wrote gets replaced rather than left beside the new
/// one — otherwise every event would fire twice, the second copy appending to a
/// log nothing tails any more.
/// Deprecated: drop a few releases out, once installs have all been through one
/// post-rebrand launch.
const LEGACY_MANAGED_MARKER: &str = "clarence-managed-hook";

const EVENTS: [&str; 4] = ["SessionStart", "UserPromptSubmit", "Stop", "Notification"];

/// Size at which the hooks log is emptied. Every agent on the machine appends
/// here forever and nothing ever removed a line, so the file's only bound was
/// how long the install had been in use. Generous on purpose: at roughly 110
/// bytes a line this is around forty thousand events, which is weeks of heavy
/// use, and rotation is a truncation so it wants to be rare.
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

fn home_dir() -> PathBuf {
    flock_core::paths::home_dir()
}

/// Must stay in step with the literal `~/.flock/hooks.jsonl` the installed hook
/// command appends to: this is the file the tailer watches, that one is the
/// file the agent writes.
pub fn hooks_log_path() -> PathBuf {
    flock_core::paths::shared_data_dir().join("hooks.jsonl")
}

/// `~/.flock/hooks.d` — one file per *jailed* pane, written from inside its
/// container and named after the pane (flock-pty `container::host_pane_hooks_log`).
///
/// Jails used to append to the shared log above, which meant bind-mounting the
/// whole machine's lifecycle feed, read-write, into every secure container.
/// Splitting them costs this watcher one directory scan per tick and buys two
/// things: a jailed agent can no longer read another pane's events, and it can
/// no longer speak for one — [`pane_owns_line`] drops any line whose `pane_id`
/// is not the file's own name.
fn jail_hooks_dir() -> PathBuf {
    flock_core::paths::shared_data_dir().join(flock_pty::container::JAIL_HOOKS_DIR)
}

/// Per-pane cap. A jailed agent controls its own file's contents, so the bound
/// on it has to be ours; the shared log's 4 MiB is a whole machine's traffic,
/// one pane needs far less.
const MAX_PANE_LOG_BYTES: u64 = 512 * 1024;

/// Files in `hooks.d` older than this are from panes that no longer exist —
/// every pane dies with the app that spawned it. Not zero, and not "delete
/// everything at startup", because a second flock (a `tauri dev` build beside
/// the installed one) may have live jails writing here right now.
const JAIL_LOG_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Whether a line found in `hooks.d/<pane>.jsonl` is allowed to be about the
/// pane it claims. The file name is assigned by flock at spawn and the jail
/// cannot rename it, so it is the one part of a jailed agent's status report
/// that the agent does not control. Everything else in the line it may write
/// freely — it is the agent, and reporting its own state is the whole point of
/// the channel.
fn pane_owns_line(pane: &str, line: &Value) -> bool {
    line.get("pane_id").and_then(|p| p.as_str()) == Some(pane)
}

/// Upper bound on what one tick will load from one file. The jail files'
/// writers are untrusted, so the amount read per tick has to be ours to
/// bound — an agent that writes gigabytes between two ticks must not get all
/// of it loaded into host memory at once. Anything past the cap is picked up
/// on later ticks (or truncated away by the per-pane cap first).
const MAX_READ_BYTES: u64 = 1024 * 1024;

/// Read whatever has been appended to `path` since byte `pos`, returning the
/// text and the new position. `None` when there is nothing new or the file
/// cannot be read; a file shorter than `pos` was truncated, so it restarts at
/// zero (that is what the shared log's rotation looks like from here).
///
/// Decoding is lossy on purpose: a single invalid byte in a jail-written file
/// must not make this return `None` forever — that would freeze the read
/// position, disable the truncation cap, and silently drop every later event
/// from that pane. A bad byte costs its own line (the JSON parse skips it) and
/// nothing else.
fn read_appended(path: &Path, pos: u64) -> Option<(String, u64)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let pos = if len < pos { 0 } else { pos };
    if len == pos {
        return None;
    }
    file.seek(SeekFrom::Start(pos)).ok()?;
    let capped = len - pos > MAX_READ_BYTES;
    let mut buf = Vec::new();
    file.take((len - pos).min(MAX_READ_BYTES)).read_to_end(&mut buf).ok()?;
    // A capped read can cut mid-line (and mid-codepoint); hand back only whole
    // lines so the cut line is read intact next tick. A single line longer
    // than the cap is swallowed as-is — advancing past it beats wedging on it.
    if capped {
        if let Some(nl) = buf.iter().rposition(|&b| b == b'\n') {
            buf.truncate(nl + 1);
        }
    }
    let read = buf.len() as u64;
    Some((String::from_utf8_lossy(&buf).into_owned(), pos + read))
}

/// Delete stale per-pane logs. Best-effort, at startup only.
fn prune_jail_logs() {
    let Ok(entries) = std::fs::read_dir(jail_hooks_dir()) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > JAIL_LOG_MAX_AGE);
        if stale {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn settings_path(agent: &str) -> Result<PathBuf, String> {
    match agent {
        "claude" => Ok(home_dir().join(".claude/settings.json")),
        "codex" => Ok(home_dir().join(".codex/hooks.json")),
        // grok reads every `*.json` in this directory and merges them, so
        // flock's entries get a file of their own instead of a marked group
        // inside a file the user also edits. See [`install_grok`].
        "grok" => Ok(home_dir().join(".grok/hooks/flock.json")),
        _ => Err(format!("unknown agent: {agent}")),
    }
}

/// Shell command run by the hook. Guarded on the pane id (only set for panes
/// we spawned — see flock-pty's env injection), so the hook is a silent no-op
/// when the same `~/.claude/settings.json` is used outside flock (a plain
/// terminal, another editor, etc).
///
/// Read as `${FLOCK_PANE_ID:-$CLARENCE_PANE_ID}`, matching the in-jail
/// installer in flock-pty's `container.rs`: this line lands in the user's own
/// settings file and outlives the app version that wrote it, so it has to keep
/// working both while the two names are exported and after the legacy one goes.
fn hook_command(agent: &str, event: &str) -> String {
    format!("sh -c '{}' >> ~/.flock/hooks.jsonl; true # {MANAGED_MARKER}", hook_body(agent, event))
}

/// The body of the hook's `sh -c`, split out from the quoting around it so a
/// test can pipe a real Claude Code payload through it (see `mod tests`).
/// Writes one JSON line to stdout; the caller redirects it to the log.
///
/// Notification is the one event that also reads its stdin. Claude Code fires
/// it for two very different things — "Claude needs your permission to use
/// Bash" (the turn is stopped on the user) and "Claude is waiting for your
/// input", which is just a nudge 60 seconds after an agent went quiet. Treating
/// both as a block is what made the pill announce "3 agents need input" at a
/// screen of resting agents. Only `message` can tell them apart, so it rides
/// along and [`notification_status`] decides. The sed grabs the first
/// `"message":"…"` up to its closing quote, and the `tr` drops backslashes so a
/// truncated escape can't run past the quote that closes our own field; a
/// payload without the field yields an empty string, never a broken line.
fn hook_body(agent: &str, event: &str) -> String {
    let capture_message = if event == "Notification" {
        "_m=$(cat | tr -d \"\\n\" | sed -n \"s/.*\\\"message\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p\" | tr -d \"\\\\\\\\\"); "
    } else {
        ""
    };
    let message_field = if event == "Notification" { ",\\\"message\\\":\\\"$_m\\\"" } else { "" };
    format!(
        "_p=\"${{FLOCK_PANE_ID:-$CLARENCE_PANE_ID}}\"; [ -n \"$_p\" ] || exit 0; {capture_message}printf \"%s\\n\" \"{{\\\"time\\\":$(date +%s),\\\"agent\\\":\\\"{agent}\\\",\\\"event\\\":\\\"{event}\\\",\\\"pane_id\\\":\\\"$_p\\\"{message_field}}}\""
    )
}

// ─── grok (Grok Build) ───────────────────────────────────────────────────────
//
// grok speaks Claude Code's hook contract — same event names, same JSON shape,
// and it even reads `~/.claude/settings.json` itself. What it does *not* share
// is how a command is run: grok expands `${VAR}` and `$VAR` in the `command`
// field at load time and **refuses to run a command that names a variable the
// environment does not have**. flock's one-liner opens with
// `_p="${FLOCK_PANE_ID:-…}"` and then reads `"$_p"` — a shell local, not an
// environment variable — so grok skips the hook outright:
//
//     hook not executed: required env var(s) not set: ${_p}
//
// Which is exactly what a grok pane in flock did before this: no status, no
// prompt counts, no provenance activity, and nothing anywhere saying so.
//
// So grok's hook runs a *script* and passes what it needs as arguments. A
// script body is not subject to grok's expansion, and the same file works for
// any future agent whose harness rewrites command strings. Three more things
// are load-bearing:
//
//   * **The file is ours alone.** grok merges every `*.json` under
//     `~/.grok/hooks/`, so flock writes `flock.json` rather than editing a
//     file the user also owns. Uninstall is a delete, not a surgical retain.
//   * **Notification is split by matcher, not by message.** Claude Code
//     announces both "I need permission" and its 60-second idle nudge through
//     one event and only the message tells them apart (see
//     [`notification_status`]). grok types them — `permission_prompt` and
//     `idle_prompt` — so the classification moves into the matcher and each
//     group emits the message this side already knows how to read. A
//     notification that is neither (`task_complete`, …) fires nothing, rather
//     than lighting "needs input" for a pane that finished.
//   * **Panes launch with `GROK_CLAUDE_HOOKS_ENABLED=false`** (see
//     `commands::agent_env`), or grok would load flock's Claude group as well
//     and every prompt would be counted twice.

/// The script grok's hooks run. Written next to the log it appends to, and
/// regenerated whenever [`install`] runs so a build that changes the line
/// format reaches installs an older one set up.
fn pane_event_script_path() -> PathBuf {
    flock_core::paths::shared_data_dir().join("hooks/pane-event.sh")
}

/// One JSON line per lifecycle event, on the same log the Claude Code hook
/// appends to and in the same shape (`time`/`agent`/`event`/`pane_id`, plus
/// `message` when there is one to carry). Inert outside a flock pane: without
/// a pane id in the environment there is nothing this could be about.
fn pane_event_script(log: &Path) -> String {
    format!(
        r#"#!/bin/sh
# {MANAGED_MARKER} — regenerated by flock on every launch; edits are overwritten.
#
# Usage: pane-event.sh <agent> <event> [message]
#
# Appends one lifecycle line to flock's hook log. Exits 0 and writes nothing
# when it is not running inside a flock pane, so the hook that calls it is
# harmless in an ordinary terminal.
pane="${{FLOCK_PANE_ID:-${{CLARENCE_PANE_ID:-}}}}"
[ -n "$pane" ] || exit 0
agent="$1"
event="$2"
message="$3"
if [ -n "$message" ]; then
  printf '{{"time":%s,"agent":"%s","event":"%s","pane_id":"%s","message":"%s"}}\n' \
    "$(date +%s)" "$agent" "$event" "$pane" "$message" >> "{log}"
else
  printf '{{"time":%s,"agent":"%s","event":"%s","pane_id":"%s"}}\n' \
    "$(date +%s)" "$agent" "$event" "$pane" >> "{log}"
fi
exit 0
"#,
        log = log.display(),
    )
}

/// What grok's Notification groups report. The strings are chosen so that
/// [`notification_status`] — written for Claude Code's free-text messages —
/// classifies them without a second vocabulary: the idle one contains
/// [`IDLE_NUDGE`], the permission one does not.
const GROK_IDLE_MESSAGE: &str = "grok is waiting for your input";
const GROK_PERMISSION_MESSAGE: &str = "grok needs your permission to run a tool";

fn grok_hooks_json(script: &Path) -> Value {
    let cmd = |event: &str, message: &str| {
        let script = script.display();
        let command = if message.is_empty() {
            format!("{script} grok {event}")
        } else {
            format!("{script} grok {event} '{message}'")
        };
        json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] })
    };
    json!({
        "hooks": {
            "SessionStart": [cmd("SessionStart", "")],
            "UserPromptSubmit": [cmd("UserPromptSubmit", "")],
            // grok also fires Stop once at session end; that one reports Idle
            // too, which is where a closing pane belongs.
            "Stop": [cmd("Stop", "")],
            "Notification": [
                {
                    "matcher": "permission_prompt",
                    "hooks": [{ "type": "command",
                                "command": format!("{} grok Notification '{GROK_PERMISSION_MESSAGE}'", script.display()),
                                "timeout": 5 }]
                },
                {
                    "matcher": "idle_prompt",
                    "hooks": [{ "type": "command",
                                "command": format!("{} grok Notification '{GROK_IDLE_MESSAGE}'", script.display()),
                                "timeout": 5 }]
                }
            ]
        }
    })
}

/// Write the shared script (executable) and grok's hook file.
fn install_grok() -> Result<(), String> {
    let script = pane_event_script_path();
    if let Some(dir) = script.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&script, pane_event_script(&hooks_log_path())).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }
    write_json(&settings_path("grok")?, &grok_hooks_json(&script))
}

/// Install grok's hooks if grok is on this machine and they are not already
/// current. Unlike Claude Code and Codex — whose hooks live inside a settings
/// file the user owns and are therefore opt-in from Settings — this writes one
/// flock-named file into a drop-in directory that exists for exactly this, and
/// the script it points at does nothing outside a flock pane. A grok pane with
/// no hooks has no status at all, so making the user find a toggle first would
/// mean shipping an agent that looks broken.
pub fn ensure_grok() {
    if !home_dir().join(".grok").is_dir() {
        return;
    }
    if commands_are_current("grok") {
        return;
    }
    if let Err(e) = install_grok() {
        tracing::warn!(target: "flock_desktop_lib", "failed to install grok hooks: {e}");
    }
}

fn group_is_managed(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.contains(MANAGED_MARKER) || s.contains(LEGACY_MANAGED_MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, pretty).map_err(|e| e.to_string())
}

/// Install (or reinstall — idempotent) the hook entries for `agent` into its
/// settings file, leaving any hooks the user configured themselves alone.
pub fn install(agent: &str) -> Result<(), String> {
    let path = settings_path(agent)?;
    // grok's file is entirely flock's, so it is written rather than merged.
    if agent == "grok" {
        return install_grok();
    }

    let mut root: Value = if path.exists() {
        let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    if !root.is_object() {
        root = json!({});
    }

    let root_obj = root.as_object_mut().unwrap();
    let hooks = root_obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();

    for event in EVENTS {
        let entry = hooks_obj.entry(event.to_string()).or_insert_with(|| json!([]));
        if !entry.is_array() {
            *entry = json!([]);
        }
        let arr = entry.as_array_mut().unwrap();
        arr.retain(|group| !group_is_managed(group));
        arr.push(json!({
            "hooks": [{ "type": "command", "command": hook_command(agent, event) }]
        }));
    }

    write_json(&path, &root)
}

/// Remove exactly the hook entries we installed, leaving user-authored hooks
/// (including ones for the same event) untouched.
pub fn uninstall(agent: &str) -> Result<(), String> {
    let path = settings_path(agent)?;
    if !path.exists() {
        return Ok(());
    }
    // Nothing of the user's is in this file, so removing our entries is
    // removing the file.
    if agent == "grok" {
        return std::fs::remove_file(&path).map_err(|e| e.to_string());
    }
    let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut root: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;

    if let Some(hooks_obj) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for event in EVENTS {
            if let Some(arr) = hooks_obj.get_mut(event).and_then(|e| e.as_array_mut()) {
                arr.retain(|group| !group_is_managed(group));
            }
        }
        hooks_obj.retain(|_, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));
    }

    write_json(&path, &root)
}

// ─── Graph grounding hook (UserPromptSubmit → flock-mcp ground) ─────────────
//
// A separate managed group from the logging hooks above: its marker string
// deliberately does NOT contain MANAGED_MARKER, so install()/uninstall() of
// the logging hooks never touch it (they retain-out groups matching
// MANAGED_MARKER under the same event).

/// Marker for the grounding hook entry. Must not contain MANAGED_MARKER.
const GROUND_MARKER: &str = "flock-graph-grounding";

/// Pre-rebrand grounding marker, matched for the same reason as
/// LEGACY_MANAGED_MARKER: replace the group a Clarence build wrote instead of
/// stacking a second one that shells to a binary that no longer exists.
/// Deprecated: drop alongside LEGACY_MANAGED_MARKER.
const LEGACY_GROUND_MARKER: &str = "clarence-graph-grounding";

/// The grounding command: pipe the UserPromptSubmit JSON into
/// `flock-mcp ground`, which prints a compact context block from the
/// flock Graph (or nothing). Guarded on the pane id so the same settings
/// file is inert outside flock panes, and exits 0 either way. The
/// KG URL is baked at install time (re-baked on every app launch, so a
/// changed Settings → Graph URL propagates); the legacy CLARENCE_KG_URL is
/// still honoured as a fallback for anyone who set it by hand. Claude and
/// Codex share this UserPromptSubmit contract: both inject the hook's stdout
/// as context.
fn ground_command(mcp_path: &str, kg_url: &str) -> String {
    format!(
        "sh -c 'if [ -n \"${{FLOCK_PANE_ID:-$CLARENCE_PANE_ID}}\" ]; then FLOCK_KG_URL=\"${{FLOCK_KG_URL:-${{CLARENCE_KG_URL:-{kg_url}}}}}\" exec \"{mcp_path}\" ground; fi' # {GROUND_MARKER}"
    )
}

/// The session-start brief command: prints the graph protocol + this
/// workspace's current knowledge. Codex's `--append-system-prompt` analogue —
/// Codex injects a SessionStart hook's stdout into context, so this primes the
/// agent once per session the way Claude's spawn-time system prompt does.
fn brief_command(mcp_path: &str, kg_url: &str) -> String {
    format!(
        "sh -c 'if [ -n \"${{FLOCK_PANE_ID:-$CLARENCE_PANE_ID}}\" ]; then FLOCK_KG_URL=\"${{FLOCK_KG_URL:-${{CLARENCE_KG_URL:-{kg_url}}}}}\" exec \"{mcp_path}\" brief; fi' # {GROUND_MARKER}"
    )
}

/// The turn-end command: logs one write-compliance telemetry event on Stop.
/// Prints nothing (the turn is over), so it's safe on any agent's Stop hook.
fn endturn_command(mcp_path: &str, kg_url: &str) -> String {
    format!(
        "sh -c 'if [ -n \"${{FLOCK_PANE_ID:-$CLARENCE_PANE_ID}}\" ]; then FLOCK_KG_URL=\"${{FLOCK_KG_URL:-${{CLARENCE_KG_URL:-{kg_url}}}}}\" exec \"{mcp_path}\" endturn; fi' # {GROUND_MARKER}"
    )
}

fn group_is_ground(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.contains(GROUND_MARKER) || s.contains(LEGACY_GROUND_MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Read a settings file into a JSON object, defaulting to `{}` when it's
/// missing or unparseable (we never clobber a file we can't read as JSON —
/// callers only add/remove our own marked groups).
fn read_json_object(path: &PathBuf) -> Result<Value, String> {
    let mut root: Value = if path.exists() {
        let s = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    if !root.is_object() {
        root = json!({});
    }
    Ok(root)
}

/// Replace (or add) our marked command group under `event` in a
/// `{hooks:{Event:[...]}}` settings file, leaving user-authored groups alone.
fn set_ground_group(root: &mut Value, event: &str, command: String) {
    let hooks = root.as_object_mut().unwrap().entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let entry = hooks
        .as_object_mut()
        .unwrap()
        .entry(event.to_string())
        .or_insert_with(|| json!([]));
    if !entry.is_array() {
        *entry = json!([]);
    }
    let arr = entry.as_array_mut().unwrap();
    arr.retain(|group| !group_is_ground(group));
    arr.push(json!({
        "hooks": [{
            "type": "command",
            "command": command,
            // Grounding must never hold a prompt hostage: flock-mcp caps its
            // own work at 1.5s, this is the harness-side backstop.
            "timeout": 5
        }]
    }));
}

/// Remove our marked groups from the given events, dropping now-empty event
/// arrays. No-op if the file is missing.
fn remove_ground_groups(path: &PathBuf, events: &[&str]) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let s = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut root: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    if let Some(hooks_obj) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for event in events {
            if let Some(arr) = hooks_obj.get_mut(*event).and_then(|e| e.as_array_mut()) {
                arr.retain(|group| !group_is_ground(group));
            }
        }
        hooks_obj.retain(|_, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));
    }
    write_json(path, &root)
}

/// Install (idempotent) the graph grounding hook for Claude Code. Every
/// prompt submitted in a flock pane gets prior decisions/attempts/claims
/// relevant to it injected as context. Claude gets the one-time protocol +
/// brief via `--append-system-prompt` at spawn (App.tsx), so no SessionStart
/// hook is needed here.
pub fn install_ground(mcp_path: &str, kg_url: &str) -> Result<(), String> {
    let path = settings_path("claude")?;
    let mut root = read_json_object(&path)?;
    set_ground_group(&mut root, "UserPromptSubmit", ground_command(mcp_path, kg_url));
    set_ground_group(&mut root, "Stop", endturn_command(mcp_path, kg_url));
    write_json(&path, &root)
}

/// Remove exactly the Claude grounding + turn-end hook entries; else stays.
pub fn uninstall_ground() -> Result<(), String> {
    remove_ground_groups(&settings_path("claude")?, &["UserPromptSubmit", "Stop"])
}

/// Install (idempotent) the graph grounding + brief hooks for Codex into
/// ~/.codex/hooks.json (same hook schema as Claude's settings.json). Codex has
/// no `--append-system-prompt`, so the protocol + workspace brief ride in on a
/// SessionStart hook whose stdout Codex injects as context; per-prompt recall
/// rides in on UserPromptSubmit. Codex gates hooks behind a trust hash, so the
/// codex launch adds `--dangerously-bypass-hook-trust` (App.tsx) — flock
/// authors and vets these hooks, and they're inert outside a flock pane.
pub fn install_ground_codex(mcp_path: &str, kg_url: &str) -> Result<(), String> {
    let path = settings_path("codex")?;
    let mut root = read_json_object(&path)?;
    set_ground_group(&mut root, "UserPromptSubmit", ground_command(mcp_path, kg_url));
    set_ground_group(&mut root, "SessionStart", brief_command(mcp_path, kg_url));
    set_ground_group(&mut root, "Stop", endturn_command(mcp_path, kg_url));
    write_json(&path, &root)
}

/// Remove exactly the Codex grounding + brief + turn-end hook entries.
pub fn uninstall_ground_codex() -> Result<(), String> {
    remove_ground_groups(
        &settings_path("codex")?,
        &["UserPromptSubmit", "SessionStart", "Stop"],
    )
}

// ─── opencode graph integration (config MCP + plugin) ───────────────────────
//
// opencode has no per-spawn config override and no UserPromptSubmit command
// hook, so its integration is two managed global files: an `mcp.flock-graph`
// stanza in opencode's config, and a plugin that injects the protocol (via
// experimental.chat.system.transform) and per-prompt recall (via chat.message
// shelling to `flock-mcp ground`). Both are flock-owned and regenerated
// on every launch; the plugin is inert unless the pane id is in the env.

fn opencode_dir() -> PathBuf {
    home_dir().join(".config/opencode")
}

/// The config file to edit: an existing opencode.json, else an existing
/// opencode.jsonc (opencode reads either), else a new opencode.json. We parse
/// it as plain JSON — a config with `//` comments is left untouched with an
/// error rather than clobbered.
fn opencode_config_path() -> PathBuf {
    let dir = opencode_dir();
    let json = dir.join("opencode.json");
    if json.exists() {
        return json;
    }
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    json
}

fn opencode_plugin_path() -> PathBuf {
    opencode_dir().join("plugin/flock-graph.js")
}

/// Where a Clarence build wrote the same plugin. opencode loads every file in
/// `plugin/`, so leaving it behind means two plugins injecting the brief and
/// shelling to two MCP binaries, one of which no longer exists.
/// Deprecated: drop alongside LEGACY_MANAGED_MARKER.
fn legacy_opencode_plugin_path() -> PathBuf {
    opencode_dir().join("plugin/clarence-graph.js")
}

/// The managed opencode plugin source, with the MCP binary path and KG URL
/// baked in (re-baked each launch). Mirrors the codex SessionStart brief +
/// UserPromptSubmit ground pair, but through opencode's plugin hooks.
fn opencode_plugin_source(mcp_path: &str, kg_url: &str) -> String {
    // JSON-encode the interpolated values so quotes/backslashes in a path or
    // URL can't break out of the JS string literal.
    let mcp = serde_json::to_string(mcp_path).unwrap_or_else(|_| "\"\"".into());
    let url = serde_json::to_string(kg_url).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"// flock-managed opencode plugin — flock Graph integration.
// Regenerated on every flock launch; do not edit (changes are overwritten).
// Injects the graph protocol + workspace brief into the system prompt and
// per-prompt recall into each message. Inert outside a flock pane.
const MCP = {mcp};
const KG_URL = {url};

export const FlockGraph = async ({{ $ }}) => {{
  if (!(process.env.FLOCK_PANE_ID || process.env.CLARENCE_PANE_ID)) return {{}};
  const env = {{ ...process.env, FLOCK_KG_URL: process.env.FLOCK_KG_URL || process.env.CLARENCE_KG_URL || KG_URL }};

  // Protocol + workspace brief: run once per session, reuse the promise.
  let briefOnce;
  const brief = () => (briefOnce ??= $`${{MCP}} brief`.env(env).text().catch(() => ""));

  return {{
    "experimental.chat.system.transform": async (_input, output) => {{
      const text = (await brief()).trim();
      if (text) output.system.push(text);
    }},
    "chat.message": async (_input, output) => {{
      const prompt = (output.parts || [])
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (prompt.length < 12 || prompt.startsWith("/")) return;
      const payload = JSON.stringify({{ prompt }});
      const block = (await $`echo ${{payload}} | ${{MCP}} ground`.env(env).text().catch(() => "")).trim();
      if (block) output.parts.push({{ type: "text", text: block }});
    }},
    stop: async () => {{
      await $`${{MCP}} endturn`.env(env).quiet().catch(() => {{}});
    }},
  }};
}};
"#
    )
}

/// Install (idempotent) opencode's graph integration: merge `mcp.flock-graph`
/// into opencode's config and write the managed plugin. Only our own keys are
/// touched; a user-authored config with `//` comments is left alone.
pub fn install_graph_opencode(mcp_path: &str, kg_url: &str) -> Result<(), String> {
    let path = opencode_config_path();
    let mut root: Value = if path.exists() {
        let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| {
            format!("opencode config at {} isn't plain JSON (comments?); left untouched: {e}", path.display())
        })?
    } else {
        json!({ "$schema": "https://opencode.ai/config.json" })
    };
    if !root.is_object() {
        root = json!({});
    }
    let mcp = root.as_object_mut().unwrap().entry("mcp").or_insert_with(|| json!({}));
    if !mcp.is_object() {
        *mcp = json!({});
    }
    let mcp_obj = mcp.as_object_mut().unwrap();
    // A Clarence build's stanza points at a binary that no longer exists, so
    // drop it rather than leaving opencode to fail spawning it every session.
    mcp_obj.remove("clarence-graph");
    mcp_obj.insert(
        "flock-graph".into(),
        json!({
            "type": "local",
            "command": [mcp_path],
            "environment": { "FLOCK_KG_URL": kg_url },
            "enabled": true
        }),
    );
    write_json(&path, &root)?;

    let plugin_path = opencode_plugin_path();
    if let Some(dir) = plugin_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(legacy_opencode_plugin_path());
    std::fs::write(&plugin_path, opencode_plugin_source(mcp_path, kg_url)).map_err(|e| e.to_string())
}

/// Remove opencode's `mcp.flock-graph` stanza and the managed plugin.
pub fn uninstall_graph_opencode() -> Result<(), String> {
    let path = opencode_config_path();
    if path.exists() {
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(mut root) = serde_json::from_str::<Value>(&s) {
                if let Some(mcp) = root.get_mut("mcp").and_then(|m| m.as_object_mut()) {
                    mcp.remove("flock-graph");
                    mcp.remove("clarence-graph");
                }
                let empty = root
                    .get("mcp")
                    .and_then(|m| m.as_object())
                    .map(|m| m.is_empty())
                    .unwrap_or(false);
                if empty {
                    root.as_object_mut().map(|o| o.remove("mcp"));
                }
                let _ = write_json(&path, &root);
            }
        }
    }
    for plugin_path in [opencode_plugin_path(), legacy_opencode_plugin_path()] {
        if plugin_path.exists() {
            let _ = std::fs::remove_file(&plugin_path);
        }
    }
    Ok(())
}

/// Whether we currently have hooks installed for `agent`.
pub fn status(agent: &str) -> bool {
    let path = match settings_path(agent) {
        Ok(p) => p,
        Err(_) => return false,
    };
    if agent == "grok" {
        return path.exists() && pane_event_script_path().exists();
    }
    let s = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let root: Value = match serde_json::from_str(&s) {
        Ok(v) => v,
        Err(_) => return false,
    };
    root.get("hooks")
        .and_then(|h| h.get(EVENTS[0]))
        .and_then(|e| e.as_array())
        .map(|arr| arr.iter().any(group_is_managed))
        .unwrap_or(false)
}

/// Re-write the hook entries of every agent that already has them, so a build
/// that changes [`hook_command`] reaches installs that were set up by an older
/// one. Without this, the command sitting in a user's `settings.json` is
/// whatever version installed it — and a status fix that lives in that command
/// (Notification carrying its `message`, so the 60s idle nudge stops counting
/// as "needs input") would only land for people who happened to reinstall.
/// Never installs where nothing was installed; `install` is idempotent and
/// touches only our own managed groups.
pub fn refresh_installed() {
    for agent in ["claude", "codex", "grok"] {
        if !status(agent) || commands_are_current(agent) {
            continue;
        }
        if let Err(e) = install(agent) {
            tracing::warn!(target: "flock_desktop_lib", "failed to refresh {agent} hooks: {e}");
        }
    }
}

/// Whether this agent's settings already hold the commands this build writes —
/// the common case, and worth checking so launching flock doesn't rewrite
/// (and reformat) a file in the user's home for nothing.
fn commands_are_current(agent: &str) -> bool {
    let Ok(path) = settings_path(agent) else {
        return false;
    };
    let Ok(s) = std::fs::read_to_string(&path) else {
        return false;
    };
    if agent == "grok" {
        // Both halves, because the file names a script that has to exist and
        // be the current one: a hook pointing at a stale (or missing) script
        // fails silently, which is the failure mode this whole module is
        // written to avoid.
        let script = pane_event_script_path();
        let want = serde_json::to_string_pretty(&grok_hooks_json(&script)).unwrap_or_default();
        return s == want
            && std::fs::read_to_string(&script).is_ok_and(|on_disk| {
                on_disk == pane_event_script(&hooks_log_path())
            });
    }
    EVENTS.iter().all(|event| s.contains(&escape_for_json(&hook_command(agent, event))))
}

/// How serde_json will render a command inside the settings file, so a plain
/// substring check against the file's text is meaningful.
fn escape_for_json(command: &str) -> String {
    let quoted = Value::String(command.to_string()).to_string();
    quoted[1..quoted.len() - 1].to_string()
}

/// Tail the hook logs for new lines and re-emit each as a `hook://event`
/// Tauri event. Polling rather than a filesystem-events crate — the files are
/// tiny and append-only, so a cheap length-check every ~800ms is plenty
/// responsive without adding a new dependency.
///
/// Two sources, and the difference is a boundary, not bookkeeping:
/// `~/.flock/hooks.jsonl` is the machine-wide log every *host* pane appends to,
/// and `~/.flock/hooks.d/<pane>.jsonl` is one file per *jailed* pane — the only
/// part of the host's `~/.flock` a container is given. Lines from the latter
/// are honoured only for the pane the file is named after; see
/// [`pane_owns_line`].
pub fn spawn_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    // Raw tokio::spawn panics here ("no reactor running") — this is called
    // from inside Builder::setup(), before Tauri's own Tokio runtime is
    // entered on this thread. tauri::async_runtime::spawn schedules onto
    // Tauri's managed runtime instead, which is always available.
    tauri::async_runtime::spawn(async move {
        let path = hooks_log_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if !path.exists() {
            let _ = std::fs::write(&path, "");
        }
        let mut pos: u64 = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut rotate_disabled = false;

        // Jailed panes each write their own file (see `jail_hooks_dir`). Seed
        // the ones already on disk at their current length so a launch does not
        // replay a previous run's events, and let files that appear later start
        // from zero — those are panes this run just spawned.
        prune_jail_logs();
        let mut jail_pos: HashMap<PathBuf, u64> = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(jail_hooks_dir()) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    jail_pos.insert(entry.path(), meta.len());
                }
            }
        }

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;

            // Every jailed pane's own log, each with its own read position. A
            // line is only honoured for the pane the FILE is named after: the
            // agent writes the contents, flock chose the name, and that is the
            // only part of a jailed status report the agent cannot forge.
            if let Ok(entries) = std::fs::read_dir(jail_hooks_dir()) {
                for entry in entries.flatten() {
                    let jail_path = entry.path();
                    let Some(pane) = jail_path.file_stem().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    if jail_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let pane = pane.to_string();
                    let start = *jail_pos.get(&jail_path).unwrap_or(&0);
                    let Some((text, new_pos)) = read_appended(&jail_path, start) else {
                        continue;
                    };
                    jail_pos.insert(jail_path.clone(), new_pos);
                    for line in text.lines() {
                        if line.trim().is_empty() {
                            continue;
                        }
                        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                        if !pane_owns_line(&pane, &v) {
                            tracing::warn!(target: "flock_desktop_lib", pane = %pane, "dropped a jail hook line claiming another pane");
                            continue;
                        }
                        apply_event_status(&app, &v).await;
                        let _ = app.emit("hook://event", v);
                    }
                    // A jailed agent controls how much it writes here, so the
                    // cap is ours to enforce. Truncation, for the same reason
                    // the shared log below truncates: the writer holds an
                    // append fd on this inode.
                    if new_pos > MAX_PANE_LOG_BYTES && std::fs::File::create(&jail_path).is_ok() {
                        jail_pos.insert(jail_path, 0);
                    }
                }
            }

            let Some((buf, new_pos)) = read_appended(&path, pos) else {
                continue;
            };
            pos = new_pos;

            for line in buf.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    apply_event_status(&app, &v).await;
                    let _ = app.emit("hook://event", v);
                }
            }

            if pos > MAX_LOG_BYTES && !rotate_disabled {
                // Truncate in place rather than rename: the installed hook
                // appends with a literal `>> ~/.flock/hooks.jsonl`, so a rename
                // leaves it writing to an inode nothing tails until the next
                // launch. Truncation keeps the inode and the loop above already
                // treats a shrunken file as a rotation.
                //
                // Everything up to `pos` has just been handled, so the only
                // thing at risk is a line appended in the moment between the
                // read and this call. That is a live notification feed, not an
                // archive — nothing reads the history, one lost status event
                // resolves itself on the agent's next, and the alternative is a
                // file that grows for the life of the install.
                match std::fs::File::create(&path) {
                    Ok(_) => {
                        pos = 0;
                        tracing::info!(target: "flock_desktop_lib", "rotated the hooks log");
                    }
                    // Keep tailing the oversized file rather than retrying — and
                    // re-logging — every 800ms for the life of the process.
                    Err(e) => {
                        rotate_disabled = true;
                        tracing::warn!(target: "flock_desktop_lib", error = %e, "could not rotate the hooks log; leaving it to grow");
                    }
                }
            }
        }
    });
}

/// Claude Code's idle nudge, fired 60 seconds after an agent goes quiet with
/// nothing pending. Verbatim from the CLI; matched as a substring so a
/// surrounding sentence still counts.
const IDLE_NUDGE: &str = "waiting for your input";

/// What a Notification hook actually means for the pane's status.
///
/// The idle nudge is the single most common hook event a healthy session
/// produces — every agent that finishes and sits there fires one a minute
/// later. Counting those as blocked meant the notification pill drifted
/// upward all day and stopped meaning anything, which is exactly the bug this
/// classifies away. Everything else Claude Code notifies about ("Claude needs
/// your permission to use Bash", and whatever future wording joins it) really
/// does hold the turn open, so an unrecognised message stays AwaitingInput:
/// a missed alert is worse than one extra, and only this one phrasing is
/// known-benign. `None` covers hook lines written by a pre-`message` build.
fn notification_status(message: Option<&str>) -> flock_core::AgentStatus {
    use flock_core::AgentStatus;
    match message {
        Some(m) if m.contains(IDLE_NUDGE) => AgentStatus::Idle,
        _ => AgentStatus::AwaitingInput,
    }
}

/// Route a hook lifecycle event into the pane's status — the sidebar's
/// idle/working signal. Hooks are the authoritative status source: the
/// pty output heuristics can't reliably see modern Claude Code's TUI
/// (its spinner redraws in place, in glyphs the detector predates), so
/// without this every claude pane reads "idle" even mid-task. The
/// heuristic path in pty_bridge stays as a fallback and both converge on
/// the same PaneEntry.status + agent://status event, so whichever speaks
/// last wins and they never disagree for long.
async fn apply_event_status(app: &tauri::AppHandle, event: &Value) {
    use flock_core::AgentStatus;
    use tauri::{Emitter, Manager};

    let Some(pane_id) = event.get("pane_id").and_then(|p| p.as_str()) else {
        return;
    };
    let new = match event.get("event").and_then(|e| e.as_str()) {
        Some("UserPromptSubmit") => AgentStatus::Working,
        // A turn ended: the agent is back at its prompt, not "done" —
        // done/failed stay reserved for process exit (see pty_bridge).
        Some("Stop") | Some("SessionStart") => AgentStatus::Idle,
        // Either a real ask or the 60s idle nudge — the message says which.
        Some("Notification") => {
            notification_status(event.get("message").and_then(|m| m.as_str()))
        }
        _ => return,
    };

    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    // Ours or nobody's. Every flock on the machine tails the same
    // `~/.flock/hooks.jsonl` (the path resolves through `shared_data_dir()`, so
    // a `tauri dev` build reads the installed app's lines too), and this lookup
    // is the whole ownership check: a pane another instance spawned is not in
    // our map, so its prompts are never counted here and its status is never
    // touched. Same rule App.tsx applies before crediting a flock ID.
    // Take the pieces out of the map and release the panes guard before any
    // database round trip: every spawn/resize/close queues behind that lock.
    let (status, recorder) = {
        let panes = state.panes.read().await;
        let Some(entry) = panes.get(pane_id) else {
            return;
        };
        (entry.status.clone(), entry.provenance.clone())
    };
    // A prompt is counted on the event, not on the status change — two
    // prompts in a row leave the pane Working throughout and are still two.
    if event.get("event").and_then(|e| e.as_str()) == Some("UserPromptSubmit") {
        if let Some(rec) = &recorder {
            rec.prompt().await;
        }
    }
    // Record and emit under the status write guard, exactly as
    // `pty_bridge::apply_status` does: the two paths race, and an emit outside
    // the guard can land in the opposite order of the writes, leaving the
    // frontend showing a status the pane map disagrees with.
    let mut s = status.write().await;
    if *s != new {
        *s = new;
        if let Some(rec) = &recorder {
            rec.status(new.as_str()).await;
        }
        let _ = app.emit(
            &format!("agent://status/{pane_id}"),
            crate::events::AgentStatusEvent {
                pane_id: pane_id.to_string(),
                status: new.as_str().to_string(),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flock_core::AgentStatus;
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// Run a hook body the way an agent does — payload on stdin, one JSON line
    /// on stdout — and hand back what the watcher would parse. The command
    /// lands in a user's `settings.json` as an escaped string inside an escaped
    /// string, so nothing short of running it proves the quoting is right.
    fn run_hook(event: &str, stdin_payload: &str) -> Value {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(hook_body("claude", event))
            .env("FLOCK_PANE_ID", "pane-1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("sh is available");
        child.stdin.take().unwrap().write_all(stdin_payload.as_bytes()).unwrap();
        let out = child.wait_with_output().expect("hook runs");
        let line = String::from_utf8(out.stdout).expect("hook writes utf-8");
        serde_json::from_str(line.trim()).unwrap_or_else(|e| panic!("hook wrote invalid JSON ({e}): {line}"))
    }

    /// The jail files are written by the agent, so `read_appended` has to
    /// survive whatever lands in them. A bad byte used to make it return
    /// `None` without advancing — the watcher then re-read a growing file
    /// from the same offset forever and dropped every later event.
    #[test]
    fn a_bad_byte_costs_its_line_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("hooks-badbyte-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pane.jsonl");
        std::fs::write(&path, b"{\"ok\":1}\n\xff\xfe garbage\n{\"ok\":2}\n").unwrap();
        let (text, new_pos) = read_appended(&path, 0).expect("a bad byte must not read as nothing");
        assert_eq!(new_pos, std::fs::metadata(&path).unwrap().len());
        assert!(text.contains("{\"ok\":1}"));
        assert!(text.contains("{\"ok\":2}"));
    }

    /// One tick loads at most `MAX_READ_BYTES`, whole lines only; the rest is
    /// there for the next tick at the returned position.
    #[test]
    fn one_tick_reads_a_bounded_amount() {
        let dir = std::env::temp_dir().join(format!("hooks-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pane.jsonl");
        let line = format!("{{\"pad\":\"{}\"}}\n", "x".repeat(1023));
        std::fs::write(&path, line.repeat(2048)).unwrap(); // ~2 MiB of 1 KiB lines
        let len = std::fs::metadata(&path).unwrap().len();

        let (text, mid) = read_appended(&path, 0).unwrap();
        assert!(mid < len, "the read must stop at the cap");
        assert!(mid <= MAX_READ_BYTES);
        assert!(text.ends_with('\n'), "a capped read hands back whole lines");
        for l in text.lines() {
            assert!(serde_json::from_str::<Value>(l).is_ok(), "no line was cut in half");
        }

        let mut at = mid;
        while let Some((_, next)) = read_appended(&path, at) {
            assert!(next > at, "every tick makes progress");
            at = next;
        }
        assert_eq!(at, len, "later ticks pick up where the cap stopped");
    }

    #[test]
    fn notification_hook_forwards_its_message() {
        let v = run_hook("Notification", r#"{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}"#);
        assert_eq!(v["event"], "Notification");
        assert_eq!(v["pane_id"], "pane-1");
        assert_eq!(v["message"], "Claude needs your permission to use Bash");
        assert_eq!(notification_status(v["message"].as_str()), AgentStatus::AwaitingInput);
    }

    #[test]
    fn the_idle_nudge_does_not_read_as_a_block() {
        // The regression: this fires for every agent that finishes and sits
        // there for a minute, and used to light "N agents need input".
        let v = run_hook("Notification", r#"{"message":"Claude is waiting for your input","hook_event_name":"Notification"}"#);
        assert_eq!(v["message"], "Claude is waiting for your input");
        assert_eq!(notification_status(v["message"].as_str()), AgentStatus::Idle);
    }

    #[test]
    fn a_hostile_message_still_yields_one_parseable_line() {
        // Quotes and backslashes in the payload must not escape our own field:
        // the line has already parsed by the time we get here.
        let v = run_hook("Notification", r#"{"message":"weird \"quoted\" and back\\slash","hook_event_name":"Notification"}"#);
        assert!(v["message"].is_string());
        // No message at all (or a payload we can't read) is treated as a real
        // ask, which is also what a pre-`message` hook line looks like.
        let v = run_hook("Notification", r#"{"hook_event_name":"Notification"}"#);
        assert_eq!(v["message"], "");
        assert_eq!(notification_status(None), AgentStatus::AwaitingInput);
    }

    #[test]
    fn lifecycle_hooks_stay_a_single_line_without_reading_stdin() {
        for event in ["SessionStart", "UserPromptSubmit", "Stop"] {
            let v = run_hook(event, "");
            assert_eq!(v["event"], event);
            assert!(v.get("message").is_none(), "{event} has no message to carry");
            assert!(v["time"].is_number());
        }
    }

    /// A jailed agent writes its own hook file, so the only thing keeping it
    /// from reporting statuses for panes it has nothing to do with — another
    /// workspace's agent, an unjailed host session — is that the file's name is
    /// flock's and the watcher checks the line against it.
    #[test]
    fn a_jail_cannot_speak_for_another_pane() {
        let mine = json!({"event": "Stop", "pane_id": "pane-a"});
        assert!(pane_owns_line("pane-a", &mine));
        assert!(!pane_owns_line("pane-b", &mine));
        // A line with no pane at all is not a line about this pane either.
        assert!(!pane_owns_line("pane-a", &json!({"event": "Stop"})));
        assert!(!pane_owns_line("pane-a", &json!({"pane_id": 7})));
    }

    /// The tail is now driven from a shared helper, and both callers depend on
    /// its truncation behaviour: the shared log rotates by truncation, and a
    /// jail's file is truncated when the agent overruns its cap.
    #[test]
    fn the_tailer_resumes_and_survives_truncation() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("flock-tail-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, "one\n").unwrap();
        let (text, pos) = read_appended(&path, 0).expect("first read");
        assert_eq!(text, "one\n");
        assert_eq!(pos, 4);
        // Nothing new reads as nothing, not as a re-read of the whole file.
        assert!(read_appended(&path, pos).is_none());
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"two\n").unwrap();
        assert_eq!(read_appended(&path, pos).unwrap().0, "two\n");
        // Truncated in place: the next read starts over rather than seeking
        // past the end and going silent for the life of the process.
        std::fs::write(&path, "three\n").unwrap();
        assert_eq!(read_appended(&path, 8).unwrap().0, "three\n");
        let _ = std::fs::remove_file(&path);
    }

    /// Run grok's hook script the way grok runs it — arguments, no stdin —
    /// against a throwaway log, and hand back the line it wrote.
    fn run_grok_hook(args: &[&str], pane: Option<&str>) -> String {
        let log = std::env::temp_dir()
            .join(format!("flock-grok-hook-{}-{}.jsonl", std::process::id(), args[1]));
        let _ = std::fs::remove_file(&log);
        let script = std::env::temp_dir()
            .join(format!("flock-grok-hook-{}-{}.sh", std::process::id(), args[1]));
        std::fs::write(&script, pane_event_script(&log)).unwrap();
        let mut cmd = Command::new("sh");
        cmd.arg(&script).args(args).stdin(Stdio::null());
        match pane {
            Some(p) => cmd.env("FLOCK_PANE_ID", p),
            None => cmd.env_remove("FLOCK_PANE_ID").env_remove("CLARENCE_PANE_ID"),
        };
        let out = cmd.output().expect("sh is available");
        assert!(out.status.success(), "the hook must always exit 0");
        let line = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_file(&log);
        line
    }

    /// The bug this whole grok path exists for: grok expands `$VAR` in a hook
    /// command and refuses to run one naming a variable the environment has
    /// not got. flock's Claude one-liner declares a shell local `_p`, which
    /// grok reads as such a variable — so the hook never ran, and a grok pane
    /// had no status, no prompt count and no provenance, silently.
    #[test]
    fn no_grok_hook_command_names_a_shell_variable() {
        let json = grok_hooks_json(Path::new("/tmp/pane-event.sh")).to_string();
        assert!(!json.contains('$'), "grok would refuse to run this: {json}");
    }

    #[test]
    fn a_grok_hook_writes_one_line_flock_can_read() {
        let line = run_grok_hook(&["grok", "UserPromptSubmit"], Some("pane-1"));
        let v: Value = serde_json::from_str(line.trim()).expect("one parseable line");
        assert_eq!(v["agent"], "grok");
        assert_eq!(v["event"], "UserPromptSubmit");
        assert_eq!(v["pane_id"], "pane-1");
        assert!(v["time"].is_number());
        assert!(v.get("message").is_none(), "no message to carry");
    }

    /// grok types its notifications, so the classification lives in the
    /// matcher rather than in a phrase match on free text. Both messages still
    /// have to land where `notification_status` puts them, because that is the
    /// one function the pill's count comes from.
    #[test]
    fn grok_notification_groups_classify_themselves() {
        let idle = run_grok_hook(&["grok", "Notification", GROK_IDLE_MESSAGE], Some("pane-1"));
        let v: Value = serde_json::from_str(idle.trim()).unwrap();
        assert_eq!(notification_status(v["message"].as_str()), AgentStatus::Idle);

        let perm =
            run_grok_hook(&["grok", "Notification2", GROK_PERMISSION_MESSAGE], Some("pane-1"));
        let v: Value = serde_json::from_str(perm.trim()).unwrap();
        assert_eq!(notification_status(v["message"].as_str()), AgentStatus::AwaitingInput);
    }

    #[test]
    fn the_grok_hook_is_inert_outside_a_flock_pane() {
        // The file sits in grok's own hooks directory, so it loads for every
        // grok session on the machine — including the ones flock knows nothing
        // about. Those must write nothing at all.
        assert_eq!(run_grok_hook(&["grok", "SessionStart"], None), "");
    }

    #[test]
    fn a_freshly_installed_file_needs_no_refresh() {
        // The round-trip that decides whether launching flock rewrites a file
        // in the user's home: what install() writes must read back as current.
        let path = std::env::temp_dir().join(format!("flock-hooks-test-{}.json", std::process::id()));
        let mut root = json!({});
        let hooks = root.as_object_mut().unwrap().entry("hooks").or_insert_with(|| json!({}));
        for event in EVENTS {
            hooks[event] = json!([{ "hooks": [{ "type": "command", "command": hook_command("claude", event) }] }]);
        }
        write_json(&path, &root).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).ok();
        for event in EVENTS {
            assert!(
                written.contains(&escape_for_json(&hook_command("claude", event))),
                "{event} command must be findable in the file it was written to"
            );
        }
    }

    #[test]
    fn the_hook_is_inert_outside_a_flock_pane() {
        // Same settings.json, a plain terminal: no pane id, no log line.
        let out = Command::new("sh")
            .arg("-c")
            .arg(hook_body("claude", "Notification"))
            .env_remove("FLOCK_PANE_ID")
            .env_remove("CLARENCE_PANE_ID")
            .stdin(Stdio::null())
            .output()
            .expect("sh is available");
        assert!(out.stdout.is_empty());
        assert!(out.status.success());
    }
}
