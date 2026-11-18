---
name: app-ui
description: Operate the Dungeon Slop website directly, the way the user does - navigate, click tools, pick textures, place objects, paint cells, read panels - through the interactive Playwright browser tools, instead of writing scripts or CLI calls. Use whenever the user asks to change, check or show something that the app's own UI can do, and before reaching for the `dungeon`/`assets` CLIs or code.
---

# Using the website directly

The user works in the app. When the UI can do something, do it there, through the
interactive browser tools (`mcp__plugin_playwright_playwright__browser_*`; load
them with ToolSearch). Do not write a playwright script, a `bun -e` snippet or a
DB patch for something a click can do. Changes made in the UI autosave
("Saved" in the top bar) and go into the editor's undo history, exactly as if the
user made them.

Reach for the CLIs or code only when the UI cannot do it (list below), and say so
in one line ("the app has no control for X, so I used ..."). If a missing control
keeps coming up, offer to add it to the UI.

## Setup

- The dev server must be running: `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173`
  (200). If not, start `bun run dev` in the background (see the `verify` skill).
- Screenshots must be saved under the repo (e.g. `.playwright-mcp/x.png`, git-ignored);
  the browser tools refuse other folders.
- `browser_navigate` to the page, then `browser_snapshot` to get element refs.
  Click by ref or by a stable selector (`button[aria-label="..."]`). Take
  `browser_take_screenshot` to look; a snapshot cannot show the map.
- Close with `browser_close` when done. Never leave Edit mode on.

## Where things are

URLs: `/` campaigns · `/c/:cid` campaign · `/c/:cid/d/:did` map · `/c/:cid/d/:did/r/:roomId` room.

Top bar: Generate, Seed, Reroll · **Edit** ("Enter edit mode"/"Exit edit mode")
· Undo / Redo · Zoom out / Zoom in / Reset view · **Rooms** / **Paths** toggles
(room numbers, path letters on the map; same as the Legend entries) · Export (↓).

Map tool rail (top-left of the map, keys V / T / S):
- **Select & pan** (V).
- **Textures** (T) - "Textures: floor, background, rooms". Layers list (rooms
  with their own floor, Floor, Background); "+ Room texture…" select; the big
  preview opens the **Texture Catalog** (or press F); Tile / Radial / Fit;
  sliders Tile size, Stagger, Rotation, Darken (each has a number box you can
  click and type into); Random variants checkbox and 🎲 Shuffle; Recents /
  Favorites shelf; ★ favourite; ⌫ clear.
- **Stamp** (S) - "Stamp: place objects". Preview opens the catalog (untick
  "Seamless tiles only" for props/decals); click the map to place; click an
  object to select, drag to move, Delete to remove, Esc to deselect; Size,
  Rotation (🎲 random), Opacity, Shadow, Flip.

Texture Catalog (modal): navigator (All, Favorites, Recently used, kinds and
motifs), search box, "Seamless tiles only", thumbnail size slider, Sort by,
Group by. Variant sets show as one tile with a **×N** badge (click the badge to
expand). Click a tile to use it; Esc closes.

Right panel, no room selected: Layout (constraint check, "Edit room and
connection plan", "Show floor plan", "Refine layout with AI") and General.
Room selected (click the room on the map, or its name in the left list): name,
description, Regenerate / History, **Room art** (its floor: inherited "Map floor"
with "Customise for this room", or its own texture) and **Objects** in the room
(click to select, × to delete, "+ Place objects").

Legend box (top-right of the map): **Room numbers** and **Path letters** toggles
(buttons titled "Hide/Show room numbers", "Hide/Show path letters"; on screen only,
remembered per browser, work in Edit mode too), then one toggle per door/feature
type on the map.

Edit mode palette (left of the map): Select, Floor, Corridor, Wall, Erase, Door,
Stair Up, Stair Dn. Hold Space to pan.

## Clicking a map cell

The map is a canvas, so cells have no refs. Find screen coordinates from things
that DO have boxes: `browser_snapshot` with `boxes: true` gives the corridor
markers (A, B, ...) and room labels; a single-cell doorway's marker sits on its
cell centre. Two markers at known cells give the scale (px per cell) and origin.
Get the cells from `bun run dungeon show <id>` ("door at x,y"). Then click with
the one `page.mouse.click(x, y)` line `browser_run_code_unsafe` takes; that is
the only scripting this needs. Zoom in first (Zoom in ×3) so a cell is big
enough to hit. Screenshot before and after.

## What the editing tools really do (tested 2026-10-15)

- **Floor** painted between two rooms (e.g. on a doorway) makes a new
  1-cell room and drops the door; the next room becomes unreachable. Do not
  use Floor to widen openings.
- **Corridor** painted on the wall cell beside a doorway widens the opening,
  but the app records it as a separate corridor with its own letter and no door
  across it (half the opening stays open). A rebuild discards it. For wider
  doorways on radial maps prefer the plan's `doorWidth` (no UI yet, see below).
- Every hand edit marks the plan stale and is lost on **Generate**/rebuild.
  Say so before making hand edits on a planned map.

## Not in the UI yet (use the CLI, and say so)

- Plan settings `gap` and `doorWidth` (radial maps): `bun run dungeon rebuild`
  with a plan file (`dungeon` skill).
- Generating new textures, variants, procedural noise (`assets` skill; needs
  ComfyUI for AI ones).
- Deleting library assets.
