import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import AgentLogo from "../components/AgentLogo";
import { pastedImageFiles, readImageFiles } from "../lib/queue";
import { AGENT_KINDS, agentLabel } from "../lib/agents";
import type { AgentKind } from "../types";
import { EFFORTS, MODELS, effortName, loadLaunch, modelLabel, saveLaunch, type LaunchOptions } from "./launch";
import { Menu, useMenu, type MenuEntry } from "./Menu";
import { ChevronDownIcon, FileIcon, FolderIcon, PaperclipIcon, SendIcon, XIcon } from "./icons";
import { MAX_ATTACHMENTS, attachmentsFromPaths, imageAttachment, type ComposerAttachment } from "./attachments";

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
  /** Screenshots and files to hand the agent with its first prompt. */
  attachments: ComposerAttachment[];
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
  dictationRef,
  onPickFiles,
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
  /** Filled while the composer is up, so dictation can type into it. */
  dictationRef?: MutableRefObject<((text: string) => void) | null>;
  /** The paperclip's file picker. */
  onPickFiles?: () => Promise<string[]>;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
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

  // Dictation lands where the cursor is, like typing would.
  useEffect(() => {
    if (!dictationRef) return;
    dictationRef.current = (spoken: string) => {
      const el = area.current;
      if (!el || !spoken) return;
      const at = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? at;
      const before = el.value.slice(0, at);
      const after = el.value.slice(end);
      const lead = before && !/\s$/.test(before) ? " " : "";
      const trail = after && !/^\s/.test(after) ? " " : "";
      const next = `${before}${lead}${spoken}${trail}${after}`;
      setText(next);
      const caret = (before + lead + spoken).length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    };
    return () => {
      dictationRef.current = null;
    };
  }, [dictationRef]);

  const addAttachments = (more: ComposerAttachment[]) => {
    if (more.length === 0) return;
    setAttachments((have) => [...have, ...more].slice(0, MAX_ATTACHMENTS));
    area.current?.focus();
  };

  // Native file drags never reach the DOM in Tauri (see usePtyFileDrop), so a
  // drop on this screen comes through the webview's own drag-drop events. No
  // terminal is mounted while the composer is up, so nothing else claims it.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const isMac = navigator.userAgent.includes("Mac");
    const over = (pos: { x: number; y: number }) => {
      const scale = isMac ? 1 : window.devicePixelRatio || 1;
      const el = document.elementFromPoint(pos.x / scale, pos.y / scale);
      return !!el?.closest?.(".v2-hello");
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setDropping(over(p.position));
        else if (p.type === "leave") setDropping(false);
        else if (p.type === "drop") {
          setDropping(false);
          if (over(p.position) && p.paths.length > 0) void attachmentsFromPaths(p.paths).then(addAttachments);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const pickFiles = async () => {
    if (!onPickFiles) return;
    const paths = await onPickFiles();
    addAttachments(await attachmentsFromPaths(paths));
  };

  // Thumbnails for the images, released when they go.
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of attachments) {
      if (a.kind === "image") map.set(a.id, URL.createObjectURL(new Blob([a.data.slice()], { type: a.ext === "svg" ? "image/svg+xml" : `image/${a.ext === "jpg" ? "jpeg" : a.ext}` })));
    }
    return map;
  }, [attachments]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);

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
    onStart({ ...target, kind, prompt: text.trim(), launch, attachments });
    setText("");
    setAttachments([]);
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
        ref={formRef}
        className={dropping ? "v2-composer is-dropping" : "v2-composer"}
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
          onPaste={(e) => {
            // Read the files during the event: the clipboard is gone after it.
            const files = pastedImageFiles(e.nativeEvent);
            if (files.length === 0) return;
            e.preventDefault();
            void readImageFiles(files).then((imgs) => addAttachments(imgs.map((i) => imageAttachment(i.data, i.ext))));
          }}
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
          Enter starts the agent, Shift+Enter adds a line. Left empty, the agent just opens. Paste or drop screenshots and files to attach them.
        </span>
        {attachments.length > 0 && (
          <ul className="v2-attachments" aria-label="Attachments">
            {attachments.map((a) => (
              <li key={a.id} className={a.kind === "image" ? "v2-attachment is-image" : "v2-attachment"} title={a.kind === "file" ? a.path : a.name}>
                {a.kind === "image" ? (
                  <img src={previews.get(a.id)} alt={a.name} />
                ) : (
                  <>
                    <FileIcon size={14} />
                    <span>{a.name}</span>
                  </>
                )}
                <button
                  type="button"
                  className="v2-attachment-remove"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => {
                    setAttachments((have) => have.filter((x) => x.id !== a.id));
                    area.current?.focus();
                  }}
                >
                  <XIcon size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="v2-composer-row">
          {onPickFiles && (
            <button
              type="button"
              className="v2-icon-btn v2-attach"
              aria-label="Attach screenshots or files"
              title="Attach screenshots or files (or paste or drop them here)"
              disabled={attachments.length >= MAX_ATTACHMENTS}
              onClick={() => void pickFiles()}
            >
              <PaperclipIcon size={16} />
            </button>
          )}
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
