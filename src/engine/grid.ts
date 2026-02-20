import { CellType } from "./types.ts";
import type { Cell } from "./types.ts";

export function createGrid(width: number, height: number): Cell[][] {
  const grid: Cell[][] = [];
  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x++) {
      row.push({
        type: CellType.Empty,
        roomId: null,
        corridorId: null,
        featureId: null,
      });
    }
    grid.push(row);
  }
  return grid;
}

export function isInBounds(grid: Cell[][], x: number, y: number): boolean {
  return y >= 0 && y < grid.length && x >= 0 && x < (grid[0]?.length ?? 0);
}

/**
 * Returns true only for cells at least 1 cell inside all four grid edges.
 * Use this instead of isInBounds whenever carving walkable cells to ensure
 * no room, corridor, or dead end ever touches the grid border.
 */
export function isInterior(grid: Cell[][], x: number, y: number): boolean {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  return x >= 1 && y >= 1 && x < w - 1 && y < h - 1;
}

export function getCell(
  grid: Cell[][],
  x: number,
  y: number,
): Cell | undefined {
  if (!isInBounds(grid, x, y)) {
    return undefined;
  }
  return grid[y]![x]!;
}

export function setCell(
  grid: Cell[][],
  x: number,
  y: number,
  cell: Cell,
): void {
  if (!isInBounds(grid, x, y)) {
    return;
  }
  grid[y]![x] = cell;
}

export function setCellType(
  grid: Cell[][],
  x: number,
  y: number,
  type: CellType,
): void {
  if (!isInBounds(grid, x, y)) {
    return;
  }
  grid[y]![x]!.type = type;
}

export function forEachCell(
  grid: Cell[][],
  callback: (x: number, y: number, cell: Cell) => void,
): void {
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]!;
    for (let x = 0; x < row.length; x++) {
      callback(x, y, row[x]!);
    }
  }
}

const CARDINAL_OFFSETS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

export function getNeighbors(
  grid: Cell[][],
  x: number,
  y: number,
): Array<{ x: number; y: number; cell: Cell }> {
  const neighbors: Array<{ x: number; y: number; cell: Cell }> = [];
  for (const offset of CARDINAL_OFFSETS) {
    const nx = x + offset.dx;
    const ny = y + offset.dy;
    const cell = getCell(grid, nx, ny);
    if (cell !== undefined) {
      neighbors.push({ x: nx, y: ny, cell });
    }
  }
  return neighbors;
}

const MOORE_OFFSETS = [
  { dx: -1, dy: -1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
];

export function countNeighborsByType(
  grid: Cell[][],
  x: number,
  y: number,
  type: CellType,
  countOobAsMatch = true,
): number {
  let count = 0;
  for (const offset of MOORE_OFFSETS) {
    const nx = x + offset.dx;
    const ny = y + offset.dy;
    const cell = getCell(grid, nx, ny);
    if (cell === undefined) {
      if (countOobAsMatch) count++;
    } else if (cell.type === type) {
      count++;
    }
  }
  return count;
}

export function cloneGrid(grid: Cell[][]): Cell[][] {
  return grid.map((row) =>
    row.map((cell) => ({
      type: cell.type,
      roomId: cell.roomId,
      corridorId: cell.corridorId,
      featureId: cell.featureId,
    })),
  );
}
