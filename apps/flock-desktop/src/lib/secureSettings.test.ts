// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getSecureByDefault, setSecureByDefault } from "./secureSettings";

/**
 * The preference is one boolean, but the thing it must never become is a way
 * to weaken a machine's security posture from a settings panel. These pin the
 * two halves of that: unset means on, and only the literal string written by
 * the setter reads as off.
 */

describe("secure-by-default", () => {
  // Node 22 puts its own half-configured `localStorage` on globalThis, which
  // shadows jsdom's and has no `clear`. Same substitution budgets.test.ts makes,
  // for the same reason.
  beforeAll(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
      },
    });
  });

  beforeEach(() => localStorage.clear());

  it("is on when nothing has been chosen", () => {
    expect(getSecureByDefault()).toBe(true);
  });

  it("round-trips both ways", () => {
    setSecureByDefault(false);
    expect(getSecureByDefault()).toBe(false);
    setSecureByDefault(true);
    expect(getSecureByDefault()).toBe(true);
  });

  /* A junk value has to fail SAFE, which for this flag means ON. The usual
   * `=== "true"` idiom would read garbage as "run agents on the host", so this
   * one reads the negative instead. */
  it("reads anything but a literal off as on", () => {
    for (const junk of ["yes please", "", "TRUE", "0", "False"]) {
      localStorage.setItem("flock:secure-by-default", junk);
      expect(getSecureByDefault()).toBe(true);
    }
  });
});
