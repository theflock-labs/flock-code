import { useEffect, useState } from "react";
import {
  applyTerminalFont, getStoredTerminalFont, getTerminalFontFamily,
  normalizeTerminalFont, onTerminalFontChange, TERMINAL_FONT_NAME_MAX, TERMINAL_FONT_PRESETS,
} from "../lib/terminalFont";

const isCustom = (font: string) => !!font && !TERMINAL_FONT_PRESETS.includes(font);

export default function TerminalFontSetting() {
  const [font, setFont] = useState(getStoredTerminalFont);
  const [custom, setCustom] = useState(() => isCustom(font));
  const [draft, setDraft] = useState(font);
  useEffect(() => onTerminalFontChange((next) => {
    setFont(next);
    setDraft(next);
    setCustom(isCustom(next));
  }), []);

  return (
    <div className="terminal-font-setting" data-setting="terminal-font">
      <div className="settings-row">
        <label className="settings-label" htmlFor="terminal-font">Terminal font</label>
        <select id="terminal-font" className="modal-input" value={custom ? "custom" : font}
          aria-describedby="terminal-font-hint"
          onChange={(event) => {
            if (event.target.value === "custom") { setCustom(true); setDraft(""); }
            else applyTerminalFont(event.target.value);
          }}>
          <option value="">System default</option>
          {TERMINAL_FONT_PRESETS.map((name) => <option key={name} value={name}>{name === "Hack" ? "Hack (bundled)" : name}</option>)}
          <option value="custom">Custom…</option>
        </select>
      </div>
      <p id="terminal-font-hint" className="settings-hint">
        Applies to every terminal pane. Except for Hack, fonts must be installed on this computer;
        unavailable fonts use system monospace.
      </p>
      {custom && (
        <form className="terminal-font-custom" onSubmit={(event) => {
          event.preventDefault();
          if (normalizeTerminalFont(draft)) applyTerminalFont(draft);
        }}>
          <label className="settings-label" htmlFor="terminal-font-custom">Installed font name</label>
          <div className="terminal-font-actions">
            <input id="terminal-font-custom" className="modal-input" type="text" value={draft}
              maxLength={TERMINAL_FONT_NAME_MAX} placeholder="e.g. Berkeley Mono" autoComplete="off" spellCheck={false}
              aria-describedby="terminal-font-hint"
              onChange={(event) => setDraft(event.target.value)} />
            <button type="submit" className="btn-ghost settings-btn"
              disabled={!normalizeTerminalFont(draft) || normalizeTerminalFont(draft) === font}>Apply</button>
          </div>
        </form>
      )}
      <div className="terminal-font-actions">
        <div className="terminal-font-preview" aria-label="Terminal font preview" style={{ fontFamily: getTerminalFontFamily(font) }}>
          Aa Bb 0123 <strong>Bold</strong> ┌─┐
        </div>
        <button type="button" className="btn-ghost settings-btn" disabled={!font && !custom}
          onClick={() => applyTerminalFont("")}>Reset font</button>
      </div>
    </div>
  );
}
