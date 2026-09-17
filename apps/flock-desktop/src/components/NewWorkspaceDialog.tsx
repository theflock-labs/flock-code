import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
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
import { lineupLabel, MAX_PRESETS, readWorkspacePresets, resizeLineup, SESSION_COUNTS, STARTER_PRESETS, writeWorkspacePresets, type WorkspacePreset } from "../lib/workspacePresets";
import type { AgentKind, BranchMode, BranchPlan, WorkspaceLaunch } from "../types";
import "../styles/spawnDialog.css";
import "../styles/newWorkspace.css";

interface Props {
  cwd: string;
  onConfirm: (launch: WorkspaceLaunch) => void;
  onCancel: () => void;
}

const BRANCH_MODES: { mode: BranchMode; label: string }[] = [
  { mode: "new", label: "New branch" },
  { mode: "existing", label: "Existing" },
  { mode: "current", label: "Current checkout" },
];

const PICKER_AGENTS: AgentKind[] = ["claude", "codex", ...AGENT_KINDS.filter((agent) => agent !== "claude" && agent !== "codex")];

const AGENT_INSTALL_GUIDES: Record<AgentKind, string> = {
  claude: "https://code.claude.com/docs/en/overview",
  grok: "https://docs.x.ai/build/overview",
  opencode: "https://opencode.ai/docs/",
  codex: "https://developers.openai.com/codex/cli",
  pi: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
};

export default function NewWorkspaceDialog({ cwd, onConfirm, onCancel }: Props) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AgentKind>("claude");
  const [agents, setAgents] = useState<AgentKind[]>(["claude"]);
  const [presets, setPresets] = useState(readWorkspacePresets);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetError, setPresetError] = useState("");
  const presetNameRef = useRef<HTMLInputElement>(null);
  const [dir, setDir] = useState(cwd);
  // `dir` stays absolute (what the backend needs); the field shows the home
  // prefix as ~ so the path reads in shortform (~/git/…/desktop). Typing ~
  // expands back on the way in.
  const [home, setHome] = useState("");
  useEffect(() => { homeDir().then((h) => setHome(h.replace(/\/$/, ""))).catch(() => {}); }, []);
  const displayDir = home && (dir === home || dir.startsWith(home + "/")) ? "~" + dir.slice(home.length) : dir;
  const expandDir = (v: string) => (home && (v === "~" || v.startsWith("~/")) ? home + v.slice(1) : v);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const kindTouched = useRef(false);
  const [customize, setCustomize] = useState(() => getDefaultBranchMode() === "existing");
  const [allowUncheckedAgent, setAllowUncheckedAgent] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [dockerError, setDockerError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  // Keep the preference separate from actual Docker readiness. A stopped
  // daemon must never silently change the user's saved secure default.
  const [secure, setSecure] = useState(getSecureByDefault);
  const [docker, setDocker] = useState<ContainerStatus | null>(null);
  // Machine-wide, set in Settings → Security. Read only to say so here: the
  // hint below otherwise reads as if the jail contained the network too, and
  // by default it does not. Never a claim this dialog makes on its own.
  const [egressRestricted, setEgressRestricted] = useState(false);
  // Missing map entries and failed checks are unknown, never ready.
  const [installed, setInstalled] = useState<Record<string, boolean> | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const dismissedRef = useRef(false);
  useFocusTrap(modalRef);
  const cancel = () => { dismissedRef.current = true; onCancel(); };
  useEffect(() => {
    dismissedRef.current = false;
    return () => { dismissedRef.current = true; };
  }, []);

  // ── Branch ────────────────────────────────────────────────────────────────
  const [branchMode, setBranchMode] = useState<BranchMode>(getDefaultBranchMode());
  const [stem, setStem] = useState("");
  // Once the stem is typed in it stops tracking the workspace name.
  const [stemTouched, setStemTouched] = useState(false);
  const [baseRef, setBaseRef] = useState("");
  const [existingBranch, setExistingBranch] = useState("");
  const [fetchBase, setFetchBase] = useState(getFetchBaseDefault());
  const [refs, setRefs] = useState<BranchOptions | null>(null);
  const [refsLoading, setRefsLoading] = useState(true);
  const [refsError, setRefsError] = useState("");
  const [repoCheck, setRepoCheck] = useState(0);
  // Per-repo setup command, stored backend-side. Empty = nothing to run.
  const [setupCmd, setSetupCmd] = useState("");
  const [setupSuggested, setSetupSuggested] = useState(false);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState("");

  const checkDocker = async () => {
    setDocker(null);
    setDockerError("");
    try { setDocker(await containerStatus()); }
    catch (error) { setDockerError(String(error)); }
  };
  const checkAgents = async () => {
    setInstalled(null);
    setAgentError("");
    setAllowUncheckedAgent(false);
    try {
      const result = await agentCliStatus();
      setInstalled(result);
      if (!kindTouched.current) {
        const firstInstalled = AGENT_KINDS.find((agent) => result[agent] === true);
        if (firstInstalled) {
          setKind(firstInstalled);
          setAgents((current) => current.map(() => firstInstalled));
        }
      }
    } catch (error) { setAgentError(String(error)); }
  };
  const selectAgent = (agent: AgentKind) => {
    kindTouched.current = true;
    setKind(agent);
    setAgents((current) => current.map(() => agent));
    setActivePreset(null);
    setAllowUncheckedAgent(false);
  };
  const changeCount = (count: number) => {
    setAgents((current) => resizeLineup(current, count, kind));
    setActivePreset(null);
    setAllowUncheckedAgent(false);
  };
  const changeSeat = (index: number, agent: AgentKind) => {
    kindTouched.current = true;
    setAgents((current) => current.map((value, seat) => seat === index ? agent : value));
    setActivePreset(null);
    setAllowUncheckedAgent(false);
  };
  const applyPreset = (preset: WorkspacePreset) => {
    kindTouched.current = true;
    setAgents([...preset.agents]);
    setKind(preset.agents[0]);
    setActivePreset(preset.id);
    setAllowUncheckedAgent(false);
  };
  const savePreset = () => {
    if (!presetName.trim() || presets.length >= MAX_PRESETS) return;
    const preset = { id: crypto.randomUUID(), name: presetName.trim(), agents: [...agents] };
    const next = [...presets, preset];
    if (!writeWorkspacePresets(next)) {
      setPresetError("Couldn’t save this preset. Your browser storage may be full or unavailable. Try again.");
      return;
    }
    setPresets(next);
    setActivePreset(preset.id);
    setEditingPreset(false);
    setPresetName("");
    setPresetError("");
  };
  const deletePreset = (id: string) => {
    const next = presets.filter((preset) => preset.id !== id);
    if (!writeWorkspacePresets(next)) {
      setPresetError("Couldn’t remove this preset. Try again when browser storage is available.");
      return;
    }
    setPresets(next);
    if (activePreset === id) setActivePreset(null);
    setPresetError("");
  };
  useEffect(() => { if (editingPreset) presetNameRef.current?.focus(); }, [editingPreset]);
  useEffect(() => {
    dirInputRef.current?.focus();
    void checkDocker();
    void checkAgents();
    egressPolicy().then((p) => setEgressRestricted(p.restrict)).catch(() => {});
  }, []);

  const agentCount = agents.length;
  const uniformKind = agents.every((agent) => agent === agents[0]) ? agents[0] : null;
  const dockerReady = !!docker?.available && !!docker?.daemon_running;
  // What the workspace will actually do, which is not the same as what the
  // toggle says: without a running daemon there is nothing to jail into.
  const jailed = secure && dockerReady;
  const defaultName = dir.replace(/\/+$/, "").split("/").pop() || "workspace";
  const agentChecking = installed === null && !agentError;
  const uncheckedAgents = [...new Set(agents)].filter((agent) => installed?.[agent] !== true);
  const agentReady = uncheckedAgents.length === 0;

  // Load the repo's refs whenever the directory settles. Debounced because
  // `dir` is a free-text field: every keystroke would otherwise shell out.
  useEffect(() => {
    let cancelled = false;
    setRefsLoading(true);
    setRefs(null);
    setRefsError("");
    setBaseRef("");
    setExistingBranch("");
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
        .catch((error) => { if (!cancelled) setRefsError(String(error)); })
        .finally(() => { if (!cancelled) setRefsLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dir, repoCheck]);

  // Setup command for this repo. A repo that's never been answered for gets
  // its detected command PREFILLED rather than placeholdered, so the choice is
  // confirm-or-clear instead of a suggestion the field might or might not run.
  useEffect(() => {
    let cancelled = false;
    setSetupLoading(true);
    setSetupError("");
    setSetupCmd("");
    setSetupSuggested(false);
    const t = setTimeout(() => {
      worktreeSetupGet(dir)
        .then((info) => {
          if (cancelled) return;
          const prefill = info.unset ? info.suggestion : info.command;
          setSetupCmd(prefill);
          setSetupSuggested(info.unset && !!info.suggestion);
        })
        .catch((error) => { if (!cancelled) setSetupError(String(error)); })
        .finally(() => { if (!cancelled) setSetupLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dir, repoCheck]);

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
  const probing = docker === null && !dockerError;
  const canCreate = !!dir.trim() && !stemError && !branchMissing && !refsLoading && !refsError
    && !(isRepo && (setupLoading || setupError)) && !probing && !agentChecking
    && (agentReady || allowUncheckedAgent) && !saving;

  // Selection never creates: only Enter or the Create button do (a stray click
  // on an agent card used to spawn a whole workspace before you'd named it).
  const confirmCreate = async () => {
    if (!canCreate) return;
    const finalName = name.trim() || defaultName;
    // Always persist the setup answer, including an empty one — that's what
    // marks the repo as answered and retires the suggestion.
    setSaving(true);
    setActionError("");
    try {
      if (isRepo) await worktreeSetupSet(dir, setupCmd);
    } catch (error) {
      setActionError(`Couldn’t save the setup command: ${String(error)}. Try launching again.`);
      setSaving(false);
      return;
    }
    if (dismissedRef.current) return;
    // Remember the switch for next time. `secure`, not `jailed`: they differ
    // only when Docker is unavailable, and that is the machine's answer rather
    // than the user's. Storing `jailed` would let one workspace made while
    // Docker Desktop happened to be shut down turn the jail off permanently.
    setSecureByDefault(secure);
    onConfirm({ name: finalName, agents: [...agents], dir, plan, secure: jailed });
    setSaving(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { cancel(); return; }
      const target = e.target instanceof HTMLElement ? e.target : null;
      // Preserve Enter on buttons, checkboxes and comboboxes: retry/browse/
      // Customize must activate their own controls without launching agents.
      if (e.key === "Enter" && !e.isComposing && !e.defaultPrevented
        && target?.matches('input:not([type="checkbox"]):not(#nw-preset-name)')) {
        e.preventDefault();
        void confirmCreate();
      }
      // Agent/layout selection is arrow-driven inside each radiogroup now, so
      // arrows in the name field move the text cursor as expected.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Choose workspace directory" });
      if (selected) setDir(selected as string);
    } catch (error) { setActionError(`Couldn’t open the folder picker: ${String(error)}`); }
  };

  // `docker === null` is the probe still running, which is neither ready nor
  // unavailable — saying either would flip the toggle under the user a moment
  // after they read it.
  // Only the network clause is conditional: the restriction is a machine-wide
  // setting, off by default, and claiming it here when it is off would be the
  // one kind of wrong this dialog cannot afford.
  const networkClause = egressRestricted ? " Network limited to your allowlist." : "";
  const secureHint = dockerError
    ? "Couldn’t check Docker. Check again to confirm secure mode is available."
    : probing
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
        fix: dockerError
          ? "Check Docker again to confirm whether secure mode is available."
          : docker?.available && !docker?.daemon_running
          ? "Start Docker Desktop, then choose Check Docker again to use secure mode."
          : docker?.available
          ? null
          : "Install Docker Desktop to jail them instead.",
      }
    : null;

  return (
    <div className="modal-overlay" onClick={cancel}>
      <div className="modal sd nw" ref={modalRef} role="dialog" aria-modal="true" aria-label="New workspace" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={cancel} />

        <div className="sd-head">
          <h2 className="sd-title">New workspace</h2>
          <p className="nw-intro">Choose your agents. Give them a place to work.</p>
        </div>

        <div className="sd-body">
        <fieldset className="sd-configuration" disabled={saving} aria-label="Workspace configuration"
          onClickCapture={(event) => { if (saving) { event.preventDefault(); event.stopPropagation(); } }}
          onChangeCapture={(event) => { if (saving) event.stopPropagation(); }}
          onKeyDownCapture={(event) => {
            // A disabled fieldset freezes native fields. Custom radio tiles
            // need the same protection, while Tab and Escape still reach
            // the dialog's focus trap and its always-available Cancel action.
            if (saving && event.key !== "Tab" && event.key !== "Escape") {
              event.preventDefault(); event.stopPropagation();
            }
          }}>
          {/* Directory */}
          <div className="sd-field">
            <label className="sd-label" htmlFor="nw-directory">Repository folder</label>
            <div className="sd-dir">
              <input
                id="nw-directory"
                ref={dirInputRef}
                title={dir}
                className="sd-input"
                value={displayDir}
                onChange={(e) => setDir(expandDir(e.target.value))}
                spellCheck={false}
              />
              <button className="sd-browse" onClick={handleBrowse}>Browse…</button>
            </div>
          </div>

          {refsError && <div className="sd-field-note" role="alert">
            Couldn’t check this folder: {refsError}
            <button className="sd-btn-ghost" onClick={() => setRepoCheck((value) => value + 1)}>Check folder again</button>
          </div>}

          <section className="sd-field" aria-labelledby="nw-presets-label">
            <div className="sd-label" id="nw-presets-label">Preset</div>
            <div className="nw-presets">
              {[...STARTER_PRESETS, ...presets].map((preset) => (
                <div className="nw-preset-wrap" key={preset.id}>
                  <button type="button" className={`nw-preset${activePreset === preset.id ? " selected" : ""}`}
                    aria-pressed={activePreset === preset.id} onClick={() => applyPreset(preset)}>
                    <span className="nw-preset-title"><WorkspaceIcon name="bookmark" /><span>{preset.name}</span><span className="nw-preset-count">{preset.agents.length}</span></span>
                    <span className="nw-preset-description">{lineupLabel(preset.agents)}</span>
                  </button>
                  {presets.some((saved) => saved.id === preset.id) && (
                    <button type="button" className="nw-preset-delete" aria-label={`Delete preset ${preset.name}`} onClick={() => deletePreset(preset.id)}>
                      <WorkspaceIcon name="close" size={12} />
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="nw-preset nw-new-preset" disabled={presets.length >= MAX_PRESETS}
                aria-expanded={editingPreset} aria-controls="nw-preset-editor"
                onClick={() => { setEditingPreset((current) => !current); setPresetError(""); }}>
                <span className="nw-preset-title"><WorkspaceIcon name="plus" />New preset</span>
                <span className="nw-preset-description">{presets.length >= MAX_PRESETS ? "Remove a saved preset to add another." : "Save this lineup for next time."}</span>
              </button>
            </div>
            {editingPreset && <form id="nw-preset-editor" className="nw-preset-editor" onSubmit={(event) => { event.preventDefault(); savePreset(); }}
              onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditingPreset(false); } }}>
              <label className="sd-label" htmlFor="nw-preset-name">Preset name</label>
              <div className="nw-preset-editor-fields">
                <input ref={presetNameRef} id="nw-preset-name" className="sd-input" maxLength={40} value={presetName}
                  placeholder="e.g. Daily team" autoComplete="off" onChange={(event) => setPresetName(event.target.value)} />
                <button type="submit" className="sd-btn-primary" disabled={!presetName.trim() || presets.length >= MAX_PRESETS}>Save preset</button>
                <button type="button" className="sd-btn-ghost" onClick={() => setEditingPreset(false)}>Cancel preset</button>
              </div>
              <span className="nw-help">Saves {lineupLabel(agents)}. Folder and isolation stay separate.</span>
            </form>}
            {presetError && <div className="sd-branch-error" role="alert">{presetError}</div>}
          </section>

          <div className="sd-field">
            <div className="nw-section-label"><span className="sd-label" id="nw-agent-label">Agent</span><span className="nw-help">{uniformKind ? "Choose for all sessions" : "Mixed lineup · choose to replace all"}</span></div>
            <div className="nw-agents" role="radiogroup" aria-labelledby="nw-agent-label">
              {PICKER_AGENTS.map((agent, index) => {
                const ready = installed?.[agent] === true;
                const missing = installed?.[agent] === false;
                const status = agentChecking ? "Checking…" : ready ? "Ready" : missing ? "Missing" : "Couldn’t check";
                return <button type="button"
                  key={agent}
                  role="radio"
                  aria-checked={uniformKind === agent}
                  aria-label={`${AGENT_META[agent].label}, ${status}`}
                  tabIndex={(uniformKind ?? kind) === agent ? 0 : -1}
                  className={`nw-agent${uniformKind === agent ? " selected" : ""}`}
                  style={{ ["--kind-color" as never]: agentColor(agent) }}
                  onClick={() => selectAgent(agent)}
                  onKeyDown={(event) => onRadioKey(event, index, PICKER_AGENTS.length, (next) => selectAgent(PICKER_AGENTS[next]))}
                >
                  <AgentLogo kind={agent} size={18} className="sd-agent-logo" />
                  <span className="nw-agent-name">{AGENT_META[agent].label}</span>
                  {!ready && <span className="nw-agent-status">{status}</span>}
                  {uniformKind === agent && <span className="nw-selected-mark"><WorkspaceIcon name="check" size={12} /></span>}
                </button>;
              })}
            </div>
            {!agentChecking && !agentReady && <div className="sd-readiness" role="status">
              {uncheckedAgents.map((agent) => <div key={agent}>
                {installed?.[agent] === false ? `${AGENT_META[agent].label} is missing from your login shell’s PATH.` : `Couldn’t check ${AGENT_META[agent].label}${agentError ? `: ${agentError}` : "."}`}
                {" "}<button type="button" className="nw-text-button" onClick={() => openUrl(AGENT_INSTALL_GUIDES[agent]).catch((error) => setActionError(String(error)))}>Installation guide for {AGENT_META[agent].label}</button>
              </div>)}
              <div>Install and sign in through the CLI, or change the affected sessions below.</div>
              <button type="button" className="sd-btn-ghost nw-recheck" onClick={() => void checkAgents()}>Check agents again</button>
              <label className="sd-override">
                <input type="checkbox" checked={allowUncheckedAgent} onChange={(event) => setAllowUncheckedAgent(event.target.checked)} />
                I use a custom wrapper or know these agents work. Launch anyway.
              </label>
            </div>}
          </div>

          <div className="sd-field">
            <div className="sd-label" id="nw-count-label">How many</div>
            <div className="nw-count-row">
              <div className="nw-counts" role="radiogroup" aria-labelledby="nw-count-label">
                {SESSION_COUNTS.map((count, index) => <button type="button" key={count} role="radio"
                  className={`nw-count${agentCount === count ? " selected" : ""}`} aria-checked={agentCount === count}
                  aria-label={`${count} ${count === 1 ? "agent" : "agents"}`} tabIndex={agentCount === count ? 0 : -1}
                  onClick={() => changeCount(count)} onKeyDown={(event) => onRadioKey(event, index, SESSION_COUNTS.length, (next) => changeCount(SESSION_COUNTS[next]))}>
                  {count}
                </button>)}
              </div>
              <span className="nw-help">parallel sessions</span>
            </div>
          </div>

          <div className="sd-field">
            <div className="sd-label" id="nw-isolation-label">Isolation</div>
            <div className="nw-isolation" role="radiogroup" aria-labelledby="nw-isolation-label">
              <button type="button" role="radio" aria-checked={effectiveMode === "current"}
                className={`nw-isolation-choice${effectiveMode === "current" ? " selected" : ""}`}
                tabIndex={effectiveMode === "current" ? 0 : -1} onClick={() => setBranchMode("current")}
                onKeyDown={(event) => { if (isRepo) onRadioKey(event, 0, 2, (next) => setBranchMode(next ? "new" : "current")); }}>
                <WorkspaceIcon name="folder" />Shared checkout
              </button>
              <button type="button" role="radio" aria-checked={effectiveMode !== "current"} disabled={!isRepo || refsLoading || !!refsError}
                className={`nw-isolation-choice${effectiveMode !== "current" ? " selected" : ""}`}
                tabIndex={effectiveMode !== "current" ? 0 : -1} onClick={() => setBranchMode((current) => current === "existing" ? current : "new")}
                onKeyDown={(event) => onRadioKey(event, 1, 2, (next) => setBranchMode(next ? "new" : "current"))}>
                <WorkspaceIcon name="branch" />{effectiveMode === "existing" && agentCount === 1 ? "Existing branch in a worktree" : "New worktree per agent"}
              </button>
            </div>
            <span className="nw-help">{refsLoading ? "Checking repository…" : refsError ? "Check the folder to choose isolation." : !isRepo ? "Not a Git repository. Sessions will share this folder." : effectiveMode === "current" ? `Agents share the files on ${refs?.current || "the current branch"}.` : effectiveMode === "existing" && agentCount === 1 && sharesWorktree ? `Joins the existing checkout of ${existingBranch}. Changes are shared.` : "Each agent gets its own working copy and branch."}</span>
          </div>

          <section className="nw-launch" aria-label="Launch summary">
            <div className="nw-section-label"><span className="sd-label">Will launch</span><span className="nw-help">Change any session</span></div>
            <ol className="nw-lineup">
              {agents.map((agent, index) => <li key={index} className="nw-seat" style={{ ["--kind-color" as never]: agentColor(agent) }}>
                <span className="nw-seat-number" aria-hidden="true">{index + 1}</span>
                <AgentLogo kind={agent} size={16} className="sd-agent-logo" />
                <select aria-label={`Session ${index + 1} agent`} value={agent} onChange={(event) => changeSeat(index, event.target.value as AgentKind)}>
                  {AGENT_KINDS.map((choice) => <option key={choice} value={choice}>{AGENT_META[choice].label}{installed?.[choice] === false ? " — Missing" : ""}</option>)}
                </select>
                <WorkspaceIcon name="chevron" size={12} />
              </li>)}
            </ol>
            <div className="nw-launch-details" aria-live="polite">
            <strong>{agentCount} {uniformKind ? `${AGENT_META[uniformKind].label} ` : ""}{agentCount === 1 ? "agent" : "agents"} in “{name.trim() || defaultName}”</strong>
            <div>{refsLoading ? "Checking repository…" : refsError ? "Choose a folder we can check before launching." : branchMissing ? "Choose an existing branch in Customize." : effectiveMode === "current"
              ? isRepo ? `Works in your current checkout on ${refs?.current || "the current branch"}. Agents share these files.` : "Works directly in this folder. It is not a Git repository."
              : effectiveMode === "existing" && agentCount === 1
              ? existingBranch ? sharesWorktree ? `Joins the existing checkout of ${existingBranch}; changes are shared.` : `Checks out ${existingBranch} in its own worktree.` : "Choose an existing branch in Customize."
              : `Creates ${agentCount === 1 ? "a separate worktree on" : `${agentCount} separate worktrees on`} ${branchPreview}${effectiveMode === "existing" ? ` from ${existingBranch || "your chosen branch"}` : baseRef ? ` from ${baseRef}` : " from current HEAD"}.`}
            </div>
            {effectiveMode !== "current" && <div>
              {setupLoading ? "Checking setup command…" : setupError ? "Couldn’t check the setup command." : setupCmd.trim() ? <>Runs <code>{setupCmd}</code> in each new worktree{setupSuggested ? " (detected from this repo)" : ""}.</> : "No setup command will run."}
              {carryPatterns.length > 0 && <> Copies {carryPatterns.join(", ")} into new worktrees.</>}
              {(effectiveMode === "new" || agentCount > 1) && <> {fetchBase ? "Fetches the base ref first." : "Uses the local base ref without fetching."}</>}
            </div>}
            <div>{probing ? "Checking execution mode…" : jailed ? `Runs in a Docker container.${docker?.image_ready ? "" : " The first launch builds its image."}` : "Runs directly on your Mac with permission prompts turned off."}</div>
            </div>
          </section>
          {stemError && !customize && <div className="sd-branch-error" role="alert">{stemError} Open Customize to fix the branch name.</div>}

          <button className="sd-customize-toggle" aria-expanded={customize} aria-controls="nw-customize" onClick={() => setCustomize((value) => !value)}>
            <span className="nw-customize-title"><WorkspaceIcon name="chevron" size={14} />{customize ? "Hide customization" : "Customize"}</span><span>Name, branch and setup</span>
          </button>
          {customize && <div id="nw-customize" className="sd-customize">
          {/* Name */}
          <div className="sd-field">
            <label className="sd-label" htmlFor="nw-name">
              Name <span className="sd-label-hint">defaults to “{defaultName}”</span>
            </label>
            <input
              id="nw-name"
              className="sd-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {/* Branch */}
          {effectiveMode !== "current" && <div className="sd-field">
            <div className="sd-label" id="nw-branch-label">
              Branch
              {!isRepo && !refsLoading && <span className="sd-label-hint">not a git repository</span>}
            </div>
            {isRepo && (
              <div className="sd-modes" role="radiogroup" aria-labelledby="nw-branch-label">
                {BRANCH_MODES.filter((mode) => mode.mode !== "current").map((m, i) => (
                  <div
                    key={m.mode}
                    role="radio"
                    aria-checked={branchMode === m.mode}
                    aria-disabled={saving}
                    tabIndex={!saving && branchMode === m.mode ? 0 : -1}
                    className={`sd-mode${branchMode === m.mode ? " selected" : ""}`}
                    onClick={() => setBranchMode(m.mode)}
                    onKeyDown={(e) => onRadioKey(e, i, 2, (ni) => setBranchMode(BRANCH_MODES[ni].mode))}
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

          </div>}

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

            {effectiveMode === "new" && (
              <label className="sd-toggle">
                <input type="checkbox" checked={fetchBase} onChange={(event) => setFetchBase(event.target.checked)} />
                <div className="sd-toggle-text">
                  <div className="sd-toggle-label">Fetch base first</div>
                  <div className="sd-toggle-hint">Updates {baseRef || "the base ref"} from its remote before creating branches.</div>
                </div>
              </label>
            )}
          </div>}
          {isRepo && setupError && <div className="sd-field-note" role="alert">
            Couldn’t check the setup command: {setupError}
            <button className="sd-btn-ghost" onClick={() => setRepoCheck((value) => value + 1)}>Check setup again</button>
          </div>}
          {/* Options */}
          <div className="sd-options sd-safety">
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
                  <span className={`sd-toggle-tag${dockerReady ? "" : " unavailable"}`}>{probing ? "Checking…" : dockerError ? "Couldn’t check" : dockerReady ? "Ready" : "Unavailable"}</span>
                </div>
                <div className="sd-toggle-hint">{secureHint}</div>
              </div>
            </label>
            {!probing && <button className="sd-btn-ghost" onClick={() => void checkDocker()}>Check Docker again</button>}
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
          {actionError && <div className="sd-branch-error" role="alert">{actionError}</div>}
        </fieldset>
        </div>

        <div className="sd-foot">
          <div className="sd-foot-keys">
            <span>esc cancel</span>
          </div>
          <div className="sd-foot-spacer" />
          <button className="sd-btn-ghost" onClick={cancel}>Cancel</button>
          <button className="sd-btn-primary" onClick={confirmCreate} disabled={!canCreate}>
            {saving ? "Preparing…" : `Launch ${agentCount === 1 ? "agent" : `${agentCount} agents`}`}
            <span className="sd-kbd">⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceIcon({ name, size = 16 }: { name: "bookmark" | "plus" | "close" | "check" | "folder" | "branch" | "chevron"; size?: number }) {
  const paths = {
    bookmark: "M6 3h12v18l-6-4-6 4V3Z",
    plus: "M12 5v14M5 12h14",
    close: "m6 6 12 12M18 6 6 18",
    check: "m5 12 4 4L19 6",
    folder: "M3 7V5h6l2 2h10v13H3V7Zm0 3h18",
    branch: "M6 6v12M6 12c7 0 12-1 12-6M4 3h4v4H4zM4 17h4v4H4zM16 3h4v4h-4z",
    chevron: "m6 9 6 6 6-6",
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
