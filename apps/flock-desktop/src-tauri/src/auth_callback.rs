//! Loopback OAuth callback for flock ID sign-in.
//!
//! The desktop sign-in flow opens the provider (Google via Supabase)
//! in the system browser; Supabase then redirects to
//! `http://127.0.0.1:{port}/auth/callback?code=…`. This module runs the tiny
//! one-shot HTTP listener that catches that redirect, hands the query string
//! to the frontend (which exchanges the PKCE code for a session), and shows
//! the user a "return to flock" page.
//!
//! Fixed ports rather than an ephemeral one: Supabase's redirect-URL
//! allowlist wants exact origins, so we register these three and try them in
//! order — three simultaneous sign-in attempts on one machine is beyond the
//! threat model.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const CALLBACK_PORTS: [u16; 3] = [43110, 43111, 43112];

/// Query-string payload forwarded to the frontend on `flock-id://callback`.
#[derive(Clone, serde::Serialize)]
struct CallbackPayload {
    query: String,
}

// Mirrors the app's SignInGate lockup one-for-one: the brand void with its one
// quiet top-center glow, the flapping goose, the logotype with its crest, then
// the message in the app's own splash voice — tracked mono eyebrow, display
// serif headline, sans sub. Everything is inlined, so the page renders whole
// with no network at all; a dash of JS flips the copy when the provider
// bounced us with an error instead of a code.
//
// The brand faces are Outfit, Fraunces and IBM Plex Mono, and none of the
// three ships with macOS — a system-font stack here would land on Helvetica
// and Georgia, which is a different brand wearing our words. So the same
// woff2 files the app loads are embedded as data URIs (~120 KB of the
// binary, decoded once at startup). Nothing else on this page is allowed to
// ask for a face that isn't one of the three.

// The goose, both wingbeat frames, kept in sync with GooseMark.tsx's UPSTROKE
// and DOWNSTROKE (tests below read that file and compare). One bird, every
// theme: the palette is GooseMark's PALETTE, as the page's g-* classes.
const UPSTROKE: [&str; 23] = [
    "...........w.w........................",
    "...........wwww.......................",
    ".........s.cwwww......................",
    ".........scccwwww.....................",
    ".........wccccwwww....................",
    ".........ssccccwwww........nhhhh......",
    ".........wwcccccwww.......nmgllhh.....",
    ".........sccccccwwww......dmgdkdh.....",
    "..........uusscccwwww.....dmgdkdlg....",
    "h..........sscccccwwww...nndmmgllppqqq",
    "lhh.........uuusssswww..dmnddddmooooo.",
    "mmlhhhhlldddnnnuuuucwwgmmmmnnnnnbbbb..",
    "nmmmllggggmdddddddlllggmmmmmd.........",
    ".dddmmmmlllllllllllllggmmmmln.........",
    "..nnnmmmmmggglllllllgggmwww...........",
    "...nnndmmmmmggggggggggwwww............",
    "....nnnndmmmmmmmmmmmlwwwww............",
    ".....nnnnndmmmmmmmmmwwwww.............",
    ".......nnnndddmmmmmccccc..............",
    ".........nbboumnnuussss...............",
    "..........bor..uuuuu..................",
    ".........brpr.........................",
    "........oopp..........................",
];

const DOWNSTROKE: [&str; 23] = [
    "......................................",
    "......................................",
    "......................................",
    "......................................",
    "......................................",
    "...........................nhhhh......",
    "...........s.wwwww........nmgllhh.....",
    "...........scccwwwww......dmgdkdh.....",
    "..........ssccccwwww......dmgdkdlg....",
    "h.........sccccccwwww....nndmmgllppqqq",
    "lhh........sscccccwwww..dmnddddmooooo.",
    "mmlhhhhlldddnnnuuuucwwgmmmmnnnnnbbbb..",
    "nmmmllggggmdddddddlllggmmmmmd.........",
    ".dddmmmmlllllllllllllggmmmmln.........",
    "..nnnmmmmmggglllllllgggmwww...........",
    "...nnndmmmmmggggggggggwwww............",
    "....nnnndmmmmmmmmmmmlwwwww............",
    ".....nnnnndmmmmmmmmmwwwww.............",
    ".......nnnndddmmmmmccccc..............",
    ".........nbboumnnuussss...............",
    "..........bor..uuuuu..................",
    ".........brpr.........................",
    "........oopp..........................",
];

// The logotype, kept in sync with Wordmark.tsx's WORD: '#' is ink, '1'..'4'
// the crest's segments, top to bottom.
const WORD: [&str; 12] = [
    "..####.11................##.....",
    ".#####.11................##.....",
    ".##....11................##.....",
    ".##....22................##.....",
    "#####..22...###.....####.##...##",
    "#####..22..#####...#####.##..##.",
    ".##....33.##...##.##.....##.##..",
    ".##....33.##...##.##.....####...",
    ".##....33.##...##.##.....####...",
    ".##....44.##...##.##.....##.##..",
    ".##....44..#####...#####.##..##.",
    ".##....44...###.....####.##...##",
];

/// Build one wingbeat frame as an inline SVG of 10px pixel cells
/// (viewBox 380x230). Fills are CSS classes, g- plus the palette letter.
fn goose_svg(grid: &[&str; 23], frame_class: &str) -> String {
    const CELL: u32 = 10;
    let mut rects = String::new();
    for (y, row) in grid.iter().enumerate() {
        for (x, c) in row.chars().enumerate() {
            if c == '.' {
                continue;
            }
            rects.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{CELL}\" height=\"{CELL}\" class=\"g-{c}\"/>",
                x as u32 * CELL,
                y as u32 * CELL,
            ));
        }
    }
    // 95px wide: the sprite's 38 cells at 2.5px, as SignInGate draws it.
    format!(
        "<svg class=\"{frame_class}\" width=\"95\" height=\"57.5\" viewBox=\"0 0 380 230\" shape-rendering=\"crispEdges\" xmlns=\"http://www.w3.org/2000/svg\">{rects}</svg>"
    )
}

/// The logotype as an inline SVG, one unit a cell, at 3.5px a cell (Wordmark's
/// size 54): ink letters in currentColor, the l's four segments in the crest.
fn wordmark_svg() -> String {
    let (cols, rows) = (WORD[0].len(), WORD.len());
    let mut ink = String::new();
    let mut crest = String::new();
    for (y, row) in WORD.iter().enumerate() {
        for (x, c) in row.chars().enumerate() {
            match c {
                '#' => ink.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"1\" height=\"1\"/>")),
                '1'..='4' => crest.push_str(&format!(
                    "<rect class=\"wm-c wm-c{c}\" x=\"{x}\" y=\"{y}\" width=\"1\" height=\"1\"/>"
                )),
                _ => {}
            }
        }
    }
    format!(
        "<svg width=\"{}\" height=\"{}\" viewBox=\"0 0 {cols} {rows}\" shape-rendering=\"crispEdges\" aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\"><g fill=\"currentColor\">{ink}</g>{crest}</svg>",
        cols as f32 * 3.5,
        rows as f32 * 3.5,
    )
}

// The app's own woff2 files, byte-for-byte. Outfit is one variable cut
// covering both brand weights, so 400 and 500 come out of a single blob.
const FONT_SANS: &[u8] = include_bytes!("../../src/assets/fonts/Outfit-400.woff2");
const FONT_SERIF: &[u8] = include_bytes!("../../src/assets/fonts/Fraunces-Roman.woff2");
const FONT_MONO_400: &[u8] = include_bytes!("../../src/assets/fonts/IBMPlexMono-400.woff2");
const FONT_MONO_600: &[u8] = include_bytes!("../../src/assets/fonts/IBMPlexMono-600.woff2");

/// `@font-face` with the file inlined as a data URI. `font-display:block`
/// because the data is already here — there is nothing to wait for, and a
/// flash of Georgia standing in for Fraunces is the one thing this page
/// exists to avoid.
fn font_face(family: &str, weight: &str, bytes: &[u8]) -> String {
    format!(
        "@font-face{{font-family:\"{family}\";font-style:normal;font-weight:{weight};\
         font-display:block;src:url(data:font/woff2;base64,{}) format(\"woff2\");}}",
        STANDARD.encode(bytes)
    )
}

fn font_faces() -> String {
    [
        font_face("Outfit", "400 500", FONT_SANS),
        font_face("Fraunces", "400 700", FONT_SERIF),
        font_face("IBM Plex Mono", "400", FONT_MONO_400),
        font_face("IBM Plex Mono", "600", FONT_MONO_600),
    ]
    .concat()
}

const SUCCESS_PAGE_TEMPLATE: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>flock</title>
<meta name="color-scheme" content="light dark">
<style>
__FONTS__
  /* Follow the OS appearance, and carry the app's own token names so this page
     and global.css stay legible against each other. Values are verbatim from
     the :root blocks in global.css — if one disagrees, that stylesheet is
     right.

     GRAPHITE, NOT NIGHTFALL, as of 2026-08-16. The navy was this page's ground
     from the day it was written, and by then it had stopped being the ground
     anyone lands on: `DEFAULT_THEME` in lib/theme.ts is `graphite`, and
     `systemTheme()` maps a dark OS to that same default rather than to
     Nightfall. So the browser tab handed the user a navy brand moment and the
     window they returned to was grey. This page cannot read the app's stored
     theme — it is served from 127.0.0.1 and the preference lives on the
     tauri:// origin — so it mirrors what `systemTheme()` resolves to instead:
     Graphite for a dark OS, Daybreak for a light one, which is exactly the
     pair the app itself picks between. */
  :root {
    color-scheme: light dark;
    /* Graphite. Neutral by design — the theme's own note in global.css is that
       the app has no hue left to spare, so chrome spends none. Ratios against
       the ground: hi 16.6, mid 10.9, low 6.6, ghost 5.4. */
    --bg-window:  #121212;
    --text-hi:    #f2f1ee;
    --text-mid:   #c6c5c1;
    --text-low:   #9a9995;
    --text-ghost: #8b8a86;
    /* White, as in the theme: once hue is gone, luminance is the only signal
       left that says "interactive". Here it is only a light source. */
    --action:     #ffffff;
    --bad:        #f08c80;
    /* The crest: the l's four segments, top to bottom, in the goose's own
       colours (Wordmark.tsx's --wm-1 to --wm-4). Lighter on this ground. */
    --wm-1: #eaae86;
    --wm-2: #fcd0af;
    --wm-3: #a1bfef;
    --wm-4: #6282bb;
  }
  @media (prefers-color-scheme: light) {
    :root {
      /* Daybreak */
      --bg-window:  #fcfbf8;
      --text-hi:    #0b1b33;
      --text-mid:   #22334f;
      --text-low:   #44546c;
      --text-ghost: #61708a;
      --action:     #1e5eff;
      --bad:        #b4483f;
      /* Cut deeper on paper so the l holds its own beside the ink letters,
         as v2.css does for the app's light theme. */
      --wm-1: #d3885a;
      --wm-2: #e9a273;
      --wm-3: #6282bb;
      --wm-4: #3b5178;
    }
  }
  /* The bird, in GooseMark.tsx's PALETTE: five blues for the body, four
     creams for the wing and breast, the bill and feet's oranges, a dark eye.
     The tests below read GooseMark.tsx and fail if a value drifts. */
  .g-h{fill:#a1bfef} .g-l{fill:#7da1db} .g-g{fill:#6282bb} .g-m{fill:#5171a5} .g-d{fill:#3b5178} .g-n{fill:#23324b} .g-w{fill:#f7ede4} .g-c{fill:#decdbd} .g-s{fill:#c1b09f} .g-u{fill:#aa9a8a} .g-q{fill:#fcd0af} .g-p{fill:#eaae86} .g-o{fill:#d3885a} .g-r{fill:#a05f3c} .g-b{fill:#613925} .g-k{fill:#0e1117}
  * { box-sizing:border-box; }
  html, body { margin:0; height:100%; background:var(--bg-window); }
  body { display:flex; align-items:center; justify-content:center; overflow:hidden;
         background:var(--bg-window); font-family:"Outfit",sans-serif; }
  /* One quiet light source, top center — the same depth the gate uses. 5% and
     not the 7% this carried on navy: --action is pure white in Graphite where
     it was #5b8cff in Nightfall, and the same alpha of a far brighter colour
     stops reading as a light source and starts reading as fog over the top
     third of the page. */
  .glow { position:fixed; top:-30vh; left:50%; transform:translateX(-50%);
          width:90vw; height:70vh; pointer-events:none;
          background:radial-gradient(ellipse at center,
            color-mix(in srgb, var(--action) 5%, transparent) 0%, transparent 65%); }
  .stage { position:relative; text-align:center; width:340px;
           animation:enter 0.7s cubic-bezier(0.16,1,0.3,1); }
  @keyframes enter { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:none; } }
  /* Two sprite frames stacked, swapped on the 260ms beat GooseMark flaps at,
     riding a slower bob. Same bird the gate shows while it waits for this tab. */
  .goose { position:relative; width:95px; height:57.5px; margin:0 auto 18px;
           animation:bob 2.6s ease-in-out infinite; }
  .goose svg { position:absolute; top:0; left:0; }
  .goose .up   { animation:wing-up 0.52s steps(1,end) infinite; }
  .goose .down { animation:wing-down 0.52s steps(1,end) infinite; }
  @keyframes wing-up   { 0%,49.9% { opacity:1 } 50%,100% { opacity:0 } }
  @keyframes wing-down { 0%,49.9% { opacity:0 } 50%,100% { opacity:1 } }
  @keyframes bob { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-5px); } }
  /* The logotype, from Wordmark.tsx: the word drawn in pixels on the goose's
     grid, ink letters and the l's four crest segments, drifting slowly up
     (segment n starts n - 1 quarters into the cycle, as in the app). */
  .wm { color:var(--text-hi); line-height:0; margin-bottom:40px; }
  .wm-c { animation:crest 14s ease-in-out infinite; }
  .wm-c1 { fill:var(--wm-1); animation-delay:0s; }
  .wm-c2 { fill:var(--wm-2); animation-delay:-3.5s; }
  .wm-c3 { fill:var(--wm-3); animation-delay:-7s; }
  .wm-c4 { fill:var(--wm-4); animation-delay:-10.5s; }
  @keyframes crest {
    0%, 100% { fill:var(--wm-1); }
    25% { fill:var(--wm-2); }
    50% { fill:var(--wm-3); }
    75% { fill:var(--wm-4); }
  }
  @media (prefers-reduced-motion: reduce) { .wm-c { animation:none; } }
  /* The splash voice, one notch up for a full page: tracked mono eyebrow,
     display serif headline set lowercase, sans sub. */
  .eyebrow { font-family:"IBM Plex Mono",monospace; font-weight:600; font-size:9px;
             letter-spacing:2.5px; text-transform:uppercase; color:var(--text-low);
             margin-bottom:14px; }
  body.is-error .eyebrow { color:var(--bad); }
  h1 { font-family:"Fraunces",serif; font-weight:400; font-size:30px;
       letter-spacing:0; line-height:1.1; color:var(--text-hi); margin:0; }
  p { font-size:14px; font-weight:400; line-height:1.6; color:var(--text-mid);
      margin:12px auto 0; max-width:34ch; }
  .detail { font-family:"IBM Plex Mono",monospace; font-size:11px; line-height:1.5;
            color:var(--text-ghost); margin-top:18px; word-break:break-word; }
  .detail:empty { display:none; }
  /* Nothing here loops for a reason the user asked for, so all of it goes.
     The crest freezes mid-travel with all three hues on the stem — the frame
     print and the app icon use (Wordmark.tsx's own reduced-motion rule). */
  @media (prefers-reduced-motion: reduce) {
    .stage, .goose, .goose .up, .goose .down { animation:none; }
    .goose .down { opacity:0; }
  }
</style></head><body>
  <div class="glow" aria-hidden="true"></div>
  <div class="stage">
    <div class="goose" aria-hidden="true">__GOOSE_UP____GOOSE_DOWN__</div>
    <div class="wm" role="img" aria-label="flock">__WORDMARK__</div>
    <div class="eyebrow" id="eyebrow">Signed in</div>
    <h1 id="title">you’re in</h1>
    <p id="sub">flock has the controls. You can close this tab.</p>
    <div class="detail" id="detail"></div>
  </div>
  <script>
    var q = new URLSearchParams(location.search);
    var err = q.get("error_description") || q.get("error");
    if (err) {
      document.body.classList.add("is-error");
      document.getElementById("eyebrow").textContent = "Sign-in failed";
      document.getElementById("title").textContent = "that didn’t go through";
      document.getElementById("sub").textContent = "Head back to flock and try again.";
      document.getElementById("detail").textContent = err;
    }
  </script>
</body></html>"#;

/// Built once: the template with the fonts and both goose frames baked in.
fn success_page() -> &'static str {
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PAGE.get_or_init(|| {
        SUCCESS_PAGE_TEMPLATE
            .replace("__FONTS__", &font_faces())
            .replace("__GOOSE_UP__", &goose_svg(&UPSTROKE, "up"))
            .replace("__GOOSE_DOWN__", &goose_svg(&DOWNSTROKE, "down"))
            .replace("__WORDMARK__", &wordmark_svg())
    })
}

/// Bind the first free callback port and wait (in the background) for one
/// redirect. Returns the bound port immediately so the frontend can build the
/// `redirectTo` URL. The listener accepts exactly one request, emits the raw
/// query string on `flock-id://callback`, and exits; it also gives up on
/// its own after 5 minutes so an abandoned sign-in doesn't hold the port.
pub async fn start(app: tauri::AppHandle) -> Result<u16, String> {
    let mut bound = None;
    for port in CALLBACK_PORTS {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => {
                bound = Some((l, port));
                break;
            }
            Err(_) => continue,
        }
    }
    let (listener, port) =
        bound.ok_or_else(|| "all flock sign-in ports are in use".to_string())?;

    tauri::async_runtime::spawn(async move {
        let accept = tokio::time::timeout(std::time::Duration::from_secs(300), async {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("");

                // Browsers also ask for /favicon.ico; only the callback ends
                // the loop.
                if !path.starts_with("/auth/callback") {
                    let _ = stream
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                        .await;
                    continue;
                }

                let query = path.splitn(2, '?').nth(1).unwrap_or("").to_string();
                let body = success_page().as_bytes();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(body).await;
                let _ = stream.flush().await;

                let _ = app.emit("flock-id://callback", CallbackPayload { query });
                return;
            }
        })
        .await;
        if accept.is_err() {
            tracing::debug!("flock-id callback listener timed out unused");
        }
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Everything on this page is a hand-copy of something that lives in the
    /// frontend, because a loopback HTTP response cannot import a React
    /// component or read a stylesheet. Hand-copies rot, and this one did: it
    /// served the retired blue-and-pink goose and Nightfall's navy for weeks
    /// after the app had moved on to a new bird and defaulted to Graphite, and
    /// nothing failed — the page renders, it is just the wrong brand. So the
    /// copies are pinned against their sources by reading the real files.
    const GOOSE_SRC: &str = include_str!("../../src/components/GooseMark.tsx");
    const WORDMARK_SRC: &str = include_str!("../../src/components/Wordmark.tsx");
    const CSS_SRC: &str = include_str!("../../src/styles/global.css");

    /// The quoted rows of a `const NAME = [ ... ];` grid in a TS source.
    fn ts_grid(src: &str, name: &str) -> Vec<String> {
        let start = src.find(&format!("const {name} = [")).unwrap_or_else(|| panic!("no {name} grid"));
        let body = &src[start..];
        let body = &body[..body.find("];").expect("unterminated grid")];
        body.lines()
            .filter_map(|l| l.trim().strip_prefix('"').and_then(|r| r.split('"').next()))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn the_goose_is_the_apps_own_palette() {
        // GooseMark.tsx's PALETTE, one `x: "#rrggbb",` line a colour, as the
        // page's CSS classes.
        let block = GOOSE_SRC
            .split("const PALETTE")
            .nth(1)
            .and_then(|r| r.split("};").next())
            .expect("GooseMark.tsx no longer declares a PALETTE");
        let page = success_page();
        let mut n = 0;
        for line in block.lines() {
            let Some((key, rest)) = line.trim().split_once(": \"") else { continue };
            let hex = rest.split('"').next().unwrap();
            let class = format!(".g-{key}{{fill:{hex}}}");
            assert!(page.contains(&class), "the callback page's goose has drifted from GooseMark.tsx: expected {class}");
            n += 1;
        }
        assert!(n >= 10, "read only {n} colours from GooseMark.tsx");
    }

    #[test]
    fn the_goose_is_the_apps_own_drawing() {
        assert_eq!(ts_grid(GOOSE_SRC, "UPSTROKE"), UPSTROKE.to_vec(), "UPSTROKE drifted from GooseMark.tsx");
        assert_eq!(ts_grid(GOOSE_SRC, "DOWNSTROKE"), DOWNSTROKE.to_vec(), "DOWNSTROKE drifted from GooseMark.tsx");
    }

    #[test]
    fn the_wordmark_is_the_apps_own_drawing() {
        assert_eq!(ts_grid(WORDMARK_SRC, "WORD"), WORD.to_vec(), "WORD drifted from Wordmark.tsx");
        // The l is always there: four crest segments, every row of the stem.
        let stem: usize = WORD.iter().map(|r| r.chars().filter(|c| ('1'..='4').contains(c)).count()).sum();
        assert_eq!(stem, 2 * WORD.len(), "the l lost cells");
    }

    /// The wing is drawn over the body, so those two are each other's
    /// background. Blue-on-pink was 1.09:1 and disappeared in greyscale, at
    /// favicon size, and for the two commonest colour deficiencies — which is
    /// why the wing became apricot, and now cream. A future palette edit must
    /// not undo that.
    #[test]
    fn the_wing_is_visible_against_the_body() {
        let hex = |c: &str| {
            let c = c.trim_start_matches('#');
            [0, 2, 4].map(|i| u8::from_str_radix(&c[i..i + 2], 16).unwrap())
        };
        let lum = |h: &str| {
            let f = |v: u8| {
                let v = v as f64 / 255.0;
                if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
            };
            let [r, g, b] = hex(h);
            0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        };
        let ratio = |a: &str, b: &str| {
            let (x, y) = (lum(a), lum(b));
            (x.max(y) + 0.05) / (x.min(y) + 0.05)
        };
        // Body vs wing, straight off the page the user is served.
        let page = success_page();
        let fill = |cls: &str| {
            page.split(&format!(".g-{cls}{{fill:"))
                .nth(1)
                .and_then(|r| r.split('}').next())
                .unwrap()
                .to_string()
        };
        let r = ratio(&fill("m"), &fill("c"));
        assert!(r > 1.8, "body/wing contrast fell back to {r:.2}:1 (blue+pink was 1.09)");
    }

    /// The crest is Wordmark.tsx's: its --wm-1..4 defaults (the dark ground)
    /// are the page's own.
    #[test]
    fn the_crest_matches_the_wordmark() {
        let block = WORDMARK_SRC
            .split(".flock-wordmark {")
            .nth(1)
            .and_then(|r| r.split('}').next())
            .expect("Wordmark.tsx no longer styles .flock-wordmark");
        let page = success_page();
        let mut n = 0;
        for line in block.lines().map(str::trim).filter(|l| l.starts_with("--wm-")) {
            assert!(page.contains(line), "crest drifted from Wordmark.tsx: expected {line}");
            n += 1;
        }
        assert_eq!(n, 4, "expected four crest colours in Wordmark.tsx");
    }

    /// The page cannot read the app's stored theme, so it mirrors what
    /// `systemTheme()` resolves to — and a dark OS resolves to `DEFAULT_THEME`,
    /// which is Graphite. If that default ever moves, this page has to move
    /// with it or the browser tab and the window disagree about the brand.
    #[test]
    fn the_dark_ground_is_the_apps_default_theme() {
        let graphite = CSS_SRC
            .split(r#":root[data-theme="graphite"]"#)
            .nth(1)
            .expect("global.css no longer has a graphite block");
        // A *declaration*, not the first mention: the block's own comment
        // opens "Ratios against --paper: hi 16.6, …", which is what a naive
        // split finds first.
        let paper = graphite
            .lines()
            .find_map(|l| l.trim().strip_prefix("--paper:"))
            .and_then(|v| v.split(';').next())
            .expect("graphite block has no --paper declaration")
            .trim();
        let page = success_page();
        assert!(
            page.contains(&format!("--bg-window:  {paper};")),
            "the callback page's ground is not Graphite's --paper ({paper})"
        );
    }

    /// Not an assertion — the only way to actually look at this page, which is
    /// otherwise reachable for about two seconds in the middle of an OAuth
    /// round trip. Writes the real bytes the browser is served; open the file,
    /// or screenshot it, and flip `prefers-color-scheme` to check Daybreak.
    ///
    ///   cargo test -p flock-desktop --lib -- --ignored dump_the_page
    #[test]
    #[ignore]
    fn dump_the_page() {
        let out = std::env::temp_dir().join("flock-auth-callback.html");
        std::fs::write(&out, success_page()).unwrap();
        eprintln!("wrote {}", out.display());
    }

    /// Both wingbeat frames render, and the eye stays punched through to the
    /// page rather than being painted a colour.
    #[test]
    fn both_frames_and_the_word_render() {
        let page = success_page();
        assert!(page.contains("class=\"up\"") && page.contains("class=\"down\""));
        // The eye is drawn, dark, as in the bird's reference drawing; it no
        // longer punches through to the page.
        assert!(page.contains(".g-k{fill:#0e1117}"));
        assert!(page.contains("class=\"wm-c wm-c1\""), "the wordmark's crest is missing");
        for slot in ["__GOOSE_UP__", "__GOOSE_DOWN__", "__WORDMARK__", "__FONTS__"] {
            assert!(!page.contains(slot), "{slot} was never filled in");
        }
    }
}
