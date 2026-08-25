import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import ModalCloseButton from "./ModalCloseButton";
import { useFocusTrap } from "../lib/useFocusTrap";
import {
  githubCheck, githubDisconnect, githubOauthStart, githubOauthPoll,
  voiceGetEnabled, voiceSetEnabled, voiceModelStatus, voiceDownloadModel, onVoiceDownloadProgress,
  voiceGetStats, type VoiceStats,
  voiceAvailableModels, voiceGetModel, voiceSetModel, type VoiceModelOption,
  voiceListInputDevices, voiceGetInputDevice, voiceSetInputDevice,
  voiceGetLanguage, voiceSetLanguage, voiceGetVocab, voiceSetVocab,
  voiceGetCleanup, voiceSetCleanup,
  installAgentHook, uninstallAgentHook, agentHookStatus, type HookAgent,
  containerStatus, egressPolicy, setEgressPolicy, type ContainerStatus,
} from "../lib/tauri";
import { copyText } from "../lib/clipboard";
import { applyTheme, getFollowSystem, getStoredTheme, setFollowSystem, systemTheme, THEMES, type ThemeId } from "../lib/theme";
import { getGithubIntegrationEnabled, setGithubIntegrationEnabled } from "../lib/githubSettings";
import {
  getDefaultBranchMode, setDefaultBranchMode,
  getDeleteBranchWithWorktree, setDeleteBranchWithWorktree,
  getWorktreesBaseDir, setWorktreesBaseDir,
  getFetchBaseDefault, setFetchBaseDefault,
  getCarryPatternsText, setCarryPatterns,
} from "../lib/worktreeSettings";
import {
  applyPaneFontSize, applyUiScale, BASE_PANE_FONT_SIZE, getStoredPaneFontSize, getStoredUiScale,
  onPaneFontSizeChange, PANE_FONT_MAX, PANE_FONT_MIN, stepPaneFontSize, UI_SCALES, type UiScaleId,
} from "../lib/uiScale";
import { VOICE_HOTKEYS, getStoredVoiceHotkey, setStoredVoiceHotkey, getVoiceHotkeyOption, type VoiceHotkeyId } from "../lib/voiceHotkey";
import GraphSettingsSection from "./GraphSettingsSection";
import { getQuickActionsHidden, setQuickActionsHidden } from "./QuickActions";
import AccountSection from "./AccountSection";
import TeamsSection from "./TeamsSection";
import AgentUsageSection from "./AgentUsageSection";
import ProvenanceSection from "./ProvenanceSection";
import OpencodeUsageSection from "./OpencodeUsageSection";
import { GrokUsageSection } from "./GrokUsageChip";
import { claudeUsage, codexUsage } from "../lib/tauri";
import { onRadioKey } from "../lib/a11y";
import {
  PersonIcon, ChartIcon, AppearanceIcon, MicIcon, BranchIcon,
  GithubIcon, GraphIcon, TeamsIcon, PuzzleIcon, RecordIcon, ShieldIcon, InfoIcon,
} from "./settingsIcons";
import { getSecureByDefault, setSecureByDefault } from "../lib/secureSettings";
import { TOAST_KIND_LABELS, onToastSuppressionChange, suppressedToasts, unsuppressToast, type ToastKind } from "../lib/toastSuppression";
import BudgetSection from "./BudgetSection";
import type { Budget } from "../lib/budgets";
import type { BranchMode, GitHubStatus, Workspace } from "../types";
// The branch-mode segmented control is shared with NewWorkspaceDialog, where
// the same choice is made per workspace.
import "../styles/spawnDialog.css";
import { CheckIcon } from "./friendIcons";

const GITHUB_CLIENT_ID = "Ov23liWUykhhVLpalI4c";

const BRANCH_MODE_CHOICES: { mode: BranchMode; label: string; hint: string }[] = [
  { mode: "new", label: "New branch", hint: "Each agent gets its own branch and worktree, cut from the repo's default branch. Your working copy is never touched." },
  { mode: "existing", label: "Existing", hint: "Pick a branch to continue on; it's checked out in a worktree. With more than one agent, that branch becomes the base each agent branches from." },
  { mode: "current", label: "Current checkout", hint: "No isolation — every agent works directly in your repo directory, on whatever branch it's on." },
];

const HOOK_AGENTS: { id: HookAgent; label: string; hint: string }[] = [
  { id: "claude", label: "Claude Code", hint: "Hooks in ~/.claude/settings.json" },
  { id: "codex", label: "Codex", hint: "Hooks in ~/.codex/hooks.json" },
  // Installed for you when grok is on the machine (a file of flock's own in a
  // drop-in directory, unlike the two above, which edit a file you also own),
  // so this row is here to turn it back off.
  { id: "grok", label: "Grok", hint: "Hooks in ~/.grok/hooks/flock.json" },
];

type SettingsTab =
  | "appearance" | "voice" | "github" | "graph" | "teams" | "integrations" | "worktrees" | "account" | "usage" | "provenance" | "security" | "about";

interface Props {
  onClose: () => void;
  /** Triggers a brief preview of the in-window voice HUD overlay. */
  onTestVoiceHud: () => void;
  /** Which tab to open on. Lets quick actions deep-link to the right place. */
  initialTab?: SettingsTab;
  /** Open workspaces, so the Usage tab can show and set a per-workspace spend
   * ceiling. Threaded down rather than read from a store because App.tsx owns
   * the workspace list and is the only thing that can persist a change to it. */
  workspaces: Workspace[];
  onSetWorkspaceBudget: (workspaceId: string, budget: Budget | undefined) => void;
}

// Settings tabs grouped into labeled clusters so the rail reads as four small
// decisions (≤4 items each) instead of one flat 11-item scan.
const NAV_GROUPS: {
  label: string;
  // A component, not a rendered node: each row instantiates its own so the
  // glyph inherits that row's colour rather than the one captured at module load.
  tabs: { id: SettingsTab; label: string; icon: (p: { size?: number }) => React.JSX.Element }[];
}[] = [
  { label: "Account", tabs: [
    { id: "account", label: "Account", icon: PersonIcon },
    { id: "usage", label: "Usage Details", icon: ChartIcon },
  ] },
  { label: "Workspace", tabs: [
    { id: "appearance", label: "Appearance", icon: AppearanceIcon },
    { id: "voice", label: "Voice", icon: MicIcon },
    // Id stays "worktrees" so any stored/deep-linked tab keeps resolving; the
    // tab now covers branch mode and fetch too, which is what users look for.
    { id: "worktrees", label: "Branches", icon: BranchIcon },
  ] },
  { label: "Connections", tabs: [
    { id: "github", label: "GitHub", icon: GithubIcon },
    { id: "graph", label: "Graph", icon: GraphIcon },
    { id: "teams", label: "Teams", icon: TeamsIcon },
    { id: "integrations", label: "Integrations", icon: PuzzleIcon },
  ] },
  { label: "System", tabs: [
    // Not under Account: the record covers every agent this machine ran, not
    // the signed-in profile, and it is what someone else asks to see.
    { id: "provenance", label: "Provenance", icon: RecordIcon },
    { id: "security", label: "Security", icon: ShieldIcon },
    { id: "about", label: "About", icon: InfoIcon },
  ] },
];

// This is the app's only shortcut reference — there is no native menu bar —
// and it used to omit the three global bindings entirely, ⌘K among them. Since
// the command bar's only other mention is on the empty-workspace screen, which
// disappears the moment you create your first workspace, a user who missed it
// there had no way left to learn the app had one. The globals lead now.
const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: "⌘K", desc: "Command bar — run anything, or type a prompt for an agent" },
  { keys: "⌘N", desc: "New workspace" },
  { keys: "⌘⇧P", desc: "Capture a prompt for later" },
  { keys: "⌘,", desc: "Settings" },
  { keys: "⌘D", desc: "Split pane right" },
  { keys: "⌘⇧D", desc: "Split pane down" },
  { keys: "⌘Z", desc: "Toggle zoom pane" },
  { keys: "⌘⇧K", desc: "Close focused pane" },
  { keys: "⌘[ ⌘]", desc: "Focus previous / next pane" },
  { keys: "⌘J", desc: "Jump to next waiting agent" },
  { keys: "⌘1–9", desc: "Switch to tab 1–9" },
  { keys: "⌘+ ⌘-", desc: "Agent pane text bigger / smaller" },
  { keys: "⌥⌘+ ⌥⌘-", desc: "App text bigger / smaller" },
  { keys: "⌘T", desc: "New tab" },
  { keys: "⌘⇧W", desc: "Close focused tab" },
  { keys: "↑↓", desc: "Navigate agents (dialog)" },
  { keys: "↵", desc: "Confirm (dialog)" },
  { keys: "Esc", desc: "Cancel / close dialog" },
];

type OAuthState =
  | { step: "idle" }
  | { step: "waiting"; userCode: string; verificationUri: string; deviceCode: string; interval: number }
  | { step: "polling" }
  | { step: "done" };

/** Dialog can't be dismissed (overlay click / Escape) while the device code
 * is pending — closing mid-flow silently kills the poll, which was the
 * actual cause of "I never see the code" reports: the browser steals focus,
 * a stray click lands on the backgrounded overlay, and the flow just dies. */
function isOAuthPending(oauth: OAuthState): boolean {
  return oauth.step === "waiting" || oauth.step === "polling";
}

export default function SettingsDialog({ onClose, onTestVoiceHud, initialTab, workspaces, onSetWorkspaceBudget }: Props) {
  const [ghStatus, setGhStatus] = useState<GitHubStatus | null>(null);
  const [oauth, setOauth] = useState<OAuthState>({ step: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState("");
  const [theme, setTheme] = useState<ThemeId>(getStoredTheme());
  const [followSystem, setFollowSystemState] = useState<boolean>(getFollowSystem());
  const [uiScale, setUiScale] = useState<UiScaleId>(getStoredUiScale());
  const [paneFont, setPaneFont] = useState<number>(getStoredPaneFontSize());
  const [codeCopied, setCodeCopied] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [modelDownloaded, setModelDownloaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [voiceError, setVoiceError] = useState("");
  const [voiceStats, setVoiceStats] = useState<VoiceStats | null>(null);
  const [voiceHotkey, setVoiceHotkey] = useState<VoiceHotkeyId>(getStoredVoiceHotkey());
  const [voiceModels, setVoiceModels] = useState<VoiceModelOption[]>([]);
  const [voiceModel, setVoiceModel] = useState<string>("base.en");
  const [inputDevices, setInputDevices] = useState<string[]>([]);
  const [inputDevice, setInputDevice] = useState<string | null>(null);
  const [voiceLanguage, setVoiceLanguageState] = useState("auto");
  const [voiceVocab, setVoiceVocabState] = useState("");
  const [voiceCleanup, setVoiceCleanupState] = useState(true);
  const [testingHud, setTestingHud] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? "account");
  const [ghIntegrationEnabled, setGhIntegrationEnabled] = useState(getGithubIntegrationEnabled());
  const [hookStatus, setHookStatus] = useState<Record<HookAgent, boolean>>({ claude: false, codex: false, grok: false });
  const [hookBusy, setHookBusy] = useState<HookAgent | null>(null);
  const [hookError, setHookError] = useState("");
  const [defaultBranchMode, setDefaultBranchModeState] = useState(getDefaultBranchMode());
  const [fetchBaseDefault, setFetchBaseDefaultState] = useState(getFetchBaseDefault());
  const [carryPatterns, setCarryPatternsState] = useState(getCarryPatternsText());
  const [quickActionsHidden, setQuickActionsHiddenState] = useState(getQuickActionsHidden());
  const [deleteBranchWithWorktree, setDeleteBranchWithWorktreeState] = useState(getDeleteBranchWithWorktree());
  const [worktreesBaseDir, setWorktreesBaseDirState] = useState(getWorktreesBaseDir());
  // Security tab. `restrictEgress` is the stored machine-wide policy;
  // `allowText` is the operator's own host list, edited here and written back
  // to the same ~/.flock/egress-allow.txt the spawn path reads.
  const [docker, setDocker] = useState<ContainerStatus | null>(null);
  const [restrictEgress, setRestrictEgress] = useState(false);
  const [secureDefault, setSecureDefaultState] = useState(getSecureByDefault);
  // The way back from a "Don't show again". Subscribed rather than read once,
  // because a toast can be silenced while this dialog is open behind it.
  const [hiddenToasts, setHiddenToasts] = useState<ToastKind[]>(suppressedToasts);
  useEffect(() => onToastSuppressionChange(() => setHiddenToasts(suppressedToasts())), []);
  // A popped-out agent window can change the pane size while this is open.
  useEffect(() => onPaneFontSizeChange(setPaneFont), []);
  const [allowText, setAllowText] = useState("");
  const [allowDefaults, setAllowDefaults] = useState<string[]>([]);
  const [egressSaved, setEgressSaved] = useState(false);
  const [egressError, setEgressError] = useState("");
  const pollAbort = useRef<AbortController | null>(null);
  const oauthRef = useRef<OAuthState>({ step: "idle" });
  oauthRef.current = oauth;
  const modalBodyRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  // .modal-body is one persistent scrollable element shared across every
  // tab (that's what keeps the dialog's height fixed instead of rejumping
  // per tab) — so without this, scrolling down on one tab and switching to
  // another lands you mid-scroll on the new tab's content instead of its top.
  useEffect(() => {
    if (modalBodyRef.current) modalBodyRef.current.scrollTop = 0;
  }, [activeTab]);

  useEffect(() => {
    githubCheck().then(setGhStatus);
    getVersion().then(setVersion);
    voiceGetEnabled().then(setVoiceEnabled).catch(() => {});
    voiceModelStatus().then((s) => setModelDownloaded(s.downloaded)).catch(() => {});
    voiceGetStats().then(setVoiceStats).catch(() => {});
    voiceAvailableModels().then(setVoiceModels).catch(() => {});
    voiceGetModel().then(setVoiceModel).catch(() => {});
    voiceListInputDevices().then(setInputDevices).catch(() => {});
    voiceGetInputDevice().then(setInputDevice).catch(() => {});
    voiceGetLanguage().then(setVoiceLanguageState).catch(() => {});
    voiceGetVocab().then(setVoiceVocabState).catch(() => {});
    voiceGetCleanup().then(setVoiceCleanupState).catch(() => {});
    containerStatus().then(setDocker).catch(() => setDocker({ available: false, daemon_running: false, image_ready: false }));
    egressPolicy()
      .then((p) => { setRestrictEgress(p.restrict); setAllowText(p.allow_file); setAllowDefaults(p.defaults); })
      .catch(() => {});
    Promise.all(HOOK_AGENTS.map((a) => agentHookStatus(a.id).then((installed) => [a.id, installed] as const)))
      .then((entries) => setHookStatus(Object.fromEntries(entries) as Record<HookAgent, boolean>))
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isOAuthPending(oauthRef.current)) onClose();
    };
    window.addEventListener("keydown", onKey);
    let unlistenProgress: (() => void) | undefined;
    onVoiceDownloadProgress((p) => setDownloadProgress(p)).then((fn) => (unlistenProgress = fn));
    return () => {
      window.removeEventListener("keydown", onKey);
      pollAbort.current?.abort();
      unlistenProgress?.();
    };
  }, [onClose]);

  const toggleGithubIntegration = () => {
    const next = !ghIntegrationEnabled;
    setGhIntegrationEnabled(next);
    setGithubIntegrationEnabled(next);
    window.dispatchEvent(new Event("flock:github-integration-changed"));
  };

  const toggleAgentHook = async (agent: HookAgent) => {
    setHookError("");
    setHookBusy(agent);
    try {
      if (hookStatus[agent]) {
        await uninstallAgentHook(agent);
      } else {
        await installAgentHook(agent);
      }
      const installed = await agentHookStatus(agent);
      setHookStatus((prev) => ({ ...prev, [agent]: installed }));
    } catch (e: any) {
      setHookError(e?.toString() ?? "Failed to update hook");
    } finally {
      setHookBusy(null);
    }
  };

  const pickDefaultBranchMode = (mode: BranchMode) => {
    setDefaultBranchModeState(mode);
    setDefaultBranchMode(mode);
  };

  const toggleFetchBaseDefault = () => {
    const next = !fetchBaseDefault;
    setFetchBaseDefaultState(next);
    setFetchBaseDefault(next);
  };

  const saveCarryPatterns = (text: string) => {
    setCarryPatternsState(text);
    setCarryPatterns(text);
  };

  const toggleDeleteBranchWithWorktree = () => {
    const next = !deleteBranchWithWorktree;
    setDeleteBranchWithWorktreeState(next);
    setDeleteBranchWithWorktree(next);
  };

  const saveWorktreesBaseDir = (dir: string) => {
    setWorktreesBaseDirState(dir);
    setWorktreesBaseDir(dir);
  };

  const toggleVoiceEnabled = async () => {
    const next = !voiceEnabled;
    setVoiceEnabled(next);
    await voiceSetEnabled(next).catch((e) => setVoiceError(e?.toString() ?? "Failed to save"));
  };

  const selectVoiceHotkey = (id: VoiceHotkeyId) => {
    setStoredVoiceHotkey(id);
    setVoiceHotkey(id);
  };

  const selectVoiceModel = async (id: string) => {
    setVoiceModel(id);
    setVoiceError("");
    await voiceSetModel(id).catch((e) => setVoiceError(e?.toString() ?? "Failed to save"));
    const status = await voiceModelStatus().catch(() => ({ downloaded: false }));
    setModelDownloaded(status.downloaded);
  };

  const downloadVoiceModel = async () => {
    setVoiceError("");
    setDownloading(true);
    setDownloadProgress({ downloaded: 0, total: 0 });
    try {
      await voiceDownloadModel();
      setModelDownloaded(true);
    } catch (e: any) {
      setVoiceError(e?.toString() ?? "Failed to download model");
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  };

  const selectInputDevice = async (name: string | null) => {
    setInputDevice(name);
    await voiceSetInputDevice(name).catch((e) => setVoiceError(e?.toString() ?? "Failed to save"));
  };

  const selectVoiceLanguage = (lang: string) => {
    setVoiceLanguageState(lang);
    voiceSetLanguage(lang).catch((e) => setVoiceError(e?.toString() ?? "Failed to save"));
  };

  const toggleVoiceCleanup = () => {
    const next = !voiceCleanup;
    setVoiceCleanupState(next);
    voiceSetCleanup(next).catch((e) => setVoiceError(e?.toString() ?? "Failed to save"));
  };

  const saveVoiceVocab = () => {
    voiceSetVocab(voiceVocab).catch((e) => setVoiceError(e?.toString() ?? "Failed to save"));
  };

  // Previews the in-window HUD overlay (owned by App) so you can see what the
  // pill looks like without holding the hotkey.
  const testHud = () => {
    setVoiceError("");
    setTestingHud(true);
    onTestVoiceHud();
    setTimeout(() => setTestingHud(false), 3200);
  };

  const copyCode = (code: string) => {
    copyText(code).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }).catch(() => {});
  };

  const startOAuth = async () => {
    setError("");
    setOauth({ step: "idle" });
    try {
      const flow = await githubOauthStart(GITHUB_CLIENT_ID);
      setOauth({
        step: "waiting",
        userCode: flow.user_code,
        verificationUri: flow.verification_uri,
        deviceCode: flow.device_code,
        interval: flow.interval,
      });
      // Copy the code before the browser steals focus — GitHub's device page
      // just needs a paste, no hunting back through app windows for it.
      copyCode(flow.user_code);
      // Start polling immediately rather than waiting on openUrl to settle —
      // if the browser launch throws (no default browser, OS dialog denied,
      // etc.) that must not prevent the poll from starting, or the dialog is
      // left showing the code forever with no way to detect a completed
      // authorization even though the user can still paste the code manually.
      beginPolling(flow.device_code, flow.interval);
      openUrl(flow.verification_uri).catch(() => {});
    } catch (e: any) {
      setError(e?.toString() ?? "Failed to start OAuth");
    }
  };

  // Manual fallback for when the poll doesn't pick up a completed
  // authorization on its own — lets the user force a re-check instead of
  // being stuck on the waiting screen indefinitely.
  const recheckOAuth = async () => {
    try {
      const status = await githubCheck();
      setGhStatus(status);
      if (status.connected) {
        pollAbort.current?.abort();
        setOauth({ step: "done" });
      }
    } catch (e: any) {
      setError(e?.toString() ?? "Failed to check status");
    }
  };

  const cancelOAuth = () => {
    pollAbort.current?.abort();
    setOauth({ step: "idle" });
  };

  const beginPolling = (deviceCode: string, interval: number) => {
    setOauth((prev) => prev.step === "waiting"
      ? { ...prev, step: "waiting" } // keep code visible while polling
      : prev);
    const ctrl = new AbortController();
    pollAbort.current = ctrl;

    githubOauthPoll(GITHUB_CLIENT_ID, deviceCode, interval)
      .then(async () => {
        if (ctrl.signal.aborted) return;
        const status = await githubCheck();
        setGhStatus(status);
        setOauth({ step: "done" });
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setError(e?.toString() ?? "Authorization failed");
        setOauth({ step: "idle" });
      });
  };

  const handleDisconnect = async () => {
    setSaving(true);
    try {
      await githubDisconnect();
      setGhStatus({ connected: false, user: null, avatar_url: null });
      setOauth({ step: "idle" });
    } catch (e: any) {
      setError(e?.toString() ?? "Failed to disconnect");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={isOAuthPending(oauth) ? undefined : onClose}>
      <div className="modal settings-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={() => { if (!isOAuthPending(oauth)) onClose(); }} />
        {/* A title bar, not a hero. The goose used to fly in here at 64px and
            park beside the close button, which is the one thing no window on
            this platform does: the title bar is chrome, and a mascot in it
            reads as a splash screen that forgot to dismiss. The bird still
            opens the app (Splash) and still sits in the rail's lockup, which
            is where a brand mark belongs. */}
        <div className="modal-header">
          <div className="title">Settings</div>
        </div>

        <div className="settings-layout">
        <div className="settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
          {NAV_GROUPS.map((group) => (
            <div className="settings-nav-group" key={group.label}>
              <div className="settings-nav-group-label">{group.label}</div>
              {group.tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={activeTab === t.id}
                  className={`settings-tab${activeTab === t.id ? " active" : ""}`}
                  onClick={() => setActiveTab(t.id)}
                >
                  <span className="settings-tab-icon" aria-hidden="true"><t.icon /></span>
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="modal-body" ref={modalBodyRef}>
          {activeTab === "github" && (
          <>
          {/* ─── GitHub integration toggle ─────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-row">
              <div>
                <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>Enable GitHub Integration</div>
                <div className="settings-hint" style={{ margin: 0 }}>
                  PR checks and notifications in the titlebar.
                </div>
              </div>
              <button
                role="switch" aria-checked={ghIntegrationEnabled} className={`voice-toggle${ghIntegrationEnabled ? " on" : ""}`}
                onClick={toggleGithubIntegration}
                title={ghIntegrationEnabled ? "Disable" : "Enable"}
              >
                <span className="voice-toggle-knob" />
              </button>
            </div>
          </div>

          {/* ─── GitHub CLI ─────────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">GitHub CLI</div>
            <div className="settings-row">
              <span className="settings-label">Signed in as</span>
              {ghStatus === null ? (
                <span className="text-ghost">checking…</span>
              ) : ghStatus.connected ? (
                <span className="text-ghost" style={{ color: "var(--text-hi)" }}>{ghStatus.user}</span>
              ) : (
                <span className="settings-badge disconnected">not signed in</span>
              )}
            </div>
            <div className="settings-row">
              <span className="settings-label">Host</span>
              <span className="text-ghost" style={{ color: "var(--text-hi)" }}>github.com</span>
            </div>
            <div className="settings-row" style={{ marginTop: 4 }}>
              {ghStatus?.connected ? (
                <button className="btn-ghost settings-btn" onClick={handleDisconnect} disabled={saving}>
                  {saving ? "Disconnecting…" : "Disconnect"}
                </button>
              ) : oauth.step === "idle" || oauth.step === "done" ? (
                <button className="btn-mint-solid settings-btn" onClick={startOAuth}>
                  Connect with GitHub
                </button>
              ) : null}
            </div>
            {isOAuthPending(oauth) && (
              <div className="settings-oauth-flow">
                <p className="settings-hint">
                  We opened <strong>github.com/login/device</strong> in your browser —
                  paste this code there (already copied for you):
                </p>
                <div className="oauth-code-row">
                  <div className="oauth-user-code">
                    {"userCode" in oauth ? oauth.userCode : ""}
                  </div>
                  <button
                    className="btn-ghost settings-btn"
                    onClick={() => { if ("userCode" in oauth) copyCode(oauth.userCode); }}
                  >
                    {codeCopied ? <>Copied <CheckIcon size={11} /></> : "Copy"}
                  </button>
                </div>
                <p className="settings-hint" style={{ color: "var(--text-ghost)" }}>
                  Waiting for authorization… don't close this window.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn-ghost settings-btn" onClick={recheckOAuth}>
                    Already authorized? Check again
                  </button>
                  <button className="btn-ghost settings-btn" onClick={cancelOAuth}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {error && <div className="settings-error">{error}</div>}
          </div>

          {/* Watched repos, auto-review and merge method moved to the PR hub's
              REPOS tab — they belong next to the PR list and queue they feed.
              This pointer stays because Settings is where people will look
              first, having found them here before. */}
          <div className="settings-section">
            <div className="settings-section-header">Pull Requests</div>
            <p className="settings-hint">
              Which repos are watched for new PRs, auto-review, and the merge
              method now live in the PR hub — open Pull Requests from the
              status bar and pick the Repos tab.
            </p>
          </div>

          </>
          )}

          {activeTab === "voice" && (
          <>
          {/* ─── flock Voice ───────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">flock Voice</div>
            <div className="settings-row">
              <span className="settings-label">Push-to-talk dictation</span>
              <button
                role="switch" aria-checked={voiceEnabled} className={`voice-toggle${voiceEnabled ? " on" : ""}`}
                onClick={toggleVoiceEnabled}
                title={voiceEnabled ? "Disable" : "Enable"}
              >
                <span className="voice-toggle-knob" />
              </button>
            </div>

            {voiceStats && voiceStats.total_dictations > 0 && (
              <div className="voice-stats-row">
                <div className="voice-stat">
                  <span className="voice-stat-value">{voiceStats.total_words.toLocaleString()}</span>
                  <span className="voice-stat-label">words</span>
                </div>
                <div className="voice-stat">
                  <span className="voice-stat-value">{avgWpm(voiceStats)}</span>
                  <span className="voice-stat-label">words/min</span>
                </div>
                <div className="voice-stat">
                  <span className="voice-stat-value">{voiceStats.total_dictations.toLocaleString()}</span>
                  <span className="voice-stat-label">dictations</span>
                </div>
              </div>
            )}

            {voiceEnabled && (
              <>
                <div className="settings-row" style={{ marginTop: 4 }}>
                  <span className="settings-label">Hotkey</span>
                </div>
                <div className="ui-scale-row">
                  {VOICE_HOTKEYS.map((h) => (
                    <button
                      key={h.id}
                      className={`btn-ghost settings-btn ui-scale-btn${voiceHotkey === h.id ? " active" : ""}`}
                      onClick={() => selectVoiceHotkey(h.id)}
                    >
                      {h.label}
                    </button>
                  ))}
                </div>

                <div className="settings-row" style={{ marginTop: 10 }}>
                  <span className="settings-label">Model</span>
                </div>
                <div className="ui-scale-row">
                  {voiceModels.map((m) => (
                    <button
                      key={m.id}
                      className={`btn-ghost settings-btn ui-scale-btn${voiceModel === m.id ? " active" : ""}`}
                      onClick={() => selectVoiceModel(m.id)}
                      title={`~${m.size_mb}MB`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                <div className="settings-row" style={{ marginTop: 10 }}>
                  <span className="settings-label">Input source</span>
                  <select
                    className="modal-input"
                    style={{ padding: "4px 8px", fontSize: 12, maxWidth: 180 }}
                    value={inputDevice ?? ""}
                    onChange={(e) => selectInputDevice(e.target.value || null)}
                  >
                    <option value="">System default</option>
                    {inputDevices.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>

                <div className="settings-row" style={{ marginTop: 10 }}>
                  <span className="settings-label">Language</span>
                  <select
                    className="modal-input"
                    style={{ padding: "4px 8px", fontSize: 12, maxWidth: 180 }}
                    value={voiceModel.endsWith(".en") ? "en" : voiceLanguage}
                    onChange={(e) => selectVoiceLanguage(e.target.value)}
                    disabled={voiceModel.endsWith(".en")}
                    title={voiceModel.endsWith(".en")
                      ? "English-only model — pick Turbo for other languages"
                      : "Language spoken during dictation"}
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="en">English</option>
                    <option value="nl">Nederlands</option>
                    <option value="fr">Français</option>
                    <option value="de">Deutsch</option>
                    <option value="es">Español</option>
                    <option value="pt">Português</option>
                    <option value="it">Italiano</option>
                  </select>
                </div>

                <div className="settings-row" style={{ marginTop: 10 }}>
                  <span className="settings-label">Remove filler words</span>
                  <button
                    role="switch" aria-checked={voiceCleanup} className={`voice-toggle${voiceCleanup ? " on" : ""}`}
                    onClick={toggleVoiceCleanup}
                    title={'Strip "um", "uh" and friends from transcripts'}
                  >
                    <span className="voice-toggle-knob" />
                  </button>
                </div>

                <div className="settings-row" style={{ marginTop: 10 }}>
                  <span className="settings-label">Vocabulary</span>
                </div>
                <textarea
                  className="modal-input"
                  style={{ width: "100%", minHeight: 60, fontSize: 12, fontFamily: "var(--font-mono)", resize: "vertical" }}
                  placeholder="Project names, jargon, teammates — one per line or comma-separated. Common coding terms are built in."
                  value={voiceVocab}
                  onChange={(e) => setVoiceVocabState(e.target.value)}
                  onBlur={saveVoiceVocab}
                />

                <div className="settings-row" style={{ marginTop: 10 }}>
                  <span className="settings-label">Preview overlay</span>
                  <button className="btn-ghost settings-btn" onClick={testHud} disabled={testingHud}>
                    {testingHud ? "Showing…" : "Test HUD"}
                  </button>
                </div>
              </>
            )}

            {voiceEnabled && (
              modelDownloaded ? (
                <p className="settings-hint">
                  Hold <span className="kbd">{getVoiceHotkeyOption(voiceHotkey).label}</span> while a pane is
                  focused to dictate — transcribed text is typed into that pane, same as typing it yourself.
                  Quick-tap it instead to dictate hands-free (tap again to finish).
                  Words appear live in the bar while you speak.
                  Works only while flock is focused (not other apps).
                </p>
              ) : (
                <div className="settings-oauth-flow">
                  <p className="settings-hint">
                    Needs a one-time ~{voiceModels.find((m) => m.id === voiceModel)?.size_mb ?? 148}MB
                    local speech model (runs fully on-device, no audio ever leaves your Mac).
                  </p>
                  {downloading ? (
                    <p className="settings-hint" style={{ color: "var(--text-ghost)" }}>
                      Downloading… {downloadProgress && downloadProgress.total > 0
                        ? `${Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)}%`
                        : `${((downloadProgress?.downloaded ?? 0) / 1e6).toFixed(0)}MB`}
                    </p>
                  ) : (
                    <button className="btn-mint-solid settings-btn" onClick={downloadVoiceModel}>
                      Download model
                    </button>
                  )}
                </div>
              )
            )}
            {voiceError && <div className="settings-error">{voiceError}</div>}
          </div>
          </>
          )}

          {activeTab === "appearance" && (
          <>
          {/* ─── Appearance ────────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">Appearance</div>
            <div className="settings-row">
              <div>
                <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>Inherit from system</div>
                <div className="settings-hint" style={{ margin: 0 }}>
                  Follow the OS light/dark appearance and switch live when it changes.
                </div>
              </div>
              <button
                role="switch" aria-checked={followSystem} className={`voice-toggle${followSystem ? " on" : ""}`}
                onClick={() => {
                  const next = !followSystem;
                  setFollowSystem(next);
                  setFollowSystemState(next);
                }}
                title={followSystem ? "Disable" : "Enable"}
              >
                <span className="voice-toggle-knob" />
              </button>
            </div>
            <div className="settings-row" style={{ marginTop: 10 }}>
              <span className="settings-label">Theme</span>
            </div>
            <div className="theme-swatch-row" aria-disabled={followSystem} style={followSystem ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
              {THEMES.map((t) => {
                // While following the OS, highlight whichever base theme it
                // currently resolves to rather than the stored pick.
                const active = followSystem ? systemTheme() === t.id : theme === t.id;
                return (
                <button
                  key={t.id}
                  className={`theme-swatch theme-swatch-${t.id}${active ? " active" : ""}`}
                  onClick={() => { applyTheme(t.id); setTheme(t.id); setFollowSystemState(false); }}
                  title={t.label}
                >
                  <span className="theme-swatch-preview" />
                  <span className="theme-swatch-label">{t.label}</span>
                </button>
                );
              })}
            </div>

            {/* Two independent sizes: the panes are the text you read all day,
                the chrome is the frame around them. See lib/uiScale.ts. */}
            <div className="settings-row" style={{ marginTop: 10 }}>
              <div>
                <div className="settings-label">Agent pane text size</div>
                <div className="settings-hint" style={{ margin: 0 }}>
                  Every terminal pane, live. <span className="kbd">⌘+</span> <span className="kbd">⌘-</span>
                </div>
              </div>
              <div className="pane-font-stepper">
                <button
                  className="btn-ghost settings-btn"
                  onClick={() => setPaneFont(stepPaneFontSize(-1))}
                  disabled={paneFont <= PANE_FONT_MIN}
                  aria-label="Smaller agent pane text"
                >
                  −
                </button>
                <span className="pane-font-value">{paneFont}px</span>
                <button
                  className="btn-ghost settings-btn"
                  onClick={() => setPaneFont(stepPaneFontSize(1))}
                  disabled={paneFont >= PANE_FONT_MAX}
                  aria-label="Larger agent pane text"
                >
                  +
                </button>
                <button
                  className="btn-ghost settings-btn"
                  onClick={() => setPaneFont(applyPaneFontSize(BASE_PANE_FONT_SIZE))}
                  disabled={paneFont === BASE_PANE_FONT_SIZE}
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="settings-row" style={{ marginTop: 10 }}>
              <div>
                <div className="settings-label">App text size</div>
                <div className="settings-hint" style={{ margin: 0 }}>
                  Sidebar, tabs and dialogs. <span className="kbd">⌥⌘+</span> <span className="kbd">⌥⌘-</span>
                </div>
              </div>
            </div>
            <div className="ui-scale-row">
              {UI_SCALES.map((s) => (
                <button
                  key={s.id}
                  className={`btn-ghost settings-btn ui-scale-btn${uiScale === s.id ? " active" : ""}`}
                  onClick={() => { applyUiScale(s.id); setUiScale(s.id); }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* Only rendered once something has actually been silenced. An
                empty list of things you have turned off is a row that teaches
                nothing and asks to be read on every visit. */}
            {hiddenToasts.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>
                  Hidden pop-ups
                </div>
                <div className="settings-hint" style={{ marginTop: 2 }}>
                  These no longer interrupt you. They still arrive in notifications.
                </div>
                {hiddenToasts.map((kind) => (
                  <div className="settings-row" key={kind}>
                    <span className="settings-label">{TOAST_KIND_LABELS[kind]}</span>
                    <button className="btn-ghost" onClick={() => unsuppressToast(kind)}>
                      Show again
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* The panel's own X sets the same flag, so this doubles as the
                way back after dismissing it from the sidebar. */}
            <div className="settings-row" style={{ marginTop: 14 }}>
              <div>
                <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>Quick actions</div>
                <div className="settings-hint" style={{ margin: 0 }}>
                  Show the setup checklist at the bottom of the sidebar.
                </div>
              </div>
              <button
                role="switch" aria-checked={!quickActionsHidden} className={`voice-toggle${quickActionsHidden ? "" : " on"}`}
                onClick={() => {
                  const nextHidden = !quickActionsHidden;
                  setQuickActionsHidden(nextHidden);
                  setQuickActionsHiddenState(nextHidden);
                }}
                title={quickActionsHidden ? "Show" : "Hide"}
              >
                <span className="voice-toggle-knob" />
              </button>
            </div>
          </div>
          </>
          )}

          {activeTab === "security" && (
          <>
          {/* ─── Secure mode ───────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">Secure mode</div>
            <p className="settings-hint" style={{ marginTop: 0 }}>
              A secure workspace runs each agent inside a Docker container that can see
              the workspace folder and nothing else of your Mac — no keys, no other
              repositories, no host processes. That is what makes flock's default
              "don't ask me for permission" launch flags reasonable. New workspaces turn
              it on for you whenever Docker is running, unless you say otherwise below.
            </p>
            <div className="settings-row">
              <div>
                <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>
                  Turn it on for new workspaces
                </div>
                <div className="settings-hint" style={{ margin: 0 }}>
                  Where the switch in the New workspace dialog starts. It also follows
                  you: leave that switch somewhere and the next workspace starts there.
                  Either way it stays a per-workspace choice, and a workspace already
                  running secure stays secure whatever this says.
                </div>
              </div>
              <button
                role="switch"
                aria-checked={secureDefault}
                className={`voice-toggle${secureDefault ? " on" : ""}`}
                onClick={() => {
                  const next = !secureDefault;
                  setSecureDefaultState(next);
                  setSecureByDefault(next);
                }}
                title={secureDefault ? "Disable" : "Enable"}
              >
                <span className="voice-toggle-knob" />
              </button>
            </div>
            <div className="settings-row">
              <span className="settings-label">Docker</span>
              <span className="text-ghost">
                {docker === null
                  ? "checking…"
                  : !docker.available
                  ? "not installed — new workspaces will run agents on your Mac"
                  : !docker.daemon_running
                  ? "installed, not running — start Docker Desktop"
                  : docker.image_ready
                  ? "ready"
                  : "ready — the first secure pane builds the image"}
              </span>
            </div>
          </div>

          {/* ─── Network egress ────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">Network</div>
            <div className="settings-row">
              <div>
                <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>
                  Restrict what secure agents can reach
                </div>
                <div className="settings-hint" style={{ margin: 0 }}>
                  Off, a jailed agent can open any connection your Mac can — including
                  services on localhost. On, it can only reach the hosts below, through a
                  proxy it cannot go around. Takes effect on the next pane.
                </div>
              </div>
              <button
                role="switch"
                aria-checked={restrictEgress}
                className={`voice-toggle${restrictEgress ? " on" : ""}`}
                onClick={() => {
                  const next = !restrictEgress;
                  setRestrictEgress(next);
                  setEgressError("");
                  setEgressSaved(false);
                  setEgressPolicy(next, allowText)
                    .then(() => setEgressSaved(true))
                    // The switch showed the new state optimistically; if the
                    // write failed it has to go back, or the UI claims a
                    // restriction that no spawn will apply.
                    .catch((e) => { setRestrictEgress(!next); setEgressError(String(e)); });
                }}
                title={restrictEgress ? "Disable" : "Enable"}
              >
                <span className="voice-toggle-knob" />
              </button>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="settings-label" style={{ marginBottom: 6 }}>Always allowed</div>
              <div className="settings-hint" style={{ margin: 0 }}>
                {allowDefaults.join("  ·  ") || "…"}
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <label className="settings-label" htmlFor="egress-allow">Also allow</label>
              <textarea
                id="egress-allow"
                className="modal-input"
                style={{ width: "100%", minHeight: 92, marginTop: 6, padding: "8px 10px", fontSize: 12, fontFamily: "var(--font-mono)" }}
                value={allowText}
                onChange={(e) => { setAllowText(e.target.value); setEgressSaved(false); }}
                placeholder={"registry.npmjs.org\ngithub.com\n*.internal.example.com"}
                spellCheck={false}
              />
              <div className="settings-row" style={{ marginTop: 6 }}>
                <span className="settings-hint" style={{ margin: 0 }}>
                  One host per line; a leading <code>*.</code> covers subdomains. Saved to
                  ~/.flock/egress-allow.txt.
                  {egressSaved && <span style={{ color: "var(--mint)" }}> Saved.</span>}
                  {egressError && <span style={{ color: "var(--yellow)" }}> {egressError}</span>}
                </span>
                <button
                  className="btn-ghost settings-btn"
                  onClick={() => {
                    setEgressError("");
                    setEgressPolicy(restrictEgress, allowText)
                      .then(() => setEgressSaved(true))
                      .catch((e) => setEgressError(String(e)));
                  }}
                >
                  Save
                </button>
              </div>
            </div>

            {/* The honest half. An allowlist bounds who the agent can talk to,
                never what it can say, and the agent's own API is on the list by
                necessity — saying otherwise would be the kind of claim this
                whole feature is supposed to be able to survive. */}
            <p className="settings-hint" style={{ marginTop: 12 }}>
              This limits where an agent can connect, not what it can send. Its own model
              API is always reachable, so anything in the workspace can still leave
              through a conversation. Adding a package registry or a git host widens that
              further — both accept uploads. Agents that ignore proxy settings will simply
              fail to connect rather than slip past.
            </p>
          </div>
          </>
          )}

          {activeTab === "about" && (
          <>
          {/* ─── About ─────────────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">About</div>
            <p className="settings-about-copy">
              Coding agents got good enough that one person can run several at once,
              but the tools still assume you're babysitting a single terminal. flock
              is the cockpit we wanted for ourselves: every agent side by side, each in
              its own pane, with its status, its branch, and its history right in front
              of you. Quit and reopen, and the work is still where you left it. The
              goal is simple. Running a room full of agents should feel like flying one
              plane, not juggling ten.
            </p>
            <div className="settings-row">
              <span className="settings-label">flock</span>
              <span className="text-ghost">{version || "…"}</span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Community</span>
              <button
                className="btn-ghost settings-btn"
                onClick={() => openUrl("https://discord.gg/rRerdy329").catch(console.error)}
              >
                Join the Discord →
              </button>
            </div>
          </div>

          {/* ─── Keyboard shortcuts ────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">Keyboard Shortcuts</div>
            <div className="settings-shortcut-grid">
              {SHORTCUTS.map((s) => (
                <div className="settings-shortcut-row" key={s.keys}>
                  <span className="settings-shortcut-keys">
                    {s.keys.split(" ").map((k, i) => (
                      <span key={i}>{i > 0 && " "}<span className="kbd">{k}</span></span>
                    ))}
                  </span>
                  <span className="settings-label">{s.desc}</span>
                </div>
              ))}
            </div>
          </div>
          </>
          )}

          {activeTab === "graph" && (
          <>
          {/* ─── flock Graph ───────────────────────────────────────────── */}
          <GraphSettingsSection />
          </>
          )}

          {activeTab === "teams" && (
          <>
          {/* ─── Orgs & teams (flock ID tenancy) ───────────────────────── */}
          <TeamsSection />
          </>
          )}

          {activeTab === "account" && (
          <>
          {/* ─── flock ID ──────────────────────────────────────────────── */}
          <AccountSection />
          </>
          )}

          {activeTab === "usage" && (
          <>
          {/* ─── Agent usage limits + spend ────────────────────────────── */}
          <BudgetSection workspaces={workspaces} onSetWorkspaceBudget={onSetWorkspaceBudget} />
          <AgentUsageSection fetcher={claudeUsage} title="Claude usage limits" />
          <AgentUsageSection fetcher={codexUsage} title="Codex usage limits" />
          <GrokUsageSection />
          <OpencodeUsageSection />
          </>
          )}

          {activeTab === "provenance" && (
          <>
          {/* ─── Provenance: the exportable record of what the fleet did ─── */}
          <ProvenanceSection />
          </>
          )}

          {activeTab === "worktrees" && (
          <>
          {/* ─── Worktrees ─────────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">Default branch mode</div>
            <p className="settings-hint" style={{ marginTop: 0 }}>
              Which option the new-workspace dialog opens on. Every workspace can still override it.
            </p>
            <div className="sd-modes" role="radiogroup" aria-label="Default branch mode">
              {BRANCH_MODE_CHOICES.map((c, i) => (
                <div
                  key={c.mode}
                  role="radio"
                  aria-checked={defaultBranchMode === c.mode}
                  tabIndex={defaultBranchMode === c.mode ? 0 : -1}
                  className={`sd-mode${defaultBranchMode === c.mode ? " selected" : ""}`}
                  onClick={() => pickDefaultBranchMode(c.mode)}
                  onKeyDown={(e) => onRadioKey(e, i, BRANCH_MODE_CHOICES.length, (ni) => pickDefaultBranchMode(BRANCH_MODE_CHOICES[ni].mode))}
                >
                  {c.label}
                </div>
              ))}
            </div>
            <p className="settings-hint">
              {BRANCH_MODE_CHOICES.find((c) => c.mode === defaultBranchMode)?.hint}
            </p>
          </div>

          <div className="settings-section">
            <div className="settings-row">
              <div>
                <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>Fetch base branch first</div>
                <div className="settings-hint" style={{ margin: 0 }}>
                  Pre-checks "Fetch base first", so new branches don't start from a stale copy of the remote.
                </div>
              </div>
              <button
                role="switch" aria-checked={fetchBaseDefault} className={`voice-toggle${fetchBaseDefault ? " on" : ""}`}
                onClick={toggleFetchBaseDefault}
                title={fetchBaseDefault ? "Disable" : "Enable"}
              >
                <span className="voice-toggle-knob" />
              </button>
            </div>
            <div className="settings-row" style={{ marginTop: 10 }}>
              <div>
                <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>Delete local branch with worktree</div>
                <div className="settings-hint" style={{ margin: 0 }}>
                  Removes the branch too when a worktree pane closes. Uncommitted changes in it are lost either way.
                </div>
              </div>
              <button
                role="switch" aria-checked={deleteBranchWithWorktree} className={`voice-toggle${deleteBranchWithWorktree ? " on" : ""}`}
                onClick={toggleDeleteBranchWithWorktree}
                title={deleteBranchWithWorktree ? "Disable" : "Enable"}
              >
                <span className="voice-toggle-knob" />
              </button>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-header">Default directory</div>
            <div className="settings-row">
              <input
                className="modal-input"
                style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
                value={worktreesBaseDir}
                onChange={(e) => saveWorktreesBaseDir(e.target.value)}
                placeholder="~/.flock/worktrees (default)"
                spellCheck={false}
              />
            </div>
            <p className="settings-hint">Parent path new worktrees are created under. Leave blank to use the default.</p>
          </div>

          <div className="settings-section">
            <div className="settings-section-header">Carry over local files</div>
            <div className="settings-row">
              <input
                className="modal-input"
                style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
                value={carryPatterns}
                onChange={(e) => saveCarryPatterns(e.target.value)}
                placeholder=".env*, .envrc, .tool-versions"
                spellCheck={false}
              />
            </div>
            <p className="settings-hint">
              A worktree contains only tracked files, so these gitignored ones are copied in from the
              main checkout — otherwise an agent's first command fails on missing local config.
              Comma-separated, repo-relative, <code>*</code> allowed in the filename
              (<code>.env*</code>, <code>apps/web/.env.local</code>). Files only: a directory never
              gets copied, so listing <code>node_modules</code> does nothing.
            </p>
          </div>
          </>
          )}

          {activeTab === "integrations" && (
          <>
          {/* ─── Agent hooks ────────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">Agent Integrations</div>
            <p className="settings-hint" style={{ marginTop: 0 }}>
              Installs hooks in each agent's own config so it reports session start/stop
              and prompt activity straight to flock's notification feed — more reliable
              than guessing status from terminal output alone.
            </p>
            {HOOK_AGENTS.map((a) => (
              <div className="settings-row" key={a.id} style={{ marginTop: 10 }}>
                <div>
                  <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>{a.label}</div>
                  <div className="settings-hint" style={{ margin: 0 }}>{a.hint}</div>
                </div>
                <button
                  className={`${hookStatus[a.id] ? "btn-ghost" : "btn-mint-solid"} settings-btn`}
                  onClick={() => toggleAgentHook(a.id)}
                  disabled={hookBusy === a.id}
                >
                  {hookBusy === a.id ? "…" : hookStatus[a.id] ? "Uninstall" : "Install"}
                </button>
              </div>
            ))}
            {hookError && <div className="settings-error">{hookError}</div>}
          </div>
          </>
          )}
        </div>
        </div>

        {/* A status bar with something to say, or no status bar.
            It used to be a permanent strip across the bottom whose whole
            content, 99% of the time, was "esc close" — a keyboard hint for the
            one shortcut every dialog on this platform already has, occupying a
            fixed band of a fixed-height window forever. No Mac window teaches
            you Escape. The one thing it said that was worth saying is the
            pending-OAuth line, which is real feedback about a real wait, so
            that survives and the strip now only exists while it does. */}
        {isOAuthPending(oauth) && (
          <div className="modal-footer">
            <span className="text-ghost">waiting for GitHub authorization…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function avgWpm(stats: VoiceStats): number {
  if (stats.total_duration_secs <= 0) return 0;
  return Math.round(stats.total_words / (stats.total_duration_secs / 60));
}
