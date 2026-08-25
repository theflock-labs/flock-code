// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The macOS grouped-list boxes in Settings are assembled entirely out of
 * selectors — `.settings-section` is turned into a rounded group by matching on
 * its children's *position* rather than by wrapping them in markup, so that the
 * seven section components (AccountSection, TeamsSection, ProvenanceSection,
 * BudgetSection, GraphSettingsSection, AgentUsageSection,
 * OpencodeUsageSection) did not have to be rewritten.
 *
 * That is cheap to build and easy to break: one extra wrapper div in any of
 * those components, or a stray non-row child, and the box silently loses a
 * corner or grows a separator in the wrong place. jsdom will not compute the
 * cascade for us, but it will answer `matches()`, which is the part that can
 * actually be wrong. So: assert the shipped selectors still exist verbatim in
 * global.css, then check they select what they are meant to on a fixture built
 * to mirror AccountSection's real DOM.
 */

// jsdom's import.meta.url is not a file: URL, so resolve off the project root
// (vitest runs with cwd = apps/flock-desktop) rather than off this module.
const CSS = readFileSync(resolve("src/styles/global.css"), "utf8");

const NOT_A_ROW = ":not(.settings-section-header):not(.settings-hint):not(.settings-error)";
const ROW = `.settings-section > *${NOT_A_ROW}`;
const FIRST_ROW = ".settings-section > .settings-section-header + *, .settings-section > *:first-child:not(.settings-section-header)";
const LAST_ROW = ".settings-section > *:last-child:not(.settings-section-header)";
const SEPARATED = `.settings-section > *${NOT_A_ROW} ~ *${NOT_A_ROW}`;

/** Mirrors AccountSection: header, then a profile block, then a settings row. */
function section(inner: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = `<div class="settings-section">${inner}</div>`;
  return host.firstElementChild as HTMLElement;
}

const kids = (el: HTMLElement) => Array.from(el.children) as HTMLElement[];

describe("settings grouped list", () => {
  it("ships the selectors this test reasons about", () => {
    // Whitespace in the file is not normalised, so compare on a squashed copy.
    const squashed = CSS.replace(/\s+/g, " ");
    for (const sel of [ROW, LAST_ROW, SEPARATED]) {
      expect(squashed).toContain(sel.replace(/\s+/g, " "));
    }
    expect(squashed).toContain(".settings-section > .settings-section-header + *");
  });

  it("treats the header as a label, not as a row of the box", () => {
    const el = section(
      `<div class="settings-section-header">flock ID</div><div class="account-card"></div>`,
    );
    const [header, card] = kids(el);
    expect(header.matches(ROW)).toBe(false);
    expect(card.matches(ROW)).toBe(true);
  });

  it("rounds the first content child and the last one", () => {
    const el = section(
      `<div class="settings-section-header">flock ID</div>` +
        `<div class="account-card"></div>` +
        `<div class="settings-row"></div>`,
    );
    const [header, card, row] = kids(el);
    expect(card.matches(FIRST_ROW)).toBe(true);
    expect(row.matches(FIRST_ROW)).toBe(false);
    expect(row.matches(LAST_ROW)).toBe(true);
    expect(card.matches(LAST_ROW)).toBe(false);
    expect(header.matches(LAST_ROW)).toBe(false);
  });

  it("rounds all four corners when a group holds a single row", () => {
    const el = section(
      `<div class="settings-section-header">Referrals</div><div class="referral-card"></div>`,
    );
    const only = kids(el)[1];
    expect(only.matches(FIRST_ROW)).toBe(true);
    expect(only.matches(LAST_ROW)).toBe(true);
  });

  it("still rounds the top when a section has no header at all", () => {
    const el = section(`<div class="settings-row"></div><div class="settings-row"></div>`);
    expect(kids(el)[0].matches(FIRST_ROW)).toBe(true);
  });

  it("draws a separator between consecutive rows and nowhere else", () => {
    const el = section(
      `<div class="settings-section-header">flock ID</div>` +
        `<div class="account-card"></div>` +
        `<div class="settings-row"></div>`,
    );
    const [, card, row] = kids(el);
    // Never under the header: that would be a line between the label and the box.
    expect(card.matches(SEPARATED)).toBe(false);
    expect(row.matches(SEPARATED)).toBe(true);
  });

  /* Explanatory copy sits outside and below the box in System Settings, so it
   * must not take the fill, the padding, or a separator above it. */
  it("keeps hint and error copy out of the box", () => {
    const el = section(
      `<div class="settings-section-header">flock ID</div>` +
        `<div class="settings-row"></div>` +
        `<div class="settings-hint">Point flock at your Supabase project.</div>` +
        `<div class="settings-error">Nope.</div>`,
    );
    const [, row, hint, error] = kids(el);
    expect(hint.matches(ROW)).toBe(false);
    expect(error.matches(ROW)).toBe(false);
    expect(hint.matches(SEPARATED)).toBe(false);
    expect(error.matches(SEPARATED)).toBe(false);
    expect(row.matches(ROW)).toBe(true);
  });

  /* A hint between two rows must not break the pair apart: the row after it is
   * still a row of the same box and still needs its separator. */
  it("does not let an interleaved hint swallow the next row's separator", () => {
    const el = section(
      `<div class="settings-section-header">Voice</div>` +
        `<div class="settings-row"></div>` +
        `<div class="settings-hint">Runs on-device.</div>` +
        `<div class="settings-row"></div>`,
    );
    const [, , , second] = kids(el);
    expect(second.matches(SEPARATED)).toBe(true);
  });
});
