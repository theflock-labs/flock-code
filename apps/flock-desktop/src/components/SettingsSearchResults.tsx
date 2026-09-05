import type { SettingSearchEntry } from "../lib/settingsSearch";

export default function SettingsSearchResults({ query, results, onSelect }: {
  query: string;
  results: SettingSearchEntry[];
  onSelect: (result: SettingSearchEntry) => void;
}) {
  return (
    <section className="settings-search-results" aria-label="Settings search results">
      <p className="settings-search-count" role="status">
        {results.length ? `${results.length} matching ${results.length === 1 ? "setting" : "settings"}` : `No settings match “${query.trim()}”`}
      </p>
      {results.length === 0 ? <p className="settings-hint">Try “agent status”, “sandbox”, “text size” or “session export”.</p> : (
        <ul className="settings-search-list">
          {results.map((result, index) => (
            <li key={result.id}>
              <button className="settings-search-result"
                aria-labelledby={`setting-result-${result.id}-label setting-result-${result.id}-section`}
                aria-describedby={`setting-result-${result.id}-description`}
                onClick={() => onSelect(result)} onKeyDown={event => {
                const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
                if (!keys.includes(event.key)) return;
                event.preventDefault();
                const buttons = event.currentTarget.closest("ul")?.querySelectorAll<HTMLButtonElement>("button");
                const next = event.key === "Home" ? 0 : event.key === "End" ? results.length - 1
                  : Math.max(0, Math.min(results.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
                buttons?.[next]?.focus();
              }}>
                <span id={`setting-result-${result.id}-section`} className="settings-search-result-section">{result.section}</span>
                <span id={`setting-result-${result.id}-label`} className="settings-search-result-label">{result.label}</span>
                <span id={`setting-result-${result.id}-description`} className="settings-search-result-description">{result.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
