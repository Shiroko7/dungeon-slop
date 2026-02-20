# Tech Lead Memory — Dungeon Slop

## Project Overview
- See `C:\Users\olava\Documents\Projects\dungeon-slop\TASKS.md` each session for open work
- Check `C:\Users\olava\.claude\projects\C--Users-olava-Documents-Projects-dungeon-slop\memory\MEMORY.md` for global project state

## Engine Architecture (src/engine/)
- `generate.ts` — orchestrator (BSP or cellular → graph → corridors → features → walls)
- `bsp.ts` — BSP tree splits canvas into leaf nodes, places one room per leaf
- `graph.ts` — Bowyer-Watson Delaunay + Kruskal MST for corridor graph selection
- `corridors.ts` — 3 modes: Straight (L-shaped), Winding (waypoints), Labyrinth (A* with noise)
- `cellular.ts` — cave generation, flood-fill region isolation, bounding-box chamber extraction
- `features.ts` — doors, secret doors, traps, treasure, stairs placement
- `shapes.ts` — 8 room shapes carved from bounding box (Rectangular/Square/Circular/etc.)
- `grid.ts` — Cell[][] utilities; Cell has {type, roomId, corridorId, featureId}
- `types.ts` — CellType enum (Empty/Floor/Wall/Corridor/Door/SecretDoor/StairsUp/StairsDown)

## Known Engine Defects (confirmed by architectural review 2026-02-17)
See `engine-review.md` for full analysis. Critical bugs:
1. **Door placement is broken**: placeDoors walks corridor path looking for cells adjacent to Floor. But corridors are carved center-to-center, passing THROUGH room floor cells. The L-shaped path doesn't stop at the room boundary — it overwrites room floor with Corridor type (`setCellType` skips Floor but the start/end points ARE floor). The actual room-corridor boundary never gets a door; the function finds the transition cells reliably only by luck.
2. **dead_ends config is ignored**: `DungeonConfig.dead_ends` is defined in schema but never consumed anywhere in the engine. `selectCorridorEdges` only uses `corridor_complexity`. Dead ends are never collapsed.
3. **nextFeatureId is module-level mutable state**: `let nextFeatureId = 0` in features.ts is reset manually at the top of `placeFeatures` — fragile, not thread-safe, breaks if called from tests in sequence without reset.
4. **Cellular cave rooms are disconnected**: `generateCellular` keeps multiple flood-fill regions but never carves corridors between them. `generate.ts` runs `carveCorridors` using Delaunay on region bounding-box centers, but the corridor path goes through wall cells — it marks them Corridor type, which is correct, but the flood-fill regions were isolated and the Delaunay graph treats bounding-box centers that may not even be on floor cells.
5. **A* labyrinth is O(n^2) open list**: `open.sort()` inside while loop — should use a priority queue (min-heap).

## Architectural Decisions Recorded
- Donjon odd-grid approach NOT adopted (see engine-review.md) — our BSP approach is kept
- Recommended hybrid: keep BSP + Delaunay/MST graph, adopt donjon sill-based door system
- See engine-review.md for full file-by-file change plan
