---
target: flock desktop v2 UI
total_score: 23
max_score: 40
na_heuristics: ""
p0_count: 0
p1_count: 4
timestamp: 2026-11-14T11-03-57Z
slug: apps-flock-desktop-src-v2
---
# flock v2 desktop UI critique (2026-11-14)

Method: dual-agent (A: design review, B: detector + in-browser overlay via Wink).

## Design health: 23/40 (Acceptable)
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Finished agents look idle: Stop hook → Idle (hooks.rs:1006-1008); no done state (Sidebar.tsx:105) |
| 2 | Match system / real world | 3 | Nouns drift (project/Workspace/thread/tab); `±3 ↑1`, "jailed" |
| 3 | User control and freedom | 2 | ⌘Z zooms inside text fields (App.tsx:3131); undo dead in composer/Settings |
| 4 | Consistency and standards | 2 | Title Case pane menu vs sentence case; red = failed vs Graph node type |
| 5 | Error prevention | 3 | Good guards; close actions below the fold of a scrolling menu |
| 6 | Recognition rather than recall | 2 | Unlabelled header icons; ⌘K never shown; random agent names |
| 7 | Flexibility and efficiency | 3 | Strong shortcuts; no "next finished", no bulk actions |
| 8 | Aesthetic and minimalist design | 3 | Calm; sidebar list shows ~9 rows at 1280×800 |
| 9 | Error recovery | 2 | Failure toasts vanish after 12 s with no reason or log |
| 10 | Help and documentation | 1 | No shortcut sheet, onboarding or help |

## Design specificity
Authored shell (orange = waiting on you only; own copy voice; pages keep the thread header) on a generic chat skeleton; v1 pages (You, Changes, Graph) off-palette. Nothing knows the work product is a UI.
Detector: CLI 0 findings (control file triggered 4). Browser: low-contrast #8a8f97 on #fff 3.3:1 (kbd hints, settings group labels, palette headings, git labels), orange badges #d9662f on #ffe7da 3.0:1; near-duplicate font sizes. Dark clean. False positives: diff rows, ellipsized task line, mocked "main", composer nested-cards.

## Priority issues
- [P1] No "done" state. Fix: unread-done state, "Ready for review (n)" row, ⌘J steps needs-you then done (threads.ts:109-138). clarify
- [P1] Composer has no paste/drop/picker or dictation (Composer.tsx:202; App.tsx:3173). Fix: attachments staged into the spawn cwd before spawn, paths in the first prompt; dictation in composer. shape
- [P1] Global shortcuts hijack ⌘Z/⌘D/⌘T/⌘1-9/⌘[ ] in text fields (App.tsx:3106-3140). Fix: skip when target is an editable field outside xterm; zoom to ⌘⇧↩. harden
- [P1] Frontend/QA blind spot: no localhost/dev-server awareness, preview, or evidence; Changes squeezes panes to ~35 cols. Fix: flock × Wink plan; "Preview :port" chip. shape
- [P2] Accessibility floor: focus ring ~1.9:1, faint text 3.3:1, orange "now" 3.6:1, menus silent to screen readers, toasts vanish after 12 s. audit

## Persona red flags
- Alex: done = idle; ⌘Z zooms; close actions in a 16-item scrolling menu; ⌘K hidden; random names.
- Sam: menu not screen-reader navigable; context ring unfocusable; rename double-click only; 40 tab stops for 20 threads.
- Frankie (frontend dev): no screenshot in composer; no running-app preview; no visual diff; Changes covers one checkout.
- Quinn (QA): check dots meaning only in tooltips; no test results; failures without reasons; provenance buried; no bug bundle; race is item 10.

## Minor observations
- Header "…" menu 16 items (App.tsx:3719-3747); fold Add-agent and Open-in submenus.
- Brand block 69 px of sidebar; Waiting row causes 33 px layout shift.
- Off-palette blue/green/bronze; Codex usage bar uses the waiting orange.
- Graph map dark: labels near-invisible and overlapping.
- Harness console errors: useVoicePushToTalk.ts:37 'downloaded'; xterm 'dimensions' (may be mock gaps).
- Website demo four-pane scene garbles one pane after resize.

## Questions
1. What means "done, come look"? Supervise or review?
2. Should the running app be the main panel for frontend work?
3. Name agents by task or branch?
4. Evidence button per thread instead of a provenance export?
