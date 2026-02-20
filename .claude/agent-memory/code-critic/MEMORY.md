# Code Critic Memory — Dungeon Slop

## Project-Wide Bug Patterns

### Global Mutable State in Module Scope
`nextFeatureId` in `src/engine/features.ts` is a module-level `let` variable reset
manually in `placeFeatures`. Every call to `createFeature` outside `placeFeatures`
(or concurrent calls) will produce wrong IDs. Pattern: never use module-level counters
for ID generation; pass state explicitly.

### `noUncheckedIndexedAccess` False Security
The project enables `noUncheckedIndexedAccess`, but code widely uses `!` non-null
assertions after array accesses (e.g., `grid[y]![x]!`). TypeScript is silenced —
the safety guarantee is hollow. Any out-of-bounds index still crashes at runtime.

### SeededRandom `nextInt(min, max)` is Inclusive on Both Ends
`nextInt` returns `Math.floor(next() * (max - min + 1)) + min`, so `nextInt(0, arr.length - 1)`
is correct but `nextInt(0, arr.length)` would overflow the array. Code does this correctly
in most places but must be verified on every call site. `next()` CAN return 1.0 in theory
(IEEE 754 rounding of `4294967295 / 4294967296`), making `nextInt(0, N)` return `N+1`.

### BSP Split Loop is O(n²) Per Iteration
`collectLeaves(root)` traverses the entire BSP tree on every iteration of the split loop.
For 50 rooms this is negligible, but the pattern is wrong.

### A* in Labyrinth Corridors is O(n²) Per Corridor Pair
Uses an unsorted array as a priority queue, with `.sort()` on every node pop.
For a 100×100 grid and 50 rooms this is 10,000 cells × O(n log n) sort × 50 pairs.

### Cellular Automata `countNeighborsByType` Counts Out-of-Bounds as Walls
When a cell is on the grid border, out-of-bounds neighbours count as the queried type
(line 118 grid.ts: `if (cell === undefined || cell.type === type) count++`). This
creates asymmetric automata — border-adjacent cells are artificially "walled" in.
Only correct for `CellType.Wall`. If called with any other type it produces wrong counts.

### Corridor Path Deduplication Missing
`carveLine` pushes every cell including duplicates to `path`. The L-shape corner cell
(the elbow of the corridor) appears twice — once from each segment. This propagates
into door placement and trap placement, creating double-features at elbow cells.

### Stairs Placement Loop Bug
In `placeStairs`, the loop for StairsDown starts `placed` where StairsUp left off,
meaning both loops can compete for the same edge rooms. The `placed` counter is shared
but the condition is `placed < sortedByEdge.length`, not `placed < upCount + downCount`.

### Test File Anti-Patterns (engine test)
- `assertNoOrphans` fires `expect(found).toHaveLength(0)` TWICE — first call is dead
  because it never throws, only the second one fails; first assert is unreachable noise.
- `orphans()` treats StairsUp/StairsDown as orphans if they lack roomId AND corridorId,
  but stairs are placed on Floor cells that already carry roomId; this is not actually
  a gap, but it would fail if stairs were ever placed on corridor cells.
- `disconnectedRoomCells` BFS seeds from `roomCells[0]` and walks ALL walkable cells —
  it can reach cells of other rooms and falsely "clear" isolated room-B cells if they
  happen to be reachable through connected room-A. The isolation check is per-room but
  the BFS seed is random (first grid cell with that roomId).
- `globallyDisconnectedRooms` marks a room reachable only if its cells carry `roomId`.
  Corridor-type cells with `roomId !== null` (the carveLine bleed bug described in the
  visual bug context) cause the engine to report those rooms as connected — this test
  passes even when the room is actually isolated if one bleed cell bridges the gap.
- `invalidDoors` Door check requires adjacent `roomId !== null` AND adjacent
  `corridorId !== null`. But Doors placed on sill cells that were Corridor have
  `corridorId` set on the door cell itself, not necessarily on a neighbour. The
  adjacency check passes only if a corridor NEIGHBOUR also exists — valid doors on
  corridor endpoints fail this test with a false positive.
- `roomFloorCellsInPaths` always returns `[]` — dead stub that was intentionally
  retained for "signature compatibility" but the signature it's compatible with is
  `assertAll`, which never calls it.
- Stress suite uses `STRESS_SEEDS_CONSTRUCTED[i]` with no type guard; when i >= 50
  (impossible here) it would be `undefined`, passed as seed to `cfg()`. Not a bug at
  the current count but structurally fragile.
- `dead_ends:"None"` + `corridors:"Labyrinth"` is never combined in any suite.
- No test ever sets `room_count` below 4 (the schema minimum is 3) or grid size to
  minimum (20x20), so degenerate-small dungeons are untested.
- `cfg()` spread over `DEFAULT_CONFIG` means `seed` from DEFAULT_CONFIG (undefined)
  is overridden, but `corridor_complexity` is always 0.3 unless explicitly overridden;
  stress suite never varies this field.

## Key Files
- `src/engine/features.ts` — global `nextFeatureId`, stairs loop bug
- `src/engine/corridors.ts` — path deduplication, A* O(n²)
- `src/engine/grid.ts` — `countNeighborsByType` counts OOB as matching type
- `src/engine/bsp.ts` — O(n²) leaf collection, room can escape grid bounds
- `src/engine/cellular.ts` — fallback room object missing `shape` field (line 192)
- `src/engine/graph.ts` — Delaunay undefined for collinear points, MST not verified connected
