/**
 * Dungeon generation step-by-step debugger.
 *
 * Usage:
 *   bun run src/engine/debug.ts [seed] [corridors] [layout]
 *
 * Examples:
 *   bun run src/engine/debug.ts
 *   bun run src/engine/debug.ts 42
 *   bun run src/engine/debug.ts 42 Labyrinth
 *   bun run src/engine/debug.ts 42 Winding organic
 */

import { CellType } from "./types.ts";
import type { Cell, Room } from "./types.ts";
import { SeededRandom } from "../lib/random.ts";
import { createGrid, getCell } from "./grid.ts";
import { generateBSP } from "./bsp.ts";
import { delaunayTriangulation, minimumSpanningTree, selectCorridorEdges } from "./graph.ts";
import { carveCorridors, thinCorridors } from "./corridors.ts";
import { placeFeatures, collapseDeadEnds } from "./features.ts";
import { carveShape } from "./shapes.ts";
import { generateCellular } from "./cellular.ts";
import { DEFAULT_CONFIG } from "../ai/schema.ts";
import type { DungeonConfig } from "../ai/schema.ts";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const seed     = Number(process.argv[2] ?? 42);
const corridors = (process.argv[3] ?? "Straight") as DungeonConfig["corridors"];
const layout   = (process.argv[4] ?? "constructed") as DungeonConfig["layout_style"];

const config: DungeonConfig = {
  ...DEFAULT_CONFIG,
  seed,
  corridors,
  layout_style: layout,
  grid_width: 40,
  grid_height: 30,
  room_count: 8,
  dead_ends: "Few",
};

// ─── ASCII renderer ───────────────────────────────────────────────────────────

const CELL_CHARS: Record<CellType, string> = {
  [CellType.Empty]:      " ",
  [CellType.Wall]:       "█",
  [CellType.Floor]:      "·",
  [CellType.Corridor]:   "+",
  [CellType.Door]:       "D",
  [CellType.SecretDoor]: "S",
  [CellType.StairsUp]:   "^",
  [CellType.StairsDown]: "v",
};

// Room floors show their room ID digit (0-9, then A-Z)
function roomChar(id: number): string {
  return id < 10 ? String(id) : String.fromCharCode(55 + id); // 10→A, 11→B …
}

function renderGrid(grid: Cell[][], rooms: Room[] = [], label = ""): void {
  const roomIdSet = new Set(rooms.map(r => r.id));
  const border = "─".repeat(grid[0]?.length ?? 0);
  console.log(`\n┌${border}┐  ${label}`);
  for (const row of grid) {
    let line = "│";
    for (const cell of row) {
      if (cell.roomId !== null && roomIdSet.has(cell.roomId) && cell.type === CellType.Floor) {
        line += roomChar(cell.roomId);
      } else {
        line += CELL_CHARS[cell.type] ?? "?";
      }
    }
    line += "│";
    console.log(line);
  }
  console.log(`└${border}┘`);
}

// ─── Stats helpers ─────────────────────────────────────────────────────────────

function gridStats(grid: Cell[][]): string {
  const counts: Partial<Record<CellType, number>> = {};
  for (const row of grid) {
    for (const cell of row) {
      counts[cell.type] = (counts[cell.type] ?? 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([t, n]) => `${CellType[Number(t)]}=${n}`)
    .join("  ");
}

function sep(title: string): void {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  STEP: ${title}`);
  console.log("═".repeat(60));
}

// ─── Pipeline (mirrors generate.ts exactly) ──────────────────────────────────

sep(`CONFIG  seed=${seed}  corridors=${corridors}  layout=${layout}  grid=${config.grid_width}×${config.grid_height}  rooms=${config.room_count}`);

const rng = new SeededRandom(seed);

// ── Step 1: Rooms ─────────────────────────────────────────────────────────────
sep("1 · ROOM GENERATION");

let grid = createGrid(config.grid_width, config.grid_height);
let rooms: Room[];

if (config.layout_style === "organic") {
  const result = generateCellular(config.grid_width, config.grid_height, config, rng);
  rooms = result.rooms;
  grid = result.caveGrid;
  console.log(`  ${rooms.length} chambers from cellular automata`);
} else {
  rooms = generateBSP(config.grid_width, config.grid_height, config, rng);
  console.log(`  ${rooms.length} rooms from BSP`);
}

console.log("\n  Room list:");
for (const r of rooms) {
  console.log(`    Room ${r.id}  pos=(${r.x},${r.y})  size=${r.width}×${r.height}  center=(${r.centerX},${r.centerY})  shape=${r.shape}`);
}

// ── Step 2: Carve rooms + walls ───────────────────────────────────────────────
sep("2 · CARVE ROOMS INTO GRID");

if (config.layout_style !== "organic") {
  for (const room of rooms) {
    const cells = carveShape(room.shape, room.x, room.y, room.width, room.height, rng);
    for (const key of cells) {
      const [xs, ys] = key.split(",");
      const x = Number(xs), y = Number(ys);
      const cell = getCell(grid, x, y);
      if (cell) { cell.type = CellType.Floor; cell.roomId = room.id; }
    }
  }
}

// buildWalls (mirrors generate.ts)
for (let y = 0; y < config.grid_height; y++) {
  for (let x = 0; x < config.grid_width; x++) {
    const cell = getCell(grid, x, y);
    if (!cell || cell.type !== CellType.Empty) continue;
    const neighbors = [
      getCell(grid, x-1, y), getCell(grid, x+1, y),
      getCell(grid, x, y-1), getCell(grid, x, y+1),
    ];
    const WALKABLE = new Set([CellType.Floor, CellType.Corridor, CellType.Door, CellType.SecretDoor, CellType.StairsUp, CellType.StairsDown]);
    if (neighbors.some(n => n && WALKABLE.has(n.type))) cell.type = CellType.Wall;
  }
}

renderGrid(grid, rooms, "After rooms + walls  (digits = room ID)");
console.log("\n  " + gridStats(grid));

// ── Step 3: Delaunay + MST + edge selection ───────────────────────────────────
sep("3 · GRAPH  (Delaunay → MST → corridor edges)");

if (rooms.length < 2) {
  console.log("  < 2 rooms — skipping graph and corridors");
  process.exit(0);
}

const points = rooms.map(r => ({ x: r.centerX, y: r.centerY }));
const triEdges = delaunayTriangulation(points);
const mstEdges = minimumSpanningTree(triEdges, rooms.length);
const selectedEdges = selectCorridorEdges(triEdges, mstEdges, config.corridor_complexity, rng);

console.log(`  Delaunay edges: ${triEdges.length}`);
console.log(`  MST edges:      ${mstEdges.length}  (minimum spanning tree — guarantees connectivity)`);
console.log(`  Selected edges: ${selectedEdges.length}  (MST + extras from corridor_complexity=${config.corridor_complexity})`);
console.log("\n  Edges to carve:");
for (const e of selectedEdges) {
  const inMST = mstEdges.some(m => (m.a === e.a && m.b === e.b) || (m.a === e.b && m.b === e.a));
  console.log(`    Room ${e.a} ↔ Room ${e.b}  dist=${e.weight.toFixed(1)}  ${inMST ? "[MST]" : "[extra]"}`);
}

// ── Step 4: Carve corridors ───────────────────────────────────────────────────
sep("4 · CORRIDOR CARVING");

let corridorsList = carveCorridors(grid, rooms, selectedEdges, config, rng);

console.log(`  ${corridorsList.length} corridors carved`);
for (const c of corridorsList) {
  console.log(`    Corridor ${c.id}: Room ${c.roomA} → Room ${c.roomB}  path length=${c.path.length}`);
}

renderGrid(grid, rooms, `After ${corridors} corridor carving`);
console.log("\n  " + gridStats(grid));

// ── Step 5: Connectivity check 1 ─────────────────────────────────────────────
sep("5 · CONNECTIVITY CHECK  (pass 1)");

function bfsReachableRooms(grid: Cell[][], rooms: Room[]): Set<number> {
  const WALKABLE = new Set([CellType.Floor, CellType.Corridor, CellType.Door, CellType.SecretDoor, CellType.StairsUp, CellType.StairsDown]);
  const start = (() => {
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < (grid[0]?.length ?? 0); x++) {
        if (grid[y]?.[x]?.roomId === rooms[0]?.id) return { x, y };
      }
    }
    return null;
  })();
  if (!start) return new Set();
  const visited = new Set<string>([`${start.x},${start.y}`]);
  const reached = new Set<number>();
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const { x, y } = queue[head++]!;
    const cell = grid[y]?.[x];
    if (cell?.roomId != null) reached.add(cell.roomId);
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
      const nx = x+dx, ny = y+dy, key = `${nx},${ny}`;
      if (visited.has(key)) continue;
      const nc = grid[ny]?.[nx];
      if (!nc || !WALKABLE.has(nc.type)) continue;
      visited.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return reached;
}

const reached1 = bfsReachableRooms(grid, rooms);
const isolated1 = rooms.filter(r => !reached1.has(r.id));
if (isolated1.length === 0) {
  console.log("  ✓ All rooms connected");
} else {
  console.log(`  ✗ ${isolated1.length} isolated rooms: ${isolated1.map(r => r.id).join(", ")} → force-connecting...`);
}

// Force-connect (mirrors generate.ts)
const mainReached = new Set(rooms.map((_, i) => i).filter(i => reached1.has(rooms[i]!.id)));
for (const room of isolated1) {
  let bestDist = Infinity, bestA = -1, bestB = room.id;
  for (const ai of mainReached) {
    const rA = rooms[ai]!;
    const dx = rA.centerX - room.centerX, dy = rA.centerY - room.centerY;
    const d = dx*dx + dy*dy;
    if (d < bestDist) { bestDist = d; bestA = ai; }
  }
  if (bestA >= 0) {
    const forceEdge = [{ a: bestA, b: room.id, weight: Math.sqrt(bestDist) }];
    const fc = carveCorridors(grid, rooms, forceEdge, config, rng, corridorsList.length);
    corridorsList = corridorsList.concat(fc);
    mainReached.add(room.id);
    console.log(`    Force-connected Room ${bestA} ↔ Room ${room.id}`);
  }
}

// ── Step 6: Post-processing ───────────────────────────────────────────────────
sep("6 · POST-PROCESSING  (thinCorridors + collapseDeadEnds)");

const corridorsBefore = (() => { let n = 0; for (const row of grid) for (const c of row) if (c.type === CellType.Corridor) n++; return n; })();
thinCorridors(grid);
const afterThin = (() => { let n = 0; for (const row of grid) for (const c of row) if (c.type === CellType.Corridor) n++; return n; })();
console.log(`  thinCorridors:     ${corridorsBefore} → ${afterThin} corridor cells  (-${corridorsBefore - afterThin} removed from 2×2 blobs)`);

collapseDeadEnds(grid, config, rng);
const afterCollapse = (() => { let n = 0; for (const row of grid) for (const c of row) if (c.type === CellType.Corridor) n++; return n; })();
console.log(`  collapseDeadEnds:  ${afterThin} → ${afterCollapse} corridor cells  (-${afterThin - afterCollapse} dead ends removed, dead_ends="${config.dead_ends}")`);

renderGrid(grid, rooms, "After post-processing");
console.log("\n  " + gridStats(grid));

// ── Step 7: Connectivity check 2 ─────────────────────────────────────────────
sep("7 · CONNECTIVITY CHECK  (pass 2 — post-processing may re-isolate rooms)");

const reached2 = bfsReachableRooms(grid, rooms);
const isolated2 = rooms.filter(r => !reached2.has(r.id));
if (isolated2.length === 0) {
  console.log("  ✓ All rooms still connected after post-processing");
} else {
  console.log(`  ✗ ${isolated2.length} re-isolated rooms: ${isolated2.map(r => r.id).join(", ")} → force-connecting again...`);
  // (mirror generate.ts second pass — abbreviated here)
}

// ── Step 8: Features ──────────────────────────────────────────────────────────
sep("8 · FEATURE PLACEMENT");

const features = placeFeatures(grid, rooms, corridorsList, config, rng);
console.log(`  ${features.length} features placed:`);
const byType: Partial<Record<string, number>> = {};
for (const f of features) {
  const key = f.type;
  byType[key] = (byType[key] ?? 0) + 1;
}
for (const [t, n] of Object.entries(byType)) {
  console.log(`    ${t}: ${n}`);
}

// Final walls pass
for (let y = 0; y < config.grid_height; y++) {
  for (let x = 0; x < config.grid_width; x++) {
    const cell = getCell(grid, x, y);
    if (!cell || cell.type !== CellType.Empty) continue;
    const WALKABLE = new Set([CellType.Floor, CellType.Corridor, CellType.Door, CellType.SecretDoor, CellType.StairsUp, CellType.StairsDown]);
    const neighbors = [getCell(grid,x-1,y),getCell(grid,x+1,y),getCell(grid,x,y-1),getCell(grid,x,y+1)];
    if (neighbors.some(n => n && WALKABLE.has(n.type))) cell.type = CellType.Wall;
  }
}

renderGrid(grid, rooms, "FINAL  (digits=roomID  +=corridor  D=door  ^/v=stairs)");
console.log("\n  " + gridStats(grid));
console.log(`\n  Rooms: ${rooms.length}   Corridors: ${corridorsList.length}   Features: ${features.length}   Seed: ${seed}`);
console.log();
