import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The sidebar's one alignment rule, enforced.
 *
 * Every text edge in the rail is 16px from the panel's left edge, reached as
 * `margin-left + padding-left`. Rows use 6 + 10 (the 6px margin is what insets
 * their rounded fill from the panel); headers that draw no fill use 0 + 16.
 * Chevrons hang in the gutter to the left of that edge, out of flow, so a
 * foldable row starts where a fixed one does.
 *
 * This is a test rather than a comment because it is the exact thing that
 * drifts: the panel had grown four competing edges (16, 22, 28 and a header
 * indented further than the rows it labelled) one plausible-looking rule at a
 * time, and the result read as assembled rather than designed. Nothing here
 * catches a bad *design*; it catches the next rule that quietly disagrees with
 * the rest.
 */

const CSS = readFileSync(resolve("src/styles/global.css"), "utf8");

const TEXT_EDGE = 16;

/** Left inset a rule contributes, from its own margin/padding shorthands. */
function leftInset(selector: string): number {
  const block = new RegExp(
    `^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)^\\}`,
    "m",
  ).exec(CSS);
  if (!block) throw new Error(`no rule for ${selector}`);
  const body = block[1];

  const side = (prop: string): number => {
    // Longhand wins if present, else read the shorthand's left slot.
    const long = new RegExp(`^\\s*${prop}-left:\\s*([^;]+);`, "m").exec(body);
    if (long) return px(long[1]);
    const short = new RegExp(`^\\s*${prop}:\\s*([^;]+);`, "m").exec(body);
    if (!short) return 0;
    const parts = short[1].trim().split(/\s+/);
    // 1 value: all sides. 2: v h. 3: t h b. 4: t r b l.
    if (parts.length === 1) return px(parts[0]);
    if (parts.length === 2 || parts.length === 3) return px(parts[1]);
    return px(parts[3]);
  };
  return side("margin") + side("padding");
}

function px(v: string): number {
  const n = /^(-?[\d.]+)px$/.exec(v.trim());
  return n ? Number(n[1]) : 0;
}

/** Everything in the rail that starts a line of text. */
const RAIL_ROWS = [
  ".sb-sec-header",
  ".sidebar-section-header",
  ".rail-group-head",
  ".workspace-card",
  ".ws-new-row",
  ".agent-row",
  ".queue-row",
  ".queue-divider",
  ".profile-footer",
  ".pr-row",
  ".empty-state",
  ".moat-readout",
  ".friend-subhead",
  ".friend-offline-head",
  ".graph-subtitle",
  ".ws-git-panel",
];

describe("sidebar alignment", () => {
  it.each(RAIL_ROWS)("%s starts on the rail's 16px text edge", (selector) => {
    expect(leftInset(selector)).toBe(TEXT_EDGE);
  });

  /* The two group headers are the same object and must stay one class. An
   * agent group that grows its own header again is the regression that made
   * the panel look assembled the first time. */
  it("has exactly one group-header class", () => {
    expect(CSS).toContain(".rail-group-head {");
    expect(CSS).not.toContain(".ws-group-head {");
    expect(CSS).not.toContain(".agent-group .group-name {");
  });

  /* A stretched, absolutely-positioned chevron centres on its containing
   * block's PADDING box, so any asymmetry in the header's vertical padding
   * lands directly on the glyph: 10-over-8 put it a pixel above the title.
   * This has now been broken twice, both times by a one-line override further
   * down the sheet quietly winning on document order, so the rule is that each
   * of these headers declares its vertical padding once and symmetrically. */
  it.each([".sb-sec-header", ".rail-group-head", ".friend-offline-head"])(
    "%s has symmetric vertical padding, which the chevron centres on",
    (selector) => {
      const blocks = [...CSS.matchAll(
        new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)^\\}`, "gm"),
      )];
      expect(blocks).toHaveLength(1);
      const body = blocks[0][1];
      // No stray longhand reopening the asymmetry the shorthand just closed.
      expect(body).not.toMatch(/^\s*padding-top:/m);
      expect(body).not.toMatch(/^\s*padding-bottom:/m);
      const short = /^\s*padding:\s*([^;]+);/m.exec(body);
      expect(short).not.toBeNull();
      const parts = short![1].trim().split(/\s+/);
      const top = parts[0];
      const bottom = parts.length >= 3 ? parts[2] : parts[0];
      expect(bottom).toBe(top);
    },
  );

  /* Chevrons are out of flow, so they cannot push their label off the edge. */
  it("hangs the group chevron in the gutter", () => {
    const block = /^\.rail-group-chevron\s*\{([\s\S]*?)^\}/m.exec(CSS);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/position:\s*absolute/);
  });

  /* The chevron class must sit on a SPAN wrapping the svg, never on the svg
   * itself. An svg is a replaced element: `top: 0; bottom: 0` cannot stretch
   * it, the browser resolves the over-constraint by dropping `bottom`, and the
   * glyph pins to the top of the header instead of centring — which is exactly
   * how the rail shipped with its chevrons floating a few pixels high. A span
   * stretches, and the rule's flex centring then centres the svg inside it. */
  it.each(["rail-group-chevron", "sb-sec-chevron"])(
    "never puts .%s directly on an svg",
    (cls) => {
      for (const file of ["src/components/Sidebar.tsx", "src/components/CollapsibleSection.tsx"]) {
        const src = readFileSync(resolve(file), "utf8");
        expect(src).not.toMatch(new RegExp(`<svg[^>]*className=.${cls}`));
      }
    },
  );

  /* The rail carries no disclosure triangles until you point at one. Four of
   * them at rest turned a list into a tree to be operated. Both halves are
   * load-bearing: hidden by default, and pinned visible while SHUT, since a
   * collapsed section with no glyph is content that has silently gone missing.
   *
   * Opacity, never `display` or `visibility` — the glyph is absolutely
   * positioned and stretched, and `display: none` on hover-in would make it
   * arrive without the transition the rest of the rail's reveals have. */
  it.each([
    [".sb-sec-chevron", ".sb-sec-header:hover", ".sb-sec.collapsed"],
    [".rail-group-chevron", ".rail-group-head:hover", ".rail-group-head.collapsed"],
  ])("keeps %s out of sight until it is needed", (chevron, hover, shut) => {
    const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hidden = [...CSS.matchAll(
      new RegExp(`^${esc(chevron)}\\s*\\{([\\s\\S]*?)^\\}`, "gm"),
    )].some((m) => /opacity:\s*0\s*;/.test(m[1]));
    expect(hidden).toBe(true);
    expect(CSS).toContain(`${hover} ${chevron},`);
    expect(CSS).toMatch(
      new RegExp(`${esc(shut)} ${esc(chevron)}\\s*\\{[^}]*opacity:\\s*1`),
    );
    expect(CSS).not.toMatch(new RegExp(`${esc(chevron)}\\s*\\{[^}]*display:\\s*none`));
  });
});
