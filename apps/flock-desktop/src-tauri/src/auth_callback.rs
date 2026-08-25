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

// The goose, both wingbeat frames — the HD sprite, kept in sync with
// GooseMark.tsx's UPSTROKE / DOWNSTROKE grids. One bird, every theme: the
// `firstlight` palette, and only the eye (`K`) follows the page background.
const UPSTROKE: [&str; 16] = [
    "..........B.B.B.....................",
    "..........BBBBBB....................",
    "..........BBBBBBB...................",
    "..........BBBBBBBB........MMMM......",
    "..........DBBBBBBBB......MMMMMM.....",
    "..........DDBBBBBBBB.....MMMMKM.....",
    "...........DDBBBBBBBB...MMMMMMMYYYY.",
    "..MMM.......DDBBBBBBB..MMMMMMMYYYZ..",
    "..MMMMMMMMMMMMMDBBBBBMMMMMMMMM......",
    "..TTMMMMMMMMMMMMMMMMMMMMMMMM........",
    "...TTMMMMMMMMMMMMMMMMMMMMM..........",
    "....TTTMMMMMMMMMMMMMMMMMM...........",
    "......TTTTMMMMMMMMMMMMM.............",
    "........TTTTTMMMMMMMM...............",
    "....................................",
    "....................................",
];

const DOWNSTROKE: [&str; 16] = [
    "....................................",
    "....................................",
    "....................................",
    "..........................MMMM......",
    ".........................MMMMMM.....",
    ".........................MMMMKM.....",
    "........................MMMMMMMYYYY.",
    "..MMM..................MMMMMMMYYYZ..",
    "..MMMMMMMMMMMMMMMMMMMMMMMMMMMM......",
    "..TTMMMMMMMMBBBBBBBBMMMMMMMM........",
    "...TTMMMMMMMBBBBBBBBBMMMMM..........",
    "....TTTMMMMMBBBBBBBBBMMMM...........",
    "......TTTTMMMDBBBBBBBMM.............",
    "........TTTTTMMDDBBBB...............",
    ".................DDBB...............",
    "...................D................",
];

/// Build one wingbeat frame as an inline SVG of 10px pixel cells
/// (viewBox 360×160). Fills are CSS classes (g-m, g-t, …) so the eye can
/// resolve to the page background per color scheme.
fn goose_svg(grid: &[&str; 16], frame_class: &str) -> String {
    const CELL: u32 = 10;
    let class = |c: char| match c {
        'M' => "g-m",
        'T' => "g-t",
        'B' => "g-b",
        'D' => "g-d",
        'Y' => "g-y",
        'Z' => "g-z",
        'K' => "g-k",
        _ => "g-m",
    };
    let mut rects = String::new();
    for (y, row) in grid.iter().enumerate() {
        for (x, c) in row.chars().enumerate() {
            if c == '.' {
                continue;
            }
            rects.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{CELL}\" height=\"{CELL}\" class=\"{}\"/>",
                x as u32 * CELL,
                y as u32 * CELL,
                class(c),
            ));
        }
    }
    // 92px wide is the exact width SignInGate renders its GooseMark at.
    format!(
        "<svg class=\"{frame_class}\" width=\"92\" height=\"40.9\" viewBox=\"0 0 360 160\" shape-rendering=\"crispEdges\" xmlns=\"http://www.w3.org/2000/svg\">{rects}</svg>"
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
    /* The crest's three hues. Sky, rose and the goose's own wing. Not
       redefined per theme — one palette on every ground, per Wordmark.tsx's
       CREST, which these are identical to. On this ground they measure 7.9,
       10.0 and 11.2 to one, so the stem carries itself unaided. */
    --crest-1:    #62ACFF;
    --crest-2:    #F2A8C4;
    --crest-3:    #FDB89B;
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
      /* No crest override: one palette on every ground, per brand.css. On this
         paper the three measure 2.06, 1.43 and 1.62 to one, so the l reads
         because the four ink letters around it complete the word rather than
         because the stem holds its own. A deeper cut was tried and rejected —
         it turns peach to rust. */
    }
  }
  /* The `firstlight` bird — sky body, apricot wing, gold bill — byte-for-byte
     PALETTES.firstlight in GooseMark.tsx, which is the mark everywhere else in
     the app and on the site.

     This page shipped the blue-and-pink pair that firstlight replaced on
     2026-07-28, and kept it for the reason stale copies always survive: it
     looked fine on the one ground it was written against. It was not fine. The
     wing is drawn on top of the body, so the two are each other's background,
     and blue-on-pink sat 1.09:1 apart — the wing vanished in greyscale, at
     favicon size, and under protanopia and deuteranopia. firstlight is 2.17:1.
     Six values, and they must stay identical to GooseMark.tsx's and to
     flock-website/scripts/generate-goose.py's.
     Only the eye follows the page, the way GooseMark punches `K` through to
     --bg-window. */
  .g-m{fill:#4f89c9} .g-t{fill:#3a6aa7} .g-b{fill:#fdb89b}
  .g-d{fill:#e1957a} .g-y{fill:#e8a962} .g-z{fill:#cb8747}
  .g-k{fill:var(--bg-window)}
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
  .goose { position:relative; width:92px; height:41px; margin:0 auto 18px;
           animation:bob 2.6s ease-in-out infinite; }
  .goose svg { position:absolute; top:0; left:0; }
  .goose .up   { animation:wing-up 0.52s steps(1,end) infinite; }
  .goose .down { animation:wing-down 0.52s steps(1,end) infinite; }
  @keyframes wing-up   { 0%,49.9% { opacity:1 } 50%,100% { opacity:0 } }
  @keyframes wing-down { 0%,49.9% { opacity:0 } 50%,100% { opacity:1 } }
  @keyframes bob { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-5px); } }
  /* The logotype, straight from Wordmark.tsx: Outfit 500, lowercase-committed,
     every letter drawn rather than set, and the `l` doubling as the crest's
     stem. Geometry and timing below are that component's, to the em and to the
     frame — the mark is one mark, and this is the copy of it that lives
     outside React.

     Drawn rather than set for two reasons. The f is no longer Outfit's f as
     shipped: its curl is translated down 10 so the terminal lands on 720, the
     ascender line the l and the k already share. And once one letter is drawn
     the rest must be too — a masked box and a hinted glyph do not land on the
     same baseline at every size, which cost the f a pixel against the k.

     The box spans -10 to 720, not 0 to 720: o and c are round and overshoot
     the baseline, and a mask clips rather than overflowing, so a box starting
     at 0 slices both of them flat. Hence 0.73em and the -0.01em pull. */
  .wm { font-family:"Outfit",sans-serif; font-weight:500; font-size:54px;
        line-height:1; letter-spacing:-0.018em; text-transform:none;
        color:var(--text-hi); white-space:nowrap; margin-bottom:40px; }
  .wm-word { display:inline-block; vertical-align:-0.01em; position:relative;
        width:2.095em; height:0.73em;
        --wm-word:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 -720 2095 730'><path transform='scale(1,-1)' d='M127 0V523Q127 575 151.9 619.9Q177.1 665 223.4 692.4Q270 720 333 720V617Q285 617 261 589.5Q237 562 237 524V0ZM12 380V480H463V380ZM851 -10Q781 -10 724 23.5Q667 57 633.5 114Q600 171 600 241Q600 311 633.5 367Q667 423 724 456.5Q781 490 851 490Q922 490 979 457Q1036 424 1069.5 367.5Q1103 311 1103 241Q1103 171 1069.5 114Q1036 57 979 23.5Q922 -10 851 -10ZM851 96Q892 96 923.5 114.5Q955 133 972.5 166Q990 199 990 241Q990 283 972 315Q954 347 923 365.5Q892 384 851 384Q811 384 779.5 365.5Q748 347 730.5 315Q713 283 713 241Q713 199 730.5 166Q748 133 779.5 114.5Q811 96 851 96ZM1397 -10Q1326 -10 1268.5 23Q1211 56 1178 113Q1145 170 1145 240Q1145 311 1178 367.5Q1211 424 1268.5 457Q1326 490 1397 490Q1453 490 1501.5 468.5Q1550 447 1584 407L1512 334Q1491 359 1461.5 371.5Q1432 384 1397 384Q1356 384 1324.5 365.5Q1293 347 1275.5 315Q1258 283 1258 240Q1258 198 1275.5 165.5Q1293 133 1324.5 114.5Q1356 96 1397 96Q1432 96 1461.5 108.5Q1491 121 1512 146L1584 73Q1550 33 1501.5 11.5Q1453 -10 1397 -10ZM1950 0 1747 245 1949 480H2080L1848 216L1853 279L2090 0ZM1645 0V720H1755V0Z' fill='%23fff'/></svg>");
        --wm-stem:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 -720 2095 730'><path transform='scale(1,-1)' d='M417 0V720H527V0Z' fill='%23fff'/></svg>"); }
  .wm-word::before, .wm-word::after { content:""; position:absolute; inset:0;
        -webkit-mask-size:100% 100%; mask-size:100% 100%;
        -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; }
  .wm-word::before { background:currentColor;
        -webkit-mask-image:var(--wm-word); mask-image:var(--wm-word); }
  /* One paint, one gradient, tiled and always moving — never four stacked
     boxes, and never four stops changing colour in place. Sky, rose, peach
     and back to sky, two stem-heights per tile, drifting up forever. First
     stop and last stop are the same hue and the animation translates by
     exactly one tile (1.44em, being 200% of the 0.72em box), so the loop has
     no seam; linear because any easing would slow the drift at the wrap and
     tick once a cycle. No ink in the gradient at all, so the hues carry
     legibility themselves — see --crest-* and the Daybreak override. */
  .wm-word::after { background-image:linear-gradient(to bottom,
          var(--crest-1) 0%, var(--crest-2) 33.33%,
          var(--crest-3) 66.67%, var(--crest-1) 100%);
        background-size:100% 200%; background-repeat:repeat;
        -webkit-mask-image:var(--wm-stem); mask-image:var(--wm-stem);
        animation:crest 14s linear infinite; }
  /* Sky above rose above peach and a negative translation, so the image
     slides up: a fixed point on the stem meets sky first. The crest rises. */
  @keyframes crest {
    from { background-position:0 0; }
    to   { background-position:0 -1.46em; }
  }
  @media (prefers-reduced-motion: reduce) { .wm-word::after { animation:none; } }
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
    <div class="wm" role="img" aria-label="flock"><span class="wm-word" aria-hidden="true"></span></div>
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
    /// after the app had moved to `firstlight` and defaulted to Graphite, and
    /// nothing failed — the page renders, it is just the wrong brand. So the
    /// copies are pinned against their sources by reading the real files.
    const GOOSE_SRC: &str = include_str!("../../src/components/GooseMark.tsx");
    const WORDMARK_SRC: &str = include_str!("../../src/components/Wordmark.tsx");
    const CSS_SRC: &str = include_str!("../../src/styles/global.css");

    #[test]
    fn the_goose_is_the_apps_own_firstlight_palette() {
        // PALETTES.firstlight in GooseMark.tsx, as the page's CSS classes.
        let line = GOOSE_SRC
            .lines()
            .find(|l| l.trim_start().starts_with("firstlight:"))
            .expect("GooseMark.tsx no longer declares a `firstlight` palette");
        let page = success_page();
        for key in ['M', 'T', 'B', 'D', 'Y', 'Z'] {
            let hex = line
                .split(&format!("{key}: \""))
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .unwrap_or_else(|| panic!("no {key} in firstlight"));
            let class = format!(".g-{}{{fill:{hex}}}", key.to_ascii_lowercase());
            assert!(
                page.contains(&class),
                "the callback page's goose has drifted from GooseMark.tsx: expected {class}"
            );
        }
    }

    /// The wing is drawn over the body, so those two are each other's
    /// background. Blue-on-pink was 1.09:1 and disappeared in greyscale, at
    /// favicon size, and for the two commonest colour deficiencies — which is
    /// why `firstlight` exists. A future palette edit must not undo that.
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
        let r = ratio(&fill("m"), &fill("b"));
        assert!(r > 1.8, "body/wing contrast fell back to {r:.2}:1 (blue+pink was 1.09)");
    }

    /// One crest, every ground — Wordmark.tsx owns the three hues.
    #[test]
    fn the_crest_matches_the_wordmark() {
        let line = WORDMARK_SRC
            .lines()
            .find(|l| l.contains("const CREST"))
            .expect("Wordmark.tsx no longer declares CREST");
        let page = success_page();
        for (i, hex) in line.split('"').filter(|s| s.starts_with('#')).enumerate() {
            let decl = format!("--crest-{}:    {hex};", i + 1);
            assert!(page.contains(&decl), "crest drifted from Wordmark.tsx: expected {decl}");
        }
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
    fn both_frames_render_with_a_knocked_out_eye() {
        let page = success_page();
        assert!(page.contains("class=\"up\"") && page.contains("class=\"down\""));
        assert!(page.contains(".g-k{fill:var(--bg-window)}"));
        assert!(!page.contains("__GOOSE_UP__") && !page.contains("__FONTS__"));
    }
}
