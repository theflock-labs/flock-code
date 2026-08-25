import { useState, type CSSProperties, type ReactNode } from "react";

/** One avatar, one rule: a picture that doesn't load is the same thing as no
 * picture at all.
 *
 * Every call site used to inline `url ? <img> : <initial>`, which handles the
 * signed-out case and nothing else. An avatar URL that 404s — and they do:
 * Google rotates its `lh3.googleusercontent.com/a/…` paths, GitHub's carry a
 * content hash, and both outlive the value stored on the profile row — got the
 * webview's broken-image glyph instead, a grey box with a blue question mark,
 * sitting in the sidebar footer next to a perfectly good fallback that never
 * ran. Now `onError` demotes the image to that fallback.
 *
 * The failed URL is remembered rather than a boolean, so when the profile heals
 * (useFlockId pushes a fresh URL from the live OAuth session) the new one is
 * tried instead of staying stuck on the initial for the rest of the session. */
export function Avatar({
  url,
  seed,
  imgClassName,
  fallbackClassName,
  fallbackContent,
  style,
}: {
  /** Remote avatar. Null, empty, or unloadable all fall through to the initial. */
  url: string | null | undefined;
  /** Handle or display name the fallback initial is taken from. */
  seed?: string | null;
  imgClassName?: string;
  /** Class(es) for the fallback chip. Defaults to imgClassName. */
  fallbackClassName?: string;
  /** Overrides the initial — for the anonymous chips that show no letter. */
  fallbackContent?: ReactNode;
  style?: CSSProperties;
}) {
  const [failed, setFailed] = useState<string | null>(null);

  if (url && failed !== url) {
    return (
      <img
        className={imgClassName}
        src={url}
        alt=""
        style={style}
        onError={() => {
          // Named so a dead avatar is one devtools line rather than a mystery
          // letter chip: the URL is the whole diagnosis (rotated Google path,
          // stale GitHub hash, or offline).
          console.warn(`avatar: failed to load ${url}`);
          setFailed(url);
        }}
      />
    );
  }
  return (
    <div className={fallbackClassName ?? imgClassName} style={style}>
      {fallbackContent ?? (seed ?? "?").slice(0, 1).toUpperCase()}
    </div>
  );
}
