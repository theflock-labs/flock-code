import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import AgentLogo from "../components/AgentLogo";
import { AGENT_KINDS, agentLabel } from "../lib/agents";
import type { AgentKind } from "../types";
import { EFFORTS, MODELS, effortName, loadLaunch, modelLabel, saveLaunch, type LaunchOptions } from "./launch";
import { Menu, useMenu, type MenuEntry } from "./Menu";
import { ChevronDownIcon, FolderIcon, SendIcon } from "./icons";

export interface ComposerProject {
  id: string;
  name: string;
  repoPath: string;
}

export interface StartRequest {
  /** An existing project, or… */
  projectId?: string;
  /** …a folder to open as a new one. */
  dir?: string;
  kind: AgentKind;
  /** Empty: just open the agent. */
  prompt: string;
  /** Model and effort, where the agent offers a choice. */
  launch: LaunchOptions;
}

const KIND_KEY = "flock:v2-last-agent";

function lastKind(fallback: AgentKind): AgentKind {
  try {
    const v = localStorage.getItem(KIND_KEY);
    return AGENT_KINDS.includes(v as AgentKind) ? (v as AgentKind) : fallback;
  } catch {
    return fallback;
  }
}

function folderName(dir: string): string {
  return dir.replace(/\/+$/, "").split("/").pop() || dir;
}

/** A new agent, the way lucy-chat starts a chat: one box to say what it should
 *  do, Enter to go. Under it, only two chips: where (the project) and who (the
 *  agent). The agent's model and effort, and the power options of the old New
 *  Workspace dialog, are one step into the agent's menu, and its chip names a
 *  model or effort only once you have picked one; until then the agent's own
 *  defaults need no label. */
export default function Composer({
  projects,
  projectId,
  defaultKind,
  onStart,
  onPickFolder,
  onMoreOptions,
  onCancel,
}: {
  projects: ComposerProject[];
  /** Preselected project (a project's "+", or the thread you came from). */
  projectId?: string | null;
  defaultKind: AgentKind;
  onStart: (req: StartRequest) => void;
  onPickFolder: () => Promise<string | null>;
  onMoreOptions: () => void;
  /** Back to the thread you came from (Escape), when there is one. */
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<{ projectId?: string; dir?: string }>(() =>
    projectId && projects.some((p) => p.id === projectId)
      ? { projectId }
      : projects[0]
        ? { projectId: projects[0].id }
        : {},
  );
  const [kind, setKind] = useState<AgentKind>(() => lastKind(defaultKind));
  // What this agent was last started with, per agent.
  const [launch, setLaunch] = useState<LaunchOptions>(() => loadLaunch(lastKind(defaultKind)));
  const projectMenu = useMenu();
  const agentMenu = useMenu();
  const modelMenu = useMenu();
  const effortMenu = useMenu();
  const hintId = useId();
  const models = MODELS[kind];
  const efforts = EFFORTS[kind];
  const area = useRef<HTMLTextAreaElement>(null);

  // A different project's "+" while this screen is up retargets it — only a
  // change of the preselection does, never a re-render.
  const preselected = useRef(projectId);
  useEffect(() => {
    if (projectId === preselected.current) return;
    preselected.current = projectId;
    if (projectId && projects.some((p) => p.id === projectId)) setTarget({ projectId });
  }, [projectId, projects]);

  // Grows with what is typed, up to the cap in CSS.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    area.current?.focus();
  }, []);

  const project = projects.find((p) => p.id === target.projectId);
  const where = project?.name ?? (target.dir ? folderName(target.dir) : null);
  const ready = !!where;

  const start = () => {
    if (!ready) return;
    try {
      localStorage.setItem(KIND_KEY, kind);
    } catch {
      /* a preference */
    }
    saveLaunch(kind, launch);
    onStart({ ...target, kind, prompt: text.trim(), launch });
    setText("");
  };

  const chooseFolder = async () => {
    const dir = await onPickFolder();
    if (!dir) return;
    const existing = projects.find((p) => p.repoPath.replace(/\/+$/, "") === dir.replace(/\/+$/, ""));
    setTarget(existing ? { projectId: existing.id } : { dir });
    area.current?.focus();
  };

  const projectEntries: MenuEntry[] = [
    ...(projects.length > 0 ? [{ heading: "Projects" } as MenuEntry] : []),
    ...projects.map<MenuEntry>((p) => ({
      label: p.name,
      hint: p.repoPath.replace(/^\/Users\/[^/]+/, "~"),
      checked: p.id === target.projectId,
      onSelect: () => setTarget({ projectId: p.id }),
    })),
    ...(projects.length > 0 ? [{ separator: true } as MenuEntry] : []),
    { label: "Open a folder…", onSelect: () => void chooseFolder() },
  ];

  // The agent's menu: which agent, then one step to its model, its effort or
  // the rest of the options. The second list opens where the first was.
  const anchor = agentMenu.anchor;
  const agentEntries: MenuEntry[] = [
    ...AGENT_KINDS.map<MenuEntry>((k) => ({
      label: agentLabel(k),
      icon: <AgentLogo kind={k} size={14} />,
      checked: k === kind,
      onSelect: () => {
        setKind(k);
        setLaunch(loadLaunch(k));
      },
    })),
    { separator: true },
    ...(models && anchor
      ? [{ label: "Model", hint: launch.model ? modelLabel(kind, launch.model) : "Default", onSelect: () => modelMenu.openAt(anchor) } as MenuEntry]
      : []),
    ...(efforts && anchor
      ? [{ label: "Effort", hint: launch.effort ? effortName(launch.effort) : "Default", onSelect: () => effortMenu.openAt(anchor) } as MenuEntry]
      : []),
    { label: "More options…", hint: "⌘⇧N", onSelect: onMoreOptions },
  ];

  const modelEntries: MenuEntry[] = [
    { heading: `${agentLabel(kind)} model` },
    { label: "Default", checked: !launch.model, onSelect: () => setLaunch((l) => ({ ...l, model: undefined })) },
    ...(models ?? []).map<MenuEntry>((m) => ({
      label: m.label,
      checked: launch.model === m.value,
      onSelect: () => setLaunch((l) => ({ ...l, model: m.value })),
    })),
  ];

  const effortEntries: MenuEntry[] = [
    { heading: `${agentLabel(kind)} effort` },
    { label: "Default", checked: !launch.effort, onSelect: () => setLaunch((l) => ({ ...l, effort: undefined })) },
    ...(efforts ?? []).map<MenuEntry>((e) => ({
      label: effortName(e),
      checked: launch.effort === e,
      onSelect: () => setLaunch((l) => ({ ...l, effort: e })),
    })),
  ];

  // The agent, and what was picked for it: "Claude Code", "Claude Code · Opus · High".
  const agentSummary = [agentLabel(kind), launch.model && modelLabel(kind, launch.model), launch.effort && effortName(launch.effort)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="v2-hello">
      <h1 className="v2-hello-title">What should we work on?</h1>
      <form
        className="v2-composer"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <textarea
          ref={area}
          rows={3}
          value={text}
          placeholder={ready ? "Describe the task" : "Choose a folder first"}
          aria-label="Task for the new agent"
          aria-describedby={hintId}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              start();
            } else if (e.key === "Escape" && onCancel) {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <span id={hintId} className="visually-hidden">
          Enter starts the agent, Shift+Enter adds a line. Left empty, the agent just opens.
        </span>
        <div className="v2-composer-row">
          <button
            type="button"
            className="v2-chip"
            aria-haspopup="menu"
            aria-label={`Project: ${where ?? "none"}`}
            aria-expanded={projectMenu.open}
            title={project?.repoPath ?? target.dir}
            onClick={projects.length === 0 ? () => void chooseFolder() : projectMenu.toggle}
          >
            <FolderIcon size={15} />
            <span>{where ?? "Choose a folder"}</span>
            {projects.length > 0 && <ChevronDownIcon size={13} />}
          </button>
          <button
            type="button"
            className="v2-chip v2-chip-agent"
            aria-haspopup="menu"
            aria-label={`Agent: ${agentSummary}`}
            aria-expanded={agentMenu.open}
            onClick={agentMenu.toggle}
          >
            <AgentLogo kind={kind} size={14} />
            <span>{agentSummary}</span>
            <ChevronDownIcon size={13} />
          </button>
          <button type="submit" className="v2-send" aria-label="Start the agent" title="Start (Enter)" disabled={!ready}>
            <SendIcon size={16} />
          </button>
        </div>
      </form>
      {projectMenu.anchor && <Menu anchor={projectMenu.anchor} entries={projectEntries} onClose={projectMenu.close} label="Project" />}
      {agentMenu.anchor && <Menu anchor={agentMenu.anchor} entries={agentEntries} onClose={agentMenu.close} label="Agent" align="end" />}
      {modelMenu.anchor && <Menu anchor={modelMenu.anchor} entries={modelEntries} onClose={modelMenu.close} label="Model" align="end" />}
      {effortMenu.anchor && <Menu anchor={effortMenu.anchor} entries={effortEntries} onClose={effortMenu.close} label="Effort" align="end" />}
    </div>
  );
}
