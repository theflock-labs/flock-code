export type SettingsTab =
  | "appearance" | "voice" | "github" | "graph" | "teams" | "integrations"
  | "worktrees" | "account" | "usage" | "provenance" | "security" | "about";

export interface SettingSearchEntry {
  id: string;
  tab: SettingsTab;
  section: string;
  label: string;
  description: string;
  keywords: string;
}

/** Stable control targets, not translated DOM text. Keep aliases here so a
 * user can search for the job without knowing the settings category. */
export const SETTINGS_SEARCH_ENTRIES: SettingSearchEntry[] = [
  { id: "account", tab: "account", section: "Account", label: "flock ID and profile", description: "Manage your account and public profile.", keywords: "sign in sign out login handle avatar identity" },
  { id: "budgets", tab: "usage", section: "Usage Details", label: "Spending budgets", description: "Daily spending ceilings for this machine and each workspace.", keywords: "budget cost money spend limit alert tokens billing" },
  { id: "claude-usage", tab: "usage", section: "Usage Details", label: "Claude usage limits", description: "Check your Claude subscription usage.", keywords: "claude quota rate limit remaining reset" },
  { id: "codex-usage", tab: "usage", section: "Usage Details", label: "Codex usage limits", description: "Check your Codex subscription usage.", keywords: "codex quota rate limit remaining reset" },
  { id: "follow-system", tab: "appearance", section: "Appearance", label: "Inherit system appearance", description: "Follow the Mac’s light and dark mode.", keywords: "automatic theme light dark night day os" },
  { id: "theme", tab: "appearance", section: "Appearance", label: "Theme", description: "Choose the app’s color theme.", keywords: "color colour dark light contrast nightfall daybreak" },
  { id: "pane-text", tab: "appearance", section: "Appearance", label: "Agent pane text size", description: "Make terminal output larger or smaller.", keywords: "terminal font zoom readability size" },
  { id: "terminal-font", tab: "appearance", section: "Appearance", label: "Terminal font", description: "Choose the font for terminal output.", keywords: "typeface family monospace custom system default hack menlo codex claude" },
  { id: "app-text", tab: "appearance", section: "Appearance", label: "App text size", description: "Resize sidebar, dialog and toolbar text.", keywords: "interface ui scale font zoom readability size" },
  { id: "quick-actions", tab: "appearance", section: "Appearance", label: "Quick actions", description: "Show or hide the sidebar setup checklist.", keywords: "checklist onboarding setup sidebar tips" },
  { id: "voice", tab: "voice", section: "Voice", label: "Voice dictation and microphone", description: "Enable dictation, then configure the hotkey, input source and transcription.", keywords: "speech whisper microphone mic hotkey language vocabulary filler words cleanup model recording" },
  { id: "github-enabled", tab: "github", section: "GitHub", label: "GitHub integration", description: "Show pull request checks and notifications.", keywords: "pull request pr checks ci notifications integration" },
  { id: "github-account", tab: "github", section: "GitHub", label: "GitHub account connection", description: "Connect or disconnect the GitHub CLI account.", keywords: "login sign in oauth authentication github cli" },
  { id: "graph", tab: "graph", section: "Graph", label: "Shared agent memory", description: "Set up the knowledge graph and its connection.", keywords: "graph memory decisions recall postgres knowledge mcp" },
  { id: "teams", tab: "teams", section: "Teams", label: "Teams and organizations", description: "Manage team membership and shared settings.", keywords: "team organization organisation invite members collaboration" },
  { id: "agent-hooks", tab: "integrations", section: "Integrations", label: "Live agent status", description: "Install or remove agent hooks that report activity to Flock.", keywords: "agent status hooks notifications working waiting claude codex grok integration" },
  { id: "session-records", tab: "provenance", section: "Provenance", label: "Session records and export", description: "Find agent history and export it as CSV or JSON.", keywords: "provenance history session export records audit csv json timeline" },
  { id: "secure-mode", tab: "security", section: "Security", label: "Secure mode and Docker", description: "Set the default sandbox mode and check Docker readiness.", keywords: "sandbox jail secure docker container isolation permissions host" },
  { id: "network", tab: "security", section: "Security", label: "Network access and allowlist", description: "Restrict which hosts sandboxed agents can reach.", keywords: "network egress allowlist internet domains proxy security" },
  { id: "branch-mode", tab: "worktrees", section: "Branches", label: "Default branch mode", description: "Choose separate branches, an existing branch or the current checkout.", keywords: "branch worktree isolation checkout default" },
  { id: "fetch-base", tab: "worktrees", section: "Branches", label: "Fetch base branch first", description: "Refresh the remote base before creating branches.", keywords: "fetch git remote origin base update branch" },
  { id: "delete-branch", tab: "worktrees", section: "Branches", label: "Delete branch with worktree", description: "Choose whether a pane’s local branch is removed with its worktree.", keywords: "delete cleanup remove branch worktree close" },
  { id: "worktree-directory", tab: "worktrees", section: "Branches", label: "Worktree directory", description: "Choose the parent folder for new worktrees.", keywords: "folder directory path worktree location" },
  { id: "carry-files", tab: "worktrees", section: "Branches", label: "Carry over local files", description: "Copy selected local configuration into new worktrees.", keywords: "env environment files copy patterns gitignored configuration" },
  { id: "shortcuts", tab: "about", section: "About", label: "Keyboard shortcuts", description: "Find shortcuts for panes, workspaces and the command bar.", keywords: "keyboard shortcuts hotkeys keybindings command palette cmdk" },
  { id: "feature-tour", tab: "about", section: "About", label: "Feature tour", description: "Explore workspaces, agents, reviews and shared memory.", keywords: "onboarding tutorial tour help getting started welcome" },
];

function words(text: string): string[] {
  return text.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]+/g) ?? [];
}

export function searchSettings(query: string): SettingSearchEntry[] {
  const terms = words(query);
  if (!terms.length) return [];
  const phrase = terms.join(" ");
  return SETTINGS_SEARCH_ENTRIES.map((entry, order) => {
    const label = words(entry.label).join(" ");
    const section = words(entry.section).join(" ");
    const haystack = words([entry.label, entry.section, entry.description, entry.keywords].join(" "));
    if (!terms.every(term => haystack.some(word => word.startsWith(term)))) return null;
    const score = (label === phrase ? 100 : label.includes(phrase) ? 40 : 0)
      + terms.reduce((sum, term) => sum + (words(label).some(word => word.startsWith(term)) ? 6 : 0)
        + (words(section).some(word => word.startsWith(term)) ? 2 : 0), 0);
    return { entry, score, order };
  }).filter((item): item is { entry: SettingSearchEntry; score: number; order: number } => item !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(item => item.entry);
}

/** Focus the destination without changing its value. A disabled or conditional
 * control leaves focus on its named group, where prerequisites are explained. */
export function revealSetting(body: HTMLElement, id: string): HTMLElement | null {
  const target = body.querySelector<HTMLElement>(`[data-setting="${id}"]`);
  if (!target || target.closest("[hidden], [inert], [aria-hidden='true']")) return null;
  target.scrollIntoView?.({ block: "center", behavior: "auto" });
  const selector = "input:not([type='hidden']), select, textarea, button, [role='radio'][tabindex='0']";
  const candidates = target.matches(selector) ? [target] : Array.from(target.querySelectorAll<HTMLElement>(selector));
  const control = candidates.find(element => !element.matches(":disabled")
    && !element.closest("[hidden], [inert], [aria-hidden='true'], [aria-disabled='true']"));
  if (control) control.focus({ preventScroll: true });
  else { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  return target;
}
