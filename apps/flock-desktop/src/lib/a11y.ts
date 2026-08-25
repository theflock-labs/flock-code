import type { KeyboardEvent } from "react";

// Keyboard activation for custom controls (clickable <div>/<span>, role="button").
// Native <button>s fire onClick on Enter AND Space; a bare onClick div does not,
// so a keyboard/screen-reader user can focus it but never activate it. Wire this
// as onKeyDown (alongside tabIndex={0} + role="button") to restore that.
export function onActivateKey(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

// Roving-focus keyboard nav for a radiogroup of tiles (the agent / layout
// pickers): arrows and Home/End move the selection and the DOM focus together,
// matching the radiogroup pattern where moving the roving focus also selects.
// Anything else falls through, so a dialog's Enter-to-confirm still fires and
// selection itself never confirms.
export function onRadioKey(
  e: KeyboardEvent<HTMLElement>,
  index: number,
  count: number,
  select: (nextIndex: number) => void,
) {
  let next = index;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % count;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + count) % count;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = count - 1;
  else return;
  e.preventDefault();
  select(next);
  (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
}
