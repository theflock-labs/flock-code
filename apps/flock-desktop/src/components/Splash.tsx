import { openUrl } from "@tauri-apps/plugin-opener";
import GooseMark from "./GooseMark";
import Wordmark from "./Wordmark";

interface Props {
  onNewWorkspace: () => void;
  onOpenCommandBar: () => void;
}

/**
 * The empty state, and the app's opening argument.
 *
 * It used to carry a time-of-day greeting in tracked caps, the mark, the
 * wordmark, a filled primary button and a Discord link with an arrow: five
 * things competing on a screen that exists because there is nothing to show.
 * What survives is the mark, the name, and one line naming the only key you
 * need. Everything the removed chrome offered is in ⌘K, which is the point of
 * having a command surface at all.
 *
 * The greeting is the one deletion worth defending: it was the largest piece
 * of text on the first screen of every session and it told you the hour, which
 * you can already see.
 */
export default function Splash({ onNewWorkspace, onOpenCommandBar }: Props) {
  return (
    <div className="splash">
      <div className="splash-mark"><GooseMark width={96} /></div>
      <Wordmark size={44} />

      <div className="splash-hint">
        <button onClick={onOpenCommandBar}>
          What should happen? <kbd>⌘K</kbd>
        </button>
        <span className="sep" />
        <button onClick={onNewWorkspace}>
          New workspace <kbd>⌘N</kbd>
        </button>
      </div>

      <div
        className="splash-foot"
        onClick={() => openUrl("https://discord.gg/rRerdy329").catch(console.error)}
      >
        Join the community on Discord
      </div>
    </div>
  );
}
