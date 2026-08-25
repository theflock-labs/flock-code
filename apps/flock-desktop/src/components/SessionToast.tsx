import { useEffect, useRef, useState } from "react";
import { CopilotIcon, EyeIcon, SendIcon } from "./friendIcons";
import { Avatar } from "./Avatar";
import { suppressToast } from "../lib/toastSuppression";

/** One newly-opened PR inside a pr_opened toast. All PRs that arrive while
 * the toast is up share it as tabs — a burst of agent-created PRs must not
 * stack up a wall of toasts. */
export interface PrToastTab {
  label: string; // "#43"
  title: string;
  author: string;
  onAccept: () => void;
}

export interface ToastItem {
  id: string;
  kind: "observe_request" | "task_send" | "copilot_invite" | "pr_opened";
  fromLogin: string;
  fromAvatar?: string;
  sessionId: string;
  prompt?: string; // for task_send
  /** pr_opened only: one tab per PR; accept acts on the active tab. */
  tabs?: PrToastTab[];
  onAccept: () => void;
  onDecline: () => void;
}

const KIND_META: Record<ToastItem["kind"], { icon: React.ReactNode; label: string; accept: string; decline: string }> = {
  observe_request: { icon: <EyeIcon size={14} />,     label: "wants to watch your terminal", accept: "Share live",        decline: "Decline" },
  task_send:       { icon: <SendIcon size={14} />,    label: "sent you a task",              accept: "Take it",           decline: "Decline" },
  copilot_invite:  { icon: <CopilotIcon size={14} />, label: "wants to co-pilot with you",   accept: "Join up",           decline: "Decline" },
  pr_opened:       { icon: <PrIcon />,                label: "opened a pull request",        accept: "Review with agent", decline: "Dismiss" },
};

const TTL_SECONDS = 45;

interface Props {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

/** Incoming session request. The countdown drains along the bottom edge and
 * pauses while hovered — deciding shouldn't be a race. Timeout declines. */
function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const [remaining, setRemaining] = useState(TTL_SECONDS);
  const [tabIdx, setTabIdx] = useState(0);
  const hovered = useRef(false);

  const tabs = toast.tabs;
  const activeTab = tabs && tabs.length > 0 ? tabs[Math.min(tabIdx, tabs.length - 1)] : undefined;

  useEffect(() => {
    const t = setInterval(() => {
      if (!hovered.current) setRemaining((c) => c - 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // A PR merged into this toast resets the countdown — deciding on the
  // newcomer shouldn't inherit a nearly-drained timer.
  useEffect(() => {
    if (tabs && tabs.length > 1) setRemaining(TTL_SECONDS);
  }, [tabs?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (remaining <= 0) {
      toast.onDecline();
      onDismiss();
    }
  }, [remaining]); // eslint-disable-line react-hooks/exhaustive-deps

  const meta = KIND_META[toast.kind];
  const accept = () => { (activeTab ? activeTab.onAccept : toast.onAccept)(); onDismiss(); };
  const decline = () => { toast.onDecline(); onDismiss(); };
  // Declines this one on the way out, exactly as the Dismiss button does. The
  // difference is only about future toasts of this kind, and the event itself
  // keeps arriving in the bell feed either way (see lib/toastSuppression.ts).
  const never = () => { suppressToast(toast.kind); decline(); };
  const fromLogin = activeTab?.author ?? toast.fromLogin;

  return (
    <div
      className="session-toast"
      onMouseEnter={() => { hovered.current = true; }}
      onMouseLeave={() => { hovered.current = false; }}
    >
      <div className="session-toast-header">
        <Avatar
          url={toast.fromAvatar}
          seed={fromLogin}
          imgClassName="session-toast-avatar"
          fallbackClassName="session-toast-avatar session-toast-avatar-fallback"
        />
        <span className="session-toast-from">@{fromLogin}</span>
        <span className="session-toast-kind-icon">{meta.icon}</span>
      </div>
      {tabs && tabs.length > 1 && (
        <div className="session-toast-tabs">
          {tabs.map((t, i) => (
            <button
              key={t.label}
              className={`session-toast-tab${t === activeTab ? " active" : ""}`}
              onClick={() => setTabIdx(i)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="session-toast-body">
        {tabs && tabs.length > 1 ? `opened ${tabs.length} pull requests` : meta.label}
        {toast.kind === "task_send" && toast.prompt && (
          <span className="session-toast-prompt">“{toast.prompt.slice(0, 120)}{toast.prompt.length > 120 ? "…" : ""}”</span>
        )}
        {activeTab && (
          <span className="session-toast-prompt">{activeTab.label} {activeTab.title.slice(0, 110)}{activeTab.title.length > 110 ? "…" : ""}</span>
        )}
      </div>
      <div className="session-toast-actions">
        <button className="session-toast-btn accept" onClick={accept}>{meta.accept}</button>
        <button className="session-toast-btn decline" onClick={decline}>{meta.decline}</button>
        {/* Deliberately quiet and last: it is the rarer intent, and it is the
            only one of the three that changes anything beyond this toast. The
            title says where it is undone, so the button is not a trap. */}
        <button
          className="session-toast-btn never"
          onClick={never}
          title="Stop showing this kind of pop-up. It keeps arriving in notifications, and Settings then Appearance turns it back on."
        >
          Don't show again
        </button>
      </div>
      <div
        className="session-toast-ttl"
        style={{ width: `${(remaining / TTL_SECONDS) * 100}%` }}
      />
    </div>
  );
}

// Git pull-request glyph: two branch lanes joined by a merge arrow.
function PrIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="18" r="2.4" />
      <path d="M6 8.4v7.2" />
      <path d="M13 6h2a3 3 0 0 1 3 3v6.6" />
      <path d="M15 3.5 12.5 6 15 8.5" />
    </svg>
  );
}

export default function SessionToasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="session-toasts">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}
