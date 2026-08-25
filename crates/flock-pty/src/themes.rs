//! flock's Claude Code custom terminal themes, shipped with the app.
//!
//! Claude Code reads custom themes from `~/.claude/themes/*.json` (see
//! <https://code.claude.com/docs/en/terminal-config>). We bundle one per
//! flock app theme so an agent's Claude Code UI matches the workspace it
//! runs in — Nightfall/Daybreak/High-Contrast — instead of a generic preset.
//!
//! The files are the source of truth for their own colors, but the *palette*
//! mirrors `apps/flock-desktop/src/lib/theme.ts` (`XTERM_THEMES`) and the
//! `global.css` token blocks. Claude Code paints on top of the pane's xterm
//! background (it can't set the terminal background itself), so every override
//! was checked for WCAG AA contrast against the exact background each theme
//! renders on (#071122 / #fcfbf8 / #000000). If you retune the palette there,
//! re-derive these and re-check the ratios.
//!
//! Two install paths, mirroring how `container.rs` ships the hook settings:
//!  - host launches use the real `~/.claude/themes/` — [`install_host`], run
//!    once on app startup, keeps the bundled `flock-*.json` in sync with the
//!    app version and never touches user-authored theme files.
//!  - jailed launches get them baked into the image build context by
//!    [`write_into_build_context`] and copied into the container `$HOME` by the
//!    image's `init.bash`.

use std::io;
use std::path::Path;

/// The bundled themes, as `(filename, contents)`. Filenames are stable slugs —
/// selecting one stores `custom:flock-<slug>` as the Claude Code theme
/// preference, so they must not change without also updating `theme_pref_for`.
pub const FILES: &[(&str, &str)] = &[
    (
        "flock-nightfall.json",
        include_str!("themes/flock-nightfall.json"),
    ),
    (
        "flock-daybreak.json",
        include_str!("themes/flock-daybreak.json"),
    ),
    (
        "flock-graphite.json",
        include_str!("themes/flock-graphite.json"),
    ),
    (
        "flock-high-contrast.json",
        include_str!("themes/flock-high-contrast.json"),
    ),
];

/// Concatenation of every bundled theme's contents, folded into the container
/// image tag ([`crate::container::image_tag`]) so editing a theme JSON — which
/// changes what `init.bash` copies in — forces an image rebuild even when the
/// Dockerfile text itself is untouched.
pub fn fingerprint() -> String {
    let mut s = String::new();
    for (name, body) in FILES {
        s.push_str(name);
        s.push('\n');
        s.push_str(body);
        s.push('\n');
    }
    s
}

/// Write the bundled themes into `<claude_dir>/themes/`, creating it if needed.
/// Overwrites our own `flock-*.json` (app-owned, fixed slugs) so a palette
/// change in a new app version propagates; leaves any other file in the folder
/// alone. Idempotent.
///
/// The pre-rebrand `clarence-*.json` files are deliberately NOT removed: a user
/// who picked one through `/theme` has `custom:clarence-<slug>` persisted in
/// their own `~/.claude/settings.json`, which is not ours to rewrite, and
/// deleting the file would leave that preference pointing at nothing.
pub fn install_into(claude_dir: &Path) -> io::Result<()> {
    let dir = claude_dir.join("themes");
    std::fs::create_dir_all(&dir)?;
    for (name, body) in FILES {
        std::fs::write(dir.join(name), body)?;
    }
    Ok(())
}

/// Install into the host user's `~/.claude/themes/`. Best-effort: a missing
/// `$HOME` is not fatal to app startup, so the caller can ignore the error.
pub fn install_host() -> io::Result<()> {
    let home = std::env::var("HOME")
        .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "HOME not set"))?;
    install_into(Path::new(&home).join(".claude").as_path())
}

/// Write the bundled themes into `<ctx>/themes/` of the container build context
/// so the Dockerfile's `COPY themes /etc/flock/themes` picks them up.
pub fn write_into_build_context(ctx: &Path) -> io::Result<()> {
    let dir = ctx.join("themes");
    std::fs::create_dir_all(&dir)?;
    for (name, body) in FILES {
        std::fs::write(dir.join(name), body)?;
    }
    Ok(())
}

/// Map a flock app theme id (as persisted by the frontend: `dark`,
/// `light`, `high-contrast`) to the Claude Code theme preference string that
/// selects the matching bundled theme. Unknown ids fall back to Nightfall.
pub fn theme_pref_for(app_theme: &str) -> &'static str {
    match app_theme {
        "light" => "custom:flock-daybreak",
        "graphite" => "custom:flock-graphite",
        "high-contrast" => "custom:flock-high-contrast",
        _ => "custom:flock-nightfall",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_themes_are_valid_and_well_formed() {
        for (name, body) in FILES {
            assert!(name.starts_with("flock-") && name.ends_with(".json"));
            let v: serde_json::Value =
                serde_json::from_str(body).unwrap_or_else(|e| panic!("{name} is not JSON: {e}"));
            // Claude Code's custom-theme shape: a base preset and overrides.
            assert!(v.get("name").and_then(|n| n.as_str()).is_some(), "{name} needs a name");
            let base = v.get("base").and_then(|b| b.as_str()).expect("base");
            assert!(
                ["dark", "light"].contains(&base),
                "{name} base {base} unexpected"
            );
            assert!(
                v.get("overrides").and_then(|o| o.as_object()).is_some_and(|o| !o.is_empty()),
                "{name} needs overrides"
            );
        }
    }

    #[test]
    fn theme_pref_slugs_match_bundled_filenames() {
        // Every id the frontend can persist must map to a bundled file, so a
        // fresh jail's settings.json never points /theme at a missing slug.
        for id in ["dark", "light", "graphite", "high-contrast", "somethingelse"] {
            let pref = theme_pref_for(id);
            let slug = pref.strip_prefix("custom:").expect("custom: prefix");
            let file = format!("{slug}.json");
            assert!(
                FILES.iter().any(|(n, _)| *n == file),
                "{id} -> {pref} has no bundled {file}"
            );
        }
    }

    #[test]
    fn fingerprint_covers_every_theme() {
        let fp = fingerprint();
        for (name, _) in FILES {
            assert!(fp.contains(name), "fingerprint missing {name}");
        }
    }
}
