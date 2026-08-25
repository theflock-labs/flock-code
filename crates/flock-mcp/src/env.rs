//! Environment lookup with a legacy-name fallback.
//!
//! flock exports `FLOCK_*` into every agent pane, but hooks already written
//! into users' `~/.claude/settings.json` still pass the pre-rename
//! `CLARENCE_*` names, and those files are not ours to rewrite on their
//! behalf. Read the new name, fall back to the old.
//!
//! DEPRECATED: drop the legacy leg (and this module's fallback) a few releases
//! after the rename ships, once installed hooks have turned over.

/// Read `FLOCK_<NAME>`, falling back to the legacy `CLARENCE_<NAME>`.
///
/// Empty counts as unset in both legs: every caller here treats these as
/// identity, and an empty workspace/person id is a value that matches nothing
/// rather than a meaningful one.
pub fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| {
            name.strip_prefix("FLOCK_")
                .and_then(|suffix| std::env::var(format!("CLARENCE_{suffix}")).ok())
                .filter(|v| !v.is_empty())
        })
}
