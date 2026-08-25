// Clickable file paths and URLs in terminal panes. WebLinksAddon matches URLs
// but rejoins only the terminal's own soft wraps, and matches no paths at all;
// this provider matches both — absolute macOS paths (and ~/ paths), optionally
// suffixed with :line or :line:col, plus http(s) URLs — and rejoins the hard
// wraps an agent performed itself before the PTY ever saw them. It is
// registered ahead of WebLinksAddon so a wrapped URL links as one whole link
// rather than as its first row; the addon stays on behind it as a fallback.

import type { IDisposable, ILink, Terminal } from "@xterm/xterm";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { homeDir } from "@tauri-apps/api/path";

// Anchored to the fixed macOS root directories (plus ~/) rather than "any
// token containing a slash", so URL tails, glob patterns, and a/b shorthands
// don't light up as links. The lookbehind keeps matches from starting inside
// a longer token (e.g. the /Users/... tail of a URL).
const ROOTS =
  "Users|home|private|tmp|var|etc|opt|usr|bin|sbin|dev|cores|Applications|Volumes|Library|System";
const PATH_RE = new RegExp(
  `(?<![\\w.:@%~/-])(?:~(?=/)|/(?:${ROOTS})\\b)(?:/[\\w.@%+=#,~-]+)*/?(?::\\d+(?::\\d+)?)?`,
  "g",
);

/** WebLinksAddon's own URL pattern, verbatim (plus /g). Taking URLs over from
 *  the addon must not narrow what counts as one, so the pattern is copied
 *  rather than reinvented. */
const URL_RE = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;

/** The first URL in `text`, delimited exactly as a clickable link is.
 *
 *  Exported so "Copy URL" in the pane menu cannot disagree with the link the
 *  user could have clicked instead. It used to carry its own `https?:\/\/\S+`,
 *  which has no notion of trailing punctuation — copying a URL out of prose
 *  handed you the sentence's full stop, and out of markdown the closing
 *  parenthesis. One definition of where a URL ends, in one place. */
export function firstUrl(text: string): string | null {
  return text.match(URL_RE)?.[0] ?? null;
}

type Match = { text: string; index: number; url: boolean };

/** Every path and URL in a logical line, URLs first: a path-shaped tail inside
 *  a URL belongs to the URL, not to a link of its own. */
function matchLinks(text: string): Match[] {
  const out: Match[] = [];
  for (const m of text.matchAll(URL_RE)) {
    if (m.index !== undefined) out.push({ text: m[0], index: m.index, url: true });
  }
  for (const m of text.matchAll(PATH_RE)) {
    // A path at the end of a sentence keeps its final punctuation out of both
    // the underline and the opened target.
    const raw = m[0].replace(/[.,]+$/, "");
    if (raw.length < 2 || m.index === undefined) continue;
    const start = m.index;
    const covered = out.some((u) => start < u.index + u.text.length && u.index < start + raw.length);
    if (!covered) out.push({ text: raw, index: start, url: false });
  }
  return out;
}

async function openTarget(raw: string): Promise<void> {
  // Editors can't be handed the :line:col suffix through `open`; drop it.
  let p = raw.replace(/:\d+(?::\d+)?$/, "");
  if (p.startsWith("~")) {
    const home = await homeDir();
    p = home.replace(/\/$/, "") + p.slice(1);
  }
  // A click means "show me this", never "run it" — and the text these links are
  // matched from is agent output, which is downstream of whatever repo the
  // agent is working in. A hostile repo can print any path it likes and wait
  // for someone to click it.
  //
  // So this is an allowlist, not a blocklist. A blocklist has to enumerate
  // every bundle and script type macOS will execute (.app .command .scpt .jar
  // .prefPane .saver .mpkg .webloc .inetloc .tool .appex …) and loses the day
  // it misses one; worse, an extensionless Mach-O binary executes under `open`
  // and no extension blocklist can catch it. Anything not known-inert is
  // revealed in Finder instead, which is safe for every file type and still
  // answers "where is this".
  // Strip a trailing slash before testing: `/Applications/Mail.app/` and
  // `/Applications/Mail.app` are the same bundle, and a trailing slash must
  // not be a way past the extension check.
  const target = p.replace(/\/+$/, "");
  return opensInPlace(target) ? openPath(target) : revealItemInDir(target);
}

/** Whether a click may hand this path to `open` (true), or must settle for
 *  revealing it in Finder (false). Exported for tests — this is the security
 *  boundary, so it is asserted directly rather than through the link provider. */
export function opensInPlace(path: string): boolean {
  const target = path.replace(/\/+$/, "");
  return INERT_FILE.test(target) || INERT_NAME.test(target);
}

/** Extensions macOS opens in a viewer or editor rather than executing. Kept
 *  deliberately narrow — a type missing from this list costs a Finder reveal
 *  instead of an open, which is a far cheaper mistake than the reverse.
 *
 *  `.py` and `.sh` are absent on purpose despite being ordinary source: a
 *  machine with python.org Python installed registers Python Launcher as the
 *  default .py handler, and a shell script can be bound to Terminal, so `open`
 *  on either can execute rather than display. They reveal instead. */
const INERT_FILE =
  /\.(?:[cm]?[jt]sx?|rs|go|rb|php|java|kt|swift|[ch]|[ch]pp|cc|hh|cs|scala|clj|ex|exs|erl|hs|lua|sql|graphql|proto|ya?ml|toml|ini|cfg|conf|env|json5?|jsonc|lock|xml|html?|css|s[ac]ss|less|svelte|vue|astro|md|mdx|txt|log|csv|tsv|rst|adoc|tex|pdf|png|jpe?g|gif|webp|bmp|tiff?|ico|mp[34]|m4a|wav|mov|webm|patch|diff|gitignore|dockerignore|editorconfig)$/i;

/** Extensionless files that are still just text. Without these, the common
 *  case of clicking a Makefile or a LICENSE would reveal rather than open. */
const INERT_NAME =
  /\/(?:Makefile|Dockerfile|Rakefile|Gemfile|Procfile|LICENSE|README|CHANGELOG|NOTICE|AUTHORS|CODEOWNERS)$/i;

/** Characters a token can be broken between — used only to decide whether two
 *  buffer rows are halves of one token, never to match a path. The head class
 *  is the wider of the two: a URL resumes on `?` or `&` as readily as on a
 *  word character, while a *line* ending in `?` is far more often a question
 *  than a query string. */
const WRAP_TAIL = /[\w.@%+=#,:~/-]/;
const WRAP_HEAD = /[\w.@%+=#,:~/?&-]/;
const NON_WRAP = /[^\w.@%+=#,:~/?&-]/;

/** How far short of `cols` a row may end and still count as flush with the
 *  block's right edge. Absorbs the right margin an agent's box leaves and the
 *  cell-rounding of the pane's own width. */
const EDGE_SLACK = 3;

/** Columns a right-aligned annotation takes off the end of a row, gap
 *  included — 0 if the row has none. Claude Code prints these next to a
 *  wrapped path (`… /scratchpad/flock-li-go (7.1KB)`), so the path's own right
 *  edge is not the row's. Only a short trailing token that sits flush with the
 *  block's right edge and holds a character no path or URL could counts:
 *  ending at the edge is the evidence that the row ran out of width. */
function annotationWidth(row: string, cols: number): number {
  const trimmed = row.replace(/ +$/, "");
  if (trimmed.length < cols - EDGE_SLACK) return 0;
  const gap = trimmed.lastIndexOf(" ");
  if (gap <= 0) return 0;
  const tail = trimmed.slice(gap + 1);
  return tail.length <= 20 && NON_WRAP.test(tail) ? trimmed.length - gap : 0;
}

/** Claude Code wraps its own output instead of letting the terminal soft-wrap
 *  it, so a path too long for the pane arrives as two *hard* buffer lines with
 *  the block's indent re-emitted at the head of the second — `isWrapped` is
 *  false and there are real spaces between the halves, so nothing about it
 *  looks like a wrap. Rejoining is therefore a sniff: the first row must end
 *  on a token character with no room left for what follows (Ink only breaks a
 *  token mid-way when it has run out of width) and the next must resume with
 *  one after its indent. Returns how many columns of `prev` are the token's
 *  (`cut`, so a trailing annotation is left out of the joined text) and how
 *  many leading columns of `next` are indent — or null if the two rows are
 *  unrelated.
 *
 *  "No room left" is measured against the row's own right edge rather than the
 *  pane's: an annotation on either row reserves those columns from both, which
 *  is why a row can break a token several columns short of the last one.
 *
 *  A wrong guess costs a link that underlines a few characters too many and
 *  fails to resolve on click; not guessing costs every wrapped path in the
 *  pane, which is most of them. */
function hardWrap(
  prev: string,
  next: string,
  cols: number,
): { cut: number; indent: number } | null {
  const prevAnn = annotationWidth(prev, cols);
  const cut = prev.slice(0, prev.replace(/ +$/, "").length - prevAnn).replace(/ +$/, "").length;
  if (cut === 0 || !WRAP_TAIL.test(prev[cut - 1])) return null;

  const indent = (next.match(/^ */) as RegExpMatchArray)[0].length;
  const head = next[indent];
  if (head === undefined || !WRAP_HEAD.test(head)) return null;

  const frag = (next.slice(indent).match(/^\S*/) as RegExpMatchArray)[0].length;
  const limit = cols - Math.max(prevAnn, annotationWidth(next, cols));
  return cut + frag > limit ? { cut, indent } : null;
}

export function registerTerminalLinks(term: Terminal): IDisposable {
  return term.registerLinkProvider({
    provideLinks(lineNo: number, callback: (links: ILink[] | undefined) => void) {
      const buf = term.buffer.active;
      const cols = term.cols;
      // Rows are read unpadded-but-untrimmed (translateToString trims only
      // when asked) so a column index into the string is a column on screen.
      const rowText = (i: number): string | undefined =>
        buf.getLine(i)?.translateToString(false);

      // Walk back to the first row of the logical line. Soft wraps report
      // themselves; hard ones have to be sniffed.
      let first = lineNo - 1;
      while (first > 0) {
        const prev = rowText(first - 1);
        const cur = rowText(first);
        if (prev === undefined || cur === undefined) break;
        if (!buf.getLine(first)?.isWrapped && hardWrap(prev, cur, cols) === null) break;
        first--;
      }

      // Assemble the logical line, remembering where each character came
      // from: dropped indents and annotations mean offsets no longer divide
      // cleanly by cols.
      let text = "";
      const xs: number[] = [];
      const ys: number[] = [];
      let skip = 0;
      for (let idx = first; ; idx++) {
        const cur = rowText(idx);
        if (cur === undefined) break;
        const next = rowText(idx + 1);
        const soft = !!buf.getLine(idx + 1)?.isWrapped;
        const hard = !soft && next !== undefined ? hardWrap(cur, next, cols) : null;
        const continues = soft || hard !== null;
        const end = hard ? hard.cut : continues ? cur.length : cur.replace(/ +$/, "").length;
        for (let c = skip; c < end; c++) {
          text += cur[c];
          xs.push(c + 1);
          ys.push(idx + 1);
        }
        if (!continues) break;
        skip = hard?.indent ?? 0;
      }

      const links: ILink[] = [];
      for (const m of matchLinks(text)) {
        const start = m.index;
        const end = start + m.text.length - 1; // inclusive
        if (ys[start] === undefined || ys[end] === undefined) continue;
        // One link for the whole span even when it crosses rows, rather than
        // one per row: xterm flattens a provider's links onto the hovered
        // row's x-axis to drop overlapping ones, so two rows of the same path
        // read as an overlap and the second gets evicted from its cache. For
        // the same reason a link the hovered row has no part of is withheld —
        // flattened, it covers the whole row and evicts the one under the
        // cursor.
        if (ys[start] > lineNo || ys[end] < lineNo) continue;
        links.push({
          text: m.text,
          range: {
            start: { x: xs[start], y: ys[start] },
            end: { x: xs[end], y: ys[end] },
          },
          activate(event, target) {
            event.preventDefault();
            const opened = m.url ? openUrl(target) : openTarget(target);
            opened.catch((err) => console.warn(`terminal link: failed to open ${target}:`, err));
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}
