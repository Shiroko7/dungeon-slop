# Frontend Specialist Memory — Dungeon Slop

## Project Essentials
- CSS: Single `src/index.css` — no framework, no modules, plain CSS custom properties
- Design language: Excalidraw-inspired — flat, clean, low-chrome. Accent `#6965db` (light) / `#8b83f0` (dark)
- Design tokens: `--bg`, `--bg-sidebar`, `--bg-surface`, `--bg-hover`, `--bg-canvas`, `--text`, `--text-2`, `--text-3`, `--accent`, `--border`, `--shadow-sm/md/lg`
- Spacing base: 4px / 8px grid. Padding values in use: 16/18px sidebar, 10/12px panels
- Border radius: 8px standard, 6px icon buttons, 2px bars/tracks
- Toolbar height: 46px fixed

## Component Architecture
- `AppShell` — root layout: `[Sidebar] [main-area: Toolbar + Canvas]`
- `Sidebar` — 340px fixed, tabs: config | rooms | export | settings
- Panels: ConfigPanel (prompt + config readout), RoomPanel (list + detail), ExportPanel, SettingsPanel
- Stores: `ui-store` (pan/zoom/panels/theme), `dungeon-store` (config/dungeon/descriptions/progress)
- `activePanel` in ui-store is typed `"settings" | "config" | "rooms" | "export" | null`

## Key UX Issues Identified (2026-02-17)
- "Describe Rooms" button lives in toolbar but progress renders inside RoomPanel (hidden behind tab)
- ConfigPanel duplicates Generate button that also exists in toolbar — source of confusion
- Sidebar tabs are flat labeled text — no status indicators for in-progress or completed states
- Canvas empty state references sidebar ("Describe your dungeon in the sidebar") but doesn't guide to Settings first

## Planned Redesign (spec written 2026-02-17)
See layout-redesign-spec.md for full design spec.
Key decisions:
- Split sidebar into two zones: top fixed (Prompt+Config), bottom contextual (state-driven panel)
- Add status badges to tab labels when work is running
- Describe Rooms action auto-switches to Rooms tab + shows inline progress toast on canvas
- Export panel moves to a floating action group anchored to canvas, not buried in sidebar
- Settings moves to a gear icon + popover in toolbar-right, freeing a full sidebar tab slot
