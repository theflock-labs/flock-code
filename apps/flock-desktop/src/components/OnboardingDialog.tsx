import { useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OPEN_GRAPH_SETUP_EVENT } from "../lib/graphSettings";
import ModalCloseButton from "./ModalCloseButton";
import { useFocusTrap } from "../lib/useFocusTrap";

interface Step {
  step: string;
  title: string;
  accent: string;
  body: string;
  bullets?: string[];
}

const STEPS: Step[] = [
  {
    step: "WELCOME",
    title: "flock",
    accent: "var(--mint)",
    body: "A multi-agent coding cockpit — run Claude Code, Grok, opencode, and Codex side by side in tiled terminal panes, backed by a workspace manager that remembers exactly where you left off.",
    bullets: [
      "Multiple agents, multiple windows, one cockpit",
      "GitHub-native — PRs, checks, and reviews built in",
      "Everything below is optional. Skip anytime, revisit in Settings.",
    ],
  },
  {
    step: "WORKSPACES & AGENTS",
    title: "One repo, many agents",
    accent: "var(--mint)",
    body: "Each workspace is tied to a repo and branch. Spawn Claude Code, Grok, opencode, or Codex into split panes and give each one its own task.",
    bullets: [
      "Split panes any direction, zoom one to full-screen and back",
      "Every agent gets a random name (Pluto, Vesper, Astrid…) so you can tell them apart at a glance",
      "Pop any pane into its own window — Teams-style — and it folds right back in when you close it",
    ],
  },
  {
    step: "GIT WORKTREES",
    title: "No more branch collisions",
    accent: "var(--yellow)",
    body: "Turn on \"separate worktrees\" for a workspace and every agent gets its own isolated git worktree instead of sharing one working directory.",
    bullets: [
      "Two agents can work on two branches of the same repo at once, safely",
      "Worktrees are cleaned up automatically when their pane closes",
    ],
  },
  {
    step: "PULL REQUESTS",
    title: "Review without leaving the cockpit",
    accent: "var(--blue)",
    body: "Open PRs for your repo show up in the sidebar automatically, from any author — not just your own.",
    bullets: [
      "Live CI check status in the top bar for the branch you're on",
      "One click \"review\" checks out a PR's branch and hands it straight to an agent",
      "No manual git juggling to go look at someone else's change",
    ],
  },
  {
    step: "VOICE",
    title: "Push-to-talk dictation",
    accent: "var(--orange)",
    body: "Hold a hotkey and talk — flock transcribes locally (via Whisper) and types the result straight into the focused agent.",
    bullets: [
      "Configurable hotkey and microphone, all offline",
      "A small floating HUD shows recording/transcribing status",
    ],
  },
  {
    step: "FRIENDS & CO-PILOT",
    title: "Bring a friend",
    accent: "var(--blue-dim)",
    body: "Add friends by GitHub handle and see who's online and how many agents they're running.",
    bullets: [
      "Invite someone into a live co-pilot session sharing your panes",
      "Or just observe — watch a friend's terminal in real time, read-only",
    ],
  },
  {
    step: "flock graph",
    title: "Agents that share understanding",
    accent: "var(--mint)",
    body: "Opt in to Graph — a local knowledge graph agents write to and read from over MCP. Decisions, failed attempts, and file ownership persist across agents and sessions, so Agent B never rediscovers what Agent A already learned.",
    bullets: [
      "Local first: Postgres + pgvector in Docker, nothing leaves your machine",
      "Works with Claude Code, opencode, Codex — anything that speaks MCP",
      "Strictly opt-in — a guided setup walks you through everything",
    ],
  },
  {
    step: "COMMUNITY",
    title: "Join the Discord",
    accent: "var(--mint)",
    body: "Ask questions, share workflows, report bugs, and get help from other flock users. This link also lives in Settings → About if you need it later.",
  },
];

interface Props {
  onDone: () => void;
}

export default function OnboardingDialog({ onDone }: Props) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  const next = () => {
    if (isLast) onDone();
    else setIndex((i) => i + 1);
  };
  const back = () => setIndex((i) => Math.max(0, i - 1));

  return (
    <div className="modal-overlay">
      <div className="modal onboarding-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Onboarding">
        <ModalCloseButton onClose={onDone} />
        <div className="modal-header">
          <div className="onboarding-eyebrow-row">
            <span className="onboarding-accent-bar" style={{ background: step.accent }} />
            <div className="step">{step.step}</div>
          </div>
          <div className="title" style={{ color: step.accent }}>{step.title}</div>
        </div>

        <div className="modal-body">
          <p className="onboarding-body">{step.body}</p>
          {step.bullets && (
            <ul className="onboarding-bullets">
              {step.bullets.map((b, i) => (
                <li key={i}>
                  <span className="onboarding-bullet-mark" style={{ color: step.accent }}>›</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
          {step.step === "flock graph" && (
            <button
              className="btn-ghost settings-btn onboarding-discord-btn"
              onClick={() => window.dispatchEvent(new Event(OPEN_GRAPH_SETUP_EVENT))}
            >
              Set up Graph →
            </button>
          )}
          {isLast && (
            <button
              className="btn-ghost settings-btn onboarding-discord-btn"
              onClick={() => openUrl("https://discord.gg/rRerdy329").catch(console.error)}
            >
              Join the Discord →
            </button>
          )}
        </div>

        <div className="modal-footer onboarding-footer">
          <div className="onboarding-dots">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`onboarding-dot${i === index ? " active" : ""}`}
                style={i === index ? { background: step.accent } : undefined}
              />
            ))}
          </div>
          <span className="onboarding-counter">{index + 1} / {STEPS.length}</span>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost settings-btn" onClick={onDone}>Skip</button>
          {index > 0 && (
            <button className="btn-ghost settings-btn" onClick={back}>Back</button>
          )}
          <button className="btn-mint-solid" onClick={next}>
            {isLast ? "Get Started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
