import type { CheckRun } from "./tauri";

/** One word for a PR's checks: failed if any did, running while any are,
 *  passed when everything that ran passed. */
export function overallCheckStatus(checks: CheckRun[]): "success" | "failure" | "running" | "info" {
  if (checks.length === 0) return "info";
  if (checks.some((c) => checkClass(c) === "failure")) return "failure";
  if (checks.some((c) => checkClass(c) === "running")) return "running";
  return "success";
}

function checkClass(c: CheckRun): "success" | "failure" | "running" | "neutral" {
  if (c.conclusion === "success") return "success";
  if (c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "action_required") return "failure";
  if (c.status === "in_progress") return "running";
  return "neutral";
}
