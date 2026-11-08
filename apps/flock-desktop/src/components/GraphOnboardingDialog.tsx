import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { graphStatus, graphUp, type GraphStatus } from "../lib/tauri";
import { copyText } from "../lib/clipboard";
import { getGraphEnabled, setGraphEnabled, getGraphUrl, isTeamGraph } from "../lib/graphSettings";
import { graphSnippets, type AgentTool } from "../lib/graphSnippets";
import { CheckIcon } from "./friendIcons";
import { Page } from "../v2/Page";

interface Props {
  onClose: () => void;
  /** Present while the app's sidebar is hidden. */
  onShowSidebar?: () => void;
}

const STEP_LABELS = ["Why", "Engine", "Connect", "Check"] as const;

const DOCKER_INSTALL_URL = "https://www.docker.com/products/docker-desktop/";

/** Guided, opt-in setup for the flock Graph: enable it, start the local
 * engine (Postgres + pgvector in Docker), and — only for agents run outside
 * flock — register the flock-graph MCP server by hand. Every step is
 * skippable and re-enterable from Settings → Graph.
 *
 * The guide is written against the two ways it actually fails, both of which
 * shipped: the engine not starting at all (see `graph.rs::docker_bin` — the
 * packaged app could not see the docker CLI), and the engine starting fine
 * while every agent still had no graph tools, because secure mode strips them
 * (`graphSpawn.ts`) and secure mode defaults **on** wherever Docker is
 * running — which is exactly every machine that got this far. A setup guide
 * that ends before either of those is checked is a guide that congratulates
 * the user on a graph nothing is writing to. */
export default function GraphOnboardingDialog({ onClose, onShowSidebar }: Props) {
  const [step, setStep] = useState(0);
  const [enabled, setEnabled] = useState(getGraphEnabled());
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  /** Counts attempts so a *repeated* failure still reads as a fresh one. The
   *  original symptom report was "hit try again and nothing happens": the
   *  error text was byte-identical to the previous one, so a genuine retry
   *  that genuinely failed again was indistinguishable from a dead button. */
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [tool, setTool] = useState<AgentTool>("claude");
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live status while the engine steps are visible — the pills flip green
  // on their own as Docker comes up, no manual refresh.
  useEffect(() => {
    let cancelled = false;
    const poll = () => graphStatus(getGraphUrl()).then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    poll();
    const interval = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // A first run pulls ~400MB of Postgres image with no progress of its own to
  // show. Without a clock on screen, a legitimately-working two-minute pull is
  // indistinguishable from a hang, and the user kills it and reports a bug.
  useEffect(() => {
    if (!starting) { setElapsed(0); return; }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [starting]);


  const enable = () => { setGraphEnabled(true); setEnabled(true); setStep(1); };

  const startEngine = async () => {
    setStartError("");
    setAttempt((n) => n + 1);
    setStarting(true);
    try {
      await graphUp();
      // Provisioning creates credentials and makes mcp_config available.
      // Refresh cached registrations/hooks without changing the opt-in.
      if (getGraphEnabled()) setGraphEnabled(true);
    } catch (e) {
      setStartError(String(e));
    } finally {
      setStarting(false);
      // Don't wait up to 2s for the poll to catch up with what we just did.
      graphStatus(getGraphUrl()).then(setStatus).catch(() => {});
    }
  };

  const copy = (id: string, text: string) => {
    copyText(text).then(() => {
      setCopied(id);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 2000);
    }).catch(() => {});
  };

  const mcpPath = status?.mcp_binary ?? "/path/to/flock-mcp";
  const kgUrl = getGraphUrl();
  const engineReady = !!status && status.container_running && status.db_reachable;
  const team = isTeamGraph();
  // Team graphs are somebody else's Postgres; reachability is the whole story
  // and there is no local engine to start.
  const ready = team ? !!status?.db_reachable : engineReady;
  // Both gated on !team: a team graph is somebody else's Postgres over the
  // network, and telling its user to install Docker is advice about a
  // dependency they do not have.
  const dockerMissing = !team && !!status && status.docker_cli === null;
  const dockerStopped = !team && !!status && status.docker_cli !== null && !status.docker_ready;

  const snippets = graphSnippets(mcpPath, kgUrl);

  return (
    <Page
      title="Set up the graph"
      meta={<span className="v2-page-meta">{step + 1} of {STEP_LABELS.length} · {STEP_LABELS[step]}</span>}
      onClose={onClose}
      onShowSidebar={onShowSidebar}
      className="v2-graph-setup"
    >
      <div className="v2-page-scroll">
        <div className="v2-setup">
          <h2 className="v2-setup-title">
            {step === 0 && "A memory your agents share"}
            {step === 1 && (team ? "Point at the team graph" : "Start the engine")}
            {step === 2 && "Give your agents the tools"}
            {step === 3 && "Check that it works"}
          </h2>
        <div className="modal-body">
          {step === 0 && (
            <>
              <p className="onboarding-body">
                Your agents write down what they decide and what they tried, and read it
                before they start, so none of them begins from zero.
              </p>
              <ul className="onboarding-bullets">
                <li><span><strong>Decisions stay decided.</strong> One agent records it; every agent after reads it.</span></li>
                <li><span><strong>Dead ends stay dead.</strong> Nobody retries what another agent already tried.</span></li>
                <li><span><strong>On this Mac.</strong> Postgres with pgvector in Docker. Nothing leaves it.</span></li>
              </ul>
              <p className="onboarding-body graph-optin-note">
                A few minutes and one Docker container (a ~400 MB image). Turn it off any
                time in Settings, Graph.
              </p>
            </>
          )}

          {step === 1 && (
            <>
              {team ? (
                <p className="onboarding-body">
                  You're pointed at a <strong>team-hosted graph</strong> (Settings →
                  Graph), so there's no local engine to start — flock just needs to
                  reach it.
                </p>
              ) : (
                <p className="onboarding-body">
                  The graph lives in Postgres (with pgvector), running in Docker and
                  bound to localhost only. You need <strong>Docker Desktop</strong>{" "}
                  installed and running — everything else is handled for you.
                </p>
              )}

              <div className="graph-status-list">
                {!team && (
                  <StatusPill
                    ok={!!status?.docker_ready}
                    label="Docker daemon"
                    detail={
                      status === null ? "checking…"
                        : status.docker_ready ? "running"
                        : dockerMissing ? "not installed"
                        : "installed, not running"
                    }
                  />
                )}
                {!team && (
                  <StatusPill
                    ok={!!status?.container_running}
                    label="Graph engine"
                    detail={status?.container_running ? "flock-graph-db up" : "not running"}
                  />
                )}
                <StatusPill
                  ok={!!status?.db_reachable}
                  label="Database"
                  detail={status?.db_reachable ? "accepting connections" : "unreachable"}
                />
              </div>

              {dockerMissing && (
                <div className="graph-warn">
                  <strong>Docker Desktop isn't installed on this machine.</strong>{" "}
                  {/* openUrl, never an <a href> — a raw anchor navigates the
                      cockpit's own webview to docker.com and there is no back
                      button to return from it. */}
                  <span
                    style={{ textDecoration: "underline", cursor: "pointer" }}
                    onClick={() => openUrl(DOCKER_INSTALL_URL).catch(console.error)}
                  >
                    Download it
                  </span>
                  , install it, launch it once, then come back — this window notices on
                  its own. If you're sure it <em>is</em> installed, its command-line tool
                  isn't where flock looks (/usr/local/bin or /opt/homebrew/bin): Docker
                  Desktop → Settings → Advanced → install the CLI tools.
                </div>
              )}
              {dockerStopped && (
                <div className="graph-warn">
                  Docker is installed but not running. Launch Docker Desktop and wait
                  for the whale in the menu bar to stop animating — the pill above goes
                  green by itself.
                </div>
              )}

              {startError && (
                <div className="graph-error">
                  <div style={{ opacity: 0.75, marginBottom: 4 }}>attempt {attempt} failed</div>
                  {startError}
                </div>
              )}

              {!team && (
                <button
                  className="btn-mint-solid"
                  style={{ alignSelf: "flex-start" }}
                  disabled={starting || engineReady}
                  onClick={startEngine}
                >
                  {engineReady
                    ? <><CheckIcon size={11} /> Engine running</>
                    : starting
                      ? `Starting… ${formatElapsed(elapsed)}`
                      : attempt > 0
                        ? "Try again"
                        : status?.container_running
                          ? "Repair engine access"
                          : "Start the engine"}
                </button>
              )}

              {starting && (
                <p className="onboarding-body graph-optin-note">
                  {elapsed < 20
                    ? "Talking to Docker…"
                    : "Pulling the Postgres image — first run only, and it's ~400 MB. Several minutes on a slow connection is normal; leave this open or press Next and it finishes in the background."}
                </p>
              )}

              {!team && !starting && (
                <p className="onboarding-body graph-optin-note">
                  Data persists in a Docker volume across restarts, and the stack comes
                  back up with Docker — enable "Start Docker Desktop at login" for a
                  zero-touch setup. flock also writes a plain-text copy of the graph to
                  ~/.flock/graph-backup.jsonl every few hours, so a wiped volume isn't
                  the end of it.
                </p>
              )}
              <p className="onboarding-body graph-optin-note">
                {team
                  ? "Switch back to the managed local engine any time: Settings → Graph → Local engine."
                  : "On a team? Host one shared graph instead and point every teammate at it: Settings → Graph → Team graph."}
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <p className="onboarding-body">
                <strong>Panes you open in flock are wired up automatically</strong> —
                flock passes the flock-graph MCP server to every agent it spawns, so
                there's nothing to install for normal use.
              </p>
              <ul className="onboarding-bullets">
                <li><span className="onboarding-bullet-mark" style={{ color: "var(--mint)" }}>›</span><span><strong>Open a new pane.</strong> Agents already running were spawned without the graph tools and won't pick them up — close and reopen one.</span></li>
                <li><span className="onboarding-bullet-mark" style={{ color: "var(--mint)" }}>›</span><span><strong>Not in a secure workspace.</strong> See below — this one catches almost everybody.</span></li>
              </ul>

              <div className="graph-warn">
                <strong>Secure mode turns the graph tools off.</strong> A jailed pane
                can't run the flock-mcp binary (it lives on your Mac, the pane is a
                Linux container), so flock deliberately gives it neither the tools nor
                the protocol. Secure mode defaults <em>on</em> for new workspaces
                wherever Docker is running — which is now you. To use the graph, create
                a workspace with Secure mode off, or turn it off in the new-workspace
                dialog. Per-prompt grounding still reaches secure panes; the{" "}
                <code>kg.*</code> tools do not.
              </div>

              <p className="onboarding-body" style={{ marginTop: 4 }}>
                Only running an agent <em>outside</em> flock — a plain terminal, another
                editor — needs the manual registration below. Pick your tool:
              </p>
              <div className="graph-tool-tabs">
                {(Object.keys(snippets) as AgentTool[]).map((t) => (
                  <button
                    key={t}
                    className={`graph-tool-tab${tool === t ? " active" : ""}`}
                    onClick={() => setTool(t)}
                  >
                    {snippets[t].title}
                  </button>
                ))}
              </div>
              <p className="onboarding-body graph-snippet-hint">{snippets[tool].hint}</p>
              <div className="graph-snippet">
                <pre>{snippets[tool].code}</pre>
                <button className="btn-ghost settings-btn graph-copy-btn" onClick={() => copy(tool, snippets[tool].code)}>
                  {copied === tool ? <><CheckIcon size={10} /> copied</> : "copy"}
                </button>
              </div>
              {!status?.mcp_binary && (
                <div className="graph-warn">
                  The flock-mcp server binary isn't where flock expects it, so the
                  snippet above has a placeholder path — and agents flock spawns get no
                  graph tools either. A packaged flock ships it alongside the app; from
                  a source checkout, build it and restart flock:
                  <div className="graph-snippet" style={{ marginTop: 6 }}>
                    <pre>cargo build --release -p flock-mcp</pre>
                    <button className="btn-ghost settings-btn graph-copy-btn" onClick={() => copy("build", "cargo build --release -p flock-mcp")}>
                      {copied === "build" ? <><CheckIcon size={10} /> copied</> : "copy"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <div className="graph-status-list">
                <StatusPill
                  ok={ready}
                  label={team ? "Team graph" : "Graph engine"}
                  detail={ready ? "reachable" : "not reachable — go back a step"}
                />
                <StatusPill
                  ok={!!status?.mcp_binary}
                  label="Agent tools"
                  detail={status?.mcp_binary ? "flock-mcp found" : "flock-mcp missing"}
                />
              </div>

              <p className="onboarding-body">
                Don't take the pills' word for it — spend one prompt proving it end to
                end. In a <strong>new, non-secure</strong> pane, ask:
              </p>
              <div className="graph-snippet">
                <pre>Record in the graph that we chose Postgres for the knowledge store, then query the graph for it.</pre>
                <button
                  className="btn-ghost settings-btn graph-copy-btn"
                  onClick={() => copy("verify", "Record in the graph that we chose Postgres for the knowledge store, then query the graph for it.")}
                >
                  {copied === "verify" ? <><CheckIcon size={10} /> copied</> : "copy"}
                </button>
              </div>
              <p className="onboarding-body">
                It worked if the agent calls <code>kg.write_decision</code> and then
                reads the same thing back, and if the node shows up in Graph Explorer
                (sidebar → Graph). If the agent says it has no such tool, it's one of
                the two things on the previous step: an old pane, or a secure
                workspace.
              </p>

              <p className="onboarding-body">
                From here on it's automatic. Agents get eight tools and use them
                unprompted — <code>kg.write_decision</code>,{" "}
                <code>kg.record_attempt</code>, <code>kg.remember</code> /{" "}
                <code>kg.forget</code>, <code>kg.query</code> /{" "}
                <code>kg.related</code> — and every prompt is pre-loaded with what the
                graph already knows about it.
              </p>
              <p className="onboarding-body graph-optin-note">
                Engine on/off, team graph, tool snippets and opt-out all live in
                Settings → Graph. If something stops working, the engine is plain
                docker compose and you can drive it by hand from ~/.flock/graph.
              </p>
            </>
          )}
        </div>

        <div className="v2-detail-actions v2-setup-actions">
          {step === 0 && (
            <button type="button" className="v2-btn primary" onClick={enable}>
              {enabled ? "Continue" : "Turn on the graph"}
            </button>
          )}
          {step === 1 && (
            <button type="button" className="v2-btn primary" onClick={() => setStep(2)} title={ready ? undefined : "The engine can finish starting in the background"}>
              Next
            </button>
          )}
          {step === 2 && (
            <button type="button" className="v2-btn primary" onClick={() => setStep(3)}>Next</button>
          )}
          {step === 3 && (
            <button type="button" className="v2-btn primary" onClick={onClose}>Done</button>
          )}
          {step > 0 && (
            <button type="button" className="v2-btn" onClick={() => setStep((s) => s - 1)}>Back</button>
          )}
          {step < 3 && (
            <button type="button" className="v2-link" style={{ marginLeft: "0.6em" }} onClick={onClose}>
              Later
            </button>
          )}
        </div>
        </div>
      </div>
    </Page>
  );
}

/** m:ss past a minute, bare seconds below it — a pull that has been running
 *  for "3:40" reads as progress in a way "220s" doesn't. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function StatusPill({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className={`graph-status-pill${ok ? " ok" : ""}`}>
      <span className="graph-status-dot"><span className={`status-mark${ok ? " filled" : ""}`} /></span>
      <span className="graph-status-label">{label}</span>
      <span className="graph-status-detail">{detail}</span>
    </div>
  );
}
