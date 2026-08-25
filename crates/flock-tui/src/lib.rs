mod draw;
mod layout;
mod theme;

pub use layout::{NavDir, Node, PaneId, SplitBorder, SplitDir};

use anyhow::Result;
use flock_core::{AgentHandle, AgentStatus, AppEvent, EventBus, Workspace, WorkspaceManager};
use crossterm::{
    event::{
        DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyCode, KeyModifiers,
        MouseButton, MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::StreamExt;
use ratatui::{backend::CrosstermBackend, layout::Rect, Terminal};
use std::{
    collections::HashMap,
    io::{self, Write as IoWrite},
    path::{Path, PathBuf},
    sync::Arc,
};

// ─── Agent preference ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum AgentPref {
    ClaudeCode,
    Shell,
    Custom(String),
}

impl AgentPref {
    pub fn load() -> Option<Self> {
        let s = std::fs::read_to_string(pref_file()).ok()?;
        Some(match s.trim() {
            "claude" => Self::ClaudeCode,
            "shell" => Self::Shell,
            other => Self::Custom(other.to_string()),
        })
    }

    pub fn save(&self) {
        let _ = std::fs::create_dir_all(flock_core::paths::shared_data_dir());
        let _ = std::fs::write(
            pref_file(),
            match self {
                Self::ClaudeCode => "claude",
                Self::Shell => "shell",
                Self::Custom(s) => s.as_str(),
            },
        );
    }

    pub fn label(&self) -> &str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Shell => "bash",
            Self::Custom(s) => s.as_str(),
        }
    }

    pub fn command(&self, cwd: &Path) -> (String, Vec<String>) {
        match self {
            Self::ClaudeCode => {
                let mut args = vec!["--dangerously-skip-permissions".to_string()];
                if has_claude_session(cwd) {
                    args.insert(0, "-c".to_string());
                }
                ("claude".to_string(), args)
            }
            Self::Shell => ("bash".to_string(), vec![]),
            Self::Custom(s) => {
                let parts: Vec<String> = s.split_whitespace().map(String::from).collect();
                let prog = parts.first().cloned().unwrap_or_else(|| "bash".to_string());
                (prog, parts[1..].to_vec())
            }
        }
    }
}

fn pref_file() -> PathBuf {
    // Through the shared resolver, so a pre-rebrand agent choice travels with
    // the rest of `~/.clarence` instead of silently resetting to the default.
    flock_core::paths::shared_data_dir().join("agent")
}

pub fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn has_claude_session(dir: &Path) -> bool {
    let encoded = dir.to_string_lossy().replace('/', "-");
    let p = home_dir().join(".claude/projects").join(&encoded);
    p.exists() && std::fs::read_dir(&p).map(|d| d.count() > 0).unwrap_or(false)
}

// ─── App state ────────────────────────────────────────────────────────────────

pub struct App {
    pub workspaces: Vec<WorkspaceState>,
    pub focused_ws: usize,
    pub ws_scroll: usize,
    pub mode: Mode,
    pub context_menu: Option<ContextMenu>,
    pub dialog: Option<Dialog>,
    pub drag: Option<DragState>,
    pub kg_available: bool,
    pub agent_pref: Option<AgentPref>,
    /// Checked once at startup via env var + `gh auth status` (non-blocking).
    pub github_connected: bool,
    pub hit: HitAreas,
    pub terminal_size: (u16, u16),
}

pub struct WorkspaceState {
    pub workspace: Workspace,
    pub layout: Node,
    pub panes: HashMap<PaneId, PaneState>,
    pub focused_pane: PaneId,
    pub zoomed: bool,
}

pub struct PaneState {
    pub agent: Option<AgentHandle>,
    pub screen: vt100::Parser,
    pub attention: bool,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Normal,          // keyboard: workspace nav + shortcuts
    Input,           // keyboard → focused pane agent stdin
    ContextMenu,     // right-click menu open
    SetupAgent,      // first-run: which agent?
    RenameWorkspace, // text input
}

// ─── Context menu ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ContextMenu {
    pub x: u16,
    pub y: u16,
    pub items: Vec<MenuItem>,
    pub selected: usize,
    pub kind: ContextMenuKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MenuItem {
    pub label: &'static str,
    pub separator: bool,
}

impl MenuItem {
    fn action(label: &'static str) -> Self { Self { label, separator: false } }
    fn sep() -> Self { Self { label: "─", separator: true } }
}

#[derive(Debug, Clone)]
pub enum ContextMenuKind {
    Workspace { ws_idx: usize },
    Pane { pane_id: PaneId, ws_idx: usize },
}

fn workspace_menu(ws_idx: usize, x: u16, y: u16) -> ContextMenu {
    ContextMenu {
        x, y,
        items: vec![
            MenuItem::action("New Agent Here"),
            MenuItem::sep(),
            MenuItem::action("Rename"),
            MenuItem::action("Delete Workspace"),
        ],
        selected: 0,
        kind: ContextMenuKind::Workspace { ws_idx },
    }
}

fn pane_menu(pane_id: PaneId, ws_idx: usize, x: u16, y: u16, has_agent: bool) -> ContextMenu {
    let mut items = Vec::new();
    if has_agent {
        items.push(MenuItem::action("Restart Agent"));
        items.push(MenuItem::sep());
    } else {
        items.push(MenuItem::action("Spawn Agent"));
        items.push(MenuItem::sep());
    }
    items.push(MenuItem::action("Split Right"));
    items.push(MenuItem::action("Split Down"));
    items.push(MenuItem::sep());
    items.push(MenuItem::action("Zoom / Unzoom"));
    items.push(MenuItem::action("Close Pane"));
    ContextMenu { x, y, items, selected: 0, kind: ContextMenuKind::Pane { pane_id, ws_idx } }
}

// ─── Dialog ───────────────────────────────────────────────────────────────────

pub struct Dialog {
    pub kind: DialogKind,
    pub input: String,
    pub setup_selection: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DialogKind {
    Setup,
    NewWorkspace,
    RenameWorkspace { ws_idx: usize },
}

// ─── Hit areas ────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct HitAreas {
    pub workspace_cards: Vec<(usize, Rect)>,
    pub new_workspace_btn: Rect,
    pub panes: Vec<(PaneId, Rect)>,
    pub split_borders: Vec<SplitBorder>,
    /// Inline header buttons: (action, rect)
    pub header_buttons: Vec<(HeaderAction, Rect)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HeaderAction {
    SplitRight,
    SplitDown,
    ZoomToggle,
    ClosePane,
}

// ─── Drag state ───────────────────────────────────────────────────────────────

pub struct DragState {
    pub border: SplitBorder,
    pub ws_idx: usize,
    pub last_col: u16,
    pub last_row: u16,
}

// ─── Action enum (result of input) ───────────────────────────────────────────

#[derive(PartialEq)]
enum Action {
    Continue,
    Quit,
}

// ─── Layout constants ─────────────────────────────────────────────────────────

pub const RAIL_W: u16 = 32;
const STATUS_H: u16 = 1;
const PANE_HEADER_H: u16 = 1;

impl App {
    fn new(terminal_size: (u16, u16)) -> Self {
        // Non-blocking GitHub check: env var or gh CLI hosts file.
        let github_connected = std::env::var("GITHUB_TOKEN").is_ok()
            || home_dir().join(".config/gh/hosts.yml").exists();
        Self {
            workspaces: Vec::new(),
            focused_ws: 0,
            ws_scroll: 0,
            mode: Mode::Normal,
            context_menu: None,
            dialog: None,
            drag: None,
            kg_available: false,
            agent_pref: AgentPref::load(),
            github_connected,
            hit: HitAreas::default(),
            terminal_size,
        }
    }

    pub fn pane_area(&self) -> Rect {
        let (cols, rows) = self.terminal_size;
        Rect {
            x: RAIL_W,
            y: 0,
            width: cols.saturating_sub(RAIL_W),
            height: rows.saturating_sub(STATUS_H),
        }
    }

    pub fn pane_content_area(&self) -> Rect {
        let a = self.pane_area();
        Rect {
            y: a.y + PANE_HEADER_H,
            height: a.height.saturating_sub(PANE_HEADER_H),
            ..a
        }
    }

    pub fn focused_ws_state(&self) -> Option<&WorkspaceState> {
        self.workspaces.get(self.focused_ws)
    }

    pub fn focused_ws_state_mut(&mut self) -> Option<&mut WorkspaceState> {
        self.workspaces.get_mut(self.focused_ws)
    }

    fn move_focus_ws(&mut self, idx: usize) {
        self.focused_ws = idx.min(self.workspaces.len().saturating_sub(1));
        // Scroll rail to keep focused visible
        if self.focused_ws < self.ws_scroll {
            self.ws_scroll = self.focused_ws;
        } else if self.focused_ws >= self.ws_scroll + 20 {
            self.ws_scroll = self.focused_ws.saturating_sub(19);
        }
    }
}

impl WorkspaceState {
    fn new(workspace: Workspace, pane_rows: u16, pane_cols: u16) -> Self {
        let (layout, pane_id) = Node::new_leaf();
        let mut panes = HashMap::new();
        panes.insert(
            pane_id.clone(),
            PaneState::new(pane_rows, pane_cols),
        );
        Self {
            workspace,
            layout,
            panes,
            focused_pane: pane_id,
            zoomed: false,
        }
    }

    pub fn pane_layout(&self, area: Rect) -> Vec<(PaneId, Rect)> {
        if self.zoomed {
            vec![(self.focused_pane.clone(), area)]
        } else {
            self.layout.layout(area)
        }
    }

    pub fn pane_count(&self) -> usize {
        self.layout.pane_count()
    }

    /// Workspace-level status rollup: most urgent agent status across all panes.
    pub fn rollup_status(&self) -> AgentStatus {
        fn priority(s: AgentStatus) -> u8 {
            match s {
                AgentStatus::AwaitingInput => 5,
                AgentStatus::Blocked => 4,
                AgentStatus::Failed => 3,
                AgentStatus::Working => 2,
                AgentStatus::Done => 1,
                AgentStatus::Idle => 0,
            }
        }
        self.panes.values().fold(AgentStatus::Idle, |acc, pane| {
            let s = pane
                .agent
                .as_ref()
                .and_then(|a| a.current_status.try_read().ok().map(|g| *g))
                .unwrap_or(AgentStatus::Idle);
            if priority(s) > priority(acc) { s } else { acc }
        })
    }

    pub fn any_attention(&self) -> bool {
        self.panes.values().any(|p| p.attention)
    }

    pub fn total_agents(&self) -> usize {
        self.panes.values().filter(|p| p.agent.is_some()).count()
    }
}

impl PaneState {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            agent: None,
            screen: vt100::Parser::new(rows.max(4), cols.max(20), 0),
            attention: false,
            rows,
            cols,
        }
    }

    fn feed(&mut self, data: &[u8]) {
        self.screen.process(data);
    }
}

// ─── Agent spawning ───────────────────────────────────────────────────────────

async fn spawn_pane_agent(
    pane: &mut PaneState,
    pref: &AgentPref,
    cwd: &Path,
    ws_id: &flock_core::WorkspaceId,
    bus: &EventBus,
    wm: &Arc<WorkspaceManager>,
) -> Result<AgentHandle> {
    let (cmd, args) = pref.command(cwd);
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    AgentHandle::spawn(
        ws_id.clone(),
        cmd.clone(),
        &cmd,
        &args_ref,
        Some(cwd),
        pane.rows,
        pane.cols,
        bus.clone(),
        Arc::clone(wm),
    )
    .await
}

// ─── App event application ────────────────────────────────────────────────────

fn apply_event(
    app: &mut App,
    event: AppEvent,
    agent_pane_map: &HashMap<String, (usize, PaneId)>,
) {
    match event {
        AppEvent::AgentOutput { agent_id, data } => {
            if let Some((ws_idx, pane_id)) = agent_pane_map.get(&agent_id.0) {
                if let Some(ws) = app.workspaces.get_mut(*ws_idx) {
                    if let Some(pane) = ws.panes.get_mut(pane_id) {
                        pane.feed(&data);
                    }
                }
            }
        }
        AppEvent::AgentStatusChanged { agent_id, status } => {
            if let Some((ws_idx, pane_id)) = agent_pane_map.get(&agent_id.0) {
                if matches!(status, AgentStatus::AwaitingInput) {
                    if *ws_idx != app.focused_ws {
                        if let Some(ws) = app.workspaces.get_mut(*ws_idx) {
                            if let Some(pane) = ws.panes.get_mut(pane_id) {
                                pane.attention = true;
                            }
                        }
                    }
                    ring_bell();
                }
            }
        }
        AppEvent::AgentExited { .. } => {}
        AppEvent::KgAvailable => app.kg_available = true,
        AppEvent::KgUnavailable => app.kg_available = false,
    }
}

fn ring_bell() {
    let mut out = io::stdout();
    let _ = out.write_all(b"\x07");
    let _ = out.flush();
}

// ─── Keyboard input ───────────────────────────────────────────────────────────

async fn handle_key(
    app: &mut App,
    ev: crossterm::event::KeyEvent,
    cwd: &Path,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<Action> {
    use KeyCode::*;

    // Ctrl-C always quits
    if ev.code == Char('c') && ev.modifiers.contains(KeyModifiers::CONTROL) {
        return Ok(Action::Quit);
    }

    // Escape dismisses overlays first
    if ev.code == Esc {
        if app.context_menu.is_some() { app.context_menu = None; app.mode = Mode::Normal; return Ok(Action::Continue); }
        if app.dialog.is_some() { app.dialog = None; app.mode = Mode::Normal; return Ok(Action::Continue); }
        if app.mode == Mode::Input { app.mode = Mode::Normal; return Ok(Action::Continue); }
    }

    // Dialog / setup intercepts everything
    if let Some(ref dialog) = app.dialog {
        let kind = dialog.kind.clone();
        return handle_dialog_key(app, ev, kind, cwd, wm, bus, agent_pane_map).await;
    }

    // Context menu navigation
    if app.mode == Mode::ContextMenu {
        return handle_context_menu_key(app, cwd, ev, wm, bus, agent_pane_map).await;
    }

    match app.mode {
        Mode::Normal => handle_normal_key(app, ev, cwd, wm, bus, agent_pane_map).await,
        Mode::Input => handle_input_key(app, ev).await,
        _ => Ok(Action::Continue),
    }
}

async fn handle_normal_key(
    app: &mut App,
    ev: crossterm::event::KeyEvent,
    cwd: &Path,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<Action> {
    use KeyCode::*;
    match ev.code {
        Char('q') => return Ok(Action::Quit),

        // Workspace navigation
        Char('j') | Down => {
            let new = (app.focused_ws + 1).min(app.workspaces.len().saturating_sub(1));
            app.move_focus_ws(new);
        }
        Char('k') | Up => {
            let new = app.focused_ws.saturating_sub(1);
            app.move_focus_ws(new);
        }
        Tab => {
            if !app.workspaces.is_empty() {
                let new = (app.focused_ws + 1) % app.workspaces.len();
                app.move_focus_ws(new);
            }
        }

        // Enter input mode
        Char('i') | Enter => {
            if app.focused_ws_state().map_or(false, |ws| ws.panes.values().any(|p| p.agent.is_some())) {
                app.mode = Mode::Input;
            }
        }

        // Pane navigation (hjkl)
        Char('H') | Left => navigate_pane(app, NavDir::Left),
        Char('L') | Right => navigate_pane(app, NavDir::Right),
        Char('K') => navigate_pane(app, NavDir::Up),
        Char('J') => navigate_pane(app, NavDir::Down),

        // New workspace
        Char('n') => open_new_workspace_dialog(app),

        // Add agent to focused pane
        Char('a') => {
            spawn_agent_in_focused_pane(app, cwd, wm, bus, agent_pane_map).await?;
        }

        // Split pane + spawn agent
        Char('|') => split_and_spawn(app, SplitDir::Horizontal, cwd, wm, bus, agent_pane_map).await?,
        Char('-') => split_and_spawn(app, SplitDir::Vertical, cwd, wm, bus, agent_pane_map).await?,

        // Zoom toggle
        Char('z') => {
            if let Some(ws) = app.focused_ws_state_mut() {
                if ws.pane_count() > 1 {
                    ws.zoomed = !ws.zoomed;
                }
            }
        }

        // Close focused pane
        Char('x') => close_focused_pane(app),

        _ => {}
    }
    Ok(Action::Continue)
}

async fn handle_input_key(app: &mut App, ev: crossterm::event::KeyEvent) -> Result<Action> {
    use KeyCode::*;

    let ws = match app.focused_ws_state() { Some(ws) => ws, None => return Ok(Action::Continue) };
    let pane = match ws.panes.get(&ws.focused_pane) { Some(p) => p, None => return Ok(Action::Continue) };
    let agent = match &pane.agent { Some(a) => a, None => { app.mode = Mode::Normal; return Ok(Action::Continue); } };

    match ev.code {
        Char(c) => {
            let mut buf = [0u8; 4];
            let s = c.encode_utf8(&mut buf);
            let _ = agent.send_input(s.as_bytes());
        }
        Enter => { let _ = agent.send_input(b"\r"); }
        Backspace => { let _ = agent.send_input(&[0x7f]); }
        Left => { let _ = agent.send_input(b"\x1b[D"); }
        Right => { let _ = agent.send_input(b"\x1b[C"); }
        Up => { let _ = agent.send_input(b"\x1b[A"); }
        Down => { let _ = agent.send_input(b"\x1b[B"); }
        Tab => { let _ = agent.send_input(b"\t"); }
        Home => { let _ = agent.send_input(b"\x1b[H"); }
        End => { let _ = agent.send_input(b"\x1b[F"); }
        Delete => { let _ = agent.send_input(b"\x1b[3~"); }
        F(n) => {
            let seq = format!("\x1b[{}~", n + 10);
            let _ = agent.send_input(seq.as_bytes());
        }
        _ => {}
    }
    Ok(Action::Continue)
}

async fn handle_dialog_key(
    app: &mut App,
    ev: crossterm::event::KeyEvent,
    kind: DialogKind,
    cwd: &Path,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<Action> {
    use KeyCode::*;
    match kind {
        DialogKind::Setup => {
            match ev.code {
                Esc => { app.dialog = None; app.mode = Mode::Normal; }
                Up | Char('k') => { if let Some(d) = app.dialog.as_mut() { d.setup_selection = d.setup_selection.saturating_sub(1); } }
                Down | Char('j') => { if let Some(d) = app.dialog.as_mut() { d.setup_selection = (d.setup_selection + 1).min(1); } }
                Char('1') => { commit_setup(app, 0); open_new_workspace_dialog(app); }
                Char('2') => { commit_setup(app, 1); open_new_workspace_dialog(app); }
                Enter => {
                    let sel = app.dialog.as_ref().map(|d| d.setup_selection).unwrap_or(0);
                    commit_setup(app, sel);
                    open_new_workspace_dialog(app);
                }
                _ => {}
            }
        }
        DialogKind::NewWorkspace => {
            match ev.code {
                Backspace => { if let Some(d) = app.dialog.as_mut() { d.input.pop(); } }
                Char(c) => { if let Some(d) = app.dialog.as_mut() { d.input.push(c); } }
                Enter => {
                    let name = app.dialog.as_ref().map(|d| {
                        if d.input.trim().is_empty() {
                            cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "workspace".to_string())
                        } else {
                            d.input.trim().to_string()
                        }
                    }).unwrap_or_else(|| "workspace".to_string());

                    app.dialog = None;
                    app.mode = Mode::Normal;
                    create_workspace(app, &name, cwd, wm, bus, agent_pane_map).await?;
                }
                _ => {}
            }
        }
        DialogKind::RenameWorkspace { ws_idx } => {
            match ev.code {
                Backspace => { if let Some(d) = app.dialog.as_mut() { d.input.pop(); } }
                Char(c) => { if let Some(d) = app.dialog.as_mut() { d.input.push(c); } }
                Enter => {
                    let new_name = app.dialog.as_ref().map(|d| d.input.trim().to_string()).unwrap_or_default();
                    app.dialog = None;
                    app.mode = Mode::Normal;
                    if !new_name.is_empty() {
                        if let Some(ws) = app.workspaces.get_mut(ws_idx) {
                            let old = ws.workspace.name.clone();
                            ws.workspace.name = new_name.clone();
                            // Persist to SQLite
                            let ws_id = ws.workspace.id.clone();
                            let _ = sqlx_rename_workspace(wm, &ws_id, &new_name).await;
                            drop(old);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(Action::Continue)
}

async fn sqlx_rename_workspace(
    wm: &Arc<WorkspaceManager>,
    _ws_id: &flock_core::WorkspaceId,
    _name: &str,
) -> Result<()> {
    // WorkspaceManager doesn't expose rename yet — silently ok for now
    drop(wm);
    Ok(())
}

async fn handle_context_menu_key(
    app: &mut App,
    cwd: &Path,
    ev: crossterm::event::KeyEvent,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<Action> {
    use KeyCode::*;
    match ev.code {
        Esc => {
            app.context_menu = None;
            app.mode = Mode::Normal;
        }
        Up | Char('k') => {
            if let Some(menu) = app.context_menu.as_mut() {
                // skip separators
                let n = menu.items.len();
                let mut sel = menu.selected.saturating_sub(1);
                while sel > 0 && menu.items[sel].separator { sel = sel.saturating_sub(1); }
                menu.selected = sel;
            }
        }
        Down | Char('j') => {
            if let Some(menu) = app.context_menu.as_mut() {
                let n = menu.items.len();
                let mut sel = (menu.selected + 1).min(n.saturating_sub(1));
                while sel < n.saturating_sub(1) && menu.items[sel].separator { sel += 1; }
                menu.selected = sel;
            }
        }
        Enter => {
            execute_context_menu(app, cwd, wm, bus, agent_pane_map).await?;
        }
        _ => {}
    }
    Ok(Action::Continue)
}

// ─── Mouse input ──────────────────────────────────────────────────────────────

async fn handle_mouse(
    app: &mut App,
    ev: crossterm::event::MouseEvent,
    cwd: &Path,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<Action> {
    let col = ev.column;
    let row = ev.row;

    match ev.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            // Dismiss context menu on any left click
            if app.context_menu.is_some() {
                // Check if click is on a menu item
                if let Some(selected_item) = context_menu_item_at(app, col, row) {
                    let item_idx = selected_item;
                    if let Some(menu) = app.context_menu.as_mut() {
                        menu.selected = item_idx;
                    }
                    execute_context_menu(app, cwd, wm, bus, agent_pane_map).await?;
                } else {
                    app.context_menu = None;
                    app.mode = Mode::Normal;
                }
                return Ok(Action::Continue);
            }

            // [+] new workspace button
            if rect_hit(&app.hit.new_workspace_btn, col, row) {
                open_new_workspace_dialog(app);
                return Ok(Action::Continue);
            }

            // Workspace card
            if let Some(&(ws_idx, _)) = app.hit.workspace_cards.iter().find(|(_, r)| rect_hit(r, col, row)) {
                if ws_idx == app.focused_ws {
                    // Already focused — enter input mode if has agent
                    if app.focused_ws_state().map_or(false, |ws| ws.panes.values().any(|p| p.agent.is_some())) {
                        app.mode = Mode::Input;
                    }
                } else {
                    app.move_focus_ws(ws_idx);
                    if let Some(ws) = app.workspaces.get_mut(ws_idx) {
                        for p in ws.panes.values_mut() { p.attention = false; }
                    }
                }
                return Ok(Action::Continue);
            }

            // Header action buttons
            if let Some(&(action, _)) = app.hit.header_buttons.iter().find(|(_, r)| rect_hit(r, col, row)) {
                handle_header_action(app, action, cwd, wm, bus, agent_pane_map).await?;
                return Ok(Action::Continue);
            }

            // Start drag on split border
            if let Some(border) = app.hit.split_borders.iter().find(|b| rect_hit(&b.rect, col, row)).cloned() {
                app.drag = Some(DragState {
                    border,
                    ws_idx: app.focused_ws,
                    last_col: col,
                    last_row: row,
                });
                return Ok(Action::Continue);
            }

            // Click inside a pane → focus it + enter input mode
            if let Some((pane_id, _)) = app.hit.panes.iter().find(|(_, r)| rect_hit(r, col, row)).map(|(id, r)| (id.clone(), *r)) {
                if let Some(ws) = app.focused_ws_state_mut() {
                    if ws.focused_pane != pane_id {
                        ws.focused_pane = pane_id.clone();
                        if let Some(p) = ws.panes.get_mut(&pane_id) { p.attention = false; }
                    } else if ws.panes.get(&pane_id).map_or(false, |p| p.agent.is_some()) {
                        app.mode = Mode::Input;
                    }
                }
                return Ok(Action::Continue);
            }
        }

        MouseEventKind::Down(MouseButton::Right) => {
            // Dismiss existing context menu
            app.context_menu = None;

            // Right-click on workspace card
            if let Some(&(ws_idx, _)) = app.hit.workspace_cards.iter().find(|(_, r)| rect_hit(r, col, row)) {
                app.context_menu = Some(workspace_menu(ws_idx, col, row));
                app.mode = Mode::ContextMenu;
                return Ok(Action::Continue);
            }

            // Right-click on a pane
            if let Some((pane_id, _)) = app.hit.panes.iter().find(|(_, r)| rect_hit(r, col, row)).map(|(id, r)| (id.clone(), *r)) {
                let has_agent = app.focused_ws_state().and_then(|ws| ws.panes.get(&pane_id)).map_or(false, |p| p.agent.is_some());
                let ws_idx = app.focused_ws;
                app.context_menu = Some(pane_menu(pane_id, ws_idx, col, row, has_agent));
                app.mode = Mode::ContextMenu;
                return Ok(Action::Continue);
            }
        }

        MouseEventKind::Drag(MouseButton::Left) => {
            if let Some(ref mut drag) = app.drag {
                let ws_idx = drag.ws_idx;
                let path = drag.border.path.clone();
                let dir = drag.border.dir.clone();
                let delta = match dir {
                    SplitDir::Horizontal => {
                        let total_w = drag.border.area.width as f32;
                        if total_w > 0.0 { (col as i32 - drag.last_col as i32) as f32 / total_w } else { 0.0 }
                    }
                    SplitDir::Vertical => {
                        let total_h = drag.border.area.height as f32;
                        if total_h > 0.0 { (row as i32 - drag.last_row as i32) as f32 / total_h } else { 0.0 }
                    }
                };
                drag.last_col = col;
                drag.last_row = row;
                if let Some(ws) = app.workspaces.get_mut(ws_idx) {
                    ws.layout.adjust_ratio(&path, delta);
                }
            }
        }

        MouseEventKind::Up(MouseButton::Left) => {
            app.drag = None;
        }

        MouseEventKind::ScrollUp => {
            if let Some(ws) = app.focused_ws_state() {
                if let Some(p) = ws.panes.get(&ws.focused_pane) {
                    if let Some(a) = &p.agent { let _ = a.send_input(b"\x1b[5~"); }
                }
            }
        }
        MouseEventKind::ScrollDown => {
            if let Some(ws) = app.focused_ws_state() {
                if let Some(p) = ws.panes.get(&ws.focused_pane) {
                    if let Some(a) = &p.agent { let _ = a.send_input(b"\x1b[6~"); }
                }
            }
        }

        _ => {}
    }
    Ok(Action::Continue)
}

fn context_menu_item_at(app: &App, col: u16, row: u16) -> Option<usize> {
    let menu = app.context_menu.as_ref()?;
    let menu_x = menu.x;
    let menu_y = menu.y;
    let width = 28u16;
    if col < menu_x || col >= menu_x + width { return None; }
    let rel_row = row.checked_sub(menu_y)? as usize;
    let rel_row = rel_row.checked_sub(1)?; // account for border
    if rel_row < menu.items.len() && !menu.items[rel_row].separator {
        Some(rel_row)
    } else {
        None
    }
}

// ─── Context menu execution ───────────────────────────────────────────────────

async fn execute_context_menu(
    app: &mut App,
    cwd: &Path,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<()> {
    let menu = match app.context_menu.take() {
        Some(m) => m,
        None => return Ok(()),
    };
    app.mode = Mode::Normal;

    let item = match menu.items.get(menu.selected) {
        Some(i) if !i.separator => i.label,
        _ => return Ok(()),
    };

    match menu.kind {
        ContextMenuKind::Workspace { ws_idx } => match item {
            "New Agent Here" => {
                app.move_focus_ws(ws_idx);
                spawn_agent_in_focused_pane(app, cwd, wm, bus, agent_pane_map).await?;
            }
            "Rename" => {
                let current_name = app.workspaces.get(ws_idx).map(|ws| ws.workspace.name.clone()).unwrap_or_default();
                app.dialog = Some(Dialog {
                    kind: DialogKind::RenameWorkspace { ws_idx },
                    input: current_name,
                    setup_selection: 0,
                });
            }
            "Delete Workspace" => {
                if app.workspaces.len() > 1 {
                    app.workspaces.remove(ws_idx);
                    if app.focused_ws >= app.workspaces.len() {
                        app.focused_ws = app.workspaces.len().saturating_sub(1);
                    }
                }
            }
            _ => {}
        },

        ContextMenuKind::Pane { ref pane_id, ws_idx } => {
            if let Some(ws) = app.workspaces.get_mut(ws_idx) {
                ws.focused_pane = pane_id.clone();
            }
            app.focused_ws = ws_idx;
            match item {
                "Spawn Agent" | "Restart Agent" => {
                    spawn_agent_in_focused_pane(app, cwd, wm, bus, agent_pane_map).await?;
                }
                "Split Right" => split_and_spawn(app, SplitDir::Horizontal, cwd, wm, bus, agent_pane_map).await?,
                "Split Down" => split_and_spawn(app, SplitDir::Vertical, cwd, wm, bus, agent_pane_map).await?,
                "Zoom / Unzoom" => {
                    if let Some(ws) = app.workspaces.get_mut(ws_idx) {
                        if ws.pane_count() > 1 { ws.zoomed = !ws.zoomed; }
                    }
                }
                "Close Pane" => close_focused_pane(app),
                _ => {}
            }
        }
    }
    Ok(())
}

// ─── Header button actions ────────────────────────────────────────────────────

async fn handle_header_action(
    app: &mut App,
    action: HeaderAction,
    cwd: &Path,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<()> {
    match action {
        HeaderAction::SplitRight => split_and_spawn(app, SplitDir::Horizontal, cwd, wm, bus, agent_pane_map).await?,
        HeaderAction::SplitDown => split_and_spawn(app, SplitDir::Vertical, cwd, wm, bus, agent_pane_map).await?,
        HeaderAction::ZoomToggle => {
            if let Some(ws) = app.focused_ws_state_mut() {
                if ws.pane_count() > 1 { ws.zoomed = !ws.zoomed; }
            }
        }
        HeaderAction::ClosePane => close_focused_pane(app),
    }
    Ok(())
}

// ─── Workspace / pane operations ──────────────────────────────────────────────

fn open_new_workspace_dialog(app: &mut App) {
    if app.agent_pref.is_none() {
        app.dialog = Some(Dialog { kind: DialogKind::Setup, input: String::new(), setup_selection: 0 });
    } else {
        app.dialog = Some(Dialog { kind: DialogKind::NewWorkspace, input: String::new(), setup_selection: 0 });
    }
}

fn commit_setup(app: &mut App, selection: usize) {
    let pref = match selection { 1 => AgentPref::Shell, _ => AgentPref::ClaudeCode };
    pref.save();
    app.agent_pref = Some(pref);
    app.dialog = None;
}

async fn create_workspace(
    app: &mut App,
    name: &str,
    cwd: &Path,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<()> {
    let (pane_rows, pane_cols) = pane_dims(app);
    let ws = wm.create(name, &cwd.to_string_lossy(), "main").await?;
    let ws_idx = app.workspaces.len();
    let mut ws_state = WorkspaceState::new(ws, pane_rows, pane_cols);

    // Auto-spawn preferred agent
    if let Some(pref) = app.agent_pref.clone() {
        let pane_id = ws_state.focused_pane.clone();
        let ws_id = ws_state.workspace.id.clone();
        if let Some(pane) = ws_state.panes.get_mut(&pane_id) {
            let agent = spawn_pane_agent(pane, &pref, cwd, &ws_id, bus, wm).await?;
            agent_pane_map.insert(agent.id.0.clone(), (ws_idx, pane_id));
            pane.agent = Some(agent);
        }
    }

    app.workspaces.push(ws_state);
    app.move_focus_ws(ws_idx);
    app.mode = Mode::Input;
    Ok(())
}

async fn spawn_agent_in_focused_pane(
    app: &mut App,
    cwd: &Path,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<()> {
    let pref = match &app.agent_pref {
        Some(p) => p.clone(),
        None => { open_new_workspace_dialog(app); return Ok(()); }
    };
    let ws_idx = app.focused_ws;
    let (ws_id, pane_id) = match app.workspaces.get(ws_idx) {
        Some(ws) => (ws.workspace.id.clone(), ws.focused_pane.clone()),
        None => return Ok(()),
    };

    if let Some(ws) = app.workspaces.get_mut(ws_idx) {
        if let Some(pane) = ws.panes.get_mut(&pane_id) {
            let agent = spawn_pane_agent(pane, &pref, cwd, &ws_id, bus, wm).await?;
            agent_pane_map.insert(agent.id.0.clone(), (ws_idx, pane_id));
            pane.agent = Some(agent);
        }
    }
    app.mode = Mode::Input;
    Ok(())
}

async fn split_and_spawn(
    app: &mut App,
    dir: SplitDir,
    cwd: &Path,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
    agent_pane_map: &mut HashMap<String, (usize, PaneId)>,
) -> Result<()> {
    let ws_idx = app.focused_ws;
    let pref = app.agent_pref.clone();
    let (pane_rows, pane_cols) = pane_dims(app);

    if let Some(ws) = app.workspaces.get_mut(ws_idx) {
        ws.zoomed = false; // exit zoom before splitting
        let focused = ws.focused_pane.clone();
        let (new_layout, new_pane_id) = ws.layout.split(&focused, dir);
        ws.layout = new_layout;
        let mut new_pane = PaneState::new(pane_rows, pane_cols);
        let ws_id = ws.workspace.id.clone();

        if let Some(pref) = pref {
            let agent = spawn_pane_agent(&mut new_pane, &pref, cwd, &ws_id, bus, wm).await?;
            agent_pane_map.insert(agent.id.0.clone(), (ws_idx, new_pane_id.clone()));
            new_pane.agent = Some(agent);
        }

        ws.panes.insert(new_pane_id.clone(), new_pane);
        ws.focused_pane = new_pane_id;
    }
    app.mode = Mode::Input;
    Ok(())
}

fn close_focused_pane(app: &mut App) {
    let ws_idx = app.focused_ws;
    if let Some(ws) = app.workspaces.get_mut(ws_idx) {
        if ws.pane_count() <= 1 { return; } // don't remove last pane
        let focused = ws.focused_pane.clone();
        let new_layout = ws.layout.remove(&focused);
        if let Some(layout) = new_layout {
            ws.layout = layout;
            ws.panes.remove(&focused);
            ws.focused_pane = ws.layout.first_pane_id();
            ws.zoomed = false;
        }
    }
}

fn navigate_pane(app: &mut App, dir: NavDir) {
    let content_area = app.pane_content_area();
    if let Some(ws) = app.focused_ws_state_mut() {
        if ws.zoomed { return; }
        let from = ws.focused_pane.clone();
        if let Some(next) = ws.layout.find_neighbor(&from, dir, content_area) {
            ws.focused_pane = next;
        }
    }
}

fn pane_dims(app: &App) -> (u16, u16) {
    let a = app.pane_content_area();
    (a.height.max(4), a.width.max(20))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

pub fn rect_hit(r: &Rect, col: u16, row: u16) -> bool {
    r.width > 0
        && r.height > 0
        && col >= r.x
        && col < r.x + r.width
        && row >= r.y
        && row < r.y + r.height
}

// ─── Terminal setup / teardown ────────────────────────────────────────────────

fn setup_terminal() -> Result<Terminal<CrosstermBackend<io::Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}

fn restore_terminal(mut terminal: Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor()?;
    Ok(())
}

// ─── Main run loop ────────────────────────────────────────────────────────────

pub async fn run(wm: Arc<WorkspaceManager>, bus: EventBus) -> Result<()> {
    let mut terminal = setup_terminal()?;
    let term_size = crossterm::terminal::size().unwrap_or((200, 50));
    let mut app = App::new(term_size);
    let mut event_stream = EventStream::new();
    let mut bus_rx = bus.subscribe();
    let mut agent_pane_map: HashMap<String, (usize, PaneId)> = HashMap::new();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/tmp"));

    // Restore persisted workspaces
    let (pr, pc) = pane_dims(&app);
    for ws in wm.list().await? {
        app.workspaces.push(WorkspaceState::new(ws, pr, pc));
    }

    // First launch — show setup
    if app.agent_pref.is_none() && app.workspaces.is_empty() {
        app.dialog = Some(Dialog { kind: DialogKind::Setup, input: String::new(), setup_selection: 0 });
    }


    loop {
        terminal.draw(|f| draw::render(f, &mut app))?;

        tokio::select! {
            maybe_ev = event_stream.next() => {
                match maybe_ev {
                    Some(Ok(Event::Key(key))) => {
                        if handle_key(&mut app, key, &cwd, &wm, &bus, &mut agent_pane_map).await? == Action::Quit { break; }
                    }
                    Some(Ok(Event::Mouse(mouse))) => {
                        handle_mouse(&mut app, mouse, &cwd, &wm, &bus, &mut agent_pane_map).await?;
                    }
                    Some(Ok(Event::Resize(cols, rows))) => {
                        app.terminal_size = (cols, rows);
                    }
                    None => break,
                    _ => {}
                }
            }
            ev = bus_rx.recv() => {
                match ev {
                    Ok(e) => apply_event(&mut app, e, &agent_pane_map),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("TUI lagged {n}");
                    }
                    Err(_) => break,
                }
            }
        }
    }

    restore_terminal(terminal)?;
    Ok(())
}
