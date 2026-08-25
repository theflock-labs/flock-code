use anyhow::Result;
use bytes::Bytes;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

pub mod container;
pub mod egress;
pub mod sandbox;
pub mod themes;

#[derive(Clone)]
pub struct PtyHandle {
    inner: Arc<PtyInner>,
}

/// For container panes: how to tear the container down when the pane is
/// killed. SIGKILLing the pane's process group only kills the `docker run`
/// *client*; the container itself lives on in the VM without this.
struct ContainerCleanup {
    docker: std::path::PathBuf,
    name: String,
}

struct PtyInner {
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    exit_rx: Mutex<Option<oneshot::Receiver<i32>>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child_pid: Option<u32>,
    container: Option<ContainerCleanup>,
}

impl PtyHandle {
    pub fn send_input(&self, data: &[u8]) -> Result<()> {
        use std::io::Write;
        let mut w = self.inner.writer.lock().unwrap();
        w.write_all(data)?;
        Ok(())
    }

    /// Forcibly terminate the pane's process tree (the wrapping shell and
    /// whatever it's running, e.g. the agent). Sends SIGKILL to the whole
    /// process *group*, not just the shell's own PID: the shell is the
    /// session/group leader (portable-pty calls setsid() when spawning), so
    /// a single-PID kill only hits the shell and leaves the agent orphaned
    /// — relying on the shell to notice and forward the signal is exactly
    /// the kind of thing that made close-then-reopen hang once the agent
    /// stopped being the direct PTY child (see the Ctrl+C shell-wrap fix).
    #[cfg(unix)]
    pub fn kill(&self) -> Result<()> {
        if let Some(pid) = self.inner.child_pid {
            // Guard against pid 0: kill(0, SIGKILL) would target every
            // process in the current process group (i.e. the whole app).
            if pid == 0 {
                return Ok(());
            }
            // Negative pid targets the process group in POSIX kill(2).
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        self.remove_container();
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn kill(&self) -> Result<()> {
        self.remove_container();
        Ok(())
    }

    /// Best-effort, fire-and-forget `docker rm -f` for container panes —
    /// killing the docker *client* (above) detaches but does not stop the
    /// container, so an explicit removal is the only thing standing between
    /// "close pane" and an orphaned agent still running in the VM.
    fn remove_container(&self) {
        if let Some(c) = &self.inner.container {
            let _ = std::process::Command::new(&c.docker)
                .args(["rm", "-f", &c.name])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }

    pub fn poll_exit(&self) -> Option<i32> {
        let mut guard = self.inner.exit_rx.lock().unwrap();
        if let Some(rx) = guard.as_mut() {
            match rx.try_recv() {
                Ok(code) => {
                    *guard = None;
                    Some(code)
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    *guard = None;
                    Some(1)
                }
                Err(oneshot::error::TryRecvError::Empty) => None,
            }
        } else {
            None
        }
    }

    /// Resize the PTY terminal dimensions.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        let master = self.inner.master.lock().unwrap();
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow::anyhow!("pty resize failed: {e}"))
    }
}

/// Spawn an interactive login shell in a PTY, then type `cmd`/`args` into it
/// as the shell's first command. The shell (not the agent) is the actual PTY
/// child, so the pane keeps full job control — Ctrl+C interrupts `cmd` as a
/// foreground job, and once it exits the pane drops back to a normal shell
/// prompt instead of dying.
///
/// `cwd` sets the working directory. `rows`/`cols` should match the pane
/// dimensions so the agent's own TUI (Claude Code, etc.) lays out correctly.
///
/// `extra_env` is exported into the shell (and therefore inherited by the
/// agent CLI *and every subprocess it spawns* — hooks, MCP servers). This is
/// the identity channel: FLOCK_PANE_ID / FLOCK_WORKSPACE_ID /
/// FLOCK_AGENT_NAME let downstream tools attribute their work to the
/// right pane without any per-tool configuration.
///
/// `setup` is an optional shell command run in the pane, in `cwd`, before the
/// agent launches — how a freshly-created git worktree gets its `npm install`.
/// See [`launch_line`] for the exact semantics.
pub fn spawn(
    cmd: &str,
    args: &[&str],
    rows: u16,
    cols: u16,
    cwd: Option<&Path>,
    extra_env: &[(&str, &str)],
    setup: Option<&str>,
) -> Result<(PtyHandle, mpsc::Receiver<Bytes>)> {
    spawn_impl(cmd, args, rows, cols, cwd, extra_env, false, setup)
}

/// The shell line that a pane runs: the agent command, optionally preceded by
/// a project setup command.
///
/// The agent's own command is shell-quoted (its args can carry a multi-KB
/// system prompt and must never be re-interpreted). The setup command is NOT:
/// it is a shell command by definition — the user writes things like
/// `npm ci && npx playwright install` — so it is spliced in as source.
///
/// Sequenced with `;`, never `&&`: a failed setup must still leave the agent
/// running. A pane that silently never starts because `npm ci` hit a registry
/// blip is worse than one where the agent is up and the error is right there
/// in the scrollback above it. The failure is called out in-line so it can't
/// be mistaken for the agent's own output.
///
/// Grouped with `{ ...; }` and NOT a `( ... )` subshell, deliberately. A
/// subshell would contain a stray `exit` (which otherwise kills the pane) and
/// a stray `cd`, but it would also throw away everything a setup command is
/// often there to establish: `source .venv/bin/activate`, `nvm use 20`,
/// `direnv allow` all work by mutating the current shell, and the agent needs
/// to inherit that. Setup runs *in the pane's shell*, which is the predictable
/// model and the one that makes those commands mean anything.
///
/// The line ends by announcing itself on the tty ([`AGENT_START_MARKER`])
/// immediately before the agent runs, so the app can tell "flock is still
/// getting this pane ready" from "the agent has the terminal now".
fn launch_line(cmd: &str, args: &[&str], setup: Option<&str>) -> String {
    let agent = std::iter::once(cmd)
        .chain(args.iter().copied())
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    // OSC, so it is swallowed by any terminal parser rather than printed. The
    // shell needs the escapes spelled out for printf.
    let announce = "printf '\\033]777;flock;agent\\007'; ";

    match setup.map(str::trim).filter(|s| !s.is_empty()) {
        None => format!("{announce}{agent}"),
        Some(setup) => {
            // `$?` still holds the setup command's status where it's expanded:
            // `||` doesn't reset it before running the right-hand side.
            let quoted = shell_quote(setup);
            format!(
                "printf '\\033[2m· flock: %s\\033[0m\\n' {quoted}; \
                 {{ {setup}; }} || printf '\\033[33m· flock: setup exited %s, starting the agent anyway\\033[0m\\n' \"$?\"; \
                 {announce}{agent}"
            )
        }
    }
}

/// Written to the pane's tty in the instant between the last thing flock does
/// to prepare the pane and the agent's own first byte.
///
/// Everything before it is plumbing the user did not ask to watch: the shell's
/// startup banner, the echoed `eval` line, a worktree's `npm ci`, a secure
/// pane's image build. The app holds a boot card over the terminal until this
/// arrives, so a fresh pane goes from "starting rex…" straight to the agent's
/// own UI. Mirrored in the frontend as `AGENT_START_MARKER` in
/// `src/lib/agentBoot.ts`; the two must stay byte-identical.
pub const AGENT_START_MARKER: &str = "\x1b]777;flock;agent\x07";

/// Like [`spawn`], but confines the pane's process tree in a macOS Seatbelt
/// sandbox so that escaping the agent to the raw shell can't read the host's
/// credentials or write outside the workspace. See [`sandbox`] for the policy
/// and its limits. Falls back to an unsandboxed spawn (with a warning) if the
/// Seatbelt driver isn't present, so callers never lose a pane over it.
pub fn spawn_sandboxed(
    cmd: &str,
    args: &[&str],
    rows: u16,
    cols: u16,
    cwd: Option<&Path>,
    extra_env: &[(&str, &str)],
    setup: Option<&str>,
) -> Result<(PtyHandle, mpsc::Receiver<Bytes>)> {
    let sandbox = if sandbox::available() {
        true
    } else {
        tracing::warn!("sandbox requested but {} not found; spawning unconfined", sandbox::SANDBOX_EXEC);
        false
    };
    spawn_impl(cmd, args, rows, cols, cwd, extra_env, sandbox, setup)
}

/// Like [`spawn`], but the agent runs inside a Docker container that sees
/// nothing of the host except the workspace directory — the "secure mode"
/// jail that makes bypass-permissions flags safe. See [`container`] for the
/// image, mounts, and confinement flags. Unlike the Seatbelt path this fails
/// closed: no docker CLI, no pane — silently degrading a mode sold as
/// "secure" to an unconfined spawn would be a lie.
///
/// `pane_id` names the container (`flock-<id>`) so [`PtyHandle::kill`] can
/// remove it; pane ids are fresh UUIDs, so names never collide. `workspace_id`
/// selects the per-workspace `$HOME` volume, keeping one workspace's stored
/// agent logins isolated from another's.
///
/// The network policy is read here from the host's own config
/// ([`egress::policy`]) rather than taken as an argument: the caller closest to
/// this is a Tauri command reachable from the webview, and a control the caller
/// can turn off is not a control. Fails closed in the same sense as the docker
/// lookup above — a restricted pane whose proxy will not come up does not
/// launch (see [`container::build_pane_script`]).
pub fn spawn_container(
    cmd: &str,
    args: &[&str],
    rows: u16,
    cols: u16,
    cwd: Option<&Path>,
    extra_env: &[(&str, &str)],
    pane_id: &str,
    workspace_id: &str,
    setup: Option<&str>,
) -> Result<(PtyHandle, mpsc::Receiver<Bytes>)> {
    let docker = container::docker_path().ok_or_else(|| {
        anyhow::anyhow!(
            "secure mode needs Docker: the docker CLI was not found on this machine \
             (install Docker Desktop, or spawn the workspace without secure mode)"
        )
    })?;
    let context_dir = container::write_build_context()?;
    let image = container::image_tag();
    let name = container::container_name(pane_id);

    // Same launch-rides-in-env contract as host panes: the agent command line
    // (which can carry multi-KB args) travels as an env var — here via
    // `docker run -e` into the container bash's init file — never through the
    // tty's 1024-byte canonical input path.
    //
    // Setup runs inside the jail, which is where it belongs: the container's
    // view of the worktree is the one the agent will work in.
    let launch_line = launch_line(cmd, args, setup);
    let policy = egress::policy();
    let run_args = container::run_args(&container::RunSpec {
        name: &name,
        image: &image,
        agent: cmd,
        cwd,
        launch: &launch_line,
        extra_env,
        workspace_id,
        pane_id,
        egress: policy,
    });
    let mut prelude = container::owner_repair_script(&docker, &image, workspace_id);
    if policy == egress::Egress::Restricted {
        prelude.push_str(&egress::ensure_script(&docker, &image, workspace_id, &egress::allowlist()));
    }
    let script = container::build_pane_script(&docker, &image, &context_dir, &run_args, &prelude);

    let mut builder = CommandBuilder::new("/bin/sh");
    builder.arg("-c");
    builder.arg(&script);
    if let Some(dir) = cwd {
        builder.cwd(dir);
    }
    // The docker CLI needs more than the bare Finder PATH: it exec's its
    // credential helper (docker-credential-desktop) from PATH on every image
    // pull, which is exactly what the first-run build does.
    builder.env("PATH", augmented_path());
    if std::env::var("TERM").is_err() {
        builder.env("TERM", "xterm-256color");
    }

    spawn_pty_child(
        builder,
        rows,
        cols,
        None,
        Some(ContainerCleanup { docker, name }),
    )
}

fn spawn_impl(
    cmd: &str,
    args: &[&str],
    rows: u16,
    cols: u16,
    cwd: Option<&Path>,
    extra_env: &[(&str, &str)],
    sandbox: bool,
    setup: Option<&str>,
) -> Result<(PtyHandle, mpsc::Receiver<Bytes>)> {
    // Spawn the user's real interactive login shell rather than exec'ing the
    // agent binary directly. This gives the pane proper job control: Ctrl+C
    // interrupts the agent as a foreground job, and when the agent exits (for
    // any reason — crash, /exit, Ctrl+C) the shell prompt returns instead of
    // leaving a dead, unusable pane. The agent is then launched by typing its
    // command into that shell, exactly as a user would.
    //
    // When sandboxing, `sandbox-exec` becomes the PTY child and `execvp`s the
    // shell in place — it replaces itself, so the shell keeps the same PID and
    // stays session/group leader. Job control and `PtyHandle::kill`'s
    // process-group signal therefore behave identically to the unsandboxed
    // path.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut builder = if sandbox {
        let home = std::env::var("HOME").unwrap_or_default();
        let profile = sandbox::build_profile(&home, cwd);
        let mut b = CommandBuilder::new(sandbox::SANDBOX_EXEC);
        b.arg("-p");
        b.arg(&profile);
        b.arg(&shell);
        b
    } else {
        CommandBuilder::new(&shell)
    };
    builder.arg("-i");
    builder.arg("-l");
    if let Some(dir) = cwd {
        builder.cwd(dir);
    }

    builder.env("PATH", augmented_path());
    // Pass through TERM so colors/TUI rendering work
    if std::env::var("TERM").is_err() {
        builder.env("TERM", "xterm-256color");
    }
    // Identity + context env (see doc comment). Inherited by the agent CLI
    // and whatever it spawns — hook subprocesses, MCP servers.
    for (key, value) in extra_env {
        builder.env(key, value);
    }

    // The launch command rides in as an env var and only a tiny `eval` line
    // is typed into the shell (below). It must NOT be typed verbatim: a
    // freshly-started shell's tty is still in canonical mode, where a single
    // input line is capped at MAX_CANON (1024 bytes on macOS). A longer line
    // (agent args can carry a multi-KB system prompt) gets truncated or
    // discarded, and its echo can flood the not-yet-drained output queue —
    // wedging this write, and with it the spawning thread, forever. The var
    // unsets itself before the agent starts so the agent never inherits it.
    let launch_line = launch_line(cmd, args, setup);
    let launch_env = format!("unset FLOCK_LAUNCH CLARENCE_LAUNCH; clear; {launch_line}");
    builder.env("FLOCK_LAUNCH", &launch_env);
    // Deprecated mirror under the pre-rebrand name, for rc files and scripts
    // that branch on it. Both are unset by the eval before the agent starts, so
    // nothing downstream inherits either. Drop it with the rest of the
    // CLARENCE_* mirrors a few releases out.
    builder.env("CLARENCE_LAUNCH", &launch_env);

    // Launch the agent in the freshly-started shell, as if the user had
    // entered the command themselves at the prompt: the FLOCK_LAUNCH
    // eval clears the screen first, so the shell's startup banner/prompt and
    // the echoed line never actually appear — the pane looks exactly like
    // the agent was exec'd directly. The shell (and its scrollback) is still
    // there underneath; it only becomes visible once the agent exits (e.g.
    // via Ctrl+C) and prints a fresh prompt of its own. This typed line must
    // stay short (see the FLOCK_LAUNCH comment above): under the tty's
    // 1024-byte canonical input limit it can neither block nor be truncated.
    spawn_pty_child(builder, rows, cols, Some(b"eval \"$FLOCK_LAUNCH\"\n"), None)
}

/// Shared PTY plumbing behind every spawn flavor: open the pty, run
/// `builder` as its child, wire the reader/exit threads, and optionally type
/// `initial_input` into the fresh tty (host shells launch their agent that
/// way; container panes launch via the image's bash init file instead, so
/// they pass `None`).
fn spawn_pty_child(
    builder: CommandBuilder,
    rows: u16,
    cols: u16,
    initial_input: Option<&[u8]>,
    container: Option<ContainerCleanup>,
) -> Result<(PtyHandle, mpsc::Receiver<Bytes>)> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut child = pair.slave.spawn_command(builder)?;
    let child_pid = child.process_id();
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let master = pair.master;

    drop(pair.slave);

    let (output_tx, output_rx) = mpsc::channel::<Bytes>(128);
    let (exit_tx, exit_rx) = oneshot::channel::<i32>();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if output_tx.blocking_send(Bytes::copy_from_slice(&buf[..n])).is_err() {
                        break;
                    }
                }
            }
        }
    });

    std::thread::spawn(move || {
        let code = match child.wait() {
            Ok(s) => {
                if s.success() {
                    0
                } else {
                    1
                }
            }
            Err(_) => 1,
        };
        let _ = exit_tx.send(code);
    });

    let handle = PtyHandle {
        inner: Arc::new(PtyInner {
            writer: Mutex::new(writer),
            exit_rx: Mutex::new(Some(exit_rx)),
            master: Mutex::new(master),
            child_pid,
            container,
        }),
    };

    if let Some(input) = initial_input {
        handle.send_input(input)?;
    }

    Ok((handle, output_rx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    /// The marker's job is to sit between flock's plumbing and the agent, so
    /// what matters is that it is emitted, that it is emitted *last*, and that
    /// what reaches the tty is the same bytes the frontend watches for.
    #[test]
    fn launch_line_announces_the_agent_immediately_before_running_it() {
        for setup in [None, Some("npm ci")] {
            let line = launch_line("claude", &[], setup);
            let at = line.find("printf '\\033]777;flock;agent\\007'").expect("no marker");
            assert!(at < line.find("claude").expect("no agent"), "marker must precede the agent: {line}");
            if let Some(s) = setup {
                assert!(line.find(s).unwrap() < at, "marker must follow setup: {line}");
            }
        }
        // What the shell's printf produces has to be what the app watches for.
        assert_eq!(AGENT_START_MARKER, "\u{1b}]777;flock;agent\u{7}");
    }

    #[test]
    fn launch_line_quotes_the_agent_and_omits_absent_setup() {
        let line = launch_line("claude", &["--session-id", "a b"], None);
        assert!(line.ends_with("claude --session-id 'a b'"), "{line}");
        // Empty / whitespace-only setup is the same as none.
        assert!(launch_line("claude", &[], Some("")).ends_with("claude"));
        assert!(launch_line("claude", &[], Some("  ")).ends_with("claude"));
        assert!(!launch_line("claude", &[], Some("  ")).contains("· flock:"));
    }

    #[test]
    fn launch_line_runs_setup_first_and_never_gates_the_agent_on_it() {
        let line = launch_line("claude", &["-p"], Some("npm ci"));
        let agent_at = line.find("claude -p").expect("agent must be in the line");
        let setup_at = line.find("{ npm ci; }").expect("setup must be spliced as source");
        assert!(setup_at < agent_at, "setup must run before the agent: {line}");
        // `;` not `&&` — a failed setup still leaves the user with a live agent.
        assert!(!line.contains("npm ci; } &&"), "setup must not gate the agent: {line}");
        assert!(line.contains("|| printf"), "a failed setup must say so: {line}");
    }

    /// The setup command is shell source by design (`a && b` has to work), but
    /// the agent's own args must stay inert no matter what they contain.
    #[test]
    fn launch_line_keeps_agent_args_inert() {
        let line = launch_line("claude", &["-p", "; rm -rf ~"], Some("npm ci"));
        assert!(line.contains("'; rm -rf ~'"), "agent arg must be quoted: {line}");
        assert!(!line.contains("-p ; rm"), "agent arg must not be spliced: {line}");
    }

    /// End-to-end secure spawn through the REAL script assembly. Both shipped
    /// secure-mode bugs (0.4.24's bare PATH, 0.4.25's "docker run run") lived
    /// in the gaps between individually unit-tested parts, so this exercises
    /// spawn_container itself: script build, daemon check, image build/reuse,
    /// docker run, and the in-container FLOCK_LAUNCH eval. Ignored by
    /// default because it needs a running Docker daemon and may build the
    /// sandbox image; run it before touching container spawning:
    ///   cargo test -p flock-pty -- --ignored
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn container_spawn_runs_launch_command_in_jail() {
        // `uname -s` in the marker proves the command ran inside the Linux
        // container, not on the macOS host or as a leaked echo of the script.
        let (pty, mut rx) = spawn_container(
            "sh",
            &["-c", "echo FLOCK_JAIL_OK_$(uname -s)"],
            24,
            80,
            None,
            &[("FLOCK_PANE_ID", "e2e-test")],
            "e2e-test-pane",
            "e2e-test-workspace",
            None,
        )
        .expect("spawn_container failed");

        // Generous budget: a cold cache builds the whole image here.
        let saw_marker = tokio::time::timeout(Duration::from_secs(300), async move {
            let mut acc: Vec<u8> = Vec::new();
            while let Some(chunk) = rx.recv().await {
                acc.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&acc).contains("FLOCK_JAIL_OK_Linux") {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);

        let name = container::container_name("e2e-test-pane");
        if let Some(docker) = container::docker_path() {
            let labeled = std::process::Command::new(&docker)
                .args([
                    "inspect",
                    "-f",
                    "{{index .Config.Labels \"flock.secure-pane\"}}",
                    &name,
                ])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
                .unwrap_or(false);
            assert!(labeled, "spawned jail is missing flock.secure-pane=1");
        }

        let _ = pty.kill();
        assert!(saw_marker, "launch command never ran inside the container");

        // Force-quit leftover: a jail with the spawn label and a dead owner
        // must go, and one whose owner is still a different live pid must not
        // — that is another flock's pane. Uses the image this test just built.
        if let Some(docker) = container::docker_path() {
            let leftover = "flock-reap-leftover-e2e";
            let other = "flock-reap-other-e2e";
            for n in [leftover, other] {
                let _ = std::process::Command::new(&docker).args(["rm", "-f", n]).output();
            }
            let image = container::image_tag();
            let run_labeled = |name: &str, owner: &str| {
                std::process::Command::new(&docker)
                    .args([
                        "run",
                        "-d",
                        "--rm",
                        "--name",
                        name,
                        "--label",
                        container::SECURE_PANE_LABEL,
                        "--label",
                        &format!("flock.owner-pid={owner}"),
                        &image,
                        "sleep",
                        "120",
                    ])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            };
            let mut child = std::process::Command::new("true").spawn().expect("true");
            let dead_pid = child.id();
            let _ = child.wait();
            assert!(
                run_labeled(leftover, &dead_pid.to_string()),
                "could not start a leftover jail"
            );
            // pid 1 is always live and is not us — a stand-in for another flock.
            assert!(run_labeled(other, "1"), "could not start a neighbour jail");
            container::reap_orphan_panes(&docker);
            let exists = |name: &str| {
                std::process::Command::new(&docker)
                    .args(["ps", "-aq", "--filter", &format!("name=^{name}$")])
                    .output()
                    .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
                    .unwrap_or(true)
            };
            let leftover_left = exists(leftover);
            let other_left = exists(other);
            for n in [leftover, other] {
                let _ = std::process::Command::new(&docker).args(["rm", "-f", n]).output();
            }
            assert!(!leftover_left, "leftover secure pane survived reap");
            assert!(other_left, "another flock's live jail was reaped");
        }

        // Every secure spawn creates this workspace's transcript directory; a
        // test must not leave one sitting in the user's ~/.claude/projects.
        if let Ok(home) = std::env::var("HOME") {
            let _ = std::fs::remove_dir_all(
                PathBuf::from(home)
                    .join(".claude/projects")
                    .join(container::secure_transcripts_name("e2e-test-workspace")),
            );
        }
    }

    /// The telemetry bridge, end to end: whatever the jailed agent writes to
    /// `~/.claude/projects` has to come out on the host, under this workspace's
    /// directory, or the pane's context meter and the machine's token totals go
    /// dark for exactly the workspaces secure mode is meant to serve best.
    ///
    /// Worth an e2e rather than another argv assertion because the risk is not
    /// in the argument list — it is whether Docker layers a bind-mount inside a
    /// named volume at all, and whether the jail's unprivileged `node` user can
    /// write through it with every capability dropped. Same ignore rule and
    /// same run line as the spawn test above.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn container_transcripts_land_on_the_host() {
        let workspace = "e2e-transcripts-workspace";
        let session = "2f1c6bb5-d843-400e-a86c-70276cd12c33";
        let host_dir = PathBuf::from(std::env::var("HOME").expect("HOME"))
            .join(".claude")
            .join("projects")
            .join(container::secure_transcripts_name(workspace));
        // Start from nothing so a pass can't be inherited from a previous run.
        let _ = std::fs::remove_dir_all(&host_dir);

        // Written from inside the jail, into the path Claude Code writes its
        // transcripts to, using the session id flock imposes with --session-id.
        let launch = format!(
            "mkdir -p \"$HOME/.claude/projects/-flock-e2e\" && \
             printf '{{}}\\n' > \"$HOME/.claude/projects/-flock-e2e/{session}.jsonl\" && \
             echo FLOCK_TRANSCRIPT_WRITTEN"
        );
        let (pty, mut rx) = spawn_container(
            "sh",
            &["-c", &launch],
            24,
            80,
            None,
            &[("FLOCK_PANE_ID", "e2e-transcripts")],
            "e2e-transcripts-pane",
            workspace,
            None,
        )
        .expect("spawn_container failed");

        let wrote = tokio::time::timeout(Duration::from_secs(300), async move {
            let mut acc: Vec<u8> = Vec::new();
            while let Some(chunk) = rx.recv().await {
                acc.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&acc).contains("FLOCK_TRANSCRIPT_WRITTEN") {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        let _ = pty.kill();
        assert!(wrote, "the jailed shell never wrote a transcript");

        let landed = host_dir.join("-flock-e2e").join(format!("{session}.jsonl"));
        assert!(
            landed.is_file(),
            "transcript never reached the host at {}",
            landed.display()
        );
        // The image's init script must also have closed out the one-shot
        // migration, or run_args keeps mounting the $HOME volume a second time
        // on every spawn of this workspace forever.
        assert!(
            host_dir.join(".flock-transcripts-migrated").is_file(),
            "the migration marker was never written"
        );

        let _ = std::fs::remove_dir_all(&host_dir);
    }

    /// Regression test for the 0.4.22 spawn wedge: the launch command used to
    /// be typed verbatim into the fresh shell's tty, which is still in
    /// canonical mode (1024-byte line cap) — multi-KB agent args (the graph
    /// system prompt) were silently truncated, or deadlocked the spawning
    /// thread on the blocked PTY write. A spawn with a huge argument must
    /// still launch the command, intact, within a bounded time.
    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_launches_with_multi_kb_args() {
        let big = "x".repeat(20_000);
        let (pty, mut rx) = spawn("echo", &["FLOCK_SPAWN_OK", &big], 24, 200, None, &[], None)
            .expect("spawn failed");

        let payload = big.clone();
        let saw_marker_and_payload = tokio::time::timeout(Duration::from_secs(30), async move {
            let mut acc: Vec<u8> = Vec::new();
            while let Some(chunk) = rx.recv().await {
                acc.extend_from_slice(&chunk);
                let text = String::from_utf8_lossy(&acc);
                if text.contains("FLOCK_SPAWN_OK") && text.contains(payload.as_str()) {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);

        let _ = pty.kill();
        assert!(
            saw_marker_and_payload,
            "launch command with 20KB arg never ran (or arrived truncated)"
        );
    }

    /// Read from a pane until `done` is satisfied by the accumulated output,
    /// or the budget runs out. Returns whatever was collected either way.
    ///
    /// Takes `Bytes`, not `Vec<u8>`: the output channel changed when the PTY
    /// pipeline's memory leak was fixed, and this helper was left behind, so
    /// the crate's tests have not compiled since. `cargo check` never caught it
    /// because it does not build test targets.
    async fn drain_until(
        rx: &mut mpsc::Receiver<Bytes>,
        secs: u64,
        done: impl Fn(&str) -> bool,
    ) -> String {
        let mut acc: Vec<u8> = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(secs), async {
            while let Some(chunk) = rx.recv().await {
                acc.extend_from_slice(&chunk);
                if done(&String::from_utf8_lossy(&acc)) {
                    return;
                }
            }
        })
        .await;
        String::from_utf8_lossy(&acc).to_string()
    }

    /// The setup command really runs, in the pane, before the agent — proven
    /// through a live PTY rather than by inspecting the assembled string.
    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_runs_setup_before_the_agent() {
        let (pty, mut rx) = spawn(
            "echo",
            &["FLOCK_AGENT_OK"],
            24,
            200,
            None,
            &[],
            Some("echo FLOCK_SETUP_OK"),
        )
        .expect("spawn failed");

        let out = drain_until(&mut rx, 30, |t| t.contains("FLOCK_AGENT_OK")).await;
        let _ = pty.kill();

        let setup_at = out.find("FLOCK_SETUP_OK").unwrap_or_else(|| panic!("setup never ran: {out}"));
        let agent_at = out.find("FLOCK_AGENT_OK").unwrap_or_else(|| panic!("agent never ran: {out}"));
        assert!(setup_at < agent_at, "setup must land before the agent: {out}");
    }

    /// A setup command that fails must not cost the user their agent.
    #[tokio::test(flavor = "multi_thread")]
    async fn failing_setup_still_starts_the_agent() {
        let (pty, mut rx) = spawn(
            "echo",
            &["FLOCK_AGENT_OK"],
            24,
            200,
            None,
            &[],
            Some("sh -c 'exit 3'"),
        )
        .expect("spawn failed");

        let out = drain_until(&mut rx, 30, |t| t.contains("FLOCK_AGENT_OK")).await;
        let _ = pty.kill();

        assert!(out.contains("FLOCK_AGENT_OK"), "agent must run anyway: {out}");
        // And the failure is reported, with the real exit status, rather than
        // passing silently as if setup had worked.
        assert!(out.contains("setup exited 3"), "failure must be surfaced: {out}");
    }

    /// Setup runs in the pane's own shell, not a subshell — the reason a
    /// `source .venv/bin/activate` or `nvm use` setup command is worth having.
    /// See `launch_line`'s note on `{ }` vs `( )`.
    #[tokio::test(flavor = "multi_thread")]
    async fn setup_state_reaches_the_agent() {
        let (pty, mut rx) = spawn(
            "sh",
            &["-c", "echo AGENT_SEES_$FLOCK_SETUP_VAR"],
            24,
            200,
            None,
            &[],
            Some("export FLOCK_SETUP_VAR=yes"),
        )
        .expect("spawn failed");

        let out = drain_until(&mut rx, 30, |t| t.contains("AGENT_SEES_")).await;
        let _ = pty.kill();

        assert!(out.contains("AGENT_SEES_yes"), "setup's env must reach the agent: {out}");
    }
}

/// PATH for pane children. Production .app launches from Finder don't inherit
/// the user's interactive shell PATH (only the bare /usr/bin:/bin:/usr/sbin:
/// /sbin), so prepend common tool locations: agent CLIs (`claude`, `opencode`,
/// `gh`, …) for host panes, and Docker's own directories for container panes —
/// the docker CLI exec's helpers like `docker-credential-desktop` from PATH
/// (~/.docker/config.json `credsStore`), and without them every image pull
/// dies with "executable file not found in $PATH".
fn augmented_path() -> String {
    let path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = format!(
        "{home}/.local/bin:{home}/.cargo/bin:{home}/.bun/bin:\
         /opt/homebrew/bin:/usr/local/bin:/opt/homebrew/sbin:/usr/local/sbin:\
         {home}/.docker/bin:/Applications/Docker.app/Contents/Resources/bin"
    );
    if path.is_empty() {
        extra
    } else {
        format!("{extra}:{path}")
    }
}

/// Quote a single argument for safe insertion into a POSIX shell command line.
fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}
