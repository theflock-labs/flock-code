import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import {
  getCarryPatterns,
  getDefaultBranchMode,
  getFetchBaseDefault,
  getLastBaseRef,
} from "../lib/worktreeSettings";
import { previewBranches, slugify, validateStem } from "../lib/branchPlan";
import { primeBaseFetch } from "../lib/baseFetch";
import ModalCloseButton from "./ModalCloseButton";
import AgentLogo from "./AgentLogo";
import BranchRefPicker, { type RefOption } from "./BranchRefPicker";
import { AGENT_KINDS, AGENT_META, agentColor } from "../lib/agents";
import { onRadioKey } from "../lib/a11y";
import { getSecureByDefault, setSecureByDefault } from "../lib/secureSettings";
import { agentCliStatus, containerStatus, egressPolicy, gitBranchOptions, worktreeSetupGet, worktreeSetupSet, type BranchOptions, type ContainerStatus } from "../lib/tauri";
import { useFocusTrap } from "../lib/useFocusTrap";
import type { AgentKind, BranchMode, BranchPlan, WindowLayout } from "../types";
import "../styles/spawnDialog.css";

interface Props {
  cwd: string;
  onConfirm: (name: string, kind: AgentKind, dir: string, layout: WindowLayout, plan: BranchPlan, secure: boolean) => void;
  onCancel: () => void;
}

const BRANCH_MODES: { mode: BranchMode; label: string }[] = [
  { mode: "new", label: "New branch" },
  { mode: "existing", label: "Existing" },
  { mode: "current", label: "Current checkout" },
];

const LAYOUTS: { kind: WindowLayout; label: string; rows: number; cols: number }[] = [
  { kind: "single", label: "1",  rows: 1, cols: 1 },
  { kind: "split",  label: "2",  rows: 1, cols: 2 },
  { kind: "quad",   label: "4",  rows: 2, cols: 2 },
  { kind: "six",    label: "6",  rows: 2, cols: 3 },
  { kind: "eight",  label: "8",  rows: 2, cols: 4 },
  { kind: "twelve", label: "12", rows: 3, cols: 4 },
];

export default function NewWorkspaceDialog({ cwd, onConfirm, onCancel }: Props) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AgentKind>("claude");
  const [layout, setLayout] = useState<WindowLayout>("single");
  const [dir, setDir] = useState(cwd);
  // `dir` stays absolute (what the backend needs); the field shows the home
  // prefix as ~ so the path reads in shortform (~/git/…/desktop). Typing ~
  // expands back on the way in.
  const [home, setHome] = useState("");
  useEffect(() => { homeDir().then((h) => setHome(h.replace(/\/$/, ""))).catch(() => {}); }, []);
  const displayDir = home && (dir === home || dir.startsWith(home + "/")) ? "~" + dir.slice(home.length) : dir;
  const expandDir = (v: string) => (home && (v === "~" || v.startsWith("~/")) ? home + v.slice(1) : v);
  // Auto-fit the font size to the field so the whole path is always visible,
  // shrinking only as far as it must (down to a legible floor) and returning
  // to full size for short paths.
  const dirInputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = dirInputRef.current;
    if (!el) return;
    const fit = () => {
      const MAX = 15, MIN = 9;
      let size = MAX;
      el.style.fontSize = `${size}px`;
      while (size > MIN && el.scrollWidth > el.clientWidth) {
        size -= 0.5;
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [displayDir]);
  // Safe by default. Agents launch with their permission prompts turned off
  // (see agentCommand in workspaceState.ts), which is only defensible because the jail
  // is what stands between an agent and the user's home directory. Defaulting
  // this off shipped the flags without the thing that makes them safe.
  // `checked` is gated on dockerReady, so this reads as unchecked until the
  // probe below confirms there is a daemon to jail into.
  //
  // The starting position is a preference (Settings → Security) rather than a
  // constant, because a machine with no Docker turns this dialog into a toggle
  // the user has to clear every single time. It still cannot make a workspace
  // less safe than the machine allows: the checkbox is gated on the probe, and
  // the backend refuses to downgrade a workspace that has already spawned
  // securely.
  const [secure, setSecure] = useState(getSecureByDefault);
  const [docker, setDocker] = useState<ContainerStatus | null>(null);
  // Machine-wide, set in Settings → Security. Read only to say so here: the
  // hint below otherwise reads as if the jail contained the network too, and
  // by default it does not. Never a claim this dialog makes on its own.
  const [egressRestricted, setEgressRestricted] = useState(false);
  // Agent kind → on the login shell's PATH. Null while probing; a kind absent
  // from the map is treated as installed, so nothing is ever marked missing on
  // a guess.
  const [installed, setInstalled] = useState<Record<string, boolean> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  // ── Branch ────────────────────────────────────────────────────────────────
  const [branchMode, setBranchMode] = useState<BranchMode>(getDefaultBranchMode());
  const [stem, setStem] = useState("");
  // Once the stem is typed in it stops tracking the workspace name.
  const [stemTouched, setStemTouched] = useState(false);
  const [baseRef, setBaseRef] = useState("");
  const [existingBranch, setExistingBranch] = useState("");
  const [fetchBase, setFetchBase] = useState(getFetchBaseDefault());
  const [refs, setRefs] = useState<BranchOptions | null>(null);
  const [refsLoading, setRefsLoading] = useState(false);
  // Per-repo setup command, stored backend-side. Empty = nothing to run.
  const [setupCmd, setSetupCmd] = useState("");
  const [setupSuggested, setSetupSuggested] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    containerStatus().then(setDocker).catch(() => setDocker({ available: false, daemon_running: false, image_ready: false }));
    egressPolicy().then((p) => setEgressRestricted(p.restrict)).catch(() => {});
    // Which agents are actually installed. Failing open ({}) means every kind
    // reads as present, which is the right way round: a spurious "not
    // installed" on a working setup sends someone to fix nothing.
    agentCliStatus().then(setInstalled).catch(() => setInstalled({}));
  }, []);

  const activeLayout = LAYOUTS.find((l) => l.kind === layout);
  const agentCount = activeLayout ? activeLayout.rows * activeLayout.cols : 1;
  const dockerReady = !!docker?.available && !!docker?.daemon_running;
  // What the workspace will actually do, which is not the same as what the
  // toggle says: without a running daemon there is nothing to jail into.
  const jailed = secure && dockerReady;
  const defaultName = dir.split("/").pop() || "workspace";

  // Load the repo's refs whenever the directory settles. Debounced because
  // `dir` is a free-text field: every keystroke would otherwise shell out.
  useEffect(() => {
    let cancelled = false;
    setRefsLoading(true);
    const t = setTimeout(() => {
      gitBranchOptions(dir)
        .then((r) => {
          if (cancelled) return;
          setRefs(r);
          // Preselect the base: what this repo was last branched from, else the
          // repo's own default branch. Only when the user hasn't picked yet.
          setBaseRef((prev) => {
            if (prev) return prev;
            const remembered = getLastBaseRef(dir);
            const known = remembered && (r.remote.includes(remembered) || r.local.some((b) => b.name === remembered));
            return known ? remembered! : r.default_ref;
          });
        })
        .catch(() => { if (!cancelled) setRefs({ is_repo: false, current: "", default_ref: "", local: [], remote: [] }); })
        .finally(() => { if (!cancelled) setRefsLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dir]);

  // Setup command for this repo. A repo that's never been answered for gets
  // its detected command PREFILLED rather than placeholdered, so the choice is
  // confirm-or-clear instead of a suggestion the field might or might not run.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      worktreeSetupGet(dir)
        .then((info) => {
          if (cancelled) return;
          const prefill = info.unset ? info.suggestion : info.command;
          setSetupCmd(prefill);
          setSetupSuggested(info.unset && !!info.suggestion);
        })
        .catch(() => {});
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dir]);

  const isRepo = refs?.is_repo ?? false;
  // Outside a repo there are no branches to plan; the section collapses and
  // agents just share the directory.
  const effectiveMode: BranchMode = isRepo ? branchMode : "current";

  // Start the base ref's fetch while the dialog is still open. It is the one
  // slow step of creating a workspace and it needs nothing the user hasn't
  // already decided, so paying for it here means Create doesn't have to.
  // Debounced past the ref settling, and re-primed if they change their mind.
  useEffect(() => {
    if (!isRepo || effectiveMode !== "new" || !fetchBase || !baseRef) return;
    const t = setTimeout(() => primeBaseFetch(dir, baseRef), 400);
    return () => clearTimeout(t);
  }, [dir, isRepo, effectiveMode, fetchBase, baseRef]);

  const effectiveStem = stemTouched ? stem : slugify(name.trim() || defaultName);
  const stemError = effectiveMode === "new" ? validateStem(effectiveStem) : null;
  const branchMissing = effectiveMode === "existing" && !existingBranch;

  /** Set when the chosen branch is already checked out in a live worktree, so
   *  picking it joins that checkout rather than making a second one. Only
   *  worktrees that still exist on disk count; git reports dead ones too. */
  const sharesWorktree = useMemo(
    () => !!refs?.local.find((b) => b.name === existingBranch)?.worktree_path,
    [refs, existingBranch],
  );

  const plan: BranchPlan = useMemo(
    () => ({
      mode: effectiveMode,
      stem: effectiveStem,
      baseRef: effectiveMode === "new" ? baseRef : "",
      branch: effectiveMode === "existing" ? existingBranch : undefined,
      fetch: fetchBase,
    }),
    [effectiveMode, effectiveStem, baseRef, existingBranch, fetchBase],
  );

  const baseOptions = useMemo<RefOption[]>(() => {
    if (!refs) return [];
    return [
      ...refs.remote.map((n) => ({ name: n, group: "Remote", note: n === refs.default_ref ? "default" : undefined })),
      ...refs.local.map((b) => ({
        name: b.name,
        group: "Local",
        note: b.name === refs.current ? "current" : undefined,
      })),
    ];
  }, [refs]);

  const existingOptions = useMemo<RefOption[]>(() => {
    if (!refs) return [];
    return refs.local.map((b) => ({
      name: b.name,
      // Nothing is unpickable any more. git allows a branch in one worktree at
      // a time, so this used to be greyed out — but the honest consequence of
      // picking it is "share that checkout", not "you may not". create_worktree
      // hands back the existing worktree instead of failing, which is the same
      // thing the Git panel's Adopt has always done.
      // (Worktrees whose directory is gone don't count at all: see
      // local_branches in git.rs.)
      // Kept to a word or two: the note column is uppercase 9px and does not
      // shrink, so anything longer eats the branch name beside it. The
      // consequence of picking one is spelled out under the picker instead.
      note: b.worktree_path
        ? b.name === refs.current
          ? "this checkout"
          : "shared"
        : b.name === refs.current
          ? "current"
          : undefined,
    }));
  }, [refs]);

  const carryPatterns = useMemo(() => getCarryPatterns(), []);
  const branchPreview = previewBranches(plan, agentCount);
  const canCreate = !stemError && !branchMissing;

  // Selection never creates: only Enter or the Create button do (a stray click
  // on an agent card used to spawn a whole workspace before you'd named it).
  const confirmCreate = () => {
    if (!canCreate) return;
    const finalName = name.trim() || defaultName;
    // Always persist the setup answer, including an empty one — that's what
    // marks the repo as answered and retires the suggestion.
    if (isRepo) worktreeSetupSet(dir, setupCmd).catch(() => {});
    // Remember the switch for next time. `secure`, not `jailed`: they differ
    // only when Docker is unavailable, and that is the machine's answer rather
    // than the user's. Storing `jailed` would let one workspace made while
    // Docker Desktop happened to be shut down turn the jail off permanently.
    setSecureByDefault(secure);
    onConfirm(finalName, kind, dir, layout, plan, jailed);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onCancel(); return; }
      // Enter creates — from anywhere, including the name field (the natural
      // "I'm done typing" gesture).
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); confirmCreate(); }
      // Agent/layout selection is arrow-driven inside each radiogroup now, so
      // arrows in the name field move the text cursor as expected.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose workspace directory" });
    if (selected) setDir(selected as string);
  };

  // `docker === null` is the probe still running, which is neither ready nor
  // unavailable — saying either would flip the toggle under the user a moment
  // after they read it.
  const probing = docker === null;
  // Only the network clause is conditional: the restriction is a machine-wide
  // setting, off by default, and claiming it here when it is off would be the
  // one kind of wrong this dialog cannot afford.
  const networkClause = egressRestricted ? " Network limited to your allowlist." : "";
  const secureHint = probing
    ? "Checking for Docker…"
    : dockerReady
    ? docker?.image_ready
      ? `Runs agents in a Docker container that sees only this folder — not your keys, your home directory or your other repos.${networkClause}`
      : `Runs agents in a Docker container that sees only this folder. First spawn builds the image.${networkClause}`
    : docker?.available
    ? "Docker is installed but not running — start Docker Desktop."
    : "Requires Docker Desktop to jail agents from your files and keys.";

  // Say the consequence out loud rather than leaving it to be inferred from an
  // unchecked box. Agents in this mode run with --dangerously-skip-permissions
  // / --yolo on the host, and a user who has not read the launch flags has no
  // way to know that from the dialog alone. Three shapes, because "you turned
  // it off", "Docker is not running" and "Docker is not installed" are three
  // different decisions and only the first one is a decision at all.
  const hostWarning = !jailed && !probing
    ? {
        title: "Agents will run directly on your Mac",
        body:
          "They start with permission prompts turned off, so each one can read, change and delete " +
          "anything your user account can, and reach the network, without asking first.",
        fix: docker?.available && !docker?.daemon_running
          ? "Start Docker Desktop and reopen this dialog to jail them instead."
          : docker?.available
          ? null
          : "Install Docker Desktop to jail them instead.",
      }
    : null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal sd" ref={modalRef} role="dialog" aria-modal="true" aria-label="New workspace" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onCancel} />

        <div className="sd-head">
          <div className="sd-eyebrow">New workspace</div>
          <div className="sd-title">A home for your agents</div>
        </div>

        <div className="sd-body">
          {/* Directory and Name share a row: two short single-line fields that
              were each taking a full one. Everything below stays stacked —
              splitting the whole dialog into columns was tried and the card
              grids do not survive half the width. */}
          <div className="sd-pair">
          {/* Directory */}
          <div className="sd-field">
            <label className="sd-label">Directory</label>
            <div className="sd-dir">
              <input
                ref={dirInputRef}
                className="sd-input"
                value={displayDir}
                onChange={(e) => setDir(expandDir(e.target.value))}
                spellCheck={false}
              />
              <button className="sd-browse" onClick={handleBrowse}>Browse…</button>
            </div>
          </div>

          {/* Name */}
          <div className="sd-field">
            <label className="sd-label">
              Name <span className="sd-label-hint">defaults to “{defaultName}”</span>
            </label>
            <input
              ref={inputRef}
              className="sd-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          </div>

          {/* Branch */}
          <div className="sd-field">
            <label className="sd-label" id="nw-branch-label">
              Branch
              {!isRepo && !refsLoading && <span className="sd-label-hint">not a git repository</span>}
            </label>
            {isRepo && (
              <div className="sd-modes" role="radiogroup" aria-labelledby="nw-branch-label">
                {BRANCH_MODES.map((m, i) => (
                  <div
                    key={m.mode}
                    role="radio"
                    aria-checked={branchMode === m.mode}
                    tabIndex={branchMode === m.mode ? 0 : -1}
                    className={`sd-mode${branchMode === m.mode ? " selected" : ""}`}
                    onClick={() => setBranchMode(m.mode)}
                    onKeyDown={(e) => onRadioKey(e, i, BRANCH_MODES.length, (ni) => setBranchMode(BRANCH_MODES[ni].mode))}
                  >
                    {m.label}
                  </div>
                ))}
              </div>
            )}

            {isRepo && branchMode === "new" && (
              <>
                <div className="sd-branch-row">
                  <input
                    className={`sd-input${stemError ? " invalid" : ""}`}
                    value={effectiveStem}
                    onChange={(e) => { setStemTouched(true); setStem(e.target.value); }}
                    aria-label="Branch name"
                    aria-invalid={!!stemError}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="sd-branch-from">from</span>
                  <BranchRefPicker
                    ariaLabel="Base ref"
                    value={baseRef}
                    options={baseOptions}
                    onPick={setBaseRef}
                    placeholder={refsLoading ? "…" : "current HEAD"}
                  />
                </div>
                {stemError && <div className="sd-branch-error">{stemError}</div>}
              </>
            )}

            {isRepo && branchMode === "existing" && (
              <BranchRefPicker
                ariaLabel="Branch to check out"
                value={existingBranch}
                options={existingOptions}
                onPick={setExistingBranch}
                placeholder={refsLoading ? "…" : "Pick a branch…"}
              />
            )}

            {/* What actually happens, in one line. */}
            <div className="sd-branch-hint">
              {effectiveMode === "current" ? (
                isRepo
                  ? `All ${agentCount === 1 ? "the agent works" : `${agentCount} agents work`} in your checkout on ${refs?.current || "the current branch"}. No isolation.`
                  : "Agents share this directory."
              ) : effectiveMode === "existing" ? (
                existingBranch
                  ? sharesWorktree
                    ? `${existingBranch} is already checked out — this joins that folder, so both agents see each other's edits.`
                    : `Checks out ${existingBranch} in its own worktree.`
                  : "Pick the branch to continue on."
              ) : branchMode === "existing" ? (
                `${agentCount} agents can't share one branch, so each gets ${branchPreview} off ${existingBranch || "it"}.`
              ) : agentCount === 1 ? (
                `Creates ${branchPreview}${baseRef ? ` off ${baseRef}` : ""}.`
              ) : (
                `Creates ${agentCount} branches (${branchPreview})${baseRef ? ` off ${baseRef}` : ""}.`
              )}
              {/* Same line, not a second paragraph under it: this is a detail
                  of the sentence above, and as its own block it cost a whole
                  row of the dialog to say one clause. */}
              {effectiveMode !== "current" && carryPatterns.length > 0 && (
                <span className="sd-hint-more"> Copies {carryPatterns.join(", ")} in.</span>
              )}
            </div>
          </div>

          {/* Setup — only meaningful for a fresh worktree; the current
              checkout is already installed. */}
          {effectiveMode !== "current" && (
            <div className="sd-field">
              <label className="sd-label" htmlFor="nw-setup">
                Setup <span className="sd-label-hint">optional, runs in each new worktree</span>
              </label>
              <input
                id="nw-setup"
                className="sd-input"
                value={setupCmd}
                onChange={(e) => { setSetupSuggested(false); setSetupCmd(e.target.value); }}
                placeholder="Nothing to run"
                autoComplete="off"
                spellCheck={false}
              />
              {/* Only when it earns the row. The empty-state sentence explained
                  why the field exists, which is worth a line the first time and
                  nothing on every visit after; the label already says what it
                  is. The lockfile note stays, because it is the one case where
                  the app has put something in the box on your behalf. */}
              {setupSuggested && setupCmd.trim() && (
                <div className="sd-branch-hint subtle">
                  Detected from this repo's lockfile — clear it if that's wrong.
                </div>
              )}
            </div>
          )}

          {/* Agent */}
          <div className="sd-field">
            <label className="sd-label" id="nw-agent-label">Coding agent</label>
            <div className="sd-agents" role="radiogroup" aria-labelledby="nw-agent-label">
              {AGENT_KINDS.map((k, i) => {
                // Still selectable when missing. The probe can be wrong (an
                // agent installed into a shell we did not ask, a wrapper
                // function rather than a binary), and being unable to pick the
                // agent you know you have is a worse failure than starting one
                // that turns out not to be there.
                const missing = installed ? installed[k] === false : false;
                return (
                  <div
                    key={k}
                    role="radio"
                    aria-checked={kind === k}
                    aria-label={missing ? `${AGENT_META[k].label} (not installed)` : AGENT_META[k].label}
                    tabIndex={kind === k ? 0 : -1}
                    className={`sd-agent${kind === k ? " selected" : ""}${missing ? " missing" : ""}`}
                    style={{ ["--kind-color" as never]: agentColor(k) }}
                    onClick={() => setKind(k)}
                    onKeyDown={(e) => onRadioKey(e, i, AGENT_KINDS.length, (ni) => setKind(AGENT_KINDS[ni]))}
                  >
                    <AgentLogo kind={k} size={16} className="sd-agent-logo" />
                    {AGENT_META[k].label}
                  </div>
                );
              })}
            </div>
            {installed?.[kind] === false && (
              <div className="sd-field-note">
                <code>{AGENT_META[kind].cmd.split(" ")[0]}</code> isn't on your shell's PATH.
                Its panes will open and show a "command not found" instead of an agent.
              </div>
            )}
          </div>

          {/* Layout */}
          <div className="sd-field">
            <label className="sd-label" id="nw-layout-label">
              Agents <span className="sd-label-hint">panes to open</span>
            </label>
            <div className="sd-layouts" role="radiogroup" aria-labelledby="nw-layout-label">
              {LAYOUTS.map((l, i) => (
                <div
                  key={l.kind}
                  role="radio"
                  aria-checked={layout === l.kind}
                  aria-label={`${l.label} ${l.label === "1" ? "agent" : "agents"}`}
                  tabIndex={layout === l.kind ? 0 : -1}
                  className={`sd-layout${layout === l.kind ? " selected" : ""}`}
                  onClick={() => setLayout(l.kind)}
                  onKeyDown={(e) => onRadioKey(e, i, LAYOUTS.length, (ni) => setLayout(LAYOUTS[ni].kind))}
                >
                  <LayoutThumb rows={l.rows} cols={l.cols} />
                  <span className="sd-layout-n">{l.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Options */}
          <div className="sd-options">
            {effectiveMode === "new" && (
              <label className="sd-toggle">
                <input
                  type="checkbox"
                  checked={fetchBase}
                  onChange={(e) => setFetchBase(e.target.checked)}
                />
                <div className="sd-toggle-text">
                  <div className="sd-toggle-label">Fetch base first</div>
                  <div className="sd-toggle-hint">
                    Updates {baseRef || "the base ref"} from its remote, so agents don't start on a stale branch.
                  </div>
                </div>
              </label>
            )}
            <label className={`sd-toggle${dockerReady ? "" : " disabled"}`}>
              <input
                type="checkbox"
                checked={jailed}
                disabled={!dockerReady}
                onChange={(e) => setSecure(e.target.checked)}
              />
              <div className="sd-toggle-text">
                <div className="sd-toggle-label">
                  Secure mode
                  <span className="sd-toggle-tag">DOCKER</span>
                </div>
                <div className="sd-toggle-hint">{secureHint}</div>
              </div>
            </label>
            {hostWarning && (
              <div className="sd-warn" role="note">
                <div className="sd-warn-title">{hostWarning.title}</div>
                <div className="sd-warn-body">
                  {hostWarning.body}
                  {hostWarning.fix ? ` ${hostWarning.fix}` : ""}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="sd-foot">
          <div className="sd-foot-keys">
            <span>↑↓ agent</span>
            <span>esc cancel</span>
          </div>
          <div className="sd-foot-spacer" />
          <button className="sd-btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="sd-btn-primary" onClick={confirmCreate} disabled={!canCreate}>
            Create workspace
            <span className="sd-kbd">⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function LayoutThumb({ rows, cols }: { rows: number; cols: number }) {
  const cells = Array.from({ length: rows * cols });
  return (
    <div
      className="sd-thumb"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
    >
      {cells.map((_, i) => (
        <div key={i} className="sd-thumb-cell" />
      ))}
    </div>
  );
}
