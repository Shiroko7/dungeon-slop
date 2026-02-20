# Dungeon Slop — Task Tracker

## Phase Status Overview

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Project Scaffold | DONE |
| 1A | AI Provider (Gemini-only) | DONE |
| 1B | AI Architect Layer | DONE — SSE fixed, prompt→config flow works |
| 2A | BSP Engine | DONE |
| 2B | Cellular Automata Engine | DONE |
| 2C | Corridors & Features | DONE — dead_ends, thinning, connectivity all working |
| 2D | Engine Test Suite | DONE — 174 tests, 0 failures |
| 3A | Canvas Renderer & Themes | PARTIAL — DungeonCanvas bypasses theme system |
| 3B | Room Interaction | DONE — regenerate wired |
| 4 | Content Generation | DONE — server + UI wired |
| 5A | Export Pipeline | DONE — modules + UI wired |
| 5B | UI Polish | NOT STARTED |
| 5C | Canvas Map Editor | NOT STARTED — plan written |

---

## Open Tasks

### SIGNIFICANT — Functionality gaps

- [ ] **Use canvas-renderer.ts + theme system in DungeonCanvas**
  - `DungeonCanvas.tsx` has inline hardcoded rendering, ignoring themes
  - Should delegate to `renderDungeon()` from `canvas-renderer.ts`
  - This makes export and UI visually consistent

- [ ] **Canvas Map Editor** *(plan written at `.claude/plans/atomic-scribbling-rocket.md`)*
  - Edit Mode toggle in toolbar activates floating tool palette
  - Tools: select, floor, corridor, room (drag-to-draw), erase, door, trap, treasure, stairs
  - Ghost preview on hover; click+drag to paint; commits to history store on mouseUp
  - Files: ui-store.ts, dungeon-store.ts, DungeonCanvas.tsx, EditToolPalette.tsx (new), Toolbar.tsx, index.css

### MODERATE — Missing implementations

- [ ] **Add 5 missing theme palettes**
  - Schema allows: Natural, Arcane, Undead, Mechanical, Frozen
  - Only Default, Infernal, Aquatic exist — others silently fall back to Default

### PHASE 5B — UI Polish (not started)

- [ ] **Wire undo/redo (history-store exists but unused)**
- [ ] **Add keyboard shortcuts (Ctrl+Z, Ctrl+Y, Escape)**
- [ ] **Loading skeletons and error toasts**
- [ ] **Responsive layout improvements**
- [ ] **Seed display/copy in toolbar**

### NICE TO HAVE

- [ ] **Use SVG path icons instead of emoji** in SvgOverlay
- [ ] **Hex grid support** — schema allows it, engine doesn't implement it
- [ ] **Fix VTT portal bounds** — horizontal/vertical doors have identical bounds (copy-paste bug)

---

## Completed Work

### Phase 0: Project Scaffold — DONE
- Bun project initialized, all dependencies installed
- Directory structure created, dev server works
- `/api/health` returns `{"status":"ok"}`

### Phase 1A: AI Provider (Gemini-only) — DONE
- Gemini provider with raw fetch, server-side API key from .env
- Multi-provider system stripped; no client-side key input

### Phase 1B: AI Architect Layer — DONE (fixed 2026-02-16)
- SSE field mismatch fixed in PromptInput.tsx (`text` not `content`)
- Complete event parsing fixed (checks `parsed.type`)
- Prompt → config flow end-to-end

### Phase 2A-2C: Engine — DONE (2026-02-18)
- BSP tree, cellular automata, Delaunay/MST, corridors, features
- `generateDungeon()` orchestrator chains everything
- `dead_ends` config fully consumed by `collapseDeadEnds()` in features.ts
- `thinCorridors()` removes 2×2 corridor clusters
- Two-pass connectivity check — post-processing re-isolation is caught and force-reconnected
- `carveStraight()` prefers L-shape orientations that avoid routing through intermediate rooms
- SVG corridor labels filter stale path cells correctly (labels no longer float in empty space)

### Phase 2D: Engine Test Suite — DONE (2026-02-18)
- 174 tests, 0 failures across all engine invariants
- Coverage: orphan cells, room connectivity, global connectivity, corridor path continuity,
  degenerate corridor paths, door boundary validity, dual ownership, corridor/room cell ownership
- Stress suite: 50 constructed × 50 organic configs with rotated parameters (all dead_ends×corridor combos covered)
- Targets: corridor_complexity extremes (0 and 1), organic+all door types, Secure door type in connectivity
- Known accepted tradeoff: `corridor.path` may contain stale (now-Wall) cells after post-processing;
  rendering filters them at draw time; documented in test file

### Backend APIs — DONE
- All 5 API endpoints implemented and functional
- SSE streaming for config generation and room descriptions

### Stores — DONE
- All 4 Zustand stores fully implemented
- ai-store has localStorage persistence
- Added async actions: `generateDungeonFromConfig`, `describeRooms`, `describeRoom`

### Frontend Wiring — DONE (fixed 2026-02-16)
- Toolbar Generate + Describe Rooms buttons wired
- ConfigPanel Generate button wired
- ExportPanel PNG/PDF/VTT buttons wired to export modules
- RoomPanel regenerate button wired to `/api/describe-room/:id`

### Export Modules — DONE
- PNG, PDF, VTT export functions complete + wired to UI
