import type { Workspace } from "../types";

/**
 * Grouping the workspace switcher by project.
 *
 * The problem: open three or four repos and the rail becomes a flat list of
 * names with nothing saying which of them belong together — and because a
 * workspace is named after its repo, two workspaces on the same repo are two
 * rows reading exactly alike.
 *
 * WHY THIS IS DERIVED FROM THE PATHS AND NOT SOMETHING YOU CONFIGURE.
 * The grouping already exists on disk. Related repos get checked out next to
 * each other under one folder (`~/git/flock-meta/flock-code` and
 * `~/git/flock-meta/flock-website`), while standalone ones sit directly in
 * whatever directory you keep code in. That folder IS the project, and asking
 * someone to re-declare it in the app is asking them to maintain a second copy
 * of a fact the filesystem already holds.
 *
 * THE RULE: a project is the repo's parent folder, unless that folder is the
 * place you keep all your code. Grouping on the parent *alone* produces a junk
 * drawer — every repo sitting directly in `~/git` lands in a group called
 * "git", which is the flat list again with a useless header over it — so a
 * parent that is a recognised code root, your home folder, or a filesystem
 * root yields no project and the workspace stays at the top level.
 *
 *   ~/git/flock-meta/flock-code      ->  project "flock-meta"
 *   ~/git/flock-meta/flock-website   ->  project "flock-meta"
 *   ~/git/trader-dashboard           ->  "git" is a code root, so no project
 *   ~/myrepo                         ->  home folder, so no project
 *
 * A NAME LIST, AFTER TRYING TO AVOID ONE. The first version of this computed
 * the code root structurally, as the deepest folder every open workspace
 * shared, and took the segment below it. That reads better in a docstring and
 * is wrong in use, for two reasons worth keeping written down:
 *
 *   * It is unstable. The root moves as workspaces are opened and closed, so
 *     the same repo drifts in and out of a group depending on what else
 *     happens to be open — the grouping changes meaning without the folders
 *     changing at all.
 *   * It vanishes in the exact case it was built for. With only the two flock
 *     repos open, the deepest shared folder IS `flock-meta`, both repos are
 *     direct children of it, and the rule concluded there was nothing to
 *     group. The feature was invisible until an unrelated third repo was
 *     opened.
 *
 * A short list of conventional code-root names is a smaller lie: it is stable,
 * it is legible, and when it is wrong it is wrong in a way you can see and
 * predict.
 */

/** Folders people keep all their repos in. A repo directly inside one of these
 *  has no project — its neighbours are unrelated. Compared case-insensitively. */
const CODE_ROOTS = new Set([
  "git",
  "github",
  "gitlab",
  "code",
  "src",
  "source",
  "sources",
  "dev",
  "develop",
  "developer",
  "project",
  "projects",
  "repo",
  "repos",
  "repositories",
  "work",
  "workspace",
  "workspaces",
  "sites",
  "documents",
  "desktop",
  "downloads",
]);

export interface ProjectGroup {
  /** `null` is the ungrouped bucket: repos with no project folder above them. */
  project: string | null;
  /** `index` is the position in the original array — the drag-reorder handlers
   *  address workspaces by it, so it must survive the regrouping. */
  items: { ws: Workspace; index: number }[];
}

/** Split a path into non-empty segments, tolerating trailing slashes and the
 *  Windows separator (repo_path comes from the OS, not from us). */
function segments(p: string): string[] {
  return p.split(/[/\\]+/).filter(Boolean);
}

/** The project folder for one repo path, or null if it has none. */
export function projectFor(repoPath: string): string | null {
  const segs = segments(repoPath ?? "");
  // Need at least <container>/<repo>, and one more level above that: a repo at
  // `/Users/x` or `C:/repo` has no meaningful parent to name.
  if (segs.length < 3) return null;
  const parent = segs[segs.length - 2];
  if (CODE_ROOTS.has(parent.toLowerCase())) return null;
  // `/Users/<name>/<repo>` — the parent is the home folder itself.
  if (segs.length === 3 && /^(users|home)$/i.test(segs[0])) return null;
  return parent;
}

/**
 * Bucket `workspaces` into projects, preserving the caller's order both between
 * and within groups. Returns a single `project: null` group when nothing has a
 * project, so the caller renders exactly what it rendered before this existed.
 */
export function groupByProject(workspaces: Workspace[]): ProjectGroup[] {
  const order: (string | null)[] = [];
  const buckets = new Map<string | null, { ws: Workspace; index: number }[]>();

  workspaces.forEach((ws, index) => {
    // Co-pilot and observe workspaces have no repo of their own, so no project.
    const project = projectFor(ws.repo_path ?? "");
    if (!buckets.has(project)) {
      buckets.set(project, []);
      order.push(project);
    }
    buckets.get(project)!.push({ ws, index });
  });

  if (order.every((p) => p === null)) {
    return [{ project: null, items: workspaces.map((ws, index) => ({ ws, index })) }];
  }

  // Ungrouped first: those rows are unchanged from before, so the eye starts
  // where it always did and the named groups read as additions below.
  const sorted = [...order].sort((a, b) => (a === null ? -1 : b === null ? 1 : 0));
  return sorted.map((project) => ({ project, items: buckets.get(project)! }));
}
