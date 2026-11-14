<p align="center">
  <a href="https://theflock.sh">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lockup-dark.svg">
      <img src="docs/assets/lockup-light.svg" width="440" alt="flock">
    </picture>
  </a>
</p>

<p align="center"><b>the agentic development environment</b><br>
your coding agents, in formation</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-black" alt="Platform: macOS (Apple Silicon)">
  <a href="https://github.com/theflock-labs/flock-code/releases"><img src="https://img.shields.io/github/v/release/theflock-labs/flock-code?cacheSeconds=3600" alt="Latest release"></a>
  <a href="https://github.com/theflock-labs/flock-code/stargazers"><img src="https://img.shields.io/github/stars/theflock-labs/flock-code?cacheSeconds=3600" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="https://theflock.sh"><b>See it run at theflock.sh</b></a>
  &nbsp;·&nbsp;
  <a href="https://theflock.sh/download">Download for Mac</a>
  &nbsp;·&nbsp;
  <a href="https://theflock.sh/docs/changelog">Changelog</a>
</p>

flock is a multi-agent coding cockpit: a desktop app that runs multiple AI
coding agents (Claude Code, Grok, opencode, Codex, Pi) side-by-side in tiled
terminal panes, over a SQLite-backed workspace manager and an opt-in shared
knowledge graph. It is built for people who ship interfaces, frontend
developers and QA: hand an agent a screenshot of the bug, watch it check its
own work in [Wink](#flock-and-wink), and review what it changed. It exists
because coding agents got good enough that one person can run several at once,
but the tools still assume you are babysitting a single terminal. Running a
room full of agents should feel like flying one plane, not juggling ten. And
when you quit and reopen, the room is exactly where you left it.

flock is free and open source under Apache-2.0. There are no paid tiers.
Agents run on your own CLI logins and your own model spend; flock is the
cockpit around them, not a reseller of tokens. Signing in with Google (a flock
ID) is required to use the app.

## What you get

- **One list of everything you are running.** The sidebar lists your projects
  and, under each, its threads: one task each, usually one agent, named after
  the task you gave it. A dot says which are working, which are waiting on you,
  which finished while you were elsewhere ("Ready for review") and which have
  not been started yet this launch. ⌘J goes through the waiting ones, then the
  finished ones, in any project.
- **Hand it a screenshot.** Start an agent from the composer (⌘N): say what it
  should do, paste or drop screenshots and files on it (or dictate), pick the
  project and the agent, Enter. Attachments are saved into the folder the agent
  starts in, its worktree included, and named in its first prompt.
- **See what each agent is doing.** Claude Code reports every tool call to
  flock's hooks, so each thread says what its agent is on right now ("Editing
  src/checkout/Steps.tsx", "Run the tests"), the page it opened in Wink, its
  to-do progress, and why a turn stopped short, such as a rate limit.
- **Tiled agents when you want them.** A thread can hold a grid of agents (a
  BSP split layout, up to twelve): add one beside the other (⌘D), zoom,
  type into all of them at once, or pop one out into its own window.
- **Light on the machine.** Only the thread on screen has live terminals in
  the window. Every other agent keeps running at full speed, with its status,
  boot state and output kept by the backend, and its terminal is rebuilt from
  that output when you open its thread again. Twenty agents across five
  projects cost the window what the one thread you are looking at costs.
- **Races across git worktrees.** Fan out N agents on the same prompt, each in
  its own worktree cut from one commit. Compare every contender's diff against
  that commit side by side, merge the winner, and discard the rest, with the
  losers' work committed first so nothing is force-deleted.
- **Secure mode.** Each agent runs in a per-workspace Docker jail that sees
  the workspace folder and nothing else of your machine: no SSH keys, no
  keychain, no other repos. That is what makes flock's default
  bypass-permissions launch flags defensible. On by default wherever Docker is
  running, fails closed rather than quietly giving you a host shell, and once
  a workspace is secure the backend refuses to downgrade it.
- **Egress control.** Opt-in per-workspace network restriction: jailed panes
  join an internal Docker network whose only way out is a CONNECT-only,
  allowlist-checked proxy. No default route, no plain HTTP, no names that
  resolve into private ranges.
- **Knowledge graph.** Opt-in shared memory (Postgres + pgvector) that agents
  write decisions and attempts to over MCP, with per-prompt grounding injected
  by a hook. Its metrics are windowed and able to fall (coverage, silent
  passes, recall volume), and the app says on screen what has not been
  measured.
- **Context ring.** How full the agent's context window is, as a ring in the
  thread's header (Claude Code and Grok), read from its own transcript.
- **Budgets and cost attribution.** Spend is attributed per session id, rolled
  up to workspaces and repos, with per-workspace and machine-wide daily
  ceilings that alert as they are approached. Token counts are exact; dollar
  figures are estimates from a local price table and every surface says so.
- **Provenance export.** One durable record per agent session (who ran it,
  where, for how long, how many prompts, what it cost), exportable as CSV or
  JSON. Prompt text, agent output, and diffs are never stored, and there is no
  flag that turns them on.
- **And the rest.** GitHub integration (pull requests, checks, one-click
  review agents, a merge queue), a changes panel beside each thread (branches,
  worktrees, diffs), on-device voice dictation, a ⌘K command bar that reaches
  everything, signed auto-updates, and a Ratatui TUI (`flock-cli`) sharing the
  same core engine.

## flock and Wink

<p align="center">
  <a href="https://wink.minnebo.ai"><img src="docs/assets/wink-eye.png" width="120" alt="Wink"></a>
</p>

[Wink](https://wink.minnebo.ai) is a Mac browser built for agents, and the
other half of the loop: flock is where agents work, Wink is where they look.
Install it and every Claude Code agent in flock can open your `localhost`,
click through the change, and read the console and network, in plain sight.
Each one shows up in Wink under its own name and project ("Nova · storefront")
with its own tabs, and flock shows the page it has open on its thread.

The homepage at [theflock.sh](https://theflock.sh) plays the real app, with
recorded Claude Code sessions, if you want to see flock before installing it.

## Getting started

### Download

Grab the DMG from [theflock.sh](https://theflock.sh) or the
[GitHub releases page](https://github.com/theflock-labs/flock-code/releases).
Builds are signed, notarized, and auto-update in the background.

flock ships for **macOS on Apple Silicon only** today. There are no Windows or
Linux builds, and cross-platform support is not currently committed: the
Rust workspace is portable, but the app is only built, tested, and released
as a macOS DMG.

### Build from source

Prerequisites: macOS, Xcode Command Line Tools, stable
[Rust](https://rustup.rs), Node 20+ with npm.

```bash
git clone https://github.com/theflock-labs/flock-code.git
cd flock-code

# One-time: build the flock-mcp sidecar the app bundles (it is gitignored)
cargo build --release -p flock-mcp
mkdir -p apps/flock-desktop/src-tauri/binaries
cp target/release/flock-mcp \
  "apps/flock-desktop/src-tauri/binaries/flock-mcp-$(rustc -vV | sed -n 's/host: //p')"

cd apps/flock-desktop
npm install
npm run tauri dev      # development, with hot reload
npm run build          # production bundle
```

To work on the interface without the desktop shell, run the UI harness: the
real app in a browser, with Tauri's IPC mocked and a signed-in identity, seeded
with projects, threads in every state and agents that paint a terminal screen.

```bash
cd apps/flock-desktop
npm run ui:harness     # http://localhost:1430/harness.html
                       # ?theme=light|dark  ?view=new|settings|palette  ?changes=1  ?live=1
```

The TUI needs only Rust:

```bash
cargo run -p flock-cli
```

### First run

1. **Sign in with Google.** flock requires a flock ID; the app gates on it.
2. **Start an agent.** The composer asks what it should work on: pick a
   folder (it becomes a project), the agent, and press Enter. If Docker is
   running and secure mode is on in Settings, the agent runs jailed. More
   options (branch strategy, several agents, mixed lineups) are one click
   away, or ⌘⇧N.
3. **The agent CLIs are not bundled.** `claude`, `grok`, `opencode`, `codex`,
   or `pi` must be installed on your machine and signed in to their own
   accounts. flock never handles your model credentials beyond passing them to
   the agent.

### Optional pieces

- **Secure mode** needs [Docker Desktop](https://www.docker.com/products/docker-desktop/).
  Without a Docker daemon, workspaces run agents directly on the host. Read
  the [security model](#security-model) before deciding that is acceptable.
- **The knowledge graph** needs Docker too. Enable it from the in-app setup
  wizard, which starts the Postgres + pgvector engine and wires new panes with
  the `kg.*` MCP tools. Two things the wizard also tells you: jailed panes do
  not get the graph tools (the MCP server is a host binary), and panes are
  wired at spawn, so open a new pane after enabling.

## Security model

flock runs coding agents with their permission prompts turned off. That is
the product, and the only thing that makes it defensible is that by default
the agent is not on your Mac. The short version, stated honestly:

- **Secure mode is a real jail.** Each pane is a Docker container with
  `--cap-drop ALL`, `no-new-privileges`, a pid limit, a non-root user, no
  Docker socket, and the stock seccomp profile. It sees the workspace
  directory (read-write), a per-workspace volume as `$HOME`, a per-workspace
  transcript directory, its own hook log, and the one API key belonging to
  its own agent. It never sees SSH keys, the Keychain, your other repos, your
  browser profile, or `~/.flock`. `<repo>/.git/hooks` is masked read-only so
  a jailed agent cannot plant a hook your own git would later run on the
  host. Secure mode fails closed: no Docker, no pane.
- **Host mode is not a sandbox.** Without Docker, an agent with prompts
  disabled can do anything your user can. The New Workspace dialog says so in
  those words. If you are deploying flock in an organisation, require Docker
  and treat host mode as out of policy.
- **The jail does not stop exfiltration of the workspace itself.** The agent
  has the repository and, by default, a network; in the worst case it can
  describe the source to its own model API. If a repository is too sensitive
  to be read by a third-party model, it is too sensitive for any agent tool,
  flock included. Treat a checkout after a secure session as untrusted input
  and review the diff.
- **Egress control closes the easy channels.** Opt-in per-workspace: panes
  join an internal Docker network with no default route, and the only way out
  is a CONNECT-only, port-443-only, allowlist-checked proxy that terminates
  no TLS and refuses names resolving into private ranges. Verified against a
  live daemon: allowlisted hosts connect, unlisted ones are refused, bypassing
  the proxy finds no route, and `host.docker.internal` no longer resolves.
  An allowlist bounds who the agent can talk to, never what it can say.
- **The webview is not trusted with security decisions.** Agent commands are
  allowlisted backend-side, launch-hijacking env keys are blocked, the
  working directory is validated, a secured workspace refuses to downgrade,
  and the egress policy is read from a host file rather than over IPC.
- **Known limits.** `host.docker.internal` reaches host loopback services
  unless egress control is on; the sandbox image installs agent CLIs from npm
  unpinned; there are no memory/CPU limits (pid limit only); container-escape
  vulnerabilities in Docker itself are out of scope. Keep Docker Desktop
  updated.

Report security issues privately through GitHub's security advisories for
this repository, not as public issues. If a claim in this section is wrong,
that is itself the report we most want.

## Architecture

```mermaid
flowchart LR
    subgraph desktop["apps/flock-desktop (Tauri 2)"]
        ui["React frontend<br>xterm.js panes, BSP layout"]
        cmds["Rust backend<br>Tauri commands"]
    end

    subgraph crates["crates/"]
        core["flock-core<br>workspaces, status, provenance"]
        pty["flock-pty<br>PTY spawn, jail, egress"]
        tui["flock-tui + flock-cli<br>Ratatui TUI"]
        kg["flock-kg<br>knowledge graph client"]
        mcp["flock-mcp<br>MCP server"]
    end

    agents["agent CLIs<br>claude, grok, opencode, codex, pi"]
    db[("SQLite<br>~/.flock/flock.db")]
    pg[("Postgres + pgvector<br>Docker, opt-in")]

    ui <-- "IPC + pty events" --> cmds
    cmds --> core
    cmds --> pty
    pty <-- "PTY (host or Docker jail)" --> agents
    tui --> core
    tui --> pty
    core --> db
    agents -- "MCP tools" --> mcp
    mcp --> kg
    kg --> pg
```

The frontend renders the panes of the thread on screen with xterm.js and talks
to the Rust backend over Tauri commands. `flock-pty` spawns each agent CLI
under a PTY (on the host, or inside a Docker container in secure mode). The
backend reads every byte of every agent whether or not it is on screen: it
detects status and the agent's first paint (`boot.rs`), keeps a replay ring
per pane, and emits only the transitions. A terminal subscribes to its pane's
output over a binary channel when its thread is opened, starting from the ring,
and lets go when it closes, so the window's cost follows what you look at, not
how many agents run. `flock-core`
owns persistence: workspaces, layouts, and the provenance record in SQLite
under `~/.flock`. The knowledge graph is a separate opt-in engine (Postgres
with pgvector in Docker) that agents reach through the `flock-mcp` server.

## Contributing and community

- [GitHub Discussions](https://github.com/theflock-labs/flock-code/discussions)
  for questions and ideas
- [Issues](https://github.com/theflock-labs/flock-code/issues): bugs and
  concrete feature requests
- Pull requests are welcome. Before opening one: `npx tsc --noEmit` and
  `npx vitest run` in `apps/flock-desktop`, and `cargo check` at the root,
  all green. Keep changes scoped; say what you verified and how.
- Security issues go through
  [private vulnerability reporting](https://github.com/theflock-labs/flock-code/security/advisories),
  never a public issue.

## License

Apache License 2.0. See [LICENSE](LICENSE).

Copyright 2026 the flock authors.

<br>

<p align="center">
  <a href="https://theflock.sh"><img src="docs/assets/app-icon.png" width="96" alt="flock"></a><br>
  <sub><a href="https://theflock.sh">theflock.sh</a> · free and open source · Apache 2.0</sub>
</p>
