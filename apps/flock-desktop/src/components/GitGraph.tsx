import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onActivateKey } from "../lib/a11y";
import { githubRepoWebUrl, type GitCommit } from "../lib/tauri";
import { computeGraph, type GraphLink } from "../lib/gitGraph";
import { rectZoomFactor } from "../lib/rectZoom";

const ROW_H = 22;   // row height (must match .git-graph-row)
const LANE_W = 12;  // horizontal spacing between lanes
const PAD_L = 8;    // left inset for the first lane
const TEXT_GAP = 12; // gap between a row's rightmost occupied lane and its text
const R = 3.5;      // solid node radius
const HEAD_R = 5;   // hollow HEAD ring radius

// Distinct, palette-friendly lane colors (cycled).
const LANE_COLORS = ["#7fb4f0", "#f6c6d8", "#f4d49b", "#ffb59e", "#9d7bff", "#5ad1e6", "#6ecd9c"];
const colorFor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];

const cx = (col: number) => PAD_L + col * LANE_W;
const cy = (row: number) => row * ROW_H + ROW_H / 2;

function linkPath(l: GraphLink): string {
  const x1 = cx(l.fromCol), y1 = cy(l.fromRow);
  const x2 = cx(l.toCol), y2 = cy(l.toRow);
  const xl = cx(l.lane);
  const enter = y1 + ROW_H / 2; // reach the travel lane by the end of the first row
  const leave = y2 - ROW_H / 2; // start bending into the parent at its row

  if (l.fromCol === l.lane && l.toCol === l.lane) {
    return `M${x1},${y1} L${x2},${y2}`;
  }
  const midA = (y1 + enter) / 2;
  const midB = (leave + y2) / 2;
  return (
    `M${x1},${y1} ` +
    `C${x1},${midA} ${xl},${midA} ${xl},${enter} ` +
    `L${xl},${leave} ` +
    `C${xl},${midB} ${x2},${midB} ${x2},${y2}`
  );
}

// Width the tooltip needs to sit on a side: .commit-tooltip's 260px max-width
// plus its padding/border and the 8px gap off the row.
const TIP_W = 290;

interface Tip {
  commit: GitCommit;
  x: number;
  y: number;
  side: "left" | "right";
}

export default function GitGraph({ commits, repoPath }: { commits: GitCommit[]; repoPath?: string }) {
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const width = PAD_L + graph.laneCount * LANE_W;
  const height = commits.length * ROW_H;

  // Per-row text indent: each commit's text hugs the rightmost lane actually
  // occupied at that row (its node plus any edges passing through), not the
  // graph's global max width. So single-lane commits pull their text all the
  // way left and only merges push it right — a ragged edge with the text
  // wrapped tight against the graph, the way Cursor/GitLens render it.
  const rowLeft = useMemo(() => {
    const maxLane = new Array(commits.length).fill(0);
    for (const n of graph.nodes) maxLane[n.row] = Math.max(maxLane[n.row], n.col);
    for (const l of graph.links) {
      const lo = Math.min(l.fromRow, l.toRow);
      const hi = Math.min(Math.max(l.fromRow, l.toRow), commits.length - 1);
      for (let r = lo; r <= hi; r++) maxLane[r] = Math.max(maxLane[r], l.lane);
      if (l.fromRow < commits.length) maxLane[l.fromRow] = Math.max(maxLane[l.fromRow], l.fromCol);
      if (l.toRow < commits.length) maxLane[l.toRow] = Math.max(maxLane[l.toRow], l.toCol);
    }
    return maxLane.map((m) => PAD_L + m * LANE_W + TEXT_GAP);
  }, [graph, commits.length]);
  const [tip, setTip] = useState<Tip | null>(null);

  // The repo's github.com base URL, resolved from its origin remote, so a
  // commit row can deep-link to its GitHub page. Null when the repo has no
  // GitHub remote — rows stay non-clickable in that case.
  const [webBase, setWebBase] = useState<string | null>(null);
  useEffect(() => {
    if (!repoPath) { setWebBase(null); return; }
    let alive = true;
    githubRepoWebUrl(repoPath)
      .then((u) => { if (alive) setWebBase(u); })
      .catch(() => { if (alive) setWebBase(null); });
    return () => { alive = false; };
  }, [repoPath]);

  const openCommit = (c: GitCommit) => {
    if (webBase) openUrl(`${webBase}/commit/${c.hash}`).catch(console.error);
  };

  // Real floating tooltip, not the native `title` attribute — same reasoning
  // as IconButton's: bigger, immediate, and (being `position: fixed`) escapes
  // the panel's `overflow-y: auto` instead of getting clipped by it. Anchored
  // to the row's right edge with the panel in the left sidebar, and flipped to
  // the row's left when the section is docked in the right rail — where the
  // card would otherwise hang off the window edge. Both rails carry
  // `zoom: --ui-scale`, so the rect has to be converted to true viewport
  // coordinates before that decision (and before positioning), exactly as
  // useFloatingTip does; without it the right rail's rows read as sitting far
  // enough from the edge and the tooltip never flips.
  const showTip = (e: MouseEvent<HTMLDivElement>, commit: GitCommit) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const zoom = rectZoomFactor(el);
    const left = rect.left * zoom;
    const right = rect.right * zoom;
    const side = right + TIP_W > window.innerWidth && left - TIP_W > 0 ? "left" : "right";
    setTip({
      commit,
      x: side === "right" ? right + 8 : left - 8,
      y: (rect.top + rect.height / 2) * zoom,
      side,
    });
  };
  const hideTip = () => setTip(null);

  return (
    <div className="git-graph">
      <svg className="git-graph-rails" width={width} height={height} aria-hidden="true">
        {graph.links.map((l, i) => (
          <path key={i} d={linkPath(l)} fill="none" stroke={colorFor(l.lane)} strokeWidth={1.5} />
        ))}
        {graph.nodes.map((n) =>
          n.commit.is_head ? (
            // HEAD: hollow ring, like VS Code's checked-out tip.
            <circle
              key={n.hash}
              cx={cx(n.col)}
              cy={cy(n.row)}
              r={HEAD_R}
              fill="none"
              stroke={colorFor(n.col)}
              strokeWidth={2}
            />
          ) : (
            <circle key={n.hash} cx={cx(n.col)} cy={cy(n.row)} r={R} fill={colorFor(n.col)} />
          ),
        )}
      </svg>
      <div className="git-graph-rows">
        {commits.map((c, row) => (
          <div
            className={`git-graph-row${webBase ? " linkable" : ""}`}
            key={c.hash}
            style={{ paddingLeft: rowLeft[row] }}
            onMouseEnter={(e) => showTip(e, c)}
            onMouseLeave={hideTip}
            onClick={webBase ? () => openCommit(c) : undefined}
            role={webBase ? "button" : undefined}
            tabIndex={webBase ? 0 : undefined}
            onKeyDown={webBase ? onActivateKey(() => openCommit(c)) : undefined}
            title={webBase ? "Open commit on GitHub" : undefined}
          >
            <span className="git-commit-subject">{c.subject}</span>
            {c.refs.length > 0 && (
              /* One ref, plus a count. Rendering every ref meant two or three
                 pills sharing 42% of a 260px rail, each ellipsised to about
                 three characters ("m…", "src-…", "inte…"), which identifies
                 nothing and takes the width from the commit subject — the one
                 thing on the row anybody reads. The full list is in the hover
                 card. */
              <span className="git-refs" title={c.refs.join(", ")}>
                <span className={`git-ref-pill${c.refs[0].includes("/") ? " remote" : ""}`}>
                  {c.refs[0]}
                </span>
                {c.refs.length > 1 && <span className="git-ref-more">+{c.refs.length - 1}</span>}
              </span>
            )}
          </div>
        ))}
      </div>
      {/* Portaled to <body>, like IconButton's: rendered in place it would sit
          inside a rail that carries `zoom`, which makes the rail — not the
          viewport — the containing block for `position: fixed`, so the
          viewport coordinates above would land scaled and offset. */}
      {tip && createPortal(
        <div
          role="tooltip"
          className={`commit-tooltip commit-tooltip-${tip.side}`}
          style={{ left: tip.x, top: tip.y }}
        >
          <div className="commit-tooltip-subject">{tip.commit.subject}</div>
          <div className="commit-tooltip-meta">
            <span className="commit-tooltip-author">{tip.commit.author}</span>
            <span>·</span>
            <span>{tip.commit.date}</span>
            <span>·</span>
            <span className="commit-tooltip-hash">{tip.commit.short}</span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
