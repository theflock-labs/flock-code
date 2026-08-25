//! macOS Seatbelt (`sandbox-exec`) confinement for agent panes.
//!
//! A pane's PTY child is the user's real login shell (see `spawn`), with the
//! agent typed in as its first command. That means anyone who breaks out of the
//! agent — Ctrl+C, an agent shell-escape, `/exit` — lands in a raw shell that
//! has the host's *full* identity: SSH keys, cloud credentials, the app's own
//! `~/.flock` secrets, everything. In a shared cockpit that is a remote code
//! execution primitive handed to whoever you're sharing with.
//!
//! Wrapping the shell in `sandbox-exec` confines the whole pane process tree —
//! shell, agent, and any escaped shell alike — with one Seatbelt profile:
//!   * reads of credential stores are denied (SSH/AWS/GPG/k8s/cloud keys,
//!     keychains, browser session cookies, `~/.flock`);
//!   * writes are denied everywhere except the workspace and temp dirs, so
//!     `rm -rf ~` and dotfile-persistence tricks are defanged.
//!
//! This is blast-radius reduction, not a perfect jail. Two honest limits worth
//! stating out loud:
//!   * Network egress stays open (the agent needs the Anthropic API), so
//!     whatever a process *can* still read, it can still exfiltrate.
//!   * `~/.claude` stays readable because the agent authenticates from it, so
//!     the current session's own API token is reachable by an escaped shell.
//!     Scope that token if it matters.

use std::path::Path;

/// Absolute path to the system Seatbelt driver. Deprecated by Apple but present
/// and functional on every supported macOS; there is no non-deprecated
/// replacement for ad-hoc profiles.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Whether the Seatbelt driver is available to wrap a pane with.
pub fn available() -> bool {
    Path::new(SANDBOX_EXEC).exists()
}

/// `$HOME`-relative directories whose contents are credentials/secrets and must
/// never be readable from inside a shared pane. Note `~/.claude` is deliberately
/// absent — the agent authenticates from it (see module docs).
const DENY_READ_HOME_SUBPATHS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".config/gcloud",
    ".config/gh",
    ".config/flock",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".flock", // app DB + minisign release key + release.env live here
    // Pre-rebrand names. The launch-time migration moves `~/.clarence` to
    // `~/.flock`, but a failed or not-yet-run migration leaves the old
    // directory in place with every secret still in it, so keep denying it.
    ".config/clarence",
    ".clarence",
];

/// `$HOME`-relative macOS stores that hold keychains and browser session data
/// (cookies, saved logins) — a second front for credential theft.
const DENY_READ_LIBRARY_SUBPATHS: &[&str] = &[
    "Library/Keychains",
    "Library/Cookies",
    "Library/Safari",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/com.apple.sharedfilelist",
];

/// Build a Seatbelt profile (SBPL) confining a pane rooted at `home`, with
/// `workspace` (the pane's cwd, if any) kept writable.
///
/// Strategy is default-allow with targeted denies: keep the agent fully
/// functional (it can run git/node/build tools, reach the network, read the
/// repo and system libraries) while removing the two things a hostile pane
/// wants — reading the host's secrets and writing outside the workspace. Later
/// rules win in SBPL, so the broad `deny file-write* $HOME` is punched back
/// through by the `allow file-write* $workspace` that follows it, which is what
/// lets a repo living under `~` stay writable.
pub fn build_profile(home: &str, workspace: Option<&Path>) -> String {
    let mut deny_reads: Vec<String> = Vec::new();
    for sub in DENY_READ_HOME_SUBPATHS {
        deny_reads.push(subpath_rule(&join(home, sub)));
    }
    for sub in DENY_READ_LIBRARY_SUBPATHS {
        deny_reads.push(subpath_rule(&join(home, sub)));
    }

    // Writable roots: temp dirs always, plus the workspace and its
    // symlink-resolved twin (macOS `/tmp`→`/private/tmp`, `/var`→`/private/var`
    // mean the kernel enforces on the resolved path, so allow both forms).
    let mut allow_writes: Vec<String> = vec![
        subpath_rule("/private/tmp"),
        subpath_rule("/private/var/folders"),
        subpath_rule("/tmp"),
    ];
    if let Some(ws) = workspace {
        for form in path_forms(ws) {
            allow_writes.push(subpath_rule(&form));
        }
    }

    format!(
        "(version 1)\n\
         (allow default)\n\
         ; --- deny reads of credential/secret stores ---\n\
         (deny file-read*\n{})\n\
         ; --- confine writes to the workspace and temp ---\n\
         (deny file-write* (subpath {}))\n\
         (allow file-write*\n{})\n",
        indent(&deny_reads),
        quote(home),
        indent(&allow_writes),
    )
}

/// The distinct absolute forms a path may be enforced under: the raw path plus
/// its fully symlink-resolved form when they differ.
fn path_forms(p: &Path) -> Vec<String> {
    let raw = p.to_string_lossy().into_owned();
    match std::fs::canonicalize(p) {
        Ok(c) => {
            let canon = c.to_string_lossy().into_owned();
            if canon == raw {
                vec![raw]
            } else {
                vec![raw, canon]
            }
        }
        Err(_) => vec![raw],
    }
}

fn join(home: &str, sub: &str) -> String {
    format!("{}/{}", home.trim_end_matches('/'), sub)
}

fn subpath_rule(path: &str) -> String {
    format!("(subpath {})", quote(path))
}

/// Quote a filesystem path as an SBPL string literal, escaping the only two
/// characters that are special inside one.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn indent(rules: &[String]) -> String {
    rules
        .iter()
        .map(|r| format!("  {r}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn profile_denies_secrets_and_scopes_writes() {
        let p = build_profile("/Users/x", Some(Path::new("/Users/x/git/repo")));
        assert!(p.contains("(subpath \"/Users/x/.ssh\")"));
        assert!(p.contains("(subpath \"/Users/x/.flock\")"));
        // The pre-rebrand directory stays denied for un-migrated homes.
        assert!(p.contains("(subpath \"/Users/x/.clarence\")"));
        assert!(p.contains("(subpath \"/Users/x/Library/Keychains\")"));
        // ~/.claude must stay readable so the agent can authenticate.
        assert!(!p.contains("/Users/x/.claude\""));
        // Home writes denied, workspace re-allowed after.
        let deny_at = p.find("(deny file-write* (subpath \"/Users/x\"))").unwrap();
        let allow_at = p.find("/Users/x/git/repo").unwrap();
        assert!(allow_at > deny_at, "workspace allow must follow the home deny");
    }

    #[test]
    fn quote_escapes_specials() {
        assert_eq!(quote("/a/b"), "\"/a/b\"");
        assert_eq!(quote("/a\"b"), "\"/a\\\"b\"");
    }
}
