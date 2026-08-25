import { useEffect, type RefObject } from "react";

// Keep keyboard focus inside a modal and hand it back to the opener on close.
// Pair with role="dialog" + aria-modal="true" on the same element. Escape is
// already handled per-dialog, so this only manages Tab wrapping and initial /
// return focus — without it, Tab walks straight out of the dialog into the
// obscured page behind it.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Remember who opened us so focus can return there on close.
    const opener = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );

    // Pull focus in if a dialog didn't already autofocus its own field.
    if (!node.contains(document.activeElement)) {
      focusables()[0]?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!node.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      // Only restore if the opener still exists and nothing else claimed focus.
      if (opener && document.body.contains(opener)) opener.focus?.();
    };
  }, [ref]);
}
