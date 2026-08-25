import type { GitCommit } from "./tauri";

export interface GraphNode {
  hash: string;
  row: number;
  col: number;
  commit: GitCommit;
}

export interface GraphLink {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  /** The lane the edge travels straight down through between its two nodes. */
  lane: number;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
  laneCount: number;
}

/**
 * Computes a git commit graph ("railroad") layout from a list of commits in
 * `git log` order (newest first). Each commit is assigned a row (its index)
 * and a column (its lane), and every parent relationship becomes a link that
 * travels down a lane, bending at its endpoints — the same model VS Code /
 * GitLens use.
 *
 * Lanes are tracked as an array where `lanes[k]` is the hash the k-th lane is
 * currently routing toward (the next commit expected in that lane). Walking
 * the commits top-to-bottom:
 *   - the commit claims the lane already pointing at it (or a fresh one if it's
 *     a branch tip),
 *   - other lanes pointing at the same hash are children merging in — they end,
 *   - the first parent continues in the commit's lane; extra parents (a merge)
 *     open new lanes.
 */
export function computeGraph(commits: GitCommit[]): Graph {
  const lanes: (string | null)[] = [];
  const nodes: GraphNode[] = [];
  const raw: { child: string; parent: string; lane: number }[] = [];

  commits.forEach((c, row) => {
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      col = lanes.length;
      lanes.push(c.hash);
    }
    nodes.push({ hash: c.hash, row, col, commit: c });

    // Children that had reserved their own lane pointing at this commit merge
    // into this node; free those lanes.
    for (let k = 0; k < lanes.length; k++) {
      if (k !== col && lanes[k] === c.hash) lanes[k] = null;
    }

    if (c.parents.length === 0) {
      lanes[col] = null;
    } else {
      lanes[col] = c.parents[0];
      raw.push({ child: c.hash, parent: c.parents[0], lane: col });
      for (let pi = 1; pi < c.parents.length; pi++) {
        let free = lanes.indexOf(null);
        if (free === -1) {
          free = lanes.length;
          lanes.push(c.parents[pi]);
        } else {
          lanes[free] = c.parents[pi];
        }
        raw.push({ child: c.hash, parent: c.parents[pi], lane: free });
      }
    }

    // Trim trailing empty lanes so the graph doesn't grow wider than needed.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  });

  const byHash = new Map(nodes.map((n) => [n.hash, n]));
  const offWindowRow = commits.length; // parent scrolled past the window
  const links: GraphLink[] = raw.map((l) => {
    const cn = byHash.get(l.child)!;
    const pn = byHash.get(l.parent);
    return {
      fromRow: cn.row,
      fromCol: cn.col,
      toRow: pn ? pn.row : offWindowRow,
      toCol: pn ? pn.col : l.lane,
      lane: l.lane,
    };
  });

  let laneCount = 0;
  for (const n of nodes) laneCount = Math.max(laneCount, n.col + 1);
  for (const l of links) laneCount = Math.max(laneCount, l.lane + 1, l.toCol + 1);

  return { nodes, links, laneCount };
}
