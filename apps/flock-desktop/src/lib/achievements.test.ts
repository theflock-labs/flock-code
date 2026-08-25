import { describe, it, expect } from "vitest";
import { resolveOne, resolveAll, ACHIEVEMENTS } from "./achievements";

const base = { prompts: 0, agents: 0, workspaces: 0, tokens: 0, memberSince: null as string | null };
const def = (id: string) => ACHIEVEMENTS.find((a) => a.id === id)!;

describe("achievements", () => {
  it("First Flight ranks up at the tier thresholds", () => {
    const ff = def("first-flight");
    expect(resolveOne(ff, { ...base, prompts: 0 }).earned).toBe(false);
    expect(resolveOne(ff, { ...base, prompts: 1 }).rank).toBe(1);
    expect(resolveOne(ff, { ...base, prompts: 999 }).rank).toBe(2);
    const migration = resolveOne(ff, { ...base, prompts: 1000 });
    expect(migration.rank).toBe(3);
    expect(migration.rankName).toBe("Migration");
    expect(migration.maxed).toBe(false);
    const maxed = resolveOne(ff, { ...base, prompts: 12000 });
    expect(maxed.rank).toBe(4);
    expect(maxed.maxed).toBe(true);
    expect(maxed.progress).toBe(1);
  });

  it("locked badge reports progress toward the first tier", () => {
    const r = resolveOne(def("first-flight"), { ...base, prompts: 250 });
    // 250 prompts → rank 2 (>=100), chasing 1000
    expect(r.rank).toBe(2);
    expect(r.need).toBe(1000);
    expect(r.have).toBe(250);
    expect(r.progress).toBeCloseTo(0.25);
  });

  it("Founder is a charter member before the cutoff, not after", () => {
    expect(resolveOne(def("founder"), { ...base, memberSince: "2026-07-01T00:00:00Z" }).earned).toBe(true);
    expect(resolveOne(def("founder"), { ...base, memberSince: "2027-01-01T00:00:00Z" }).earned).toBe(false);
    expect(resolveOne(def("founder"), { ...base, memberSince: null }).earned).toBe(false);
  });

  it("graph seals appear only when includeSelf is true", () => {
    const shared = resolveAll(base, false);
    const withSelf = resolveAll({ ...base, decisions: 5 }, true);
    expect(shared.some((r) => r.def.scope === "self")).toBe(false);
    expect(withSelf.some((r) => r.def.id === "cartographer")).toBe(true);
  });
});
