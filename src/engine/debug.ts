/**
 * Dungeon generation step-by-step debugger.
 *
 * Usage:
 *   bun run src/engine/debug.ts [seed] [layout]
 *
 * Examples:
 *   bun run src/engine/debug.ts
 *   bun run src/engine/debug.ts 42
 *   bun run src/engine/debug.ts 42 organic
 */

import { CellType } from "./types.ts";
import type { Cell, Room } from "./types.ts";
import { SeededRandom } from "../lib/random.ts";
import { createGrid, getCell } from "./grid.ts";
import { generateBSP } from "./bsp.ts";
import { placeFeatures } from "./features.ts";
import { carveShape } from "./shapes.ts";
import { generateCellular } from "./cellular.ts";
import { DEFAULT_CONFIG } from "../ai/schema.ts";
import type { DungeonConfig } from "../ai/schema.ts";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const seed   = Number(process.argv[2] ?? 42);
const layout = (process.argv[3] ?? "constructed") as DungeonConfig["layout_style"];

const config: DungeonConfig = {
  ...DEFAULT_CONFIG,
  seed,
  layout_style: layout,
  grid_width: 40,
  grid_height: 30,
  room_count: 8,
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

function roomChar(id: number): string {
  return id < 10 ? String(id) : String.fromCharCode(55 + id);
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

// ─── Pipeline ─────────────────────────────────────────────────────────────────

sep(`CONFIG  seed=${seed}  layout=${layout}  grid=${config.grid_width}×${config.grid_height}  rooms=${config.room_count}`);

const rng = new SeededRandom(seed);

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

for (let y = 0; y < config.grid_height; y++) {
  for (let x = 0; x < config.grid_width; x++) {
    const cell = getCell(grid, x, y);
    if (!cell || cell.type !== CellType.Empty) continue;
    const neighbors = [
      getCell(grid, x-1, y), getCell(grid, x+1, y),
      getCell(grid, x, y-1), getCell(grid, x, y+1),
    ];
    if (neighbors.some(n => n && n.type === CellType.Floor)) cell.type = CellType.Wall;
  }
}

renderGrid(grid, rooms, "After rooms + walls");
console.log("\n  " + gridStats(grid));

sep("3 · FEATURE PLACEMENT");

const features = placeFeatures(grid, rooms, [], config, rng);
console.log(`  ${features.length} features placed`);

for (let y = 0; y < config.grid_height; y++) {
  for (let x = 0; x < config.grid_width; x++) {
    const cell = getCell(grid, x, y);
    if (!cell || cell.type !== CellType.Empty) continue;
    const neighbors = [getCell(grid,x-1,y),getCell(grid,x+1,y),getCell(grid,x,y-1),getCell(grid,x,y+1)];
    if (neighbors.some(n => n && (n.type === CellType.Floor || n.type === CellType.StairsUp || n.type === CellType.StairsDown))) cell.type = CellType.Wall;
  }
}

renderGrid(grid, rooms, "FINAL  (digits=roomID  ^/v=stairs)");
console.log("\n  " + gridStats(grid));
console.log(`\n  Rooms: ${rooms.length}   Features: ${features.length}   Seed: ${seed}`);
console.log();
