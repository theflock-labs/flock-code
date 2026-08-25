//! Per-repo "set this worktree up" command.
//!
//! A git worktree contains only tracked files, so a fresh one has no
//! `node_modules`, no built artifacts, no installed gems. `worktree::carry_over_files`
//! restores the small local config; this restores the *installed* half, by
//! running a project command in the pane before the agent starts.
//!
//! ## Why the command lives here and not in the frontend
//!
//! Unlike every other worktree preference (which are localStorage in
//! `src/lib/worktreeSettings.ts`), this one is stored backend-side and is never
//! passed over IPC at spawn time — `spawn_pane` takes the repo path and looks
//! the command up itself. The string is spliced into the pane's shell as
//! source, so a frontend-supplied one would hand any compromised webview direct
//! shell execution, sidestepping the `ALLOWED_SPAWN_CMDS` allowlist and the
//! shell-quoting that keeps agent args inert. Setting it is still a normal user
//! action; it just has to go through an explicit, auditable command rather than
//! riding along with every spawn.
//!
//! One JSON blob at `~/.flock/worktree_setup.json`, keyed by repo path.
//! Same shape and locking as `pr_watch`.

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::Mutex};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SetupConfig {
    /// repo path → setup command. An entry present but empty means the user
    /// explicitly declined, which is why it isn't pruned: absence is what
    /// makes the dialog offer a suggestion.
    #[serde(default)]
    pub commands: HashMap<String, String>,
}

/// What the new-workspace dialog needs to render the setup field for a repo.
#[derive(Debug, Serialize)]
pub struct SetupInfo {
    /// The stored command, or "" when none is stored.
    pub command: String,
    /// True when this repo has never been answered for — the dialog prefills
    /// `suggestion` in that case, so the user confirms or clears it.
    pub unset: bool,
    /// Command inferred from the repo's lockfiles, or "" if nothing matched.
    pub suggestion: String,
}

/// Through `shared_data_dir`, never a hand-built `~/.flock`: a path that
/// creates the directory itself makes `resolve_dir` see a finished migration
/// and strand the user's `~/.clarence` permanently.
fn state_path() -> PathBuf {
    flock_core::paths::shared_data_dir().join("worktree_setup.json")
}

fn load() -> SetupConfig {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(config: &SetupConfig) -> Result<(), String> {
    let path = state_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

static LOCK: Mutex<()> = Mutex::new(());

/// The setup command for `repo_path`, or None when there is none to run.
pub fn command_for(repo_path: &str) -> Option<String> {
    let _guard = LOCK.lock().unwrap();
    load()
        .commands
        .get(repo_path)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn info_for(repo_path: &str) -> SetupInfo {
    let _guard = LOCK.lock().unwrap();
    let stored = load().commands.get(repo_path).cloned();
    SetupInfo {
        command: stored.clone().unwrap_or_default(),
        unset: stored.is_none(),
        suggestion: suggest(repo_path).unwrap_or_default(),
    }
}

/// Record the user's answer for a repo. An empty command is stored as an empty
/// entry (an explicit "no setup here"), not deleted, so the suggestion isn't
/// offered again every time.
pub fn set_command(repo_path: &str, command: &str) -> Result<(), String> {
    if repo_path.trim().is_empty() {
        return Ok(());
    }
    let _guard = LOCK.lock().unwrap();
    let mut config = load();
    // Bound the stored string: it ends up spliced into a shell line, and
    // nothing legitimate here is a novel.
    let command: String = command.trim().chars().take(2000).collect();
    config.commands.insert(repo_path.to_string(), command);
    save(&config)
}

/// Guess a project's install command from its lockfiles.
///
/// Lockfile-only on purpose. A `package.json` with no lockfile, or a
/// `requirements.txt` with no declared environment, doesn't say *how* the
/// project is installed, and suggesting the wrong thing is worse than
/// suggesting nothing — the user sees this prefilled and may just accept it.
/// Cargo and Go are absent for the same reason: they build on demand, so
/// there's no install step worth several minutes per agent.
pub fn suggest(repo_path: &str) -> Option<String> {
    let repo = Path::new(repo_path);
    // Order matters: a repo can carry more than one lockfile (a stale
    // package-lock.json next to the pnpm one it migrated to). Most specific
    // package managers first.
    const RULES: &[(&str, &str)] = &[
        ("bun.lockb", "bun install"),
        ("bun.lock", "bun install"),
        ("pnpm-lock.yaml", "pnpm install --frozen-lockfile"),
        ("yarn.lock", "yarn install --immutable"),
        ("package-lock.json", "npm ci"),
        ("uv.lock", "uv sync"),
        ("poetry.lock", "poetry install"),
        ("Pipfile.lock", "pipenv sync"),
        ("Gemfile.lock", "bundle install"),
        ("composer.lock", "composer install"),
        ("mix.lock", "mix deps.get"),
    ];
    RULES
        .iter()
        .find(|(file, _)| repo.join(file).is_file())
        .map(|(_, cmd)| cmd.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggest_reads_lockfiles_and_prefers_the_specific_manager() {
        let dir = std::env::temp_dir().join(format!("flock-setup-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_str().unwrap();

        assert_eq!(suggest(p), None);

        std::fs::write(dir.join("package-lock.json"), "{}").unwrap();
        assert_eq!(suggest(p).as_deref(), Some("npm ci"));

        // A repo that migrated to pnpm but still carries the npm lockfile must
        // not be told to run `npm ci`.
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(suggest(p).as_deref(), Some("pnpm install --frozen-lockfile"));

        // A directory named like a lockfile isn't one.
        std::fs::remove_file(dir.join("pnpm-lock.yaml")).unwrap();
        std::fs::remove_file(dir.join("package-lock.json")).unwrap();
        std::fs::create_dir(dir.join("Gemfile.lock")).unwrap();
        assert_eq!(suggest(p), None);

        std::fs::remove_dir_all(&dir).ok();
    }
}
