//! Network egress control for secure-mode panes.
//!
//! The jail ([`crate::container`]) contains the filesystem and the process
//! table; until this module it did nothing about the network. A jailed agent
//! could open any connection the host's network could: the public internet,
//! the developer's LAN, and — verified on Docker Desktop for macOS — services
//! bound to `127.0.0.1` on the *host*, via the `host.docker.internal` name
//! Docker Desktop injects into every container. That is the difference between
//! "the agent cannot read your keys" and "the agent cannot phone them home",
//! and only the first half was true.
//!
//! ## How the restriction works
//!
//! Two containers and one network, all per workspace:
//!
//!   * `flock-jail-<hash>` — a user-defined bridge created with `--internal`,
//!     which is what removes the default route. A container on it has no path
//!     to the internet, the LAN, the host, or `host.docker.internal`, and
//!     cannot resolve external DNS. Nothing inside the jail can lift that: it
//!     is the daemon's routing, not a rule in the container's namespace, which
//!     is why this works with `--cap-drop ALL` where the usual in-container
//!     `iptables` recipe (Anthropic's devcontainer reference) needs NET_ADMIN.
//!   * `flock-egress-<hash>` — the only other container on that network, and
//!     the only thing the jail can reach. It is the same sandbox image running
//!     [`PROXY_SCRIPT`], and it is also attached to the default bridge, so it
//!     alone has egress. The jail gets `HTTPS_PROXY` pointing at it.
//!   * the pane's own container, with `--network flock-jail-<hash>`.
//!
//! The proxy speaks only HTTPS `CONNECT`, and only to hosts on the allowlist.
//! It never terminates TLS — it matches on the hostname in the CONNECT line
//! and then splices bytes — so no certificate is installed anywhere and no
//! request body is readable by flock. Plain HTTP is refused outright rather
//! than proxied, so there is no cleartext path around the same check.
//!
//! ## What this does NOT stop
//!
//! An allowlisted host is a hole the size of that host. `api.anthropic.com` is
//! on the default list because the agent is useless without it, and an agent
//! that wants to exfiltrate the repo can paste it into a conversation. Adding
//! `github.com` (which most real work needs) adds "push to an attacker's fork".
//! The allowlist bounds *who* the agent can talk to, not *what* it can say.
//! The README's security model states this in the terms an operator needs.
//!
//! DNS rebinding is handled, narrowly: the proxy resolves the CONNECT target
//! itself and refuses any address in a loopback, link-local, private or CGNAT
//! range, so an allowlisted name whose A record points at `127.0.0.1` or the
//! LAN cannot be used to reach the proxy's own network neighbours. It does not
//! re-check on reconnect and it does not pin, because the proxy has no state
//! worth attacking beyond that one hop.

use std::path::{Path, PathBuf};

/// Whether a secure pane's network is restricted to the allowlist. Read
/// host-side from [`policy_path`]; deliberately not a parameter the webview
/// can influence, for the same reason `secure` is backend-authoritative in
/// `spawn_pane` — an IPC caller that can turn the jail's network back on has
/// undone the control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Egress {
    /// Today's behaviour: the default bridge, unrestricted.
    Open,
    /// Internal network plus the allowlist proxy.
    Restricted,
}

/// Hosts every install allows when the restriction is on: the agent APIs and
/// the endpoints their sign-in flows use, and nothing else. Deliberately
/// missing: package registries and git forges. Both are needed for most real
/// work and both are exfiltration channels (`npm publish`, `git push`), so
/// they are a decision the operator makes by name in [`allow_file_path`]
/// rather than one flock makes for them.
///
/// A leading dot matches the domain and its subdomains; anything else is an
/// exact host match.
pub const DEFAULT_ALLOW: &[&str] = &[
    // Claude Code: the API, plus console/claude.ai for the OAuth sign-in and
    // statsig.anthropic.com for the feature-flag fetch it makes on startup
    // (a blocked one costs a slow launch, not a failure).
    ".anthropic.com",
    "claude.ai",
    // Codex.
    ".openai.com",
    "chatgpt.com",
    // opencode: its own service and the model catalogue it reads. The provider
    // the user points it at is theirs to allow.
    ".opencode.ai",
    "models.dev",
];

/// Port the in-jail clients are told to proxy through, and the one the proxy
/// listens on. Above 1024 because the proxy runs as the image's unprivileged
/// `node` user.
const PROXY_PORT: u16 = 3128;

/// The allowlist proxy, run inside the sandbox image (no extra base image, no
/// second `apt-get`, nothing to pull). Written into the build context by
/// [`crate::container::write_build_context`] and `COPY`d in by the Dockerfile;
/// its text is part of the image tag's content hash, so editing it rebuilds.
///
/// Deliberately dependency-free and small enough to read in one sitting: it is
/// the whole of the egress control, and a security reviewer should not have to
/// take a proxy's configuration language on trust to audit it.
pub const PROXY_SCRIPT: &str = r##"'use strict';
// flock secure mode: CONNECT-only allowlist proxy. See crates/flock-pty/src/egress.rs.
const http = require('http');
const net = require('net');
const dns = require('dns');

const PORT = Number(process.env.FLOCK_EGRESS_PORT || 3128);
// Comma-separated. A leading dot (or "*.") matches the domain and any
// subdomain; anything else must match the host exactly.
const RULES = (process.env.FLOCK_EGRESS_ALLOW || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
  .map((s) => (s.startsWith('*.') ? s.slice(1) : s));

function hostAllowed(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return RULES.some((r) => (r.startsWith('.') ? h === r.slice(1) || h.endsWith(r) : h === r));
}

// An allowlisted name whose DNS answer points inside the network must not
// become a way to reach the proxy's neighbours, the LAN, or the host.
function isPublic(addr, family) {
  if (family === 4) {
    const p = addr.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
    if (p[0] >= 224) return false;
    return true;
  }
  const a = addr.toLowerCase();
  if (a === '::1' || a === '::') return false;
  if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return false;
  if (a.startsWith('::ffff:')) return isPublic(a.slice(7), 4);
  return true;
}

function deny(sock, why) {
  console.log('flock-egress DENY ' + why);
  try { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (_) {}
}

// Plain HTTP is refused rather than proxied: allowing it would be a cleartext
// path around the same allowlist, and every agent API is HTTPS.
const server = http.createServer((req, res) => {
  console.log('flock-egress DENY plain-http ' + req.url);
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end('flock secure mode: only HTTPS to allowlisted hosts is proxied\n');
});

// A client that resets mid-handshake must not take the proxy down with it:
// the proxy dying is fail-closed (the workspace loses all egress) but it
// reads as flock breaking, and one denied request used to be enough.
server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch (_) {} });
process.on('uncaughtException', (e) => console.log('flock-egress ERROR ' + (e && e.message)));

server.on('connect', (req, client, head) => {
  client.on('error', () => { try { client.destroy(); } catch (_) {} });
  const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(req.url || '');
  if (!m) return deny(client, 'malformed ' + req.url);
  const host = m[1];
  const port = Number(m[2]);
  if (port !== 443) return deny(client, 'port ' + host + ':' + port);
  if (!hostAllowed(host)) return deny(client, 'host ' + host);
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err || !addrs.length) return deny(client, 'dns ' + host);
    const ok = addrs.find((a) => isPublic(a.address, a.family));
    if (!ok) return deny(client, 'private-address ' + host);
    const up = net.connect(port, ok.address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
      console.log('flock-egress ALLOW ' + host);
    });
    up.on('error', () => { try { client.destroy(); } catch (_) {} });
    client.on('close', () => { try { up.destroy(); } catch (_) {} });
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('flock-egress listening, allow=' + RULES.join(' ')));
"##;

/// Path the proxy script is baked to inside the image.
pub const PROXY_SCRIPT_IMAGE_PATH: &str = "/etc/flock/egress-proxy.js";

/// `~/.flock/egress.json` — the one bit that says whether the restriction is
/// on. A file rather than a spawn argument so the webview is not in the loop.
pub fn policy_path() -> Option<PathBuf> {
    Some(crate::container::host_flock_dir()?.join("egress.json"))
}

/// `~/.flock/egress-allow.txt` — the operator's additions, one host per line,
/// `#` for comments. A plain file so it can be managed by whatever a company
/// already uses to manage dotfiles; the Settings pane edits the same file.
pub fn allow_file_path() -> Option<PathBuf> {
    Some(crate::container::host_flock_dir()?.join("egress-allow.txt"))
}

/// The current policy.
///
/// Two failures that look alike and are not:
///
///   * **A corrupt or missing file reads as [`Egress::Open`].** The control is
///     opt-in and off by default, so an unparseable file must not silently
///     strand every secure workspace with no network and no explanation.
///   * **A shared directory that was never injected reads as
///     [`Egress::Restricted`].** That is not a user's configuration, it is this
///     process having spawned a jail before `flock-core` resolved
///     `shared_data_dir()` (see [`crate::container::set_shared_dir`]) — a
///     programming error, and one whose *quiet* answer would be to hand a
///     workspace the operator restricted a jail with the whole network. The
///     control that says "this agent may not reach the internet" is the last
///     one that should guess when it cannot find its own configuration.
///
/// The restricted branch is reachable only from that bug, so it also logs.
pub fn policy() -> Egress {
    policy_in(policy_path())
}

/// The decision itself, against an explicit path so both failures can be
/// tested — `host_flock_dir()` answers with a temp directory under `cfg(test)`,
/// so the un-injected case is unreachable through [`policy`].
pub(crate) fn policy_in(path: Option<PathBuf>) -> Egress {
    let Some(path) = path else {
        tracing::error!(
            target: "flock_pty::egress",
            "egress policy read before the shared data directory was injected; \
             failing closed (restricted). This is a startup-ordering bug: call \
             flock_core::paths::shared_data_dir() before spawning a jail."
        );
        return Egress::Restricted;
    };
    let Ok(text) = std::fs::read_to_string(path) else { return Egress::Open };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if v.get("restrict").and_then(|r| r.as_bool()) == Some(true) => Egress::Restricted,
        _ => Egress::Open,
    }
}

/// Write the policy flag, preserving nothing else (the file has one key).
pub fn set_policy(restrict: bool) -> anyhow::Result<()> {
    let path = policy_path().ok_or_else(|| anyhow::anyhow!("shared data dir not set"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, format!("{{\"restrict\":{restrict}}}\n"))?;
    Ok(())
}

/// One allowlist entry, or `None` if the line is a comment, blank, or not a
/// hostname pattern.
///
/// The filter is not cosmetic. Entries are joined with commas into a single
/// `docker run -e FLOCK_EGRESS_ALLOW=…` value, and that value is shell-quoted
/// into the pane script; a line containing a comma would silently become two
/// rules, and one containing a quote is the shape of an argument-injection
/// bug. Only letters, digits, `-`, `.` and a leading `*.` survive.
fn parse_allow_line(line: &str) -> Option<String> {
    let line = line.split('#').next().unwrap_or("").trim().to_ascii_lowercase();
    if line.is_empty() {
        return None;
    }
    let body = line.strip_prefix("*.").map(|r| format!(".{r}")).unwrap_or(line);
    let checkable = body.strip_prefix('.').unwrap_or(&body);
    if checkable.is_empty() || !checkable.contains('.') {
        return None;
    }
    if !checkable
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return None;
    }
    Some(body)
}

/// The effective allowlist: the built-in agent endpoints plus whatever the
/// operator named, deduplicated and in a stable order (the order feeds a hash
/// that decides whether a running proxy is stale, so it must not wobble).
pub fn allowlist() -> Vec<String> {
    let mut out: Vec<String> = DEFAULT_ALLOW.iter().map(|s| s.to_string()).collect();
    if let Some(path) = allow_file_path() {
        if let Ok(text) = std::fs::read_to_string(path) {
            for line in text.lines() {
                if let Some(entry) = parse_allow_line(line) {
                    out.push(entry);
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Read back the operator's file verbatim for the Settings pane, so editing it
/// there is editing the same file and not a second copy of the list.
pub fn read_allow_file() -> String {
    allow_file_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

/// Write the operator's file. Lines that are not hostname patterns are kept as
/// written — [`allowlist`] drops them at spawn — so a typo is visible in the
/// editor rather than silently deleted from under the person who typed it.
pub fn write_allow_file(text: &str) -> anyhow::Result<()> {
    let path = allow_file_path().ok_or_else(|| anyhow::anyhow!("shared data dir not set"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut text = text.to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    std::fs::write(path, text)?;
    Ok(())
}

/// The per-workspace internal network. Per workspace, not per machine, so two
/// workspaces' jails cannot reach each other either — on a shared network the
/// weaker one's agent is a stepping stone to the stronger one's proxy.
pub fn network_name(workspace_id: &str) -> String {
    format!("flock-jail-{:016x}", crate::container::fnv1a(workspace_id))
}

/// The per-workspace proxy container.
pub fn proxy_name(workspace_id: &str) -> String {
    format!("flock-egress-{:016x}", crate::container::fnv1a(workspace_id))
}

/// Short digest of the effective allowlist, carried as a label on the proxy
/// container. A running proxy whose label does not match the list we would
/// hand it now is stale — the operator edited the file — and is replaced.
fn allow_digest(allow: &[String]) -> String {
    format!("{:016x}", crate::container::fnv1a(&allow.join(",")))
}

/// Env every restricted jail gets, so the agent CLIs, `git`, `npm` and `curl`
/// all route through the proxy. Both cases of each name: `curl` reads the
/// lowercase ones, most Node tooling the uppercase.
pub fn proxy_env(workspace_id: &str) -> Vec<(String, String)> {
    let url = format!("http://{}:{PROXY_PORT}", proxy_name(workspace_id));
    let no_proxy = "localhost,127.0.0.1,::1".to_string();
    vec![
        ("HTTP_PROXY".into(), url.clone()),
        ("http_proxy".into(), url.clone()),
        ("HTTPS_PROXY".into(), url.clone()),
        ("https_proxy".into(), url),
        ("NO_PROXY".into(), no_proxy.clone()),
        ("no_proxy".into(), no_proxy),
    ]
}

/// The shell fragment the pane runs before `docker run`: create the internal
/// network if it is missing, then make sure a proxy container with the current
/// allowlist is up on it.
///
/// Every step is `|| exit 1`. If the network or the proxy cannot be brought up
/// the pane must not start, because the alternative — falling back to the
/// default bridge — is a pane the user believes is network-restricted and is
/// not. Same fail-closed rule as a missing Docker CLI.
pub fn ensure_script(docker: &Path, image: &str, workspace_id: &str, allow: &[String]) -> String {
    let dq = crate::shell_quote(&docker.to_string_lossy());
    let net = crate::shell_quote(&network_name(workspace_id));
    let proxy = crate::shell_quote(&proxy_name(workspace_id));
    let iq = crate::shell_quote(image);
    let allow_env = crate::shell_quote(&format!("FLOCK_EGRESS_ALLOW={}", allow.join(",")));
    let digest = crate::shell_quote(&format!("flock.egress-allow={}", allow_digest(allow)));
    // The image tag is content-hashed over the Dockerfile *and* the proxy
    // script, so labelling the proxy with it and filtering on that label is
    // what makes "reuse the running proxy" safe: a proxy started by an older
    // binary — enforcing an older script — fails the filter and is replaced.
    // Reuse keyed on the allowlist digest alone kept stale enforcers alive
    // across upgrades, which is exactly when the script changes for a reason.
    let img_label = crate::shell_quote(&format!("flock.egress-image={image}"));
    let port = PROXY_PORT;
    let script = crate::shell_quote(PROXY_SCRIPT_IMAGE_PATH);
    format!(
        // `network create` races with a second pane of the same workspace
        // starting at the same moment, so the failure path re-inspects rather
        // than giving up: whichever call lost the race still needs the network
        // that the winner just made.
        // Both halves are written to survive a second pane of the same
        // workspace running this at the same moment: `network create` falls
        // back to re-inspecting (whoever lost the race still needs the network
        // the winner made), and the proxy's success test is re-run at the end
        // rather than taken from its own `docker run` — the loser's run fails
        // on the name, and finding the winner's proxy up is a pass, not an
        // error. Only the final test decides whether the pane may start.
        "if ! {dq} network inspect {net} >/dev/null 2>&1; then \
           {dq} network create --internal {net} >/dev/null 2>&1 || \
             {dq} network inspect {net} >/dev/null 2>&1 || \
             {{ printf 'flock secure mode: could not create the restricted network.\\n'; exit 1; }}; \
         fi; \
         if [ -z \"$({dq} ps -q --filter name=^{proxy}$ --filter label={digest} --filter label={img_label})\" ]; then \
           {dq} rm -f {proxy} >/dev/null 2>&1; \
           if {dq} run -d --name {proxy} --network {net} \
             --label flock.egress-proxy=1 --label {digest} --label {img_label} \
             --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
             -e FLOCK_EGRESS_PORT={port} -e {allow_env} \
             {iq} node {script} >/dev/null 2>&1; then \
             {dq} network connect bridge {proxy} >/dev/null 2>&1 || \
               {dq} rm -f {proxy} >/dev/null 2>&1; \
           fi; \
           if [ -z \"$({dq} ps -q --filter name=^{proxy}$ --filter label={digest} --filter label={img_label})\" ]; then \
             printf 'flock secure mode: the egress proxy would not start; the agent was not launched.\\n'; \
             exit 1; \
           fi; \
         fi; ",
    )
}

/// Remove egress proxies and networks left behind by a previous run.
///
/// A proxy outlives the pane that started it on purpose — the next pane of the
/// same workspace reuses it — so nothing in the pane lifecycle can remove one.
/// This runs at app startup instead, and only removes a proxy whose network
/// has no secure pane still attached, so a second flock instance (or a `tauri
/// dev` build beside the installed app) does not cut its neighbour's egress.
///
/// Blocking; call from a blocking task. Best-effort throughout: a docker that
/// is not running simply leaves the containers for the next launch.
pub fn reap_orphan_proxies(docker: &Path) {
    let run = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new(docker).args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let Some(list) = run(&["ps", "-aq", "--filter", "label=flock.egress-proxy=1"]) else {
        return;
    };
    for id in list.lines().filter(|l| !l.trim().is_empty()) {
        let Some(net) = run(&[
            "inspect",
            "-f",
            "{{range $k, $v := .NetworkSettings.Networks}}{{if ne $k \"bridge\"}}{{$k}}{{end}}{{end}}",
            id,
        ]) else {
            continue;
        };
        if net.is_empty() {
            continue;
        }
        // Anything on that network other than the proxy itself is a live
        // secure pane, and the proxy is the only way it reaches its API. A
        // failed query is not "no peers" — removing on it would cut a live
        // workspace's egress; skip and let the next launch look again.
        let Some(peers) = run(&["ps", "-q", "--filter", &format!("network={net}")]) else {
            continue;
        };
        let peer_count = peers.lines().filter(|l| !l.trim().is_empty()).count();
        if peer_count > 1 {
            continue;
        }
        let _ = run(&["rm", "-f", id]);
        let _ = run(&["network", "rm", &net]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two ways this can fail to find a policy point in opposite
    /// directions, and getting them the same way round is the whole point:
    /// a user's missing/corrupt file is the opt-in control being off, while
    /// no shared directory at all is a startup-ordering bug — and answering
    /// "unrestricted" to that hands a workspace the operator restricted a
    /// jail with the entire network and says nothing.
    #[test]
    fn an_uninjected_shared_dir_fails_closed_but_a_missing_file_does_not() {
        assert_eq!(policy_in(None), Egress::Restricted);

        let dir = std::env::temp_dir().join(format!("flock-egress-policy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("egress.json");

        let _ = std::fs::remove_file(&path);
        assert_eq!(policy_in(Some(path.clone())), Egress::Open, "no file: the control is off");

        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(
            policy_in(Some(path.clone())),
            Egress::Open,
            "a corrupt file must not strand every secure workspace with no network"
        );

        std::fs::write(&path, r#"{"restrict":false}"#).unwrap();
        assert_eq!(policy_in(Some(path.clone())), Egress::Open);

        std::fs::write(&path, r#"{"restrict":true}"#).unwrap();
        assert_eq!(policy_in(Some(path.clone())), Egress::Restricted);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn allow_lines_that_are_not_hostnames_are_dropped() {
        assert_eq!(parse_allow_line("api.example.com"), Some("api.example.com".into()));
        assert_eq!(parse_allow_line("  API.Example.COM  "), Some("api.example.com".into()));
        assert_eq!(parse_allow_line("*.example.com"), Some(".example.com".into()));
        assert_eq!(parse_allow_line(".example.com"), Some(".example.com".into()));
        assert_eq!(parse_allow_line("example.com # the CDN"), Some("example.com".into()));
        assert_eq!(parse_allow_line("# just a comment"), None);
        assert_eq!(parse_allow_line(""), None);
        // A bare label is not a host worth allowing, and matching it would be
        // ambiguous against the suffix rules.
        assert_eq!(parse_allow_line("localhost"), None);
        // The entries are joined with commas and shell-quoted into the pane
        // script. Anything that could split a rule in two, or close a quote,
        // must never reach that string.
        assert_eq!(parse_allow_line("evil.com,also-evil.com"), None);
        assert_eq!(parse_allow_line("evil.com' -e FOO=bar '"), None);
        assert_eq!(parse_allow_line("evil.com:443"), None);
        assert_eq!(parse_allow_line("https://evil.com"), None);
        assert_eq!(parse_allow_line("evil.com/path"), None);
        assert_eq!(parse_allow_line("$(id).com"), None);
    }

    #[test]
    fn the_default_allowlist_covers_the_agents_and_nothing_else() {
        let allow = DEFAULT_ALLOW;
        assert!(allow.contains(&".anthropic.com"));
        assert!(allow.contains(&".openai.com"));
        // Registries and forges are the operator's call, by name: allowing
        // them is allowing `npm publish` and `git push` as exfiltration.
        assert!(!allow.iter().any(|h| h.contains("npmjs")));
        assert!(!allow.iter().any(|h| h.contains("github")));
        assert!(!allow.iter().any(|h| h.contains("pypi")));
        // Every default must survive the same parse the operator's lines get.
        for h in allow {
            assert_eq!(parse_allow_line(h).as_deref(), Some(*h), "default {h} is not a valid rule");
        }
    }

    #[test]
    fn network_and_proxy_names_are_stable_and_per_workspace() {
        assert_eq!(network_name("ws-a"), network_name("ws-a"));
        assert_ne!(network_name("ws-a"), network_name("ws-b"));
        assert_ne!(proxy_name("ws-a"), network_name("ws-a"));
        // Docker-safe from an arbitrary workspace id (they can contain `:`
        // and `/` — see the copilot:/observe: session ids).
        let n = proxy_name("copilot:weird/id");
        assert!(n
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    }

    #[test]
    fn the_ensure_script_fails_closed_and_never_publishes_the_jail() {
        let allow = vec![".anthropic.com".to_string()];
        let s = ensure_script(Path::new("/usr/local/bin/docker"), "img", "ws-1", &allow);
        // The network is what removes the default route; without --internal
        // the whole control is decorative.
        assert!(s.contains("network create --internal"));
        // Both failure paths stop the pane rather than falling back to an
        // unrestricted spawn: no network, and no proxy on it.
        assert_eq!(s.matches("exit 1").count(), 2);
        assert!(s.contains("--cap-drop ALL"));
        assert!(s.contains("--security-opt no-new-privileges"));
        // The proxy reaches the internet; the jail reaches the proxy. A proxy
        // that came up without that second attach is torn down, so the final
        // test below fails and the pane does not launch with a proxy that can
        // reach nothing.
        assert!(s.contains("network connect bridge"));
        assert!(s.contains("rm -f"));
        // The decision is the re-test, not the exit status of `docker run` —
        // that is what lets the loser of a two-pane race use the winner's
        // proxy instead of failing on the name conflict.
        let checks = s.matches("ps -q --filter name=").count();
        assert_eq!(checks, 2, "the proxy must be re-tested after the attempt: {s}");
        // The allowlist rides in as one env var, quoted.
        assert!(s.contains("'FLOCK_EGRESS_ALLOW=.anthropic.com'"));
    }

    #[test]
    fn a_changed_allowlist_replaces_a_running_proxy() {
        let a = ensure_script(Path::new("/docker"), "img", "ws-1", &[".anthropic.com".into()]);
        let b = ensure_script(
            Path::new("/docker"),
            "img",
            "ws-1",
            &[".anthropic.com".into(), "registry.npmjs.org".into()],
        );
        // Same container name, different label — the `docker ps --filter
        // label=` guard therefore misses the stale one and it is recreated.
        assert!(a.contains(&proxy_name("ws-1")) && b.contains(&proxy_name("ws-1")));
        let digest_of = |s: &str| {
            s.split("flock.egress-allow=")
                .nth(1)
                .and_then(|r| r.split('\'').next())
                .unwrap()
                .to_string()
        };
        assert_ne!(digest_of(&a), digest_of(&b));
    }

    #[test]
    fn proxy_env_points_every_client_at_the_proxy() {
        let env = proxy_env("ws-1");
        let url = format!("http://{}:{PROXY_PORT}", proxy_name("ws-1"));
        for key in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
            assert_eq!(
                env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()),
                Some(url.as_str()),
                "{key} must point at the proxy"
            );
        }
    }

    /// The proxy is the whole control, so the properties that make it one are
    /// pinned here rather than left to review.
    #[test]
    fn the_proxy_script_is_connect_only_and_checks_the_allowlist() {
        assert!(PROXY_SCRIPT.contains("server.on('connect'"));
        // Plain HTTP is answered with a refusal, never forwarded.
        assert!(PROXY_SCRIPT.contains("only HTTPS to allowlisted hosts is proxied"));
        assert!(PROXY_SCRIPT.contains("if (!hostAllowed(host)) return deny"));
        assert!(PROXY_SCRIPT.contains("if (port !== 443) return deny"));
        // And the rebinding guard, which is what stops an allowlisted name
        // resolving to the LAN or to the proxy's own neighbours.
        assert!(PROXY_SCRIPT.contains("private-address"));
        // A reset client must not kill the proxy: fail-closed is safe but the
        // whole workspace loses its network, and one denial used to do it.
        assert!(PROXY_SCRIPT.contains("clientError"));
    }

    /// The restriction, proven against a real daemon rather than asserted
    /// against an argument vector.
    ///
    /// Everything that could make this feature a lie lives past the strings:
    /// whether `--internal` really removes the route, whether the proxy is
    /// reachable by name from the jail, whether an agent that ignores
    /// `HTTPS_PROXY` can just open the socket itself, and whether
    /// `host.docker.internal` — which on Docker Desktop reaches services bound
    /// to 127.0.0.1 on the user's Mac — is still there. Four probes, one pane.
    ///
    /// Ignored by default: needs a running Docker daemon, may build the sandbox
    /// image, and makes real requests. Run it before touching this module:
    ///   cargo test -p flock-pty -- --ignored --test-threads=1 restricted
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn a_restricted_jail_reaches_the_allowlist_and_nothing_else() {
        use portable_pty::CommandBuilder;
        use std::time::Duration;

        let docker = crate::container::docker_path().expect("docker CLI");
        let context = crate::container::write_build_context().expect("build context");
        let image = crate::container::image_tag();
        let workspace = "e2e-egress-workspace";
        let allow = vec![".anthropic.com".to_string()];
        // Start clean: a run that ended badly leaves the pane container behind
        // and every later run then dies on the name conflict instead of testing
        // anything.
        for name in ["flock-e2e-egress", &proxy_name(workspace)] {
            let _ = std::process::Command::new(&docker).args(["rm", "-f", name]).output();
        }

        // `--noproxy '*'` is the interesting half: it is what an agent that
        // does not honour proxy env does, and on the internal network it must
        // find no route rather than a way around the allowlist.
        let probe = "printf 'ALLOWED='; curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://api.anthropic.com/v1/messages; echo; \
                     printf 'DENIED='; curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://example.com; echo; \
                     printf 'DIRECT='; curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 https://example.com; echo; \
                     printf 'HOSTNAME_RESOLVES='; getent hosts host.docker.internal >/dev/null 2>&1 && echo yes || echo no; \
                     echo FLOCK_EGRESS_PROBE_DONE";
        let launch = crate::launch_line("sh", &["-c", probe], None);
        let args = crate::container::run_args(&crate::container::RunSpec {
            name: "flock-e2e-egress",
            image: &image,
            agent: "sh",
            cwd: None,
            launch: &launch,
            extra_env: &[("FLOCK_PANE_ID", "e2e-egress")],
            workspace_id: workspace,
            pane_id: "e2e-egress",
            egress: Egress::Restricted,
        });
        let script = crate::container::build_pane_script(
            &docker,
            &image,
            &context,
            &args,
            &ensure_script(&docker, &image, workspace, &allow),
        );

        let mut builder = CommandBuilder::new("/bin/sh");
        builder.arg("-c");
        builder.arg(&script);
        builder.env("PATH", crate::augmented_path());
        builder.env("TERM", "xterm-256color");
        let (pty, mut rx) = crate::spawn_pty_child(builder, 24, 120, None, None).expect("spawn");

        let out = tokio::time::timeout(Duration::from_secs(420), async move {
            let mut acc: Vec<u8> = Vec::new();
            while let Some(chunk) = rx.recv().await {
                acc.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&acc).contains("FLOCK_EGRESS_PROBE_DONE") {
                    break;
                }
            }
            String::from_utf8_lossy(&acc).to_string()
        })
        .await
        .unwrap_or_default();

        // `pty.kill()` reaches the docker *client*; the pane's own container,
        // the proxy and the network all outlive it and would fail the next run
        // on a name conflict.
        let _ = pty.kill();
        let _ = std::process::Command::new(&docker)
            .args(["rm", "-f", "flock-e2e-egress"])
            .output();
        let _ = std::process::Command::new(&docker)
            .args(["rm", "-f", &proxy_name(workspace)])
            .output();
        let _ = std::process::Command::new(&docker)
            .args(["network", "rm", &network_name(workspace)])
            .output();
        let _ = std::fs::remove_file(
            crate::container::host_flock_dir()
                .unwrap()
                .join(crate::container::JAIL_HOOKS_DIR)
                .join("e2e-egress.jsonl"),
        );

        assert!(out.contains("FLOCK_EGRESS_PROBE_DONE"), "probe never finished: {out}");
        // The API the agent needs still answers (any status but curl's "could
        // not connect" 000 means the TLS session was established end to end).
        assert!(!out.contains("ALLOWED=000"), "the allowlisted host was unreachable: {out}");
        // Everything else is refused by the proxy…
        assert!(out.contains("DENIED=000"), "a host off the allowlist was reachable: {out}");
        // …and cannot be reached around it either.
        assert!(out.contains("DIRECT=000"), "the jail had a route that bypassed the proxy: {out}");
        // The host's own loopback services are gone with the default bridge.
        assert!(out.contains("HOSTNAME_RESOLVES=no"), "host.docker.internal still resolves: {out}");
    }
}
