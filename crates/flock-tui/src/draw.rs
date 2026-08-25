use crate::{
    layout::SplitDir,
    theme,
    App, Dialog, DialogKind, HeaderAction, Mode, PaneId, PaneState, WorkspaceState,
};
use flock_core::AgentStatus;
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

// ─── Top-level render ─────────────────────────────────────────────────────────

pub fn render(f: &mut Frame, app: &mut App) {
    let area = f.area();
    app.terminal_size = (area.width, area.height);

    // Clear hit areas — they are rebuilt every frame
    app.hit.workspace_cards.clear();
    app.hit.panes.clear();
    app.hit.split_borders.clear();
    app.hit.header_buttons.clear();

    let rail_rect = Rect { x: 0, y: 0, width: crate::RAIL_W, height: area.height.saturating_sub(1) };
    let status_rect = Rect { x: 0, y: area.height.saturating_sub(1), width: area.width, height: 1 };
    let main_rect = Rect {
        x: crate::RAIL_W,
        y: 0,
        width: area.width.saturating_sub(crate::RAIL_W),
        height: area.height.saturating_sub(1),
    };
    let header_rect = Rect { height: 1, ..main_rect };
    let content_rect = Rect {
        y: main_rect.y + 1,
        height: main_rect.height.saturating_sub(1),
        ..main_rect
    };

    render_sidebar(f, app, rail_rect);
    render_pane_header(f, app, header_rect);
    render_panes(f, app, content_rect);
    render_status_bar(f, app, status_rect);

    if let Some(ref dialog) = app.dialog {
        render_dialog(f, dialog, area, app);
    }

    if app.context_menu.is_some() {
        render_context_menu(f, app, area);
    }
}

// ─── Sidebar — logo + three-panel layout ──────────────────────────────────────
//
//  flock                       ← italic mint wordmark
//  ════════════════════════════ ← thick separator
//  ─ WORKSPACES ──────── [+] ─ ← section header
//  ▌ ws-name           ●WORK   ← colored left bar + name + status
//    @main · claude · 2p       ← meta line
//  ─────────────────────────── ← thin card divider
//  ─ AGENTS ─────────────────  ← section header
//  ▌ ws-name                   ← workspace group (workspace color)
//    ● claude   working         ← agent + status
//    · bash     idle
//  ─ PULL REQUESTS ──────────  ← section header
//    ⊘ GitHub not connected

const SEP_COLOR: Color = Color::Rgb(0x18, 0x20, 0x2E);
const SEP_DIM: Color = Color::Rgb(0x12, 0x16, 0x22);

fn render_sidebar(f: &mut Frame, app: &mut App, area: Rect) {
    // Background + right border
    f.render_widget(
        Block::default()
            .borders(Borders::RIGHT)
            .border_style(Style::default().fg(SEP_COLOR))
            .style(Style::default().bg(theme::BG_SIDEBAR)),
        area,
    );

    let w = area.width.saturating_sub(1);
    let total_h = area.height;

    // ── Heights ──────────────────────────────────────────────────────────────
    const LOGO_H: u16 = 4; // blank + flock + blank + thick sep

    let ws_count = app.workspaces.len();
    // 3 rows per card (name + meta + divider), minimum 4 rows of content
    let ws_content_h = (ws_count as u16 * 3).max(4);
    let ws_section_h = (2 + ws_content_h)                // header(1) + sep(1) + content
        .min(total_h.saturating_sub(LOGO_H) * 42 / 100)
        .max(5);

    let agent_rows: u16 = app.workspaces.iter()
        .map(|ws| {
            let n = ws.panes.values().filter(|p| p.agent.is_some()).count() as u16;
            if n > 0 { n + 1 } else { 0 } // +1 for group header
        })
        .sum::<u16>()
        .max(3);
    let agents_section_h = (2 + agent_rows)
        .min(total_h.saturating_sub(LOGO_H) * 36 / 100)
        .max(5);

    let prs_section_h = total_h
        .saturating_sub(LOGO_H + ws_section_h + agents_section_h)
        .max(4);

    let logo_rect = Rect { x: area.x, y: area.y, width: w, height: LOGO_H };
    let ws_rect   = Rect { x: area.x, y: area.y + LOGO_H,                              width: w, height: ws_section_h };
    let ag_rect   = Rect { x: area.x, y: area.y + LOGO_H + ws_section_h,               width: w, height: agents_section_h };
    let prs_rect  = Rect { x: area.x, y: area.y + LOGO_H + ws_section_h + agents_section_h, width: w, height: prs_section_h };

    render_logo(f, logo_rect);
    render_workspaces_section(f, app, ws_rect);
    render_agents_section(f, app, ag_rect);
    render_prs_section(f, app, prs_rect);
}

// ── Logo ──────────────────────────────────────────────────────────────────────

fn render_logo(f: &mut Frame, area: Rect) {
    // Row 0: blank breathing room
    // Row 1: "flock" — italic mint, the wordmark (never sentence-cased)
    // Row 2: blank
    // Row 3: thick separator
    //
    // The wordmark stands alone — there is no second word under it.
    let lines = vec![
        Line::raw(""),
        Line::from(vec![
            Span::raw(" "),
            Span::styled(
                "flock",
                Style::default()
                    .fg(theme::MINT)
                    .add_modifier(Modifier::ITALIC)
                    .add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::raw(""),
        // Thick separator — doubles as the logo underline
        Line::from(Span::styled(
            "═".repeat(area.width as usize),
            Style::default().fg(SEP_COLOR),
        )),
    ];
    f.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme::BG_SIDEBAR)),
        area,
    );
}

// ── Shared: labeled section header ───────────────────────────────────────────

fn section_header_line(label: &str, w: u16) -> Line<'static> {
    let label_str = format!(" {} ", label);
    let label_len = label_str.len() as u16;
    let fill = w.saturating_sub(1 + label_len);
    Line::from(vec![
        Span::styled("─", Style::default().fg(SEP_COLOR)),
        Span::styled(
            label_str,
            Style::default().fg(theme::TEXT_MID).add_modifier(Modifier::BOLD),
        ),
        Span::styled("─".repeat(fill as usize), Style::default().fg(SEP_COLOR)),
    ])
}

fn thin_divider(w: u16) -> Line<'static> {
    Line::from(Span::styled(
        "─".repeat(w as usize),
        Style::default().fg(SEP_DIM),
    ))
}

// ── Section 1: Workspaces ─────────────────────────────────────────────────────

fn render_workspaces_section(f: &mut Frame, app: &mut App, area: Rect) {
    let w = area.width;
    let mut y = area.y;

    // Section header with [+] button on the right
    let header = {
        let label = " WORKSPACES ";
        let label_len = label.len() as u16;
        let btn = "[+]";
        let btn_len = btn.len() as u16;
        let fill = w.saturating_sub(1 + label_len + btn_len + 1);
        Line::from(vec![
            Span::styled("─", Style::default().fg(SEP_COLOR)),
            Span::styled(label, Style::default().fg(theme::TEXT_MID).add_modifier(Modifier::BOLD)),
            Span::styled("─".repeat(fill as usize), Style::default().fg(SEP_COLOR)),
            Span::styled(btn, Style::default().fg(theme::MINT).add_modifier(Modifier::BOLD)),
            Span::styled("─", Style::default().fg(SEP_COLOR)),
        ])
    };
    f.render_widget(
        Paragraph::new(header).style(Style::default().bg(theme::BG_SIDEBAR)),
        Rect { x: area.x, y, width: w, height: 1 },
    );
    // [+] hit area — last 4 cols of the header row
    app.hit.new_workspace_btn = Rect { x: area.x + w.saturating_sub(4), y, width: 3, height: 1 };
    y += 1;

    let bottom = area.y + area.height;
    if y >= bottom { return; }

    if app.workspaces.is_empty() {
        f.render_widget(
            Paragraph::new(vec![
                Line::raw(""),
                Line::from(Span::styled(
                    "  click [+] or press  n",
                    theme::status_dim(),
                )),
                Line::from(Span::styled(
                    "  to create a workspace",
                    theme::status_dim(),
                )),
            ])
            .style(Style::default().bg(theme::BG_SIDEBAR)),
            Rect { x: area.x, y, width: w, height: bottom - y },
        );
        return;
    }

    // 3 rows per card: name | meta | divider
    const CARD_H: u16 = 3;
    let slots = ((bottom - y) / CARD_H) as usize;
    let end = (app.ws_scroll + slots).min(app.workspaces.len());

    for (rel, ws_state) in app.workspaces[app.ws_scroll..end].iter().enumerate() {
        if y + CARD_H > bottom { break; }
        let ws_idx = rel + app.ws_scroll;

        // The clickable area covers all 3 rows of the card
        let card_rect = Rect { x: area.x, y, width: w, height: CARD_H };
        app.hit.workspace_cards.push((ws_idx, card_rect));

        render_workspace_card(f, ws_state, ws_idx, ws_idx == app.focused_ws, area.x, y, w);
        y += CARD_H;
    }

    let remaining = app.workspaces.len().saturating_sub(end);
    if remaining > 0 && y < bottom {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                format!("  ↓ {} more workspaces", remaining),
                theme::status_dim(),
            )))
            .style(Style::default().bg(theme::BG_SIDEBAR)),
            Rect { x: area.x, y, width: w, height: 1 },
        );
    }
}

fn render_workspace_card(
    f: &mut Frame,
    ws: &WorkspaceState,
    ws_idx: usize,
    focused: bool,
    x: u16, y: u16, w: u16,
) {
    let status = ws.rollup_status();
    let attention = ws.any_attention() && !focused;
    let accent = theme::ws_color(ws_idx);
    let bg = if focused { Color::Rgb(0x0C, 0x11, 0x1C) } else { theme::BG_SIDEBAR };

    // ── Line 1: ▌ name ──────────── ● ────────────────────────────────────────
    let indicator_color = if focused { accent }
        else if attention { theme::YELLOW }
        else { SEP_COLOR };

    let name_style = if focused {
        Style::default().fg(accent).add_modifier(Modifier::BOLD)
    } else if attention {
        Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme::TEXT_MID)
    };

    let dot = status_dot(status, attention);
    let name = truncate(&ws.workspace.name, 16);
    let name_len = name.chars().count() as u16;
    let pad = w.saturating_sub(2 + name_len + 2); // ▌ space | name | pad | dot

    let line1 = Line::from(vec![
        Span::styled("▌ ", Style::default().fg(indicator_color)),
        Span::styled(name, name_style),
        Span::styled(" ".repeat(pad.max(1) as usize), Style::default()),
        dot,
    ]);

    // ── Line 2: meta ─────────────────────────────────────────────────────────
    let ag = ws.total_agents();
    let pc = ws.pane_count();
    // Identify the agent kinds in use
    let kinds: Vec<String> = ws.panes.values()
        .filter_map(|p| p.agent.as_ref().map(|a| a.kind.clone()))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let kind_str = if kinds.is_empty() { String::new() } else {
        format!("  {}", truncate(&kinds.join(","), 8))
    };

    let meta = format!(
        "  @{}{}{}",
        truncate(&ws.workspace.branch, 8),
        kind_str,
        match (ag, pc) {
            (0, _) => "".to_string(),
            (n, 1) => format!("  {n}ag"),
            (n, p) => format!("  {n}ag {p}p"),
        }
    );
    let line2 = Line::from(Span::styled(meta, Style::default().fg(theme::TEXT_LOW)));

    // ── Line 3: thin divider ─────────────────────────────────────────────────
    let line3 = thin_divider(w);

    f.render_widget(
        Paragraph::new(vec![line1, line2, line3]).style(Style::default().bg(bg)),
        Rect { x, y, width: w, height: 3 },
    );
}

// ── Section 2: Agents ────────────────────────────────────────────────────────

fn render_agents_section(f: &mut Frame, app: &App, area: Rect) {
    let w = area.width;
    let mut y = area.y;

    f.render_widget(
        Paragraph::new(section_header_line("AGENTS", w)).style(Style::default().bg(theme::BG_SIDEBAR)),
        Rect { x: area.x, y, width: w, height: 1 },
    );
    y += 1;

    let bottom = area.y + area.height;
    if y >= bottom { return; }

    if !app.workspaces.iter().any(|ws| ws.total_agents() > 0) {
        f.render_widget(
            Paragraph::new(vec![
                Line::raw(""),
                Line::from(Span::styled("  no agents running", theme::status_dim())),
                Line::from(Span::styled("  right-click a pane", theme::status_dim())),
                Line::from(Span::styled("  to spawn one", theme::status_dim())),
            ])
            .style(Style::default().bg(theme::BG_SIDEBAR)),
            Rect { x: area.x, y, width: w, height: bottom - y },
        );
        return;
    }

    for (ws_idx, ws) in app.workspaces.iter().enumerate() {
        if ws.total_agents() == 0 { continue; }
        if y >= bottom { break; }
        let accent = theme::ws_color(ws_idx);

        // Workspace group header
        f.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("▌ ", Style::default().fg(accent)),
                Span::styled(
                    truncate(&ws.workspace.name, w.saturating_sub(3) as usize),
                    Style::default().fg(accent).add_modifier(Modifier::BOLD),
                ),
            ]))
            .style(Style::default().bg(theme::BG_SIDEBAR)),
            Rect { x: area.x, y, width: w, height: 1 },
        );
        y += 1;

        for pane in ws.panes.values() {
            if y >= bottom { break; }
            let agent = match &pane.agent { Some(a) => a, None => continue };
            let status = agent.current_status.try_read()
                .map(|g| *g)
                .unwrap_or(AgentStatus::Idle);

            let (status_dot_ch, status_label, dot_style, label_style) = match_agent_status(status, pane.attention);

            f.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(status_dot_ch, dot_style),
                    Span::raw(" "),
                    Span::styled(
                        truncate(&agent.kind, 9),
                        Style::default().fg(theme::TEXT_MID),
                    ),
                    Span::raw("  "),
                    Span::styled(status_label, label_style),
                ]))
                .style(Style::default().bg(theme::BG_SIDEBAR)),
                Rect { x: area.x, y, width: w, height: 1 },
            );
            y += 1;
        }

        // Small gap between workspace groups
        if y < bottom {
            f.render_widget(
                Paragraph::new(Line::raw("")).style(Style::default().bg(theme::BG_SIDEBAR)),
                Rect { x: area.x, y, width: w, height: 1 },
            );
            y += 1;
        }
    }
}

fn match_agent_status(status: AgentStatus, attention: bool) -> (&'static str, &'static str, Style, Style) {
    if attention && matches!(status, AgentStatus::AwaitingInput) {
        return (
            "●", "awaiting input!",
            Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
            Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
        );
    }
    match status {
        AgentStatus::Idle => (
            "·", "idle",
            Style::default().fg(theme::TEXT_LOW),
            Style::default().fg(theme::TEXT_LOW),
        ),
        AgentStatus::Working => (
            "●", "working",
            Style::default().fg(theme::MINT),
            Style::default().fg(theme::MINT),
        ),
        AgentStatus::AwaitingInput => (
            "●", "awaiting input",
            Style::default().fg(theme::YELLOW),
            Style::default().fg(theme::YELLOW),
        ),
        AgentStatus::Blocked => (
            "◆", "blocked",
            Style::default().fg(Color::Rgb(0xFF, 0xA0, 0x00)),
            Style::default().fg(Color::Rgb(0xFF, 0xA0, 0x00)),
        ),
        AgentStatus::Done => (
            "✓", "done",
            Style::default().fg(theme::BLUE),
            Style::default().fg(theme::TEXT_LOW),
        ),
        AgentStatus::Failed => (
            "✗", "failed",
            Style::default().fg(theme::ORANGE).add_modifier(Modifier::BOLD),
            Style::default().fg(theme::ORANGE),
        ),
    }
}

// ── Section 3: Pull Requests ─────────────────────────────────────────────────

fn render_prs_section(f: &mut Frame, app: &App, area: Rect) {
    let w = area.width;
    let mut y = area.y;

    f.render_widget(
        Paragraph::new(section_header_line("PULL REQUESTS", w)).style(Style::default().bg(theme::BG_SIDEBAR)),
        Rect { x: area.x, y, width: w, height: 1 },
    );
    y += 1;

    let bottom = area.y + area.height;
    if y >= bottom { return; }

    if app.github_connected {
        f.render_widget(
            Paragraph::new(vec![
                Line::raw(""),
                Line::from(Span::styled("  ○ no open PRs", theme::status_dim())),
                Line::from(Span::styled("  GitHub phase 4 →", Style::default().fg(SEP_COLOR))),
            ])
            .style(Style::default().bg(theme::BG_SIDEBAR)),
            Rect { x: area.x, y, width: w, height: bottom - y },
        );
    } else {
        f.render_widget(
            Paragraph::new(vec![
                Line::raw(""),
                Line::from(Span::styled(
                    "  ⊘ GitHub not connected",
                    Style::default().fg(theme::TEXT_LOW),
                )),
                Line::raw(""),
                Line::from(Span::styled(
                    "  export GITHUB_TOKEN",
                    Style::default().fg(SEP_COLOR),
                )),
                Line::from(Span::styled(
                    "  or  gh auth login",
                    Style::default().fg(SEP_COLOR),
                )),
            ])
            .style(Style::default().bg(theme::BG_SIDEBAR)),
            Rect { x: area.x, y, width: w, height: bottom - y },
        );
    }
}

// ─── Pane header bar ──────────────────────────────────────────────────────────

fn render_pane_header(f: &mut Frame, app: &mut App, rect: Rect) {
    let ws = match app.focused_ws_state() {
        Some(ws) => ws,
        None => {
            f.render_widget(
                Paragraph::new(Line::from(Span::styled(
                    // Lowercase even in a kicker that used to shout: the
                    // logotype is lowercase-committed everywhere a user sees it.
                    "  // flock  —  press n to create a workspace",
                    theme::status_dim(),
                )))
                .style(Style::default().bg(theme::BG_CHROME)),
                rect,
            );
            return;
        }
    };

    let status = ws.rollup_status();
    let dot = status_dot(status, ws.any_attention());

    let mode_span = match app.mode {
        Mode::Input => Span::styled("[input] ", Style::default().fg(theme::MINT).add_modifier(Modifier::BOLD)),
        _ => Span::styled("[normal] ", Style::default().fg(theme::TEXT_LOW)),
    };

    let zoomed = ws.zoomed;
    let pane_c = ws.pane_count();

    // Build action buttons — rightmost part of header
    // We'll place them at fixed positions from the right
    let btn_w = 4u16; // each button
    let btn_gap = 1u16;
    let buttons: &[(&str, HeaderAction)] = &[
        ("[↔]", HeaderAction::SplitRight),
        ("[↕]", HeaderAction::SplitDown),
        (if zoomed { "[⊟]" } else { "[⊡]" }, HeaderAction::ZoomToggle),
        ("[×]", HeaderAction::ClosePane),
    ];

    // Calculate button positions from right
    let total_btn_w = buttons.len() as u16 * (btn_w + btn_gap);
    let info_width = rect.width.saturating_sub(total_btn_w + 2);

    // Render info section
    let info_line = Line::from(vec![
        Span::styled("  // ", theme::section_label()),
        Span::styled(ws.workspace.name.clone(), theme::workspace_selected()),
        Span::styled(format!("  @{}", ws.workspace.branch), Style::default().fg(theme::TEXT_LOW)),
        Span::raw("  "),
        dot,
        Span::raw("  "),
        mode_span,
    ]);
    f.render_widget(
        Paragraph::new(info_line).style(Style::default().bg(theme::BG_CHROME)),
        rect,
    );

    // Render buttons on the right
    app.hit.header_buttons.clear();
    let mut btn_x = rect.x + rect.width.saturating_sub(total_btn_w);
    for (label, action) in buttons {
        let btn_rect = Rect { x: btn_x, y: rect.y, width: btn_w, height: 1 };

        let (btn_style, bg) = match action {
            HeaderAction::ClosePane => (Style::default().fg(theme::ORANGE), theme::BG_CHROME),
            HeaderAction::ZoomToggle if zoomed => (Style::default().fg(theme::YELLOW), theme::BG_CHROME),
            _ => (Style::default().fg(theme::TEXT_MID), theme::BG_CHROME),
        };

        f.render_widget(
            Paragraph::new(Span::styled(*label, btn_style)).style(Style::default().bg(bg)),
            btn_rect,
        );
        if pane_c > 1 || matches!(action, HeaderAction::SplitRight | HeaderAction::SplitDown) {
            app.hit.header_buttons.push((*action, btn_rect));
        }
        btn_x += btn_w + btn_gap;
    }
}

// ─── Pane grid ────────────────────────────────────────────────────────────────

fn render_panes(f: &mut Frame, app: &mut App, area: Rect) {
    // Collect all data from workspace before any mutable borrows of app.hit
    let (pane_layout, focused_pane, borders, zoomed, in_input, pane_data) = {
        let ws = match app.focused_ws_state() {
            Some(ws) => ws,
            None => { render_splash(f, area); return; }
        };
        if ws.panes.is_empty() { render_splash(f, area); return; }

        let layout = ws.pane_layout(area);
        let focused = ws.focused_pane.clone();
        let borders = if !ws.zoomed { ws.layout.split_borders(area) } else { vec![] };
        let zoomed = ws.zoomed;

        // Snapshot pane rendering data: (pane_id, rect, is_focused, has_agent, attention, screen snapshot)
        let pane_data: Vec<(PaneId, Rect, bool, bool, bool)> = layout
            .iter()
            .map(|(pid, rect)| {
                let is_foc = *pid == focused;
                let p = ws.panes.get(pid);
                let has_agent = p.map_or(false, |p| p.agent.is_some());
                let attention = p.map_or(false, |p| p.attention);
                (pid.clone(), *rect, is_foc, has_agent, attention)
            })
            .collect();

        (layout, focused, borders, zoomed, app.mode == Mode::Input, pane_data)
    };

    // Update hit areas
    for b in borders.clone() { app.hit.split_borders.push(b); }
    for (pane_id, rect, _, _, _) in &pane_data {
        app.hit.panes.push((pane_id.clone(), *rect));
    }

    let multi = pane_layout.len() > 1;

    // Render each pane
    for (pane_id, pane_rect, is_focused, has_agent, attention) in &pane_data {
        if multi {
            // Render border directly
            let (border_style, title_style) = if *attention {
                (Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD), Style::default().fg(theme::YELLOW))
            } else if *is_focused && in_input {
                (Style::default().fg(theme::MINT), Style::default().fg(theme::MINT))
            } else if *is_focused {
                (Style::default().fg(theme::TEXT_MID), Style::default().fg(theme::TEXT_MID))
            } else {
                (Style::default().fg(theme::TEXT_LOW), Style::default().fg(theme::TEXT_LOW))
            };
            let dot = if *has_agent { "●" } else { "·" };
            let status_ch = if *attention { "⚠ " } else { "" };
            f.render_widget(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(border_style)
                    .title(Span::styled(format!(" {}{} ", status_ch, dot), title_style))
                    .style(Style::default().bg(theme::BG)),
                *pane_rect,
            );
        }

        let content = if multi {
            Rect {
                x: pane_rect.x + 1,
                y: pane_rect.y + 1,
                width: pane_rect.width.saturating_sub(2),
                height: pane_rect.height.saturating_sub(2),
            }
        } else {
            *pane_rect
        };

        if content.width > 0 && content.height > 0 {
            // Borrow pane immutably from app for rendering
            if let Some(pane_state) = app.workspaces.get(app.focused_ws).and_then(|ws| ws.panes.get(pane_id)) {
                render_pane_content(f, pane_state, content);
            } else {
                render_empty_pane(f, content);
            }
        }
    }

    // Draw split border resize handles
    for border in &borders {
        render_split_border(f, border);
    }
}


fn render_split_border(f: &mut Frame, border: &crate::layout::SplitBorder) {
    let style = Style::default().fg(Color::Rgb(0x20, 0x25, 0x32)).bg(Color::Rgb(0x0A, 0x0C, 0x12));
    let content = match border.dir {
        SplitDir::Horizontal => "│".repeat(border.rect.height as usize),
        SplitDir::Vertical => "─".repeat(border.rect.width as usize),
    };
    f.render_widget(
        Paragraph::new(content).style(style),
        border.rect,
    );
}

fn render_pane_content(f: &mut Frame, pane: &PaneState, area: Rect) {
    let screen = pane.screen.screen();
    let (screen_rows, screen_cols) = screen.size();
    let h = area.height as usize;
    let w = area.width as usize;

    let start_row = (screen_rows as usize).saturating_sub(h) as u16;

    let mut lines: Vec<Line> = Vec::with_capacity(h);
    for row in start_row..screen_rows {
        let mut spans: Vec<Span> = Vec::with_capacity(w);
        for col in 0..screen_cols.min(w as u16) {
            if let Some(cell) = screen.cell(row, col) {
                let ch = cell.contents();
                let display = if ch.is_empty() { " ".to_string() } else { ch.to_string() };
                spans.push(Span::styled(display, cell_to_style(cell)));
            }
        }
        // Pad to area width
        let rendered = spans.iter().map(|s| s.content.chars().count()).sum::<usize>();
        if rendered < w {
            spans.push(Span::styled(" ".repeat(w - rendered), Style::default().bg(theme::BG)));
        }
        lines.push(Line::from(spans));
    }
    while lines.len() < h {
        lines.push(Line::raw(" ".repeat(w)));
    }

    f.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme::BG)),
        area,
    );
}

fn render_empty_pane(f: &mut Frame, area: Rect) {
    f.render_widget(
        Paragraph::new(vec![
            Line::raw(""),
            Line::from(Span::styled("  right-click to spawn an agent", theme::status_dim())),
        ])
        .style(Style::default().bg(theme::BG)),
        area,
    );
}

fn render_splash(f: &mut Frame, area: Rect) {
    let lines = vec![
        Line::raw(""),
        Line::raw(""),
        Line::from(Span::styled(
            "  flock",
            Style::default().fg(theme::MINT).add_modifier(Modifier::ITALIC),
        )),
        Line::raw(""),
        Line::from(Span::styled("  press  n  or click  [+]  to create a workspace", theme::status_dim())),
        Line::raw(""),
        Line::from(Span::styled("  then  right-click  a pane to split or spawn agents", theme::status_dim())),
    ];
    f.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme::BG)),
        area,
    );
}

// ─── Status bar ───────────────────────────────────────────────────────────────
//
// Layout: [ left: stats ] [ center: shortcuts ] [ right: mode ]

fn render_status_bar(f: &mut Frame, app: &App, rect: Rect) {
    use ratatui::layout::{Constraint, Direction, Layout};
    use ratatui::widgets::Paragraph;

    // ── Gather stats ─────────────────────────────────────────────────────────
    let ws_count = app.workspaces.len();
    let total_agents: usize = app.workspaces.iter().map(|ws| ws.total_agents()).sum();
    let total_panes: usize = app.workspaces.iter().map(|ws| ws.pane_count()).sum();

    let (mut working, mut awaiting, mut done, mut failed) = (0usize, 0, 0, 0);
    for ws in &app.workspaces {
        for pane in ws.panes.values() {
            match pane.agent.as_ref()
                .and_then(|a| a.current_status.try_read().ok().map(|g| *g))
                .unwrap_or(AgentStatus::Idle)
            {
                AgentStatus::Working => working += 1,
                AgentStatus::AwaitingInput => awaiting += 1,
                AgentStatus::Done => done += 1,
                AgentStatus::Failed => failed += 1,
                _ => {}
            }
        }
    }

    // ── Left: counts + status summary ────────────────────────────────────────
    let mut left_spans: Vec<Span> = vec![Span::raw(" ")];
    if ws_count > 0 {
        left_spans.push(Span::styled(format!("{ws_count}ws"), theme::status_dim()));
        if total_panes > ws_count {
            left_spans.push(Span::styled(format!(" {total_panes}p"), theme::status_dim()));
        }
        if total_agents > 0 {
            left_spans.push(Span::styled(format!(" {total_agents}ag"), theme::status_dim()));
        }
    }
    if awaiting > 0 {
        left_spans.push(Span::styled(
            format!("  ● {awaiting} awaiting"),
            Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
        ));
    }
    if working > 0 {
        left_spans.push(Span::styled(format!("  {working} working"), theme::status_mint()));
    }
    if done > 0 {
        left_spans.push(Span::styled(format!("  {done} done"), theme::status_blue()));
    }
    if failed > 0 {
        left_spans.push(Span::styled(format!("  {failed} failed"), theme::status_error()));
    }

    // ── Center: context-sensitive shortcuts ───────────────────────────────────
    let shortcuts: &[(&str, &str)] = match app.mode {
        Mode::Input => &[
            ("esc", "normal"),
            ("right-click", "pane options"),
        ],
        Mode::ContextMenu => &[
            ("↑↓", "select"),
            ("↵", "confirm"),
            ("esc", "cancel"),
        ],
        _ => &[
            ("n", "new ws"),
            ("|", "split→"),
            ("-", "split↓"),
            ("z", "zoom"),
            ("x", "close"),
            ("right-click", "menu"),
        ],
    };

    let mut center_spans: Vec<Span> = Vec::new();
    for (i, (key, desc)) in shortcuts.iter().enumerate() {
        if i > 0 {
            center_spans.push(Span::styled("  ", Style::default()));
        }
        center_spans.push(Span::styled(
            format!(" {key} "),
            Style::default()
                .fg(theme::BG_CHROME)
                .bg(theme::TEXT_LOW)
                .add_modifier(Modifier::BOLD),
        ));
        center_spans.push(Span::styled(
            format!(" {desc}"),
            Style::default().fg(theme::TEXT_LOW),
        ));
    }

    // ── Right: mode indicator ─────────────────────────────────────────────────
    let (mode_label, mode_style) = match app.mode {
        Mode::Input => (
            " INPUT ",
            Style::default().fg(theme::BG).bg(theme::MINT).add_modifier(Modifier::BOLD),
        ),
        Mode::ContextMenu => (
            " MENU  ",
            Style::default().fg(theme::BG).bg(theme::YELLOW).add_modifier(Modifier::BOLD),
        ),
        _ => (
            " NORMAL",
            Style::default().fg(theme::TEXT_MID).bg(Color::Rgb(0x14, 0x1A, 0x24)),
        ),
    };
    let kg_dot = if app.kg_available {
        Span::styled(" ⬡", Style::default().fg(theme::MINT))
    } else {
        Span::raw("")
    };

    // ── Layout: three horizontal regions ─────────────────────────────────────
    let left_w = 38u16.min(rect.width / 3);
    let right_w = 10u16;
    let center_w = rect.width.saturating_sub(left_w + right_w);

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(left_w),
            Constraint::Length(center_w),
            Constraint::Length(right_w),
        ])
        .split(rect);

    f.render_widget(
        Paragraph::new(Line::from(left_spans))
            .style(Style::default().bg(theme::BG_CHROME)),
        chunks[0],
    );

    f.render_widget(
        Paragraph::new(Line::from(center_spans))
            .alignment(ratatui::layout::Alignment::Center)
            .style(Style::default().bg(theme::BG_CHROME)),
        chunks[1],
    );

    f.render_widget(
        Paragraph::new(Line::from(vec![
            kg_dot,
            Span::styled(mode_label, mode_style),
        ]))
        .alignment(ratatui::layout::Alignment::Right)
        .style(Style::default().bg(theme::BG_CHROME)),
        chunks[2],
    );
}

// ─── Context menu ─────────────────────────────────────────────────────────────

fn render_context_menu(f: &mut Frame, app: &mut App, _area: Rect) {
    let menu = match &app.context_menu {
        Some(m) => m,
        None => return,
    };

    let w = 26u16;
    let h = (menu.items.len() + 2) as u16;
    let x = menu.x.min(f.area().width.saturating_sub(w));
    let y = menu.y.min(f.area().height.saturating_sub(h));
    let rect = Rect { x, y, width: w, height: h };

    f.render_widget(Clear, rect);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::MINT))
        .style(Style::default().bg(theme::BG_CHROME));
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    let mut lines = Vec::new();
    for (i, item) in menu.items.iter().enumerate() {
        if item.separator {
            lines.push(Line::from(Span::styled(
                "─".repeat(inner.width as usize),
                Style::default().fg(theme::TEXT_LOW),
            )));
        } else {
            let selected = i == menu.selected;
            let style = if selected {
                Style::default().fg(theme::BG).bg(theme::MINT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT_HI)
            };
            let prefix = if selected { " › " } else { "   " };
            lines.push(Line::from(Span::styled(
                format!("{}{}", prefix, item.label),
                style,
            )));
        }
    }
    f.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme::BG_CHROME)),
        inner,
    );
}

// ─── Dialog overlay ───────────────────────────────────────────────────────────

fn render_dialog(f: &mut Frame, dialog: &Dialog, area: Rect, app: &App) {
    let dw = 62u16.min(area.width.saturating_sub(4));
    let dh = 10u16;
    let dx = (area.width.saturating_sub(dw)) / 2;
    let dy = (area.height.saturating_sub(dh)) / 2;
    let rect = Rect { x: area.x + dx, y: area.y + dy, width: dw, height: dh };
    f.render_widget(Clear, rect);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::MINT))
        .style(Style::default().bg(theme::BG_CHROME));
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    match &dialog.kind {
        DialogKind::Setup => render_setup_dialog(f, dialog, inner),
        DialogKind::NewWorkspace => render_text_dialog(f, dialog, inner, "NEW WORKSPACE", "workspace name:", "↵ enter  ·  leave blank for current dir name"),
        DialogKind::RenameWorkspace { .. } => render_text_dialog(f, dialog, inner, "RENAME WORKSPACE", "new name:", "↵ confirm  ·  esc cancel"),
    }
}

fn render_setup_dialog(f: &mut Frame, dialog: &Dialog, area: Rect) {
    let options = [
        ("1", "Claude Code", "claude --dangerously-skip-permissions"),
        ("2", "bash / zsh", "plain shell, no agent"),
    ];
    let mut lines = vec![
        Line::raw(""),
        Line::from(vec![
            Span::styled("  // ", theme::section_label()),
            Span::styled("SETUP", theme::workspace_selected()),
        ]),
        Line::raw(""),
        Line::from(Span::styled("  what coding agent do you use?", Style::default().fg(theme::TEXT_MID))),
        Line::raw(""),
    ];
    for (i, (key, label, hint)) in options.iter().enumerate() {
        let sel = i == dialog.setup_selection;
        let (bullet, ls, hs) = if sel {
            (
                Span::styled("  › ", Style::default().fg(theme::MINT)),
                Style::default().fg(theme::TEXT_HI).add_modifier(Modifier::BOLD),
                Style::default().fg(theme::TEXT_MID),
            )
        } else {
            (
                Span::raw("    "),
                Style::default().fg(theme::TEXT_MID),
                Style::default().fg(theme::TEXT_LOW),
            )
        };
        lines.push(Line::from(vec![
            bullet,
            Span::styled(format!("[{key}] {label}"), ls),
            Span::styled(format!("  — {hint}"), hs),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled("  ↑↓ navigate  ·  ↵ confirm  ·  esc cancel", theme::status_dim())));
    f.render_widget(Paragraph::new(lines).style(Style::default().bg(theme::BG_CHROME)), area);
}

fn render_text_dialog(f: &mut Frame, dialog: &Dialog, area: Rect, title: &str, prompt: &str, hint: &str) {
    let lines = vec![
        Line::raw(""),
        Line::from(vec![
            Span::styled("  // ", theme::section_label()),
            Span::styled(title, theme::workspace_selected()),
        ]),
        Line::raw(""),
        Line::from(Span::styled(format!("  {prompt}"), Style::default().fg(theme::TEXT_MID))),
        Line::from(vec![
            Span::styled("  › ", Style::default().fg(theme::MINT)),
            Span::styled(dialog.input.clone(), Style::default().fg(theme::TEXT_HI)),
            Span::styled("█", Style::default().fg(theme::MINT)),
        ]),
        Line::raw(""),
        Line::from(Span::styled(format!("  {hint}"), theme::status_dim())),
    ];
    f.render_widget(Paragraph::new(lines).style(Style::default().bg(theme::BG_CHROME)), area);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn cell_to_style(cell: &vt100::Cell) -> Style {
    let mut style = Style::default();
    match cell.fgcolor() {
        vt100::Color::Default => { style = style.fg(theme::TEXT_HI); }
        vt100::Color::Idx(i) => { style = style.fg(Color::Indexed(i)); }
        vt100::Color::Rgb(r, g, b) => { style = style.fg(Color::Rgb(r, g, b)); }
    }
    match cell.bgcolor() {
        vt100::Color::Default => {}
        vt100::Color::Idx(i) => { style = style.bg(Color::Indexed(i)); }
        vt100::Color::Rgb(r, g, b) => { style = style.bg(Color::Rgb(r, g, b)); }
    }
    if cell.bold() { style = style.add_modifier(Modifier::BOLD); }
    if cell.italic() { style = style.add_modifier(Modifier::ITALIC); }
    if cell.underline() { style = style.add_modifier(Modifier::UNDERLINED); }
    style
}

fn status_dot(status: AgentStatus, attention: bool) -> Span<'static> {
    if attention && matches!(status, AgentStatus::AwaitingInput) {
        return Span::styled("●⚠", Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD));
    }
    match status {
        AgentStatus::Idle => Span::styled("·", theme::status_dim()),
        AgentStatus::Working => Span::styled("●", theme::status_mint()),
        AgentStatus::AwaitingInput => Span::styled("●", theme::status_yellow()),
        AgentStatus::Blocked => Span::styled("◆", Style::default().fg(Color::Rgb(0xFF, 0xA0, 0x00))),
        AgentStatus::Done => Span::styled("✓", theme::status_blue()),
        AgentStatus::Failed => Span::styled("✗", theme::status_error()),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { return s.to_string(); }
    let cut = s.char_indices().nth(max - 1).map(|(i, _)| i).unwrap_or(s.len());
    format!("{}…", &s[..cut])
}
