#!/usr/bin/env bash
# flock release train. Runs the whole thing:
#   version derive → bump → build (signed + notarized when creds exist) →
#   GitHub release → website /download → hero version → /Applications.
#
# Usage:
#   scripts/release.sh              # patch bump from the latest GitHub tag
#   scripts/release.sh 0.5.0        # explicit version
#
# Version truth is `gh release list`, NOT the working tree — parallel
# sessions release too, and the tree once said 0.4.1 while GitHub was at
# 0.4.3.
#
# Signing/notarization (optional until the Apple Developer enrollment is
# active): export these before running, or put them in scripts/release.env
# (gitignored):
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID="you@example.com"
#   APPLE_PASSWORD="app-specific-password"   # appleid.apple.com → App-Specific Passwords
#   APPLE_TEAM_ID="TEAMID"
# With APPLE_SIGNING_IDENTITY set, the bundle is signed with the Developer
# ID cert and Tauri notarizes automatically via the APPLE_* vars; without
# it, the ad-hoc identity from tauri.conf.json applies (Gatekeeper "Open
# Anyway" flow).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Sourced BEFORE the SITE_DIR / BRIDGE_UPDATES_DIR defaults below, so a
# SITE_DIR set in release.env participates in them. Sourcing it after (as this
# script once did) left BRIDGE_UPDATES_DIR computed from the stale default
# while everything else honoured the override, and the two manifests drifted.
[ -f "$REPO_DIR/scripts/release.env" ] && source "$REPO_DIR/scripts/release.env"

# Derived from this repo, not from $HOME: a path anchored on $HOME goes stale
# the moment the tree is moved or cloned somewhere else. It already did. The
# old "$HOME/git/flock-website" survived a move because
# `mkdir -p "$SITE_DIR/updates"` below happily CREATES the missing directory:
# a whole release published into a phantom ~/git/flock-website while the real
# site sat untouched, and the only thing that noticed was the one copy into
# downloads/, which is the one directory this script does not mkdir. If the
# website checkout is not a sibling of this repo, set SITE_DIR in release.env.
SITE_DIR="${SITE_DIR:-$(cd "$REPO_DIR/../flock-website" 2>/dev/null && pwd || echo "$REPO_DIR/../flock-website")}"
APP_DIR="$REPO_DIR/apps/flock-desktop"
# Where the clarence.minnebo.ai bridge manifest is written. Today the bridge is
# an alias on the same Vercel project, so it is the same file; if it is ever
# split onto its own deployment, point BRIDGE_UPDATES_DIR at that checkout and
# both manifests still get written from the one payload below.
BRIDGE_UPDATES_DIR="${BRIDGE_UPDATES_DIR:-$SITE_DIR/updates}"

cd "$REPO_DIR"

# ── Version ──────────────────────────────────────────────────────────────────
latest=$(gh release list --limit 1 --json tagName --jq '.[0].tagName' | sed 's/^v//')
if [ -n "${1:-}" ]; then
  version="$1"
else
  IFS=. read -r major minor patch <<< "$latest"
  version="$major.$minor.$((patch + 1))"
fi
echo "── latest release: v$latest → releasing: v$version"

if git tag -l "v$version" | grep -q .; then
  echo "!! v$version already exists" >&2; exit 1
fi

# ── Preflight ────────────────────────────────────────────────────────────────
# Hand-written notes are mandatory: gh --generate-notes is structurally useless
# on this repo (features land as direct commits, not PRs), so it emits either a
# dead private-repo compare link or whatever stray PR happened to merge — both
# v0.6.4/v0.7.6-style "No notable changes." changelogs and the v0.7.8 "Test PR"
# bullet came from exactly this. Set ALLOW_GENERATED_NOTES=1 to bypass on
# purpose.
if [ -z "${ALLOW_GENERATED_NOTES:-}" ]; then
  if [ -z "${RELEASE_NOTES_FILE:-}" ] || [ ! -s "$RELEASE_NOTES_FILE" ]; then
    echo "!! RELEASE_NOTES_FILE is unset or empty — write the notes first:" >&2
    echo "   RELEASE_NOTES_FILE=notes.md scripts/release.sh $version" >&2
    exit 1
  fi
fi
# Prove the site checkout is real before spending ten minutes on a notarised
# build. Every publish step below writes into $SITE_DIR, and several of them
# create what they cannot find, so a wrong path does not fail: it silently
# ships the release into an empty directory and reports success.
for d in .git downloads updates; do
  [ -d "$SITE_DIR/$d" ] || {
    echo "!! SITE_DIR does not look like the website checkout: missing $d" >&2
    echo "   SITE_DIR=$SITE_DIR" >&2
    echo "   Point SITE_DIR at it explicitly if it lives somewhere else." >&2
    exit 1
  }
done

git pull --rebase
if [ -n "$(git status --porcelain)" ]; then
  echo "!! working tree not clean — commit or stash first" >&2; exit 1
fi
(cd "$APP_DIR" && npx tsc --noEmit)
cargo check -p flock-desktop

# Stale mounted DMG volumes break bundle_dmg.sh
for v in /Volumes/[Ff]lock*; do
  [ -e "$v" ] && hdiutil detach "$v" || true
done

# ── Bump ─────────────────────────────────────────────────────────────────────
sed -i '' -E "s/^version = \"[0-9.]+\"/version = \"$version\"/" Cargo.toml
python3 - "$version" << 'PY'
import json, sys
v = sys.argv[1]
for f in ("apps/flock-desktop/package.json", "apps/flock-desktop/src-tauri/tauri.conf.json"):
    d = json.load(open(f)); d["version"] = v
    json.dump(d, open(f, "w"), indent=2)
PY
cargo check -p flock-desktop > /dev/null 2>&1 # refresh Cargo.lock
git add -A && git commit -m "Bump to $version" && git push

# ── Build (signed + notarized when creds are present) ────────────────────────
cd "$APP_DIR"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "── building with Developer ID signing + notarization"
  APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
  APPLE_ID="${APPLE_ID:?}" APPLE_PASSWORD="${APPLE_PASSWORD:?}" APPLE_TEAM_ID="${APPLE_TEAM_ID:?}" \
    npm run tauri build -- --config "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"$APPLE_SIGNING_IDENTITY\"}}}"
else
  echo "── building ad-hoc signed (no Apple Developer creds in env)"
  npm run tauri build
fi
cd "$REPO_DIR"

# Lowercase, because the product name is lowercase everywhere including the
# bundle: these two paths are whatever `productName` in tauri.conf.json says.
APP="target/release/bundle/macos/flock.app"
DMG="target/release/bundle/dmg/flock_${version}_aarch64.dmg"
codesign --verify --deep --strict "$APP"
[ -f "$DMG" ] || { echo "!! DMG missing: $DMG" >&2; exit 1; }

# ── Smoke ────────────────────────────────────────────────────────────────────
# Run the thing we are about to publish, and touch it. Everything above this
# line — tsc, cargo check, the unit tests — was green for 0.7.30, which aborted
# the process on the first click of its own titlebar, and for 0.7.30/0.7.31,
# which turned the scroll wheel into prompt-history navigation. Both reached
# every install through auto-update inside one day. A gate that only reads the
# code cannot catch a selector that resolves at runtime or a behaviour that
# lives in an agent on the far side of a pty; this one launches the bundle and
# clicks it.
#
# Verified against the real failure: scripts/smoke.sh run on the published
# 0.7.30 build exits 1 with "process died after: titlebar double-click".
#
# SKIP_SMOKE=1 exists for a machine that genuinely cannot grant Accessibility
# permission (CI). Using it on a workstation is choosing to ship the way we
# shipped today.
if [ -n "${SKIP_SMOKE:-}" ]; then
  echo "!! smoke test SKIPPED by SKIP_SMOKE — publishing a build nobody has run"
else
  "$REPO_DIR/scripts/smoke.sh" "$APP" || {
    echo "!! smoke test failed — not publishing v$version" >&2
    echo "   The bundle is still at $APP if you want to reproduce by hand." >&2
    exit 1
  }
fi

# ── Auto-updater artifacts (hosted on the website, NOT GitHub) ───────────────
# The GitHub repo is PRIVATE, so its release assets 404 for the unauthenticated
# request the updater makes. We host the update payload + manifest on the
# marketing site (public, already our download host) instead. With
# TAURI_SIGNING_PRIVATE_KEY set (scripts/release.env) and
# createUpdaterArtifacts=true the build emits flock.app.tar.gz + .sig; we copy
# the tarball to the site's /updates and write latest.json pointing at it. The
# app's updater endpoint (https://theflock.sh/updates/latest.json) reads it and
# offers the "Restart to update" prompt. No key → DMG only.
#
# Two manifests, one payload, one write: every copy installed before the
# rebrand polls https://clarence.minnebo.ai/updates/latest.json and has no other
# way to hear about a new build, so that URL keeps serving the identical bytes
# indefinitely. Both destinations are written from the same manifest object in
# the same python run — if they ever drift, those installs freeze silently on
# the version they have.
# Named, never globbed. The bundle directory is not cleaned between releases,
# so a glob here sees every tarball ever built — and `ls | head -1` sorts
# capitals first, which means a leftover Clarence.app.tar.gz wins over today's
# flock.app.tar.gz. Its .sig sits beside it and verifies, so the payload that
# shipped would be an old build wearing the new version number, silently.
TARGZ="${APP}.tar.gz"
SIG="${TARGZ}.sig"
if [ -f "$TARGZ" ] && [ -f "$SIG" ]; then
  mkdir -p "$SITE_DIR/updates" "$BRIDGE_UPDATES_DIR"
  cp "$TARGZ" "$SITE_DIR/updates/flock_${version}.app.tar.gz"
  python3 - "$version" "$SIG" "$SITE_DIR/updates/latest.json" "$BRIDGE_UPDATES_DIR/latest.json" << 'PY'
import json, os, sys, datetime
version, sig_path, outs = sys.argv[1], sys.argv[2], sys.argv[3:]
# Absolute URL, so the bridge's copy of the manifest points at the same payload
# on the canonical host rather than needing its own duplicate of the tarball.
url = f"https://theflock.sh/updates/flock_{version}.app.tar.gz"
manifest = {
    "version": version,
    "notes": f"flock {version}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        "darwin-aarch64": {"signature": open(sig_path).read().strip(), "url": url},
    },
}
blob = json.dumps(manifest, indent=2)
for out in dict.fromkeys(os.path.realpath(p) for p in outs):
    open(out, "w").write(blob)
    print(f"── manifest written: {out}")
PY
  echo "── updater published to site: /updates/flock_${version}.app.tar.gz + latest.json"
  case "$BRIDGE_UPDATES_DIR" in
    "$SITE_DIR"/*) ;;
    *) echo "!! BRIDGE_UPDATES_DIR is outside the site repo — deploy it yourself, the vercel deploy below only ships $SITE_DIR" >&2 ;;
  esac
else
  echo "── no updater artifacts (TAURI_SIGNING_PRIVATE_KEY unset) — shipping DMG only"
fi

# ── Publish ──────────────────────────────────────────────────────────────────
notes="${RELEASE_NOTES_FILE:-}"
if [ -n "$notes" ] && [ -f "$notes" ]; then
  gh release create "v$version" "$DMG" --title "flock $version" --notes-file "$notes"
else
  gh release create "v$version" "$DMG" --title "flock $version" --generate-notes
fi

# Whatever notes just went to GitHub (hand-written or auto-generated from
# merged PRs) are the same notes that get rendered into docs.html's
# Changelog section below — one source of truth, no separate write-up.
RELEASE_NOTES_TMP="$(mktemp)"
gh release view "v$version" --json body -q .body > "$RELEASE_NOTES_TMP"

cp "$DMG" "$SITE_DIR/downloads/"
ditto "$APP" /Applications/flock.app

cd "$SITE_DIR"
python3 - "$version" << 'PY'
import json, re, sys
v = sys.argv[1]
c = json.load(open("vercel.json"))

# /download is served by api/download.js, which counts the click and then
# redirects. It reads the version out of updates/latest.json (written above),
# so there is no per-release destination to rewrite here any more.
#
# What this block does instead is protect that route. Vercel evaluates
# redirects BEFORE rewrites, so a leftover /download redirect shadows the
# function completely: downloads keep working, the counter silently records
# nothing, and the only symptom is a number that stays flat. This used to
# write exactly that redirect on every release, so strip it if it reappears.
#
# Leave every other redirect alone. Assigning the whole array once silently
# deleted the rebrand's /docs/clarence-id -> /docs/flock-id, which would have
# 404ed every existing link to it at the next ship.
c["redirects"] = [r for r in c.get("redirects", []) if r.get("source") != "/download"]
rewrites = [r for r in c.get("rewrites", []) if r.get("source") != "/download"]
c["rewrites"] = [{"source": "/download", "destination": "/api/download"}] + rewrites
json.dump(c, open("vercel.json", "w"), indent=2)

# Keep the function's parachute current. It is only used when latest.json is
# unreachable, so a stale constant is invisible until the day it is not.
p = "api/download.js"
s = open(p).read()
# subn's count, not `s2 != s`: on a re-run of the same version the substitution
# matches and produces an identical string, and comparing the text alone would
# report that as "constant missing" every second run.
s2, n = re.subn(r'(const FALLBACK_DMG = ")[^"]*(")',
                lambda m: m.group(1) + f"/downloads/flock_{v}_aarch64.dmg" + m.group(2), s, count=1)
if n == 0:
    print("!! FALLBACK_DMG not found in api/download.js, left untouched", file=sys.stderr)
elif s2 != s:
    open(p, "w").write(s2)
PY
sed -i '' -E "s/v[0-9.]+ · macOS/v$version · macOS/" index.html

# ── Changelog (docs.html) ─────────────────────────────────────────────────
python3 - "$version" "$RELEASE_NOTES_TMP" << 'PY'
import datetime, html, os, re, sys

version, notes_path = sys.argv[1], sys.argv[2]
raw = open(notes_path).read().strip()

# The repo is private, so any github.com link in these notes is dead for the
# public site — most commonly `gh --generate-notes`'s own
# "**Full Changelog**: <compare-url>" boilerplate, which becomes the *entire*
# changelog entry when a release has no other notes (see v0.4.13: the site
# briefly shipped nothing but a 404 link). Strip that line outright, strip
# github.com PR auto-links ("<title> by @user in <url>"), and de-link any
# other stray github.com URL while keeping its surrounding text.
def strip_github_refs(md):
    kept = []
    for line in md.split("\n"):
        if re.match(r"^\*\*full changelog\*\*\s*:", line.strip(), re.IGNORECASE):
            continue
        line = re.sub(r"\s+in\s+https?://github\.com/\S+\s*$", "", line)
        line = re.sub(r"\[([^\]]+)\]\(https?://github\.com/[^\s)]+\)", r"\1", line)
        line = re.sub(r"https?://github\.com/\S+", "", line)
        stripped = re.sub(r" {2,}", " ", line).rstrip()
        # A line that was blank stays blank: it is the paragraph break, and
        # md_to_html folds everything between two of them into one paragraph.
        # Dropping them here is what put every entry on the page as a single
        # unbroken block, sub-headings and all, from v0.4.13 to v0.7.27.
        # Only a line emptied by the stripping above is discarded, which is
        # the case this was written for: a bullet that was nothing but a
        # github.com link would otherwise leave a hole in its own list.
        if stripped.strip() or not line.strip():
            kept.append(stripped)
    return "\n".join(kept)

raw = strip_github_refs(raw)

# These notes come off a GitHub release, which is usually written from a PR
# description, which is written for us. The changelog is read by people
# deciding whether to trust the product, so an entry that lists crate names and
# the type we swapped a buffer for tells them nothing and tells a competitor
# something. v0.7.23 shipped exactly that way and had to be rewritten by hand.
#
# Fail the release rather than publish it. The fix is thirty seconds of writing
# a note that says what changed for the person using flock. Set
# ALLOW_INTERNAL_NOTES=1 to publish anyway.
IMPL_TELLS = [
    (r"\btokio\b|\bserde\b|\bTauri\b|\bArc\b|\bMutex\b|\bRwLock\b", "library or type names"),
    (r"\bflock-(pty|core|graph)\b|\bcrate\b|\bTUI\b|\bPTY\b", "internal module names"),
    (r"`[^`]*(::|\(\))[^`]*`|\.await\b|\bcargo \w+", "code symbols"),
    (r"zero-copy|hot path|broadcast channel|replay buffer|legacy code|"
     r"\bcode path\b|test suite|\bCSP\b|allocations?/sec", "implementation detail"),
]
found = [(w, re.findall(p, raw, re.I)[:3]) for p, w in IMPL_TELLS if re.search(p, raw, re.I)]
if found and not os.environ.get("ALLOW_INTERNAL_NOTES"):
    print(f"\n  Release notes for v{version} read as engineering notes, not public copy:\n",
          file=sys.stderr)
    for what, eg in found:
        print(f"    {what}: {', '.join(str(e) for e in eg)}", file=sys.stderr)
    print("\n  Rewrite them for someone deciding whether to use flock: what changed for\n"
          "  them, and what they will notice. Keep shortcuts, paths and env vars, those\n"
          "  are things they type. Then re-run, or set ALLOW_INTERNAL_NOTES=1.\n",
          file=sys.stderr)
    sys.exit(1)

# House style: no em dashes (or en dashes) anywhere in public copy. Release
# notes are written by hand and by agents, both of which reach for them
# constantly, and every one of those lands verbatim on the public changelog.
# Normalise here instead of hand-editing docs.html after every ship, because
# a hand edit gets buried under the next entry anyway.
def dedash(md):
    kept = []
    for line in md.split("\n"):
        # Numeric ranges want a plain hyphen: "12–15" stays a range.
        line = re.sub(r"(\d)\s*[–—]\s*(\d)", r"\1-\2", line)
        if len(re.findall(r"\s[–—]\s", line)) >= 2:
            # A matched pair on one line is a parenthetical aside: commas.
            line = re.sub(r"\s[–—]\s", ", ", line)
        else:
            # "**Feature** — what it does" is a definition, so a colon reads
            # right. Same after a code span or a closing paren.
            line = re.sub(r"(\*\*|`|\))\s[–—]\s", r"\1: ", line)
            # Anything else is an aside mid-sentence: a comma carries it.
            line = re.sub(r"\s[–—]\s", ", ", line)
        # Leading dash on a line is decoration; a bare one is a comma.
        line = re.sub(r"^\s*[–—]\s*", "", line)
        line = re.sub(r"\s*[–—]\s*", ", ", line)
        kept.append(line)
    return "\n".join(kept)

raw = dedash(raw)

def inline(text):
    text = html.escape(text, quote=False)
    # Code spans come out first and are held aside, so the bold and link rules
    # below cannot reach inside them and a path like `**/*.rs` stays a path.
    spans = []
    def stash(m):
        spans.append(m.group(1))
        return f"\x00{len(spans) - 1}\x00"
    text = re.sub(r"`([^`]+)`", stash, text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^\s)]+)\)",
                   r'<a href="\2" target="_blank" rel="noreferrer">\1</a>', text)
    text = re.sub(r'(?<!["\'=])(https?://[^\s<]+)',
                   r'<a href="\1" target="_blank" rel="noreferrer">\1</a>', text)
    return re.sub(r"\x00(\d+)\x00",
                  lambda m: f"<code>{spans[int(m.group(1))]}</code>", text)

# A pipe table: a header row, a |---|---| separator, then body rows. Release
# notes use these for before/after numbers and they used to land on the page as
# one paragraph per row, pipes and all.
def _is_row(l):
    return l.startswith("|") and l.endswith("|") and len(l) > 1

def _cells(l):
    return [c.strip() for c in l.strip("|").split("|")]

def _is_sep(l):
    return _is_row(l) and all(re.fullmatch(r":?-{2,}:?", c) for c in _cells(l))

def md_to_html(md):
    lines = [l.strip() for l in md.split("\n")]
    out, para, in_ul, i = [], [], False, 0

    def close_ul():
        nonlocal in_ul
        if in_ul:
            out.append("</ul>"); in_ul = False

    # Markdown folds consecutive lines into one paragraph. This used to emit a
    # <p> per line, so hand-wrapped prose in a release note arrived on the page
    # as five stacked paragraphs with paragraph spacing between every line of a
    # single sentence. Buffer instead, and flush on a blank line or a block.
    def flush_para():
        if para:
            body = inline(" ".join(para))
            # A line that is entirely bold is a sub-heading inside the entry.
            cls = ' class="changelog-sub"' if re.fullmatch(
                r"<strong>[^<]*</strong>:?", body) else ""
            out.append(f"<p{cls}>{body}</p>")
            para.clear()

    while i < len(lines):
        line = lines[i]
        if not line:
            flush_para(); close_ul(); i += 1; continue
        if line.startswith("#"):
            flush_para(); i += 1; continue  # redundant with the version/date shown
        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", line):
            flush_para(); close_ul(); i += 1; continue  # a rule, not content
        if _is_row(line) and i + 1 < len(lines) and _is_sep(lines[i + 1]):
            flush_para(); close_ul()
            # The wrapper is what scrolls on a narrow screen, so a wide table
            # never drags the whole document sideways.
            out.append('<div class="changelog-table-scroll">'
                       '<table class="changelog-table"><thead><tr>'
                       + "".join(f"<th>{inline(c)}</th>" for c in _cells(line))
                       + "</tr></thead><tbody>")
            i += 2
            while i < len(lines) and _is_row(lines[i]) and not _is_sep(lines[i]):
                out.append("<tr>" + "".join(f"<td>{inline(c)}</td>"
                                            for c in _cells(lines[i])) + "</tr>")
                i += 1
            out.append("</tbody></table></div>")
            continue
        if line.startswith("* ") or line.startswith("- "):
            flush_para()
            if not in_ul:
                out.append("<ul>"); in_ul = True
            out.append(f"<li>{inline(line[2:])}</li>")
            i += 1; continue
        close_ul()
        para.append(line)
        i += 1

    flush_para(); close_ul()
    return "\n".join(out) or "<p>No notable changes.</p>"

# ── Title and kind ────────────────────────────────────────────────────────
# The changelog is sixty-plus releases on one page, so every entry carries a
# title and one or more kinds, and the index at the top is built from them.
# Both come off the release notes:
#
#   Kind: DESIGN, FIX
#   Title: The l is a letter again          <- optional
#
# Title falls back to the notes' own opening sentence, which is how the
# entries have been written for a while and reads better than anything a
# script could derive. Kind has no sensible default: guessing it would put a
# wrong badge on a permanent record, so a missing one fails the release.
KINDS = ["ACTION NEEDED", "FEATURE", "FIX", "DESIGN", "PERFORMANCE", "SECURITY"]

def take_field(md, name):
    m = re.search(rf"^{name}:[ \t]*(.+)$", md, re.I | re.M)
    if not m:
        return None, md
    return m.group(1).strip(), (md[: m.start()] + md[m.end():]).strip()

kind_line, raw = take_field(raw, "Kind")
title, raw = take_field(raw, "Title")

if not kind_line and not os.environ.get("ALLOW_INTERNAL_NOTES"):
    sys.exit(
        f"\n  Release notes for v{version} carry no Kind, so the changelog entry\n"
        f"  and its index row would have no badge.\n\n"
        f"    Add a line to the release notes:  Kind: FEATURE\n"
        f"    One or more of: {', '.join(KINDS)}\n"
    )

kinds = []
for k in (kind_line or "FEATURE").split(","):
    k = k.strip().upper()
    if k and k not in KINDS:
        sys.exit(f"\n  Unknown Kind {k!r}. Use one or more of: {', '.join(KINDS)}\n")
    if k:
        kinds.append(k)

if not title:
    lead = re.sub(r"<[^>]+>", "", md_to_html(raw).split("</p>")[0]).strip()
    lead = html.unescape(re.sub(r"\s+", " ", lead))
    title = re.split(r"(?<=\.)\s", lead)[0].rstrip(".") if lead else f"flock {version}"

body_html = md_to_html(raw)

# The title usually opens the notes too. Say it once: drop the lead sentence
# from the body when the heading above already carries it.
norm = lambda s: re.sub(r"\s+", " ", s).rstrip(".").strip().lower()
first_p = re.search(r"(<p[^>]*>)([\s\S]*?)(</p>)", body_html)
if first_p:
    inner = first_p.group(2)
    plain = html.unescape(re.sub(r"<[^>]+>", "", inner)).strip()
    strong = re.match(r"\s*<strong>([^<]*?)\.?</strong>\s*", inner)
    if norm(plain) == norm(title):
        body_html = body_html[: first_p.start()] + body_html[first_p.end():].lstrip("\n")
    elif strong and norm(html.unescape(strong.group(1))) == norm(title):
        body_html = (body_html[: first_p.start()] + first_p.group(1)
                     + inner[strong.end():] + first_p.group(3)
                     + body_html[first_p.end():])
    elif norm(re.split(r"(?<=\.)\s", plain)[0]) == norm(title):
        cut = re.sub(r"^\s*" + re.escape(re.split(r"(?<=\.)\s", plain)[0]) + r"\s*",
                     "", inner, count=1)
        body_html = (body_html[: first_p.start()] + first_p.group(1) + cut
                     + first_p.group(3) + body_html[first_p.end():])

anchor = "v" + re.sub(r"[^0-9a-z]+", "-", version.lower()).strip("-")
today = datetime.date.today().isoformat()
# Pipe-delimited: ACTION NEEDED has a space in it, so a space-separated list
# could not be tokenised by the index filter.
kinds_attr = "|" + "|".join(kinds) + "|"
chips = "".join(
    f'<span class="changelog-kind '
    f'{"is-action" if k == "ACTION NEEDED" else ""}">{k}</span>'
    for k in kinds
)

entry = f'''          <div class="changelog-entry" id="{anchor}">
            <div class="changelog-header">
              <span class="changelog-version">v{version}</span>
              <span class="changelog-date">{today}</span>
              {chips}
            </div>
            <h3 class="changelog-title"><a href="#{anchor}">{html.escape(title)}</a></h3>
            <div class="changelog-body">
{body_html}
            </div>
          </div>
'''

index_row = (f'            <a class="cl-row" href="#{anchor}" data-kinds="{kinds_attr}">'
             f'<span class="cl-row-date">{today}</span>'
             f'<span class="cl-row-ver">v{version}</span>'
             f'<span class="cl-row-title">{html.escape(title)}</span>'
             f'<span class="cl-row-kinds">{chips}</span></a>')

# The docs are one page per section now: the changelog has its own page at
# /docs/changelog, while the "Current release" line stays on the docs hub.
# Two files, one write each.
log_path = "docs/changelog.html"
log = open(log_path).read()
marker = '<div class="changelog-list"><!-- CHANGELOG_ENTRIES -->'
assert marker in log, f"{log_path}: changelog marker not found"
log = log.replace(marker, marker + "\n" + entry, 1)

# The index is generated the same way and has to grow with it, or it silently
# stops listing the newest release.
rows_marker = '<div class="cl-rows">'
assert rows_marker in log, f"{log_path}: index marker not found"
log = log.replace(rows_marker, rows_marker + "\n" + index_row, 1)
total = log.count('<a class="cl-row"')
log = re.sub(r'(<span class="cl-index-count">)[^<]*(</span>)',
             rf'\g<1>{total} of {total}\g<2>', log, count=1)

open(log_path, "w").write(log)

hub = open("docs.html").read()
assert "Current release: <strong>v" in hub, "docs.html: release string not found"
open("docs.html", "w").write(
    re.sub(r"Current release: <strong>v[0-9.]+</strong>",
           f"Current release: <strong>v{version}</strong>", hub))
PY
rm -f "$RELEASE_NOTES_TMP"

git add -A && git commit -m "Ship $version" && vercel deploy --prod --yes

sleep 5
curl -s -o /dev/null -w "/download → %{http_code} · %{size_download}b\n" -L https://theflock.sh/download

# The two manifests are written from one payload above, but they are served by
# two hostnames, so verify the bytes actually landed on both. A pre-rebrand
# install only ever sees the bridge; if it lags or 404s, that install never
# hears about this release and nothing else in the pipeline would say so.
canonical="$(curl -sL https://theflock.sh/updates/latest.json)"
bridge="$(curl -sL https://clarence.minnebo.ai/updates/latest.json)"
if [ -n "$canonical" ] && [ "$canonical" = "$bridge" ]; then
  echo "── updater manifests match on theflock.sh and the clarence.minnebo.ai bridge"
else
  echo "!! updater manifests DIFFER (or one is empty) — pre-rebrand installs are stranded until this is fixed" >&2
fi

# ── Announce to running apps (instant update pill) ───────────────────────────
# Insert a row into the public `releases` table; Supabase Realtime nudges every
# running client to re-check latest.json now instead of on its next poll, so the
# "Restart to update" pill shows the moment we ship. Best-effort — the client's
# own recheck interval is the fallback. Needs SUPABASE_URL + service-role key.
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  curl -s -o /dev/null -w "── announced v$version to running apps (%{http_code})\n" \
    "$SUPABASE_URL/rest/v1/releases" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates" \
    -d "{\"version\":\"$version\",\"notes\":\"flock $version\"}"
else
  echo "── SUPABASE_* unset in release.env — skipped realtime announcement"
fi
echo "── released v$version"
