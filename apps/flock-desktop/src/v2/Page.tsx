import { useEffect, type ReactNode } from "react";
import { PanelLeftIcon, XIcon } from "./icons";

export interface PageTab<T extends string> {
  id: T;
  label: string;
  /** Shown beside the label when above zero. */
  count?: number;
  title?: string;
}

/** A page of the main panel, in place of a dialog over the window: Settings,
 *  Graph, Pull requests. It wears the thread's own head (its name, its views as
 *  quiet tabs, its tools, a close) over the panel's ground, so moving between
 *  a thread and a page changes the content and nothing around it.
 *
 *  Escape closes it, unless something inside used the key first: a menu stops
 *  the event, and a search field with text in it keeps it. */
export function Page<T extends string>({
  title,
  meta,
  tabs,
  tab,
  onTab,
  tools,
  onClose,
  onShowSidebar,
  className,
  children,
}: {
  title: string;
  /** Beside the title: the project, a scope chip. */
  meta?: ReactNode;
  tabs?: PageTab<T>[];
  tab?: T;
  onTab?: (id: T) => void;
  /** Buttons before the close. */
  tools?: ReactNode;
  onClose: () => void;
  /** Present while the app's sidebar is hidden: the page carries the toggle. */
  onShowSidebar?: () => void;
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLInputElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && t.value) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section className={`v2-page${className ? ` ${className}` : ""}`} aria-label={title}>
      <header className="v2-head" data-tauri-drag-region>
        {onShowSidebar && (
          <button type="button" className="v2-icon-btn" aria-label="Show sidebar" title="Show sidebar (⌘\)" onClick={onShowSidebar}>
            <PanelLeftIcon size={16} />
          </button>
        )}
        <h1 className="v2-head-title" data-tauri-drag-region>
          {title}
        </h1>
        {meta}
        {tabs && tabs.length > 1 && (
          <div className="v2-tabs" role="tablist" aria-label={`${title} views`}>
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="v2-tab"
                aria-selected={t.id === tab}
                title={t.title}
                onClick={() => onTab?.(t.id)}
              >
                {t.label}
                {!!t.count && <span className="v2-tab-count">{t.count}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="v2-head-tools">
          {tools}
          <button type="button" className="v2-icon-btn" aria-label={`Close ${title}`} title="Close (Esc)" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>
      </header>
      <div className="v2-page-body">{children}</div>
    </section>
  );
}

/** What a page shows when it has nothing to list, centred in its space. */
export function PageEmpty({ children }: { children: ReactNode }) {
  return <div className="v2-page-empty">{children}</div>;
}
