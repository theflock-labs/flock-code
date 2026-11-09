import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { latestTask, sameTitle } from "./titles";
import Terminal from "../components/Terminal";
import RemoteTerminal from "../components/RemoteTerminal";
import ErrorBoundary from "../components/ErrorBoundary";
import { broadcastIsActive, broadcastKey, broadcastRecipients, useBroadcast } from "../lib/broadcastInput";
import { computeBorders, computeLayout, setRatioAtPath, type BorderRect, type Rect, type SplitPath } from "../lib/layout";
import { clearTerminalSelection } from "../lib/terminalRegistry";
import { agentLabel } from "../lib/agents";
import type { LayoutNode, Pane, Workspace, WorkspaceTab } from "../types";
import { MaximizeIcon, MinimizeIcon, XIcon } from "./icons";
import { paneState } from "./threads";

interface Props {
  workspace: Workspace;
  tab: WorkspaceTab;
  /** The thread's name, as its header shows it. */
  title?: string;
  /** Panes with a live pop-out window: another webview drives those PTYs. */
  poppedOutIds: ReadonlySet<string>;
  onFocusPane: (workspaceId: string, paneId: string) => void;
  onResizeSplit: (workspaceId: string, tabId: string, path: SplitPath, ratio: number) => void;
  onEvenSplits: (workspaceId: string, tabId: string) => void;
  onSwapPanes: (workspaceId: string, tabId: string, a: string, b: string) => void;
  onZoomPane: (workspaceId: string, paneId: string | null) => void;
  onClosePane: (paneId: string) => void;
  onPaneContextMenu: (workspaceId: string, paneId: string | null, e: React.MouseEvent) => void;
  onIntentCaptured: (paneId: string, text: string) => void;
  /** Lift a boot card by hand (click it, or it times out). */
  onReveal: (paneId: string) => void;
  onBringBack: (paneId: string) => void;
}

/** One thread's agents, tiled. Only the thread on screen is ever rendered, so
 *  every terminal here is a visible one. */
function ThreadView({
  workspace,
  tab,
  title,
  poppedOutIds,
  onFocusPane,
  onResizeSplit,
  onEvenSplits,
  onSwapPanes,
  onZoomPane,
  onClosePane,
  onPaneContextMenu,
  onIntentCaptured,
  onReveal,
  onBringBack,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = (width: number, height: number) =>
      setGridSize((prev) =>
        prev && prev.width === Math.floor(width) && prev.height === Math.floor(height)
          ? prev
          : { x: 0, y: 0, width: Math.floor(width), height: Math.floor(height) },
      );
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) measure(r.width, r.height);
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      measure(width, height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A gutter drag previews locally and commits once, on release.
  const [liveRatio, setLiveRatio] = useState<{ path: SplitPath; ratio: number } | null>(null);
  useEffect(() => setLiveRatio(null), [tab.layoutTree]);

  const displayTree = useMemo<LayoutNode | null>(() => {
    const base: LayoutNode | null = tab.zoomedPaneId ? { type: "leaf", paneId: tab.zoomedPaneId } : tab.layoutTree;
    return base && liveRatio ? setRatioAtPath(base, liveRatio.path, liveRatio.ratio) : base;
  }, [tab.zoomedPaneId, tab.layoutTree, liveRatio]);
  const paneRects = useMemo(() => (displayTree && gridSize ? computeLayout(displayTree, gridSize) : []), [displayTree, gridSize]);
  const borders = useMemo(
    () => (displayTree && gridSize && !tab.zoomedPaneId ? computeBorders(displayTree, gridSize) : []),
    [displayTree, gridSize, tab.zoomedPaneId],
  );
  const tiled = paneRects.length > 1 || !!tab.zoomedPaneId;

  useBroadcast();
  const recipients = useMemo(() => broadcastRecipients(tab, workspace.panes, undefined, poppedOutIds), [tab, workspace.panes, poppedOutIds]);
  const broadcasting = broadcastIsActive(broadcastKey(workspace.id, tab.id), tab, recipients, true);
  const broadcastGroup = useMemo<readonly string[] | null>(
    () => (broadcasting ? recipients.map((p) => p.id) : null),
    [broadcasting, recipients],
  );

  // ─── Drag a pane by its bar onto another to swap them ──────────────────
  const [dragPaneId, setDragPaneId] = useState<string | null>(null);
  const [swapDrag, setSwapDrag] = useState<{ overId: string | null; x: number; y: number } | null>(null);
  const swapCtx = useRef({ paneRects, onSwapPanes, wsId: workspace.id, tabId: tab.id });
  swapCtx.current = { paneRects, onSwapPanes, wsId: workspace.id, tabId: tab.id };
  useEffect(() => {
    if (!dragPaneId) return;
    const grid = gridRef.current?.getBoundingClientRect();
    const ox = grid?.left ?? 0;
    const oy = grid?.top ?? 0;
    let start: { x: number; y: number } | null = null;
    let live = false;
    let over: string | null = null;
    const paneAt = (x: number, y: number) =>
      swapCtx.current.paneRects.find(({ rect }) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)?.paneId ?? null;
    const onMove = (e: PointerEvent) => {
      if (!start) { start = { x: e.clientX, y: e.clientY }; return; }
      if (!live && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      live = true;
      const x = e.clientX - ox;
      const y = e.clientY - oy;
      const hit = paneAt(x, y);
      over = hit && hit !== dragPaneId ? hit : null;
      setSwapDrag({ overId: over, x, y });
    };
    const finish = (commit: boolean) => {
      const { onSwapPanes: swap, wsId, tabId } = swapCtx.current;
      if (commit && live && over) swap(wsId, tabId, dragPaneId, over);
      window.getSelection()?.removeAllRanges();
      clearTerminalSelection(dragPaneId);
      setDragPaneId(null);
      setSwapDrag(null);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") finish(false); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragPaneId]);

  // ─── Gutters ────────────────────────────────────────────────────────────
  const dragRef = useRef<{ path: SplitPath; dir: BorderRect["dir"]; area: Rect; ratio: number; ox: number; oy: number } | null>(null);
  const onGutterDown = (e: React.PointerEvent, b: BorderRect) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const grid = gridRef.current?.getBoundingClientRect();
    dragRef.current = { path: b.path, dir: b.dir, area: b.area, ratio: 0.5, ox: grid?.left ?? 0, oy: grid?.top ?? 0 };
  };
  const onGutterMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const raw = d.dir === "horizontal"
      ? (e.clientX - d.ox - d.area.x) / d.area.width
      : (e.clientY - d.oy - d.area.y) / d.area.height;
    d.ratio = Math.max(0.1, Math.min(0.9, raw));
    setLiveRatio({ path: d.path, ratio: d.ratio });
  };
  const onGutterUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    window.getSelection()?.removeAllRanges();
    onResizeSplit(workspace.id, tab.id, d.path, d.ratio);
  };

  const byId = useMemo(() => new Map(workspace.panes.map((p) => [p.id, p])), [workspace.panes]);
  const draggedPane = swapDrag && dragPaneId ? byId.get(dragPaneId) : undefined;

  return (
    <div ref={gridRef} className="v2-grid" onContextMenu={(e) => onPaneContextMenu(workspace.id, tab.focusedPaneId, e)}>
      {paneRects.map(({ paneId, rect }) => {
        const pane = byId.get(paneId);
        const focused = paneId === tab.focusedPaneId;
        const popped = poppedOutIds.has(paneId);
        return (
          <div
            key={paneId}
            className="v2-pane"
            data-pane-id={paneId}
            data-focused={tiled && focused ? "" : undefined}
            data-broadcast={broadcastGroup?.includes(paneId) || undefined}
            data-swap-source={swapDrag && dragPaneId === paneId ? "" : undefined}
            data-swap-target={swapDrag?.overId === paneId ? "" : undefined}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            onMouseDown={() => onFocusPane(workspace.id, paneId)}
            onContextMenu={(e) => {
              e.stopPropagation();
              onPaneContextMenu(workspace.id, paneId, e);
            }}
          >
            {pane && tiled && (
              <PaneBar
                pane={pane}
                threadTitle={title}
                zoomed={tab.zoomedPaneId === paneId}
                draggable={!tab.zoomedPaneId && paneRects.length > 1}
                onGrab={(e) => {
                  if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                  e.preventDefault();
                  onFocusPane(workspace.id, paneId);
                  setDragPaneId(paneId);
                }}
                onZoom={() => {
                  onFocusPane(workspace.id, paneId);
                  onZoomPane(workspace.id, paneId);
                }}
                onClose={() => onClosePane(paneId)}
              />
            )}
            <ErrorBoundary label="This agent's terminal">
              <div className="v2-pane-body">
                {popped ? (
                  <div className="v2-popped">
                    <span>Open in its own window.</span>
                    <button type="button" className="v2-btn" onClick={() => onBringBack(paneId)}>
                      Bring it back
                    </button>
                  </div>
                ) : (
                  <>
                    {pane?.streamId ? (
                      // A friend's agent: drawn from their stream. Typing reaches it
                      // only in a co-pilot session; watching is read-only.
                      <RemoteTerminal streamId={pane.streamId} focused={focused} interactive={!!workspace.copilot} />
                    ) : (
                      pane &&
                      !pane.spawning && (
                        <Terminal
                          paneId={paneId}
                          focused={focused}
                          booting={pane.booting}
                          cwd={pane.cwd}
                          onIntentCaptured={onIntentCaptured}
                          broadcastGroup={broadcastGroup?.includes(paneId) ? broadcastGroup : null}
                        />
                      )
                    )}
                    {pane && (pane.spawning || pane.booting) && <BootCard pane={pane} onReveal={onReveal} />}
                  </>
                )}
              </div>
            </ErrorBoundary>
          </div>
        );
      })}
      {borders.map((b, i) => {
        const pad = 4;
        const rect =
          b.dir === "horizontal"
            ? { left: b.x - pad, top: b.y, width: b.width + pad * 2, height: b.height }
            : { left: b.x, top: b.y - pad, width: b.width, height: b.height + pad * 2 };
        const dragging = liveRatio !== null && liveRatio.path.join() === b.path.join();
        return (
          <div
            key={`g${i}`}
            className="v2-gutter"
            data-dir={b.dir === "horizontal" ? "h" : "v"}
            data-dragging={dragging || undefined}
            style={rect}
            onPointerDown={(e) => onGutterDown(e, b)}
            onPointerMove={onGutterMove}
            onPointerUp={onGutterUp}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEvenSplits(workspace.id, tab.id);
            }}
            title="Drag to resize · double-click to even out"
          />
        );
      })}
      {swapDrag && draggedPane && (
        <div className="v2-swap-ghost" style={{ left: swapDrag.x + 14, top: swapDrag.y + 14 }}>
          <span>{draggedPane.displayName ?? agentLabel(draggedPane.kind)}</span>
          <small>
            {swapDrag.overId
              ? `swap with ${byId.get(swapDrag.overId)?.displayName ?? "this agent"}`
              : "drop on an agent to swap"}
          </small>
        </div>
      )}
    </div>
  );
}

function PaneBar({
  pane,
  threadTitle,
  zoomed,
  draggable,
  onGrab,
  onZoom,
  onClose,
}: {
  pane: Pane;
  /** A task that only repeats the thread's name, right above it, is left out. */
  threadTitle?: string;
  zoomed: boolean;
  draggable: boolean;
  onGrab: (e: React.PointerEvent) => void;
  onZoom: () => void;
  onClose: () => void;
}) {
  const state = paneState(pane);
  // What this agent is on now: its latest task, else the one it started with.
  const doing = latestTask(pane.promptHistory) ?? pane.intent;
  return (
    <div className="v2-pane-bar" onPointerDown={draggable ? onGrab : undefined} style={draggable ? undefined : { cursor: "default" }}>
      <span className="v2-dot" data-state={state} />
      <span className="v2-pane-name">{pane.displayName ?? agentLabel(pane.kind)}</span>
      <span className="v2-pane-task" title={doing}>
        {doing && !sameTitle(doing, threadTitle) ? doing : !doing && (pane.spawning || pane.booting) ? "Starting…" : ""}
      </span>
      <button type="button" className="v2-icon-btn" aria-label={zoomed ? "Show all agents" : "Fill the thread with this agent"} title={zoomed ? "Unzoom (⌘Z)" : "Zoom (⌘Z)"} onClick={onZoom}>
        {zoomed ? <MinimizeIcon size={13} /> : <MaximizeIcon size={13} />}
      </button>
      <button type="button" className="v2-icon-btn" aria-label={`Close ${pane.displayName ?? "agent"}`} title="Close agent (⌘⇧K)" onClick={onClose}>
        <XIcon size={13} />
      </button>
    </div>
  );
}

/** What a pane shows between "start" and the agent's own first frame: one
 *  line naming the step. Click to watch; after 20s it gets out of the way by
 *  itself, because a step that slow is one where the output is the only honest
 *  progress bar. */
function BootCard({ pane, onReveal }: { pane: Pane; onReveal: (paneId: string) => void }) {
  const [elapsed, setElapsed] = useState(0);
  const paneId = pane.id;
  useEffect(() => {
    const t0 = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    const reveal = setTimeout(() => onReveal(paneId), 20_000);
    return () => {
      clearInterval(tick);
      clearTimeout(reveal);
    };
  }, [paneId, onReveal]);
  const who = pane.displayName ?? agentLabel(pane.kind);
  const [line, detail] = ((): [string, string | undefined] => {
    switch (pane.phase?.kind) {
      case "fetching":
        return ["Fetching the base branch", pane.phase.ref];
      case "branching":
        return ["Making its worktree", pane.phase.branch];
      case "installing":
        return ["Installing dependencies", pane.phase.command];
      default:
        return [`Starting ${who}`, undefined];
    }
  })();
  return (
    <div className="v2-boot" role="status" title="Click to watch" onClick={() => onReveal(paneId)}>
      <span className="v2-boot-line">
        {line}…{elapsed >= 5 ? ` ${elapsed}s` : ""}
      </span>
      {detail && <span className="v2-boot-detail">{detail}</span>}
      <span className="v2-boot-bar" />
    </div>
  );
}

export default memo(ThreadView);
