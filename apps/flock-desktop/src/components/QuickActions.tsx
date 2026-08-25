import { useEffect, useState, type ReactNode } from "react";
import { onActivateKey } from "../lib/a11y";
import { agentHookStatus, installAgentHook, voiceGetEnabled } from "../lib/tauri";
import IconButton from "./IconButton";
import { XIcon } from "./friendIcons";

const COLLAPSE_KEY = "flock:quickactions-collapsed";
const HIDDEN_KEY = "flock:quickactions-hidden";
/** Fired whenever the hidden flag flips, so the sidebar panel and the
 *  Settings toggle stay in sync without threading state between them. */
const HIDDEN_EVENT = "flock:quickactions-hidden-change";

export function getQuickActionsHidden(): boolean {
  return localStorage.getItem(HIDDEN_KEY) === "1";
}
export function setQuickActionsHidden(hidden: boolean) {
  localStorage.setItem(HIDDEN_KEY, hidden ? "1" : "0");
  window.dispatchEvent(new Event(HIDDEN_EVENT));
}
export function onQuickActionsHiddenChange(fn: () => void): () => void {
  window.addEventListener(HIDDEN_EVENT, fn);
  return () => window.removeEventListener(HIDDEN_EVENT, fn);
}

interface Action {
  id: string;
  label: string;
  /** Shown instead of `label` once `done`. */
  doneLabel?: string;
  hint: string;
  /** true = configured (✓), false = not yet, undefined = not a setup item. */
  done?: boolean;
  busy?: boolean;
  /** Hide entirely (contextual actions like "review PRs" with no PRs). */
  visible?: boolean;
  run: () => void;
  /** Action when already done — usually open the relevant settings to review. */
  doneRun?: () => void;
  icon: ReactNode;
}

/** Replaces the old auto-rotating "Tips" carousel with a short, browsable list
 * of things worth doing. Setup items (hooks / GitHub / voice) show a ✓ once
 * done but stay in the list — dimmed and re-clickable to review — so it reads
 * as a checklist with progress rather than collapsing to a single item.
 * Evergreen actions (new workspace, review PRs) are always live. Foldable,
 * never auto-rotates. */
export default function QuickActions({
  onSettings,
  onNewWorkspace,
  onOpenPrManager,
  githubConnected,
  prCount,
}: {
  onSettings: (tab?: string) => void;
  onNewWorkspace: () => void;
  onOpenPrManager: () => void;
  githubConnected: boolean;
  prCount: number;
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [hidden, setHidden] = useState(getQuickActionsHidden);
  const [hookOn, setHookOn] = useState<boolean | null>(null);
  const [voiceOn, setVoiceOn] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    agentHookStatus("claude").then(setHookOn).catch(() => setHookOn(true));
    voiceGetEnabled().then(setVoiceOn).catch(() => setVoiceOn(true));
  }, []);
  useEffect(() => onQuickActionsHiddenChange(() => setHidden(getQuickActionsHidden())), []);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });

  const installHooks = async () => {
    setInstalling(true);
    try {
      await installAgentHook("claude");
      setHookOn(true);
    } catch {
      /* keep the action visible so it can be retried */
    } finally {
      setInstalling(false);
    }
  };

  const actions: Action[] = [
    {
      id: "hooks",
      label: "Turn on live agent status",
      doneLabel: "Live agent status on",
      hint: "Show what each agent is doing in the sidebar",
      done: hookOn === true,
      busy: installing,
      run: installHooks,
      doneRun: () => onSettings("integrations"),
      icon: <PulseIcon />,
    },
    {
      id: "github",
      label: "Connect GitHub",
      doneLabel: "GitHub connected",
      hint: "Review PRs and see checks inline",
      done: githubConnected,
      run: () => onSettings("github"),
      icon: <GithubIcon />,
    },
    {
      id: "voice",
      label: "Set up voice dictation",
      doneLabel: "Voice dictation on",
      hint: "Hold a hotkey and talk into any agent",
      done: voiceOn === true,
      run: () => onSettings("voice"),
      icon: <MicIcon />,
    },
    {
      id: "review",
      label: prCount === 1 ? "Review 1 open PR" : `Review ${prCount} open PRs`,
      hint: "Check one out and put an agent on it",
      visible: prCount > 0,
      run: onOpenPrManager,
      icon: <ReviewIcon />,
    },
    {
      id: "workspace",
      label: "New workspace",
      hint: "Point flock at a repo and spin up agents",
      run: onNewWorkspace,
      icon: <PlusIcon />,
    },
  ];

  const visible = actions.filter((a) => a.visible !== false);
  // Badge counts remaining setup items (those with a done/not-done state).
  const todo = visible.filter((a) => a.done === false).length;

  if (hidden) return null;

  return (
    <div className="quick-actions">
      <div className="qa-header" onClick={toggleCollapsed} onKeyDown={onActivateKey(toggleCollapsed)} role="button" tabIndex={0} aria-expanded={!collapsed}>
        <BoltIcon />
        <span className="qa-title">Quick actions</span>
        {todo > 0 && <span className="qa-count">{todo}</span>}
        <div className="spacer" />
        {/* Dismisses the whole panel, not just a fold. Hover-revealed so the
            resting header stays quiet; recoverable via Settings, Appearance. */}
        <IconButton
          className="qa-dismiss-btn"
          icon={<XIcon size={10} />}
          label="Hide quick actions"
          onClick={(e) => { e.stopPropagation(); setQuickActionsHidden(true); }}
        />
        <span className={`qa-chevron${collapsed ? " collapsed" : ""}`}>
          <ChevronDown />
        </span>
      </div>
      {!collapsed && (
        <div className="qa-list">
          {visible.map((a) => {
            const isDone = a.done === true;
            return (
              <button
                key={a.id}
                className={`qa-item${isDone ? " done" : ""}`}
                onClick={isDone && a.doneRun ? a.doneRun : a.run}
                disabled={a.busy}
              >
                <span className="qa-item-icon">{isDone ? <CheckIcon /> : a.icon}</span>
                <span className="qa-item-body">
                  <span className="qa-item-label">
                    {a.busy ? "Installing…" : isDone ? a.doneLabel ?? a.label : a.label}
                  </span>
                  <span className="qa-item-hint">{a.hint}</span>
                </span>
                <span className="qa-item-go">
                  <ChevronRight />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── icons ───────────────────────────────────────────────────────────────────

const S = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function BoltIcon() {
  return <svg {...S} width={12} height={12}><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" /></svg>;
}
function PulseIcon() {
  return <svg {...S} width={14} height={14}><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>;
}
function MicIcon() {
  return <svg {...S} width={14} height={14}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></svg>;
}
function ReviewIcon() {
  return <svg {...S} width={14} height={14}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M6 8.5v7M18 8v7" /><circle cx="18" cy="6" r="2.5" /><path d="M13 6h2.5" /></svg>;
}
function PlusIcon() {
  return <svg {...S} width={14} height={14}><path d="M12 5v14M5 12h14" /></svg>;
}
function CheckIcon() {
  return <svg {...S} width={14} height={14}><path d="M20 6L9 17l-5-5" /></svg>;
}
function GithubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
function ChevronDown() {
  return <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>;
}
function ChevronRight() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>;
}
