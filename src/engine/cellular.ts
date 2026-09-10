import type { DungeonConfig } from "../ai/schema.ts";
import type { Room } from "./types.ts";
import type { SeededRandom } from "../lib/random.ts";
import { CellType } from "./types.ts";
import {
  createGrid,
  cloneGrid,
  forEachCell,
  countNeighborsByType,
  getCell,
} from "./grid.ts";
import type { Cell } from "./types.ts";

function initializeCave(
  grid: Cell[][],
  width: number,
  height: number,
  rng: SeededRandom,
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        grid[y]![x]!.type = CellType.Wall;
      } else {
        grid[y]![x]!.type = rng.chance(0.45) ? CellType.Floor : CellType.Wall;
      }
    }
  }
}

function applyAutomataStep(grid: Cell[][], width: number, height: number): Cell[][] {
  const newGrid = cloneGrid(grid);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const wallCount = countNeighborsByType(grid, x, y, CellType.Wall);
      const cell = grid[y]![x]!;
      if (cell.type === CellType.Wall) {
        if (wallCount < 3) {
          newGrid[y]![x]!.type = CellType.Floor;
        }
      } else {
        if (wallCount >= 6) {
          newGrid[y]![x]!.type = CellType.Wall;
        }
      }
    }
  }
  return newGrid;
}

interface Region {
  cells: Array<{ x: number; y: number }>;
}

function floodFill(
  grid: Cell[][],
  width: number,
  height: number,
): Region[] {
  const visited: boolean[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => false),
  );
  const regions: Region[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = getCell(grid, x, y);
      if (cell === undefined || cell.type !== CellType.Floor || visited[y]![x]) {
        continue;
      }

      const region: Region = { cells: [] };
      const stack: Array<{ x: number; y: number }> = [{ x, y }];

      while (stack.length > 0) {
        const pos = stack.pop()!;
        if (
          pos.x < 0 ||
          pos.y < 0 ||
          pos.x >= width ||
          pos.y >= height ||
          visited[pos.y]![pos.x]
        ) {
          continue;
        }
        const c = getCell(grid, pos.x, pos.y);
        if (c === undefined || c.type !== CellType.Floor) {
          continue;
        }
        visited[pos.y]![pos.x] = true;
        region.cells.push(pos);
        stack.push({ x: pos.x + 1, y: pos.y });
        stack.push({ x: pos.x - 1, y: pos.y });
        stack.push({ x: pos.x, y: pos.y + 1 });
        stack.push({ x: pos.x, y: pos.y - 1 });
      }

      if (region.cells.length > 0) {
        regions.push(region);
      }
    }
  }

  return regions;
}

function extractChambers(region: Region, targetCount: number): Room[] {
  if (region.cells.length === 0) return [];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cell of region.cells) {
    if (cell.x < minX) minX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y > maxY) maxY = cell.y;
  }

  const cellSet = new Set(region.cells.map((c) => `${c.x},${c.y}`));

  const regionW = maxX - minX + 1;
  const regionH = maxY - minY + 1;

  const cols = Math.ceil(Math.sqrt(targetCount * (regionW / regionH)));
  const rows = Math.ceil(targetCount / cols);
  const sliceW = Math.floor(regionW / cols);
  const sliceH = Math.floor(regionH / rows);

  const rooms: Room[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (rooms.length >= targetCount) break;

      const startX = minX + col * sliceW;
      const startY = minY + row * sliceH;
      const endX = col === cols - 1 ? maxX : startX + sliceW - 1;
      const endY = row === rows - 1 ? maxY : startY + sliceH - 1;

      let chamberMinX = Infinity;
      let chamberMinY = Infinity;
      let chamberMaxX = -Infinity;
      let chamberMaxY = -Infinity;
      let hasCells = false;

      for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) {
          if (cellSet.has(`${x},${y}`)) {
            if (x < chamberMinX) chamberMinX = x;
            if (y < chamberMinY) chamberMinY = y;
            if (x > chamberMaxX) chamberMaxX = x;
            if (y > chamberMaxY) chamberMaxY = y;
            hasCells = true;
          }
        }
      }

      if (!hasCells) continue;

      const w = chamberMaxX - chamberMinX + 1;
      const h = chamberMaxY - chamberMinY + 1;
      if (w < 3 || h < 3) continue;

      rooms.push({
        id: rooms.length,
        x: chamberMinX,
        y: chamberMinY,
        width: w,
        height: h,
        centerX: Math.floor(chamberMinX + w / 2),
        centerY: Math.floor(chamberMinY + h / 2),
        shape: "Cave",
        connections: [],
        features: [],
      });
    }
  }

  if (rooms.length === 0 && region.cells.length >= 9) {
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    rooms.push({
      id: 0,
      x: minX,
      y: minY,
      width: w,
      height: h,
      centerX: Math.floor(minX + w / 2),
      centerY: Math.floor(minY + h / 2),
      shape: "Cave",
      connections: [],
      features: [],
    });
  }

  return rooms;
}

export function generateCellular(
  width: number,
  height: number,
  config: DungeonConfig,
  rng: SeededRandom,
): { rooms: Room[]; caveGrid: Cell[][] } {
  const targetChambers = config.room_count ?? 10;
  let grid = createGrid(width, height);

  initializeCave(grid, width, height, rng);

  const iterations = 5;
  for (let i = 0; i < iterations; i++) {
    grid = applyAutomataStep(grid, width, height);
  }

  const regions = floodFill(grid, width, height);

  regions.sort((a, b) => b.cells.length - a.cells.length);

  const keptRegions = regions.slice(0, Math.max(1, targetChambers));

  const keptCells = new Set<string>();
  for (const region of keptRegions) {
    for (const cell of region.cells) {
      keptCells.add(`${cell.x},${cell.y}`);
    }
  }

  forEachCell(grid, (x, y, cell) => {
    if (cell.type === CellType.Floor && !keptCells.has(`${x},${y}`)) {
      cell.type = CellType.Wall;
    }
  });

  const allRooms: Room[] = [];
  for (const region of keptRegions) {
    const chambers = extractChambers(
      region,
      Math.ceil(targetChambers / keptRegions.length),
    );
    for (const chamber of chambers) {
      chamber.id = allRooms.length;
      allRooms.push(chamber);
    }
  }

  // Snap each room center to the nearest floor cell in its bounding box.
  for (const room of allRooms) {
    const center = getCell(grid, room.centerX, room.centerY);
    if (center && center.type === CellType.Floor) continue;
    let bestDist = Infinity;
    let bestX = room.centerX;
    let bestY = room.centerY;
    for (let y = room.y; y < room.y + room.height; y++) {
      for (let x = room.x; x < room.x + room.width; x++) {
        const cell = getCell(grid, x, y);
        if (!cell || cell.type !== CellType.Floor) continue;
        const dx = x - room.centerX;
        const dy = y - room.centerY;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; bestX = x; bestY = y; }
      }
    }
    room.centerX = bestX;
    room.centerY = bestY;
  }

  // Multi-source BFS (Voronoi flood fill) from all room centers simultaneously.
  // Each cave floor cell gets assigned to the first (closest) room that reaches it.
  // This guarantees every room's assigned cells are contiguous and reachable from its center.
  const bfsQueue: Array<{ x: number; y: number }> = [];
  for (const room of allRooms) {
    const cell = getCell(grid, room.centerX, room.centerY);
    if (cell && cell.type === CellType.Floor) {
      cell.roomId = room.id;
      bfsQueue.push({ x: room.centerX, y: room.centerY });
    }
  }
  let bfsHead = 0;
  while (bfsHead < bfsQueue.length) {
    const { x, y } = bfsQueue[bfsHead++]!;
    const cell = getCell(grid, x, y);
    if (!cell || cell.roomId === null) continue;
    const roomId = cell.roomId;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const nc = getCell(grid, nx, ny);
      if (!nc || nc.type !== CellType.Floor || nc.roomId !== null) continue;
      nc.roomId = roomId;
      bfsQueue.push({ x: nx, y: ny });
    }
  }

  // Wall off any cave pockets not reachable from any room center.
  forEachCell(grid, (x, y, cell) => {
    if (cell.type === CellType.Floor && cell.roomId === null) {
      cell.type = CellType.Wall;
    }
  });

  return { rooms: allRooms, caveGrid: grid };
}
