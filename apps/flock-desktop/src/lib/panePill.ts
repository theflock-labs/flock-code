/** A short-lived status chip floated over a pane — image attaches, copy
 * failures. Rendered imperatively (the pane host is xterm's DOM, not React).
 * Multiple simultaneous pills stack instead of overlapping. */
export function flashPanePill(paneId: string, text: string, error = false): void {
  if (typeof document === "undefined") return;
  const host = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(paneId)}"]`);
  if (!host) return;
  const existing = host.querySelectorAll(".pane-image-pill").length;
  const pill = document.createElement("div");
  pill.className = error ? "pane-image-pill error" : "pane-image-pill";
  pill.textContent = text;
  pill.style.bottom = `${12 + existing * 30}px`;
  host.appendChild(pill);
  window.setTimeout(() => {
    pill.classList.add("leaving");
    window.setTimeout(() => pill.remove(), 220);
  }, 2400);
}
