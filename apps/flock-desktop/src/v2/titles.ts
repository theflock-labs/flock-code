// What a thread is called, without asking a model.
//
// v1 named every agent by running `claude -p` (through a login shell) on its
// last few prompts, after every prompt you sent. With twenty agents that was a
// steady stream of full Claude Code boots just to repaint a label. A thread's
// title is now its first real task, cut down to a line, the moment you send it
// — the way a chat is named after its first message. At most one AI title is
// asked for per thread, once, and only when Settings allows it (see App).

/** Longest title shown before it is cut at a word. */
export const TITLE_MAX = 60;

/** A whole prompt that is an answer or a nudge rather than a task. */
const NOT_A_TASK = /^(ls|pwd|clear|exit|q|quit|status|help|y|yes|n|no|ok|okay|continue|go on|go|do it|thanks?|thank you|sure|yep|nope|push it|commit)\W*$/i;
/** A shell-ish command typed into the agent, with or without arguments. */
const COMMAND = /^(ls|cd|cat|echo|which|git (status|checkout|switch|log|diff|pull|push|stash|branch|fetch))(\s|$)/i;

/** Things that are prompts but not tasks: slash-commands, a bare `ls`, a git
 *  checkout, a "yes". They never name a thread. */
export function looksLikeTask(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 3) return false;
  if (s.startsWith("/")) return false;
  return !NOT_A_TASK.test(s) && !COMMAND.test(s);
}

/** A thread title from the prompt that started it, or undefined when the
 *  prompt is not a task (see looksLikeTask). */
export function titleFromPrompt(raw: string): string | undefined {
  let s = raw
    // Terminal escapes a paste can carry.
    .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, " ")
    .replace(/\x1b\][^\x07]*\x07/g, " ")
    // Attached images: Claude's chips and flock's staged paths.
    .replace(/\[(Image|Pasted text) #\d+[^\]]*\]/gi, " ")
    .replace(/(?:[\w./~-]*\/)?\.flock\/images\/\S+/g, " ")
    // A bare URL is not a title; the words around it are.
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || !looksLikeTask(s)) return undefined;

  // The first sentence, when there is a real one.
  const sentence = s.match(/^(.{12,}?[.!?])(\s|$)/);
  if (sentence) s = sentence[1];
  s = s.replace(/[\s.,;:!?-]+$/, "");
  if (s.length > TITLE_MAX) {
    const cut = s.slice(0, TITLE_MAX - 1);
    const space = cut.lastIndexOf(" ");
    s = `${(space > TITLE_MAX * 0.5 ? cut.slice(0, space) : cut).replace(/[\s.,;:-]+$/, "")}…`;
  }
  if (!s) return undefined;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const AI_TITLES_KEY = "flock:ai-titles";

/** Whether new threads get one short AI title (one `claude -p` call per
 *  thread, never per prompt). On unless turned off in Settings. */
export function getAiTitles(): boolean {
  try {
    return localStorage.getItem(AI_TITLES_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAiTitles(on: boolean): void {
  try {
    localStorage.setItem(AI_TITLES_KEY, on ? "1" : "0");
  } catch {
    /* a preference, not state */
  }
}

/** What an agent is working on now: its latest task-like prompt, as a title.
 *  The thread keeps the name its first task gave it; this follows the agent as
 *  you hand it the next thing, locally, with no model call. */
export function latestTask(history: readonly string[] | undefined): string | undefined {
  if (!history) return undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const raw = history[i];
    if (looksLikeTask(raw)) return titleFromPrompt(raw);
  }
  return undefined;
}

/** Whether two titles say the same thing, ignoring case, spacing and an ellipsis. */
export function sameTitle(a: string | undefined, b: string | undefined): boolean {
  const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/…$/, "").replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}
