# Engine Architectural Review — Algorithm A vs B
# Produced: 2026-02-17

## Summary Verdict
Keep Algorithm A's structural framework (BSP, Delaunay/MST, shape carving, typed Cell grid).
Adopt three specific ideas from Algorithm B (donjon): sill-based door placement, dead-end collapse, odd-grid corridor discipline.
Do NOT adopt the donjon bitmask cell model — our typed Cell struct is more maintainable and already works.

---

## Criterion-by-Criterion Analysis

### 1. Connectivity Guarantee
**Algorithm A (current)**: STRONG.
Kruskal MST over Delaunay triangulation gives a guaranteed spanning tree. Every room index that appears in the triangulation will be in the MST. The only gap is when `rooms.length < 2` (early return), and when cellular cave generates disconnected regions that never get corridors connecting them (see defect #4 in MEMORY.md).

**Algorithm B (donjon)**: MODERATE.
Recursive corridor tunneling from all odd-grid positions creates a maze-like structure, but it relies on rooms being encountered by the tunneling pass. If a room is fully enclosed by corridors that arrived first, it could be isolated. Donjon addresses this only partially — it doesn't run an explicit connectivity check.

**Winner: Algorithm A** — explicit MST is provably correct for constructed dungeons.

### 2. Visual Quality
**Algorithm A**: MIXED.
BSP produces evenly spaced rooms with no overlap, but can feel mechanical and grid-aligned. The Delaunay/MST corridor graph produces sensible paths between nearby rooms. The L-shaped (Straight) corridor carving looks reasonable. The labyrinth A* mode has good visual variety but is expensive. Room shapes (circular, hexagonal, cross, diamond) add visual interest.

**Algorithm B (donjon)**: STRONG.
The odd-grid constraint means corridors always have implicit wall padding — corridors are 1 cell wide with a guaranteed 1-cell buffer between them, producing clean T-junctions and turns. The three corridor layout modes (Labyrinth/Bent/Straight) produce genuinely different dungeon characters. Dead-end collapse at a configurable percentage produces deliberately varied density. The perimeter ring around rooms prevents corridor-room visual ambiguity.

**Winner: Algorithm B** on raw visual quality, but the gap is closeable with targeted fixes to A.

### 3. Door/Entrance System
**Algorithm A**: BROKEN in practice.
`placeDoors` walks each corridor path, looking for corridor cells adjacent to a room Floor cell. The problem: `carveLine` carves center-to-center. The path origin is roomA.centerX/centerY, which is already a Floor cell. The function skips Floor cells (`cell.type !== CellType.Floor`), so the center cell is left as Floor and the first carved cell beyond it is Corridor. This means the door ends up 1+ cells inside the corridor, not at the room boundary. On small rooms or when center-to-center distance is short, multiple path cells may be adjacent to Floor, generating spurious doors throughout the corridor.

**Algorithm B (donjon)**: ELEGANT.
Before carving corridors, donjon pre-computes "sills" for each room — the set of (wall position, opening direction) pairs where a corridor could validly exit. This is topologically correct: sills are always at the room boundary. Doors go on sills. This means doors are always exactly at room entrances, never mid-corridor.

**Winner: Algorithm B** by a wide margin. Our door system has a fundamental spatial error.

### 4. Corridor Variety
**Algorithm A**: GOOD but expensive.
- Straight: L-shaped, coin-flip on which axis first. Produces clean T-junctions if corridors overlap.
- Winding: 1-2 random waypoints between rooms, L-shaped segments between them. Adds bends but waypoints are constrained to the bounding box of the two rooms, so variety is limited.
- Labyrinth: A* with per-cell noise weighting (cost 1-8 depending on cell type and hash). Genuinely winding but O(n^2) open list (list.sort() inside while loop).

**Algorithm B (donjon)**: GOOD and cheap.
- Labyrinth: pure random direction each step.
- Bent: 50% chance to continue straight.
- Straight: 90% chance to continue straight.
The recursive flood approach is O(cells) and produces genuine maze structure including loops when corridors cross. The constraint "corridors never cross rooms/perimeters/other corridors" keeps the result clean.

**Winner: Tie** — A has better algorithmic foundations for controlled paths (A* can be improved), B has better runtime characteristics and more convincing labyrinth output.

### 5. Dead-End Handling
**Algorithm A**: NOT IMPLEMENTED.
`dead_ends` is in the schema and the config but zero lines of engine code read it. The Delaunay/MST approach with `selectCorridorEdges` creates extra cycles via non-MST edges when `corridor_complexity > 0`, which reduces dead ends indirectly — but this is not the same as explicitly controlling dead-end density, and it operates at room-graph level rather than corridor-cell level.

**Algorithm B (donjon)**: EXPLICIT and configurable.
After corridor generation, dead-ends (corridor cells with 3 wall neighbors) are collected and collapsed at a configurable percentage. The collapse is recursive — removing one dead-end may expose another. This produces tight, intentional control over dungeon "spareness."

**Winner: Algorithm B** — we have a schema field we never use.

### 6. Room Placement Quality
**Algorithm A**: GOOD.
BSP guarantees non-overlapping rooms by construction. The density margin (`getDensityMargin`) controls breathing room between rooms. Room placement within a leaf node is randomized within the margin bounds. The `room_layout` field (Sparse/Moderate/Dense) correctly maps to margin factors. Room count requested may not be fully achieved if BSP can't split enough nodes (capped at 100 split attempts).

**Algorithm B (donjon)**: GOOD but less sophisticated.
Two modes — Packed (systematic grid iteration, place if no collision) and Scattered (random positions, collision check + max attempts). Packed gives denser, more regular layout. Scattered can leave more empty space. No BSP guarantees; relies on collision detection and attempt limits. Can fail to place `room_count` rooms if space is full.

**Winner: Algorithm A** — BSP is a cleaner, more principled partitioning strategy.

### 7. Feature Placement
**Algorithm A**: ADEQUATE but has problems.
- Doors: fundamentally broken (see criterion 3).
- Secret doors: scans all wall cells for a wall that has passable cells on both sides in one axis. This is actually correct but fires on interior walls between corridors, not just room entrances — `rng.chance(0.15)` keeps count down.
- Traps: placed on corridor cells; prioritizes intersections (3+ corridor neighbors) and dead ends (1 neighbor). Priority-sorted, density-controlled. Reasonable.
- Treasure: placed in dead-end rooms first. Good instinct.
- Stairs: placed in rooms sorted by proximity to grid edge. Reasonable heuristic.
- `nextFeatureId` is a module-level mutable — will produce non-deterministic IDs across multiple calls in the same process unless `placeFeatures` resets it (it does reset it, but this is fragile).

**Algorithm B (donjon)**: STRONG.
Stairs always go at corridor dead-ends (topologically correct placement). Door type probabilities scale by room area (bigger rooms get more doors). Sill-based door placement ensures doors are at room boundaries.

**Winner: Algorithm B** on correctness, **A** on variety (traps, treasure, etc. are not in donjon).

### 8. Configurability
**Algorithm A**: RICHER schema.
`DungeonConfig` covers: layout_style, motif, room_layout, room_size, room_count, corridors, corridor_complexity, dead_ends, door_type, trap_density, treasure_density, stairs, grid_type, grid_width, grid_height, room_shapes, theme_description, seed.
However, `dead_ends` and `grid_type: "Hex"` are defined but not implemented.

**Algorithm B (donjon)**: Core dungeon parameters only.
Covers: room placement mode, room size range, door type, corridor layout, dead-end removal %, stair count, dungeon layout mask. No trap/treasure/theme config.

**Winner: Algorithm A** — richer schema, though some fields are unimplemented.

### 9. Code Complexity
**Algorithm A**: MODERATE complexity, GOOD structure.
Clean module separation. Each file has a clear single responsibility. TypeScript types throughout. The Delaunay implementation is a complete Bowyer-Watson algorithm — verbose but correct. The A* in corridors.ts is clearly readable but has the O(n^2) performance defect (array.sort on open list).

**Algorithm B (donjon)**: Perl, so direct comparison is hard.
The bitmask approach is clever but makes the grid's state implicit — you need to know which bits mean what to read any cell. The recursive corridor tunneling with configurable direction bias is elegant. The sill system requires a pre-computation pass.

**Winner: Algorithm A** for maintainability (typed Cell struct vs raw bitmask integers).

### 10. Edge Cases
**Algorithm A known failure modes**:
1. `rooms.length < 2` → early return with no corridors. Correct but means a single-room result is silently returned.
2. BSP leaf nodes too small for minimum room size → leaf skipped, room_count not reached. No warning.
3. Cellular cave: `extractChambers` uses bounding-box grid slicing, not actual floor cells — a chamber's bounding box may be mostly wall.
4. Cellular cave: multiple regions are kept but corridors are never carved between them.
5. Labyrinth A* `cameFrom` null-terminates the path reconstruction loop — if A* fails to find a path, the partial path is silently used.
6. `carveWinding` waypoints constrained to roomA/roomB bounding box — if rooms are vertically aligned, all waypoints collapse to a point and it degenerates to Straight.
7. `placeSecretDoors` fires on wall cells between two corridors (valid shape match) — can produce secret doors in the middle of corridor junctions, not just room walls.

**Algorithm B known failure modes**:
1. Scattered room placement: high room counts on small grids fail silently.
2. Recursive corridor tunneling: stack depth can be large on big grids (Perl doesn't blow the stack easily, but a TypeScript port would need iteration).
3. Dead-end collapse is also recursive — same stack concern.

---

## Recommendation: Targeted Hybrid

Keep the Algorithm A framework. Fix its specific defects by adopting donjon concepts selectively.

### What to Keep from Algorithm A
- BSP room placement (superior partitioning vs collision-detect scatter)
- Delaunay + MST graph (provable connectivity)
- Typed Cell struct (far more maintainable than bitmask)
- Shape carving system (donjon only has rectangular rooms)
- Full DungeonConfig schema
- Feature categories (traps, treasure — donjon doesn't have these)

### What to Adopt from Algorithm B
1. **Sill-based door placement** — pre-compute valid exit points per room before carving corridors; place doors at those sills
2. **Dead-end collapse** — implement the recursive collapsing pass that reads `dead_ends` config
3. **Odd-grid corridor discipline** — not the full odd-grid grid model, but the concept of a 1-cell perimeter/buffer around rooms that corridors must respect; enforced during corridor carving, not as a global grid constraint

### What NOT to Adopt from Algorithm B
- Bitmask cell model (our typed struct is better)
- Recursive corridor tunneling to replace our graph-based approach (MST is more correct)
- Global odd-grid constraint (incompatible with our BSP and shape systems without a full rewrite)

---

## File-by-File Change Plan

### src/engine/features.ts
**Changes:**
1. Replace `placeDoors` with a sill-based approach. Add a `computeRoomSills(grid, room)` function that scans the room's perimeter for cells that are adjacent to Empty/Corridor cells. These are the valid door positions. Store them. After corridors are carved, check which sills are now adjacent to Corridor — those are active entrances. Place doors there.
2. Fix `nextFeatureId` — pass it as a parameter or return the new value; do not use module-level mutable state.
3. Fix `placeSecretDoors` — add a check that at least one side of the wall passage is a room Floor (not just any Corridor-to-Corridor wall).

**New interface to define:**
```typescript
interface RoomSill {
  x: number;     // wall cell position
  y: number;
  dir: "N"|"S"|"E"|"W";  // direction into the room
  roomId: number;
}
```

### src/engine/corridors.ts
**Changes:**
1. Fix `carveLabyrinth` — replace `open.sort()` with a proper min-heap. A BinaryHeap<{x,y,f}> implemented in `src/lib/heap.ts`.
2. Fix `carveWinding` — detect when roomA and roomB share an axis (dx < 2 or dy < 2) and fall back to Straight rather than generating degenerate waypoints.
3. Add a `PERIMETER_MARGIN` constant (value: 1). In `carveLine`, skip carving if the cell is within margin distance of a room boundary without being the designated entry point. This enforces the corridor-room buffer concept.

### src/engine/generate.ts
**Changes:**
1. After `carveCorridors`, run a new `collapseDeadEnds(grid, config, rng)` function that reads `config.dead_ends`.
2. Pass the computed sills from a new pre-pass into `placeFeatures` so the door system can use them.
3. Cellular path: after `generateCellular` + `buildWalls`, run `carveCorridors` only if the regions are disconnected (currently always runs). This is already done but confirm corridor carving actually connects isolated cave regions by checking start/end points are Floor cells, not wall.

### src/engine/features.ts (dead-end collapse)
Add `collapseDeadEnds(grid: Cell[][], config: DungeonConfig, rng: SeededRandom): void`.
Algorithm:
1. Collect all corridor cells with exactly 1 corridor neighbor (dead ends).
2. Based on `config.dead_ends`: "None" → collapse 100%, "Few" → collapse ~70%, "Many" → collapse 0%.
3. For each selected dead-end: set to Wall, then check if its corridor neighbor is now a dead end; recurse.
4. Must be iterative (not recursive) to avoid stack overflow on large grids.

### src/lib/heap.ts (new file)
A generic min-heap for use in A* and dead-end collection. Interface:
```typescript
interface MinHeap<T> {
  push(item: T, priority: number): void;
  pop(): T | undefined;
  size: number;
}
```

### src/engine/cellular.ts
**Changes:**
1. `extractChambers` is architecturally wrong: it does bounding-box slicing of the region, producing chamber metadata that does not reflect actual floor cells. The chamber's x/y/width/height bounds a rectangle that is mostly wall. The `generate.ts` corridor logic then uses `room.centerX/centerY` — which may be a wall cell in a cave. Fix: instead of bounding-box slicing, identify the medoid (actual floor cell closest to centroid) as the center point.

### src/engine/shapes.ts
No architectural changes needed. The cave shape carve already does flood-fill from center — that's correct.

### src/engine/types.ts
Add `RoomSill` interface (as above). Consider adding a `perimeter: boolean` flag to Cell to make the buffer zone explicit during generation (can be cleared after corridor carving).
