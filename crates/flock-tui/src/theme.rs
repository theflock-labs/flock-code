use ratatui::style::{Color, Modifier, Style};

// ─── flock palette ────────────────────────────────────────────────────────────

pub const MINT: Color = Color::Rgb(0x4F, 0xFF, 0xB0);
pub const YELLOW: Color = Color::Rgb(0xE8, 0xFF, 0x3A);
pub const BLUE: Color = Color::Rgb(0x4D, 0xAF, 0xFF);
pub const ORANGE: Color = Color::Rgb(0xFF, 0x70, 0x30);

pub const TEXT_HI: Color = Color::Rgb(0xF0, 0xF4, 0xF8);
pub const TEXT_MID: Color = Color::Rgb(0x6B, 0x75, 0x88);
pub const TEXT_LOW: Color = Color::Rgb(0x4A, 0x52, 0x66);

pub const BG: Color = Color::Rgb(0x06, 0x08, 0x0C);
pub const BG_SIDEBAR: Color = Color::Rgb(0x08, 0x09, 0x0E);
pub const BG_CHROME: Color = Color::Rgb(0x0D, 0x11, 0x19);

// ─── Workspace color palette ──────────────────────────────────────────────────
// 8 distinct colors that stay out of the way of status colors (mint/yellow/orange).
// They cycle when there are more than 8 workspaces.

const WS_PALETTE: [Color; 8] = [
    Color::Rgb(0x4D, 0xAF, 0xFF), // blue
    Color::Rgb(0xC7, 0x92, 0xEA), // violet
    Color::Rgb(0xF7, 0x8C, 0x6C), // peach
    Color::Rgb(0xC3, 0xE8, 0x8D), // sage
    Color::Rgb(0xFF, 0xCB, 0x6B), // gold
    Color::Rgb(0x89, 0xDD, 0xFF), // sky
    Color::Rgb(0xFF, 0x53, 0x70), // rose
    Color::Rgb(0x80, 0xCB, 0xC4), // teal
];

/// Returns the accent color assigned to workspace at `index`.
pub fn ws_color(index: usize) -> Color {
    WS_PALETTE[index % WS_PALETTE.len()]
}

// ─── Styles ───────────────────────────────────────────────────────────────────

pub fn section_label() -> Style {
    Style::default().fg(TEXT_LOW).add_modifier(Modifier::BOLD)
}

pub fn workspace_selected() -> Style {
    Style::default().fg(MINT).add_modifier(Modifier::BOLD)
}

pub fn workspace_normal() -> Style {
    Style::default().fg(TEXT_MID)
}

pub fn status_mint() -> Style {
    Style::default().fg(MINT)
}

pub fn status_yellow() -> Style {
    Style::default().fg(YELLOW).add_modifier(Modifier::BOLD)
}

pub fn status_blue() -> Style {
    Style::default().fg(BLUE)
}

pub fn status_dim() -> Style {
    Style::default().fg(TEXT_LOW)
}

pub fn status_error() -> Style {
    Style::default().fg(ORANGE).add_modifier(Modifier::BOLD)
}
