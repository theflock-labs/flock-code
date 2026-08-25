// Getting one prompt into one freshly-spawned pane.
//
// A pane is not its agent for the first second or two: it is a login shell,
// an echoed `eval`, a worktree's `npm ci`, a jail building its image. Text
// sent into that window is run by bash — which is how a multi-line PR-review
// prompt became a handful of shell commands — and text sent into the splash an
// agent draws before wiring up its input line is swallowed with no trace, so
// the agent just sits there having been asked nothing.
//
// Extracted from App.tsx with its clock injected so both of those windows can
// actually be tested; the race path and the PR-review/co-pilot path share it,
// which is the point (a second copy is what "a flat 3s sleep" was).

/** What the caller knows about the pane right now. */
export type PaneReadiness = "gone" | "booting" | "ready";

export interface DeliveryDeps {
  readiness: (paneId: string) => PaneReadiness;
  /** Put the text on the pane's input line (bracketed paste, sniffer kept in
   *  step) without submitting it. */
  paste: (paneId: string, text: string) => void;
  /** Press enter. */
  submit: (paneId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** How long to wait for a pane to stop booting before sending anyway. An agent
 *  that never paints (a missing CLI, a jail still building) must not leave this
 *  pending forever. */
export const READY_TIMEOUT_MS = 60_000;

/** How long past "the agent is painting" to wait before pasting. One beat: the
 *  splash is drawn before the input line is live. */
export const SETTLE_MS = 900;

const POLL_MS = 150;

/** Wait for the pane to be the agent's, then paste the prompt and submit it.
 *  Resolves when the prompt has been sent — callers await it so a loading
 *  state covers delivery, not just the spawn. */
export async function deliverPromptWhenReady(
  paneId: string,
  text: string,
  deps: DeliveryDeps,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  const deadline = now() + READY_TIMEOUT_MS;
  for (;;) {
    const state = deps.readiness(paneId);
    // Closed while we were waiting: there is nothing to type into, and typing
    // into a reused id would be worse than typing nothing.
    if (state === "gone") return;
    if (state === "ready") break;
    // Timed out: send anyway. A prompt landing in a shell is bad; a race
    // contender that was never asked anything is worse, and the caller is
    // awaiting this.
    if (now() > deadline) break;
    await sleep(POLL_MS);
  }
  await sleep(SETTLE_MS);
  deps.paste(paneId, text);
  await deps.submit(paneId);
}
