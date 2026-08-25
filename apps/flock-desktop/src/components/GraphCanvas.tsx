import { useEffect, useMemo, useRef } from "react";
import ForceGraph from "force-graph";
import { getEffectiveTheme, onThemeChange } from "../lib/theme";
import type { GraphKgNode, GraphEdge } from "../lib/tauri";

/** One node in the graph. force-graph augments these with live x/y/vx/… as it
 *  simulates, so we keep our own props minimal. */
interface GNode { id: string; kind: string; label: string; x?: number; y?: number }
interface GLink { source: string | GNode; target: string | GNode; edge_type: string }

interface Props {
  nodes: GraphKgNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Clear the current selection (click the void, or the selected node again). */
  onDeselect: () => void;
  colorFor: (kind: string) => string;
  /** Dim nodes not of this kind when set (from the kind filter chips). */
  activeKind: string | null;
  /** Brighten nodes whose label matches (from the search box). */
  query: string;
}

// Each node kind maps to a token from the app's "dawn family" (the only colours
// the design language lets carry hue) — resolved live so the graph tracks the
// active theme instead of baking hex. See the palette block in global.css.
const KIND_VAR: Record<string, string> = {
  Decision: "--blue", Attempt: "--red", File: "--blue-dim", Note: "--yellow",
  Interface: "--ok",
  // Provenance hubs — the author/codebase every node hangs off of.
  Person: "--violet", Repo: "--orange",
};
const NODE_R = 4;       // base node radius in graph units (scaled by nodeVal)
const MIN_SCREEN_R = 5; // never let a node shrink below this many screen px —
                        // keeps every node clickable even when the whole graph
                        // is fit to view (the "hard to click" fix).
const TAU = Math.PI * 2;

type RGB = [number, number, number];
function parseColor(s: string): RGB {
  s = s.trim();
  if (s[0] === "#") {
    const h = s.slice(1);
    const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
  }
  const m = s.match(/(\d+(?:\.\d+)?)/g);
  return m ? [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0] : [143, 166, 198];
}
function rgb(c: RGB): string { return `rgb(${c[0]},${c[1]},${c[2]})`; }
function rgba(c: RGB, a: number): string { return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }
function mix(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}
/** Deterministic 0..1 from an id — a stable per-node brightness grade. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return (h >>> 8) / 0xffffff;
}

// ── Backdrop: a fixed starfield + faint dawn-family nebula washes ──
// Stars live in graph coordinates (they pan/zoom with the world) but are drawn
// at a near-constant screen size so they read as a distant background plane.
interface Star { x: number; y: number; r: number; phase: number; tint: number }
function makeStars(count: number, radius: number): Star[] {
  // Seeded LCG so the sky is identical every open — no Math.random flicker.
  let seed = 1234567;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    const a = rand() * TAU;
    const d = Math.sqrt(rand()) * radius + 40;
    stars.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: 0.4 + rand() * 1.1, phase: rand() * TAU, tint: rand() });
  }
  return stars;
}
// Large soft colour clouds behind the graph, keyed to the dawn-family tokens
// so the "universe" is unmistakably in the app's own palette.
const NEBULAE = [
  { x: -420, y: -260, r: 780, token: "--blue" },
  { x: 470, y: 190, r: 700, token: "--violet" },
  { x: -60, y: 470, r: 620, token: "--red" },
];

/**
 * 2D canvas view of the knowledge graph (force-graph). Flat on purpose: the
 * whole graph reads at once — pan, scroll to zoom, fit-to-view — which the 3D
 * version couldn't give (nodes occluded each other and you had to rotate to
 * see anything). Node colours come from the app's dawn-family theme tokens,
 * graded per-node; the selected node's connections light up peach with fast
 * particles.
 *
 * The field is alive, quietly: nodes breathe on individual phases, the web
 * shimmers, slow signal particles drift along every link like synapses firing,
 * and behind it a seeded starfield twinkles through faint dawn-family nebula
 * washes (dark ground; the light theme keeps only the washes). All motion is
 * slow, low-amplitude, and deterministic per id — a creature at rest, not a
 * screensaver.
 *
 * Zoom is clamped to the graph's own extent (recomputed as the layout settles
 * or the panel resizes): you can pull back to half the fit-to-view level, no
 * further — never a speck lost in the void — and push in far enough to read a
 * single node, never into empty pixels.
 *
 * Performance: canvas 2D with no post-processing — far lighter than the old
 * WebGL + bloom version, even with autoPauseRedraw off to drive the ambient
 * animation. React never re-renders; prop changes are pushed into the running
 * instance, and the draw accessors read live refs so styling updates on the
 * next frame.
 */
export default function GraphCanvas({ nodes, edges, selectedId, onSelect, onDeselect, colorFor, activeKind, query }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph<GNode, GLink> | null>(null);
  const nodeCache = useRef<Map<string, GNode>>(new Map());
  const didFit = useRef(false);
  const isLight = useRef(getEffectiveTheme() === "light");
  const hoverRef = useRef<string | null>(null);
  const countRef = useRef(0);
  const starsRef = useRef<Star[]>([]);
  if (starsRef.current.length === 0) starsRef.current = makeStars(380, 1700);
  // Lifts the zoom clamps while a new dataset re-simulates (a bigger layout
  // may need a smaller fit scale than the old floor allowed); the engine-stop
  // handler re-derives tight limits from the settled extent.
  const resetZoomLimitsRef = useRef<() => void>(() => {});

  const selRef = useRef(selectedId);
  const kindRef = useRef(activeKind);
  const qRef = useRef(query.trim().toLowerCase());
  const colorRef = useRef(colorFor);
  const onSelectRef = useRef(onSelect);
  const onDeselectRef = useRef(onDeselect);
  selRef.current = selectedId;
  kindRef.current = activeKind;
  qRef.current = query.trim().toLowerCase();
  colorRef.current = colorFor;
  onSelectRef.current = onSelect;
  onDeselectRef.current = onDeselect;

  const neighbors = useMemo(() => {
    const s = new Set<string>();
    if (selectedId) for (const e of edges) {
      if (e.from === selectedId) s.add(e.to);
      if (e.to === selectedId) s.add(e.from);
    }
    return s;
  }, [edges, selectedId]);
  const neighborRef = useRef(neighbors);
  neighborRef.current = neighbors;

  // Resolve theme CSS vars → concrete colours. Cached; cleared on theme flip.
  const varCache = useRef<Map<string, RGB>>(new Map());
  const resolveVar = (name: string): RGB => {
    const hit = varCache.current.get(name);
    if (hit) return hit;
    const el = mountRef.current ?? document.documentElement;
    const v = getComputedStyle(el).getPropertyValue(name).trim() || "#8fa6c6";
    const c = parseColor(v);
    varCache.current.set(name, c);
    return c;
  };

  const gradedRgb = (n: GNode): RGB => {
    const base = resolveVar(KIND_VAR[n.kind] ?? "--text-mid");
    const h = hash01(n.id);
    return isLight.current ? mix(base, [10, 12, 24], h * 0.16) : mix(base, [255, 255, 255], h * 0.28);
  };
  const isDimmed = (n: GNode): boolean => {
    const sel = selRef.current, q = qRef.current, ak = kindRef.current;
    if (sel) return n.id !== sel && !neighborRef.current.has(n.id);
    if (q) return !n.label.toLowerCase().includes(q);
    if (ak) return n.kind !== ak;
    return false;
  };
  const nodeVal = (n: GNode): number => (n.id === selRef.current ? 6 : neighborRef.current.has(n.id) ? 2.5 : 1);
  // Radius in graph units, floored to a minimum on-screen size (MIN_SCREEN_R /
  // scale) so nodes stay a comfortable click target at any zoom.
  const radiusOf = (n: GNode, scale: number): number => Math.max(Math.sqrt(nodeVal(n)) * NODE_R, MIN_SCREEN_R / scale);

  const linkEnds = (l: GLink): [string, string] => [
    typeof l.source === "object" ? l.source.id : l.source,
    typeof l.target === "object" ? l.target.id : l.target,
  ];
  const isHot = (l: GLink): boolean => {
    const sel = selRef.current;
    if (!sel) return false;
    const [s, t] = linkEnds(l);
    return s === sel || t === sel;
  };

  // ── Backdrop: nebula washes + twinkling stars, painted before the graph.
  // The ctx arrives already transformed to graph coordinates.
  const drawBackdrop = (ctx: CanvasRenderingContext2D, scale: number) => {
    // The light theme stays clean paper: low-alpha gradients band visibly on
    // white, so no washes and no stars — life comes from the graph itself.
    if (isLight.current) return;
    const t = performance.now() / 1000;
    for (let i = 0; i < NEBULAE.length; i++) {
      const nb = NEBULAE[i];
      const c = resolveVar(nb.token);
      // Each cloud breathes on its own slow phase — minutes-scale, not seconds.
      const breathe = 0.7 + 0.3 * Math.sin(t * 0.09 + i * 2.1);
      const g = ctx.createRadialGradient(nb.x, nb.y, 0, nb.x, nb.y, nb.r);
      g.addColorStop(0, rgba(c, 0.075 * breathe));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(nb.x, nb.y, nb.r, 0, TAU);
      ctx.fill();
    }
    for (const s of starsRef.current) {
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (0.5 + s.tint * 0.9) + s.phase));
      // Most stars are near-white; a scattering carry a faint dawn hue.
      const c: RGB = s.tint < 0.78 ? [222, 230, 246]
        : mix(resolveVar(s.tint < 0.89 ? "--blue" : s.tint < 0.96 ? "--violet" : "--red"), [255, 255, 255], 0.45);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r / Math.max(1, Math.sqrt(scale)), 0, TAU);
      ctx.fillStyle = rgba(c, 0.16 + 0.3 * tw);
      ctx.fill();
    }
  };

  // ── Custom node draw: graded dot + thin ring, label when useful ──
  const drawNode = (n: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
    if (n.x === undefined || n.y === undefined) return;
    const dim = isDimmed(n);
    const c = gradedRgb(n);
    const sel = n.id === selRef.current;
    const near = neighborRef.current.has(n.id);
    // Every node breathes on its own phase — a slow ±5% swell of the core and
    // halo. Low amplitude on purpose: alive at a glance, still when studied.
    const breath = 1 + 0.05 * Math.sin(performance.now() / 1000 * 1.3 + hash01(n.id) * TAU);
    const r = radiusOf(n, scale) * (dim ? 1 : breath);

    // Restrained glow on the dark ground: a whisper of halo on every live
    // node, a clear one on the focus + its neighbours. Never on light.
    if (!isLight.current && !dim) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * (sel || near ? 2.6 : 2.1), 0, TAU);
      ctx.fillStyle = rgba(c, (sel || near ? 0.11 : 0.045) * breath);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, TAU);
    ctx.fillStyle = dim ? (isLight.current ? "rgba(34,36,54,0.12)" : "rgba(150,164,196,0.14)") : rgb(c);
    ctx.fill();
    // Thin ring for a crisp edge against the ground (the img-26 look).
    if (!dim) {
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = isLight.current ? "rgba(11,27,51,0.35)" : "rgba(255,255,255,0.28)";
      ctx.stroke();
    }
    if (sel) {
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = rgb(resolveVar("--orange"));
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 3 / scale, 0, TAU);
      ctx.stroke();
    }

    // Label: always for focus/neighbours/hover; otherwise only for small graphs
    // or once zoomed in, so the overview stays uncluttered.
    const show = !dim && (sel || near || hoverRef.current === n.id || countRef.current <= 28 || scale > 1.6);
    if (show) {
      const fs = 11 / scale;
      ctx.font = `${fs}px ${MONO}`;
      ctx.textBaseline = "middle";
      const label = n.label.length > 28 ? n.label.slice(0, 27) + "…" : n.label;
      ctx.fillStyle = isLight.current ? "rgba(40,54,76,0.9)" : "rgba(200,214,236,0.9)";
      ctx.fillText(label, n.x + r + 3 / scale, n.y);
    }
  };

  const paintPointerArea = (n: GNode, color: string, ctx: CanvasRenderingContext2D, scale: number) => {
    if (n.x === undefined || n.y === undefined) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    // Hit area = visible radius + a constant screen-space pad, so the target is
    // always a bit bigger than the dot no matter the zoom.
    ctx.arc(n.x, n.y, radiusOf(n, scale) + 6 / scale, 0, TAU);
    ctx.fill();
  };

  /** True while a selection / search / kind filter has the field dimmed. */
  const isFaded = (): boolean => !!selRef.current || !!qRef.current || !!kindRef.current;

  const linkColorOf = (l: GLink): string => {
    if (isHot(l)) return rgb(resolveVar("--orange"));
    if (isFaded()) return rgba(resolveVar("--blue"), 0.08);
    // The web shimmers: each strand's alpha sways on its own phase.
    const [s, t] = linkEnds(l);
    const a = 0.26 + 0.09 * Math.sin(performance.now() / 1000 * 0.8 + hash01(s + t) * TAU);
    return rgba(resolveVar("--blue"), a);
  };

  // ── Create the graph once ──
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    // Clamp zoom to the graph's own extent so neither direction runs away:
    // out stops at half the fit-to-view level (whole creature + breathing
    // room), in stops once a single node fills a good part of the panel.
    const applyZoomLimits = () => {
      const rect = el.getBoundingClientRect();
      const ns = (graph.graphData().nodes as GNode[]).filter((n) => n.x !== undefined && n.y !== undefined);
      if (!ns.length || rect.width < 10 || rect.height < 10) return;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const n of ns) {
        if (n.x! < x0) x0 = n.x!;
        if (n.x! > x1) x1 = n.x!;
        if (n.y! < y0) y0 = n.y!;
        if (n.y! > y1) y1 = n.y!;
      }
      const kFit = Math.min(rect.width / (x1 - x0 + 160), rect.height / (y1 - y0 + 160));
      graph.minZoom(kFit * 0.5).maxZoom(Math.max(4, Math.min(kFit * 10, 20)));
    };

    const graph = new ForceGraph<GNode, GLink>(el)
      .backgroundColor(isLight.current ? "#ffffff" : "#000000")
      .autoPauseRedraw(false) // keep painting after cooldown — the ambient breathing/twinkle needs frames
      .onRenderFramePre(drawBackdrop)
      .nodeRelSize(NODE_R)
      .nodeVal(nodeVal)
      .nodeCanvasObject(drawNode)
      .nodePointerAreaPaint(paintPointerArea)
      .linkColor(linkColorOf)
      .linkWidth((l) => (isHot(l) ? 1.6 : 0.6))
      // Slow faint signals drift along every strand while the field is calm;
      // the selected node's links fire fast peach pulses instead.
      .linkDirectionalParticles((l) => (isHot(l) ? 3 : isFaded() ? 0 : 1))
      .linkDirectionalParticleWidth((l) => (isHot(l) ? 2 : 1.2))
      .linkDirectionalParticleSpeed((l) => {
        if (isHot(l)) return 0.006;
        const [s, t] = linkEnds(l);
        return 0.0012 + hash01(s + t) * 0.0012; // desynced, unhurried
      })
      .linkDirectionalParticleColor((l) =>
        isHot(l) ? rgb(resolveVar("--orange")) : rgba(resolveVar("--blue"), isLight.current ? 0.4 : 0.55))
      // Click the selected node again to deselect; a different node selects it.
      .onNodeClick((n) => (n.id === selRef.current ? onDeselectRef.current() : onSelectRef.current(n.id)))
      .onNodeHover((n) => {
        hoverRef.current = n ? n.id : null;
        el.classList.toggle("over-node", !!n);
      })
      // Click the void: deselect if something's selected, otherwise fit the graph.
      .onBackgroundClick(() => (selRef.current ? onDeselectRef.current() : graph.zoomToFit(400, 50)))
      .cooldownTicks(200)
      .onEngineStop(() => {
        applyZoomLimits();
        if (!didFit.current) { graph.zoomToFit(400, 50); didFit.current = true; }
      });

    // More repulsion + longer links than the defaults so nodes spread out and
    // don't pile on top of each other — easier to see and to click between.
    const charge = graph.d3Force("charge") as unknown as { strength?: (s: number) => void } | undefined;
    if (charge?.strength) charge.strength(-260);
    const link = graph.d3Force("link") as unknown as { distance?: (d: number) => void } | undefined;
    if (link?.distance) link.distance(48);

    graphRef.current = graph;

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { graph.width(r.width).height(r.height); applyZoomLimits(); }
    });
    ro.observe(el);
    resetZoomLimitsRef.current = () => graph.minZoom(0.01).maxZoom(1000);

    const offTheme = onThemeChange(() => {
      varCache.current.clear();
      isLight.current = getEffectiveTheme() === "light";
      graph.backgroundColor(isLight.current ? "#ffffff" : "#000000");
      graph.nodeCanvasObject(drawNode).linkColor(linkColorOf); // nudge a redraw
    });

    return () => {
      ro.disconnect();
      offTheme();
      graph._destructor();
      graphRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Push data into the running graph (preserving positions by node id) ──
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const prev = nodeCache.current;
    const next = new Map<string, GNode>();
    const gnodes = nodes.map((n) => {
      const existing = prev.get(n.id);
      if (existing) { existing.kind = n.kind; existing.label = n.label; next.set(n.id, existing); return existing; }
      const fresh: GNode = { id: n.id, kind: n.kind, label: n.label };
      next.set(n.id, fresh);
      return fresh;
    });
    nodeCache.current = next;
    countRef.current = gnodes.length;
    const glinks: GLink[] = edges
      .filter((e) => next.has(e.from) && next.has(e.to))
      .map((e) => ({ source: e.from, target: e.to, edge_type: e.edge_type }));
    didFit.current = false; // refit once the new layout settles
    resetZoomLimitsRef.current();
    graph.graphData({ nodes: gnodes, links: glinks });
  }, [nodes, edges]);

  // ── Nudge a restyle when selection / filter / search changes ──
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graph
      .linkColor(linkColorOf)
      .linkWidth((l) => (isHot(l) ? 1.6 : 0.6))
      .linkDirectionalParticles((l) => (isHot(l) ? 3 : isFaded() ? 0 : 1))
      .nodeCanvasObject(drawNode);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, activeKind, query, neighbors]);

  return (
    <div className="gx-canvas-wrap">
      <div className="gx-webgl" ref={mountRef} />
      <div className="gx-canvas-hint">drag to pan · scroll to zoom · click a node · click empty space to deselect / fit</div>
    </div>
  );
}

const MONO = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
