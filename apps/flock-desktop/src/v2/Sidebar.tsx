import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Menu, useMenu, type MenuEntry } from "./Menu";
import {
  BellIcon,
  ChevronDownIcon,
  GraphIcon,
  MoonIcon,
  MoreIcon,
  PanelLeftIcon,
  PlusIcon,
  PullRequestIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
} from "./icons";
import { ago, filterProjects, type Project, type Thread } from "./threads";
import GooseMark from "../components/GooseMark";
import People, { type PeopleProps } from "./People";
import UsageMeters from "./UsageMeters";
import Wordmark from "../components/Wordmark";

export interface Me {
  name: string;
  handle?: string | null;
  avatarUrl?: string | null;
}

interface Props {
  projects: Project[];
  /** The thread on screen, if the main panel shows one. Primitives, so the
   *  memoized sidebar skips renders that change nothing it draws. */
  currentWorkspaceId: string | null;
  currentTabId: string | null;
  /** What the main panel shows, so the matching row reads as current. */
  view: "thread" | "new" | "settings" | "prs" | "graph";
  waiting: number;
  /** Open pull requests for the current project; undefined hides the row. */
  prCount?: number;
  /** Whether the shared graph is set up: its row opens the explorer, or setup. */
  graphEnabled: boolean;
  me: Me;
  /** Online with friends: a dot on your avatar. */
  meOnline?: boolean;
  /** Friends and requests; absent while signed out. Memoized by the caller. */
  people?: PeopleProps;
  /** Your stats and achievements. */
  onOpenMe: () => void;
  dark: boolean;
  onToggleTheme: () => void;
  onNewAgent: (workspaceId?: string) => void;
  onOpenThread: (workspaceId: string, tabId: string) => void;
  onNextWaiting: () => void;
  onOpenPrs: () => void;
  onOpenGraph: () => void;
  onSettings: (page?: string) => void;
  onCollapse: () => void;
  onRenameThread: (workspaceId: string, tabId: string, name: string) => void;
  threadMenu: (thread: Thread) => MenuEntry[];
  projectMenu: (workspaceId: string) => MenuEntry[];
}

const COLLAPSED_KEY = "flock:v2-collapsed-projects";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** One clock for every "4m" in the list, ticking twice a minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function initials(name: string): string {
  const parts = name.replace(/^@/, "").trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  return (last ? (first[0] ?? "") + (last[0] ?? "") : first.slice(0, 2)).toUpperCase();
}

function stateMeta(t: Thread, now: number): string {
  switch (t.state) {
    case "needs-you":
      return ago(t.since, now) || "now";
    case "failed":
      return "failed";
    case "ended":
      return "ended";
    case "idle":
      return ago(t.since, now);
    default:
      return "";
  }
}

const STATE_LABEL: Record<Thread["state"], string> = {
  "needs-you": "waiting on you",
  failed: "failed",
  working: "working",
  starting: "starting",
  idle: "idle",
  ended: "ended",
  asleep: "not started yet",
};

function ThreadRow({
  thread,
  current,
  now,
  renaming,
  onOpen,
  onStartRename,
  onRename,
  menu,
}: {
  thread: Thread;
  current: boolean;
  now: number;
  renaming: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (name: string | undefined) => void;
  menu: () => MenuEntry[];
}) {
  const more = useMenu();
  const kept = useRef(false);
  const meta = stateMeta(thread, now);
  return (
    <li className="v2-thread-item" data-renaming={renaming || undefined}>
      {renaming ? (
        <div className="v2-thread" data-state={thread.state}>
          <span className="v2-dot" data-state={thread.state} />
          <input
            className="v2-rename"
            aria-label="Thread name"
            defaultValue={thread.title}
            autoFocus
            maxLength={60}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                kept.current = true;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              onRename(kept.current ? undefined : e.currentTarget.value);
              kept.current = false;
            }}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            className="v2-thread"
            data-state={thread.state}
            aria-current={current ? "page" : undefined}
            title={`${thread.title}${thread.doing ? `\nNow: ${thread.doing}` : ""} — ${STATE_LABEL[thread.state]}`}
            onClick={onOpen}
            onDoubleClick={onStartRename}
          >
            <span className="v2-dot" data-state={thread.state} />
            <span className="v2-thread-text">
              <span className="v2-thread-title">{thread.title}</span>
              {thread.doing && <span className="v2-thread-doing">{thread.doing}</span>}
            </span>
            {thread.agents > 1 && <span className="v2-thread-agents">×{thread.agents}</span>}
            {meta && <span className="v2-thread-meta">{meta}</span>}
            <span className="visually-hidden">, {STATE_LABEL[thread.state]}</span>
          </button>
          <button
            type="button"
            className="v2-icon-btn v2-thread-more"
            aria-label={`Actions for ${thread.title}`}
            aria-expanded={more.open}
            onClick={more.toggle}
          >
            <MoreIcon size={15} />
          </button>
          {more.anchor && <Menu anchor={more.anchor} entries={menu()} onClose={more.close} label={thread.title} />}
        </>
      )}
    </li>
  );
}

function ProjectGroup({
  project,
  collapsed,
  onToggle,
  children,
  onNewAgent,
  menu,
}: {
  project: Project;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  onNewAgent: () => void;
  menu: () => MenuEntry[];
}) {
  const more = useMenu();
  return (
    <section className="v2-project" data-collapsed={collapsed || undefined} aria-label={project.name}>
      <div className="v2-project-head">
        <button type="button" className="v2-project-name" aria-expanded={!collapsed} onClick={onToggle} title={project.repoPath}>
          <ChevronDownIcon size={13} />
          <span>{project.name}</span>
          {collapsed && project.waiting > 0 && <span className="v2-count mark">{project.waiting}</span>}
        </button>
        <button type="button" className="v2-icon-btn" aria-label={`New agent in ${project.name}`} title="New agent here" onClick={onNewAgent}>
          <PlusIcon size={15} />
        </button>
        <button
          type="button"
          className="v2-icon-btn"
          aria-label={`Actions for ${project.name}`}
          aria-expanded={more.open}
          onClick={more.toggle}
        >
          <MoreIcon size={15} />
        </button>
        {more.anchor && <Menu anchor={more.anchor} entries={menu()} onClose={more.close} label={project.name} />}
      </div>
      {!collapsed && children}
    </section>
  );
}

function Sidebar({
  projects,
  currentWorkspaceId,
  currentTabId,
  view,
  waiting,
  prCount,
  graphEnabled,
  me,
  meOnline,
  people,
  onOpenMe,
  dark,
  onToggleTheme,
  onNewAgent,
  onOpenThread,
  onNextWaiting,
  onOpenPrs,
  onOpenGraph,
  onSettings,
  onCollapse,
  onRenameThread,
  threadMenu,
  projectMenu,
}: Props) {
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const now = useNow();
  const shown = useMemo(() => filterProjects(projects, query), [projects, query]);
  const searching = query.trim().length > 0;

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* a preference */
      }
      return next;
    });

  return (
    <aside className="v2-sidebar" aria-label="Projects and agents">
      {/* The window's own buttons are drawn over this band on macOS; it is the
          handle that moves the window, and holds only the sidebar toggle. */}
      <div className="v2-side-head" data-tauri-drag-region>
        <button type="button" className="v2-icon-btn" aria-label="Hide sidebar" title="Hide sidebar (⌘\)" onClick={onCollapse}>
          <PanelLeftIcon size={16} />
        </button>
      </div>
      {/* The mark, under the window's buttons as lucy-chat sets its logo: the
          goose and the wordmark, whose l carries the crest. */}
      <div className="v2-brand" data-tauri-drag-region>
        <GooseMark width={57} />
        <Wordmark size={33} />
      </div>

      <div className="v2-search" role="search">
        <SearchIcon size={14} />
        <input
          type="search"
          placeholder="Search agents"
          aria-label="Search agents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              setQuery("");
            } else if (e.key === "Enter") {
              const first = shown.flatMap((p) => p.threads)[0];
              if (first) onOpenThread(first.workspaceId, first.tabId);
            }
          }}
        />
      </div>

      <nav className="v2-nav" aria-label="Start">
        <button type="button" className="v2-row" aria-current={view === "new" ? "page" : undefined} onClick={() => onNewAgent()}>
          <PlusIcon size={16} />
          New agent
          <span className="v2-row-end">
            <kbd>⌘N</kbd>
          </span>
        </button>
        {waiting > 0 && (
          <button type="button" className="v2-row" onClick={onNextWaiting} title="Jump to the next agent waiting on you (⌘J)">
            <BellIcon size={16} />
            Waiting on you
            <span className="v2-row-end">
              <span className="v2-count mark">{waiting}</span>
            </span>
          </button>
        )}
        {prCount !== undefined && (
          <button type="button" className="v2-row" aria-current={view === "prs" ? "page" : undefined} onClick={onOpenPrs}>
            <PullRequestIcon size={16} />
            Pull requests
            {prCount > 0 && (
              <span className="v2-row-end">
                <span className="v2-count">{prCount}</span>
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          className="v2-row"
          aria-current={view === "graph" ? "page" : undefined}
          onClick={onOpenGraph}
          title={graphEnabled ? "What your agents decided and tried, shared between them" : "Give your agents a shared memory"}
        >
          <GraphIcon size={16} />
          Graph
          {!graphEnabled && (
            <span className="v2-row-end">
              <small className="v2-row-note">Set up</small>
            </span>
          )}
        </button>
      </nav>

      <div className="v2-projects">
        {shown.length === 0 ? (
          <p className="v2-empty">{searching ? "No agents match." : "No projects yet. Start one with New agent."}</p>
        ) : (
          shown.map((p) => (
            <ProjectGroup
              key={p.id}
              project={p}
              collapsed={!searching && collapsed.has(p.id)}
              onToggle={() => toggle(p.id)}
              onNewAgent={() => onNewAgent(p.id)}
              menu={() => projectMenu(p.id)}
            >
              {p.threads.length === 0 ? (
                <p className="v2-empty">No agents running.</p>
              ) : (
                <ul className="v2-thread-list">
                  {p.threads.map((t) => (
                    <ThreadRow
                      key={t.key}
                      thread={t}
                      current={view === "thread" && currentWorkspaceId === t.workspaceId && currentTabId === t.tabId}
                      now={now}
                      renaming={renaming === t.key}
                      onOpen={() => onOpenThread(t.workspaceId, t.tabId)}
                      onStartRename={() => setRenaming(t.key)}
                      onRename={(name) => {
                        setRenaming(null);
                        if (name !== undefined && name.trim() !== t.title) onRenameThread(t.workspaceId, t.tabId, name);
                      }}
                      menu={() => [
                        { label: "Rename", onSelect: () => setRenaming(t.key) },
                        ...threadMenu(t),
                      ]}
                    />
                  ))}
                </ul>
              )}
            </ProjectGroup>
          ))
        )}
      </div>

      {people && <People {...people} />}

      <UsageMeters />

      <div className="v2-side-foot">
        <button type="button" className="v2-me" title="Your stats and achievements" onClick={onOpenMe}>
          <span className="v2-avatar" aria-hidden="true">
            {me.avatarUrl ? <img src={me.avatarUrl} alt="" referrerPolicy="no-referrer" /> : initials(me.name)}
            {meOnline && <span className="v2-avatar-dot" title="Friends can see you're online" />}
          </span>
          <span className="v2-me-text">
            <b>{me.name}</b>
            {me.handle && <small>@{me.handle}</small>}
          </span>
        </button>
        <button
          type="button"
          className="v2-icon-btn"
          aria-label={dark ? "Use the light theme" : "Use the dark theme"}
          title={dark ? "Light" : "Dark"}
          onClick={onToggleTheme}
        >
          {dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
        <button
          type="button"
          className="v2-icon-btn"
          aria-label="Settings"
          title="Settings (⌘,)"
          aria-current={view === "settings" ? "page" : undefined}
          onClick={() => onSettings()}
        >
          <SettingsIcon size={16} />
        </button>
      </div>
    </aside>
  );
}

export default memo(Sidebar);
