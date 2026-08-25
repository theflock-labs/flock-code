// Persisted defaults for git-worktree-per-agent behavior. Frontend-only
// preferences (no backend involved beyond the create/remove worktree calls
// themselves already taking these as parameters).

import type { BranchMode } from "../types";

const MODE_KEY = "flock:branch-default-mode";
const LEGACY_DEFAULT_KEY = "flock:worktrees-default-enabled";
const DELETE_BRANCH_KEY = "flock:worktrees-delete-branch";
const BASE_DIR_KEY = "flock:worktrees-base-dir";
const FETCH_KEY = "flock:branch-fetch-base";
const CARRY_KEY = "flock:worktrees-carry-patterns";
const LAST_BASE_KEY = "flock:branch-last-base";

const MODES: BranchMode[] = ["new", "existing", "current"];

/** Branch mode the new-workspace dialog opens on.
 *
 * Defaults to "new" — a workspace is a branch. Users who had explicitly turned
 * the old "use worktrees by default" toggle OFF are honored once and migrated
 * to "current", so the change of default doesn't override a stated preference. */
export function getDefaultBranchMode(): BranchMode {
  const v = localStorage.getItem(MODE_KEY);
  if (v && (MODES as string[]).includes(v)) return v as BranchMode;
  const legacy = localStorage.getItem(LEGACY_DEFAULT_KEY);
  return legacy === "false" ? "current" : "new";
}

export function setDefaultBranchMode(mode: BranchMode) {
  localStorage.setItem(MODE_KEY, mode);
}

/** Whether removing a worktree also deletes its local branch. Defaults on — matches prior hardcoded behavior. */
export function getDeleteBranchWithWorktree(): boolean {
  const v = localStorage.getItem(DELETE_BRANCH_KEY);
  return v === null ? true : v === "true";
}

export function setDeleteBranchWithWorktree(enabled: boolean) {
  localStorage.setItem(DELETE_BRANCH_KEY, String(enabled));
}

/** Parent directory new worktrees are created under. Empty/unset = backend default (`~/.flock/worktrees/`). */
export function getWorktreesBaseDir(): string {
  return localStorage.getItem(BASE_DIR_KEY) ?? "";
}

export function setWorktreesBaseDir(dir: string) {
  localStorage.setItem(BASE_DIR_KEY, dir);
}

/** Whether "Fetch base first" starts on. Defaults on: branching from a stale
 * `origin/main` is the failure this whole flow exists to prevent. */
export function getFetchBaseDefault(): boolean {
  const v = localStorage.getItem(FETCH_KEY);
  return v === null ? true : v === "true";
}

export function setFetchBaseDefault(enabled: boolean) {
  localStorage.setItem(FETCH_KEY, String(enabled));
}

/** A worktree holds only tracked files, so these gitignored ones are copied in
 * from the main checkout. Kept to small local config on purpose — the backend
 * never copies directories, so a `node_modules` entry here does nothing. */
export const DEFAULT_CARRY_PATTERNS = [".env*", ".envrc", ".tool-versions"];

export function getCarryPatterns(): string[] {
  const raw = localStorage.getItem(CARRY_KEY);
  if (raw === null) return DEFAULT_CARRY_PATTERNS;
  return parseCarryPatterns(raw);
}

export function setCarryPatterns(text: string) {
  localStorage.setItem(CARRY_KEY, text);
}

/** The raw stored text, for editing. Read separately from `getCarryPatterns`
 * because an empty list is a real choice that can't round-trip through it. */
export function getCarryPatternsText(): string {
  return localStorage.getItem(CARRY_KEY) ?? DEFAULT_CARRY_PATTERNS.join(", ");
}

/** Split the settings field on commas and newlines. */
export function parseCarryPatterns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Last base ref used in a given repo, so the second workspace there doesn't
 * make you pick again. Stored as one map rather than a key per repo. */
function lastBaseMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_BASE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getLastBaseRef(repoPath: string): string | undefined {
  return lastBaseMap()[repoPath];
}

export function setLastBaseRef(repoPath: string, baseRef: string) {
  if (!repoPath || !baseRef) return;
  const map = lastBaseMap();
  map[repoPath] = baseRef;
  // Cap the map so it can't grow without bound across a long-lived install.
  const keys = Object.keys(map);
  if (keys.length > 50) delete map[keys[0]];
  localStorage.setItem(LAST_BASE_KEY, JSON.stringify(map));
}
