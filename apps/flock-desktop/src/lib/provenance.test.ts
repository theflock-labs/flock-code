import { describe, expect, it } from "vitest";
import {
  costUsd,
  dayRangeToEpoch,
  dayStart,
  defaultRange,
  durationLabel,
  isolationLabel,
  isValidRange,
  suggestFilename,
  toDayString,
} from "./provenance";

describe("provenance date range", () => {
  it("names the local day, not the UTC one", () => {
    // 23:30 local on the 9th. toISOString() would say the 10th anywhere east of
    // Greenwich and the 9th anywhere west, so the picker would open on a window
    // that excludes the session the user just ran.
    const d = new Date(2026, 7, 9, 23, 30, 0);
    expect(toDayString(d)).toBe("2026-08-09");
    // Single digits are padded — an unpadded "2026-8-9" does not round-trip
    // through <input type="date">, which silently shows an empty field.
    expect(toDayString(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("includes the whole of the end day", () => {
    const { from, to } = dayRangeToEpoch("2026-08-01", "2026-08-09");
    expect(from).toBe(dayStart("2026-08-01"));
    // Exclusive end at the following midnight. Using the end day's own midnight
    // is the classic bug: the report claims to cover the 9th and contains
    // nothing from it.
    expect(to).toBe(dayStart("2026-08-10"));
    expect(to - from).toBe(9 * 86_400);
  });

  it("covers exactly one day when both ends are the same", () => {
    const { from, to } = dayRangeToEpoch("2026-08-09", "2026-08-09");
    expect(to - from).toBe(86_400);
    expect(isValidRange("2026-08-09", "2026-08-09")).toBe(true);
  });

  it("spans a daylight-saving boundary without losing or gaining a day", () => {
    // Whether the local clock jumped inside the window or not, the boundaries
    // are local midnights — so the window is a whole number of days even when
    // one of them was 23 or 25 hours long.
    const { from, to } = dayRangeToEpoch("2026-03-28", "2026-03-30");
    expect(from).toBe(dayStart("2026-03-28"));
    expect(to).toBe(dayStart("2026-03-31"));
  });

  it("refuses a backwards or unparseable range rather than swapping it", () => {
    // Quietly covering a different period than the one asked for is worse than
    // not running.
    expect(isValidRange("2026-08-09", "2026-08-01")).toBe(false);
    expect(isValidRange("", "2026-08-09")).toBe(false);
    expect(isValidRange("2026-08-09", "not-a-day")).toBe(false);
    expect(Number.isNaN(dayStart(""))).toBe(true);
  });

  it("opens on the last thirty days, inclusive of today", () => {
    const { fromDay, toDay } = defaultRange(new Date(2026, 7, 9));
    expect(toDay).toBe("2026-08-09");
    expect(fromDay).toBe("2026-07-11");
    expect(dayRangeToEpoch(fromDay, toDay).to - dayRangeToEpoch(fromDay, toDay).from)
      .toBe(30 * 86_400);
  });

  it("crosses a month and a year boundary", () => {
    expect(defaultRange(new Date(2026, 0, 5)).fromDay).toBe("2025-12-07");
  });
});

describe("provenance display", () => {
  it("puts the range in the filename", () => {
    expect(suggestFilename("2026-07-11", "2026-08-09", "csv"))
      .toBe("flock-provenance-2026-07-11_2026-08-09.csv");
    expect(suggestFilename("2026-07-11", "2026-08-09", "json"))
      .toBe("flock-provenance-2026-07-11_2026-08-09.json");
  });

  it("formats durations the way the CSV column does", () => {
    expect(durationLabel(0, 9)).toBe("9s");
    expect(durationLabel(0, 63)).toBe("1m 03s");
    expect(durationLabel(0, 3723)).toBe("1h 02m");
    expect(durationLabel(100, null)).toBe("");
    // A clock that moved backwards must not print a negative duration.
    expect(durationLabel(100, 50)).toBe("0s");
  });

  it("reads cost back out of micros", () => {
    expect(costUsd(1_234_567)).toBeCloseTo(1.234567, 9);
    expect(costUsd(0)).toBe(0);
  });

  it("names the strongest isolation the pane had", () => {
    // A secure pane is also in a worktree; the jail is the stronger claim and
    // the one a reviewer is asking about.
    expect(isolationLabel({ secure: true, worktree: true })).toBe("container");
    expect(isolationLabel({ secure: false, worktree: true })).toBe("worktree");
    expect(isolationLabel({ secure: false, worktree: false })).toBe("checkout");
  });
});
