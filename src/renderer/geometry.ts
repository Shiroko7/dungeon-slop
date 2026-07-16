import type { Dungeon, Cell } from "../engine/types.ts";
import { CellType } from "../engine/types.ts";

export interface Point {
  x: number;
  y: number;
}

export interface Polygon {
  points: Point[];
  type: "floor" | "corridor";
}

const FLOOR_TYPES = new Set([CellType.Floor, CellType.Corridor, CellType.Door, CellType.SecretDoor, CellType.StairsUp, CellType.StairsDown]);

function isWalkable(cell: Cell | undefined): boolean {
  return cell !== undefined && FLOOR_TYPES.has(cell.type);
}

export function extractDungeonPolygons(dungeon: Dungeon, cellSize: number): Polygon[] {
  const { width, height, grid } = dungeon;
  const visited: boolean[][] = Array.from({ length: height }, () => Array(width).fill(false));
  const polygons: Polygon[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = grid[y]?.[x];
      const visitedRow = visited[y];
      if (!cell || !isWalkable(cell) || !visitedRow || visitedRow[x]) continue;

      const region = floodFillRegion(grid, x, y, width, height, visited);
      const outline = traceOutline(grid, region, width, height, cellSize);
      
      if (outline.length >= 3) {
        polygons.push({
          points: outline,
          type: cell.type === CellType.Corridor ? "corridor" : "floor",
        });
      }
    }
  }

  return polygons;
}

function floodFillRegion(
  grid: Cell[][],
  startX: number,
  startY: number,
  width: number,
  height: number,
  visited: boolean[][]
): Set<string> {
  const region = new Set<string>();
  const stack: [number, number][] = [[startX, startY]];

  while (stack.length > 0) {
    const popped = stack.pop();
    if (!popped) continue;
    const [x, y] = popped;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const visitedRow = visited[y];
    if (!visitedRow || visitedRow[x]) continue;
    
    const cell = grid[y]?.[x];
    if (!cell || !isWalkable(cell)) continue;

    visitedRow[x] = true;
    region.add(`${x},${y}`);

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  return region;
}

function traceOutline(
  grid: Cell[][],
  region: Set<string>,
  width: number,
  height: number,
  cellSize: number
): Point[] {
  if (region.size === 0) return [];

  const edges: Array<[Point, Point]> = [];
  
  for (const key of region) {
    const parts = key.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    
    const right = `${x + 1},${y}`;
    const left = `${x - 1},${y}`;
    const up = `${x},${y - 1}`;
    const down = `${x},${y + 1}`;

    if (!region.has(right)) {
      edges.push([
        { x: (x + 1) * cellSize, y: y * cellSize },
        { x: (x + 1) * cellSize, y: (y + 1) * cellSize },
      ]);
    }
    if (!region.has(left)) {
      edges.push([
        { x: x * cellSize, y: (y + 1) * cellSize },
        { x: x * cellSize, y: y * cellSize },
      ]);
    }
    if (!region.has(up)) {
      edges.push([
        { x: x * cellSize, y: y * cellSize },
        { x: (x + 1) * cellSize, y: y * cellSize },
      ]);
    }
    if (!region.has(down)) {
      edges.push([
        { x: (x + 1) * cellSize, y: (y + 1) * cellSize },
        { x: x * cellSize, y: (y + 1) * cellSize },
      ]);
    }
  }

  return chainEdges(edges);
}

function chainEdges(edges: Array<[Point, Point]>): Point[] {
  if (edges.length === 0) return [];

  const edgeMap = new Map<string, Array<[Point, Point]>>();
  
  for (const edge of edges) {
    const key1 = `${edge[0].x},${edge[0].y}`;
    const key2 = `${edge[1].x},${edge[1].y}`;
    
    if (!edgeMap.has(key1)) edgeMap.set(key1, []);
    if (!edgeMap.has(key2)) edgeMap.set(key2, []);
    
    edgeMap.get(key1)!.push(edge);
    edgeMap.get(key2)!.push([edge[1], edge[0]]);
  }

  const polygon: Point[] = [];
  const used = new Set<string>();
  
  const firstEdge = edges[0];
  if (!firstEdge) return polygon;
  
  let current: [Point, Point] = firstEdge;
  polygon.push(current[0]);
  used.add(`${current[0].x},${current[0].y}-${current[1].x},${current[1].y}`);

  for (let i = 0; i < edges.length; i++) {
    const lastPoint = current[1];
    polygon.push(lastPoint);
    
    const key = `${lastPoint.x},${lastPoint.y}`;
    const candidates = edgeMap.get(key) || [];
    
    let found = false;
    for (const candidate of candidates) {
      const edgeKey = `${candidate[0].x},${candidate[0].y}-${candidate[1].x},${candidate[1].y}`;
      if (!used.has(edgeKey)) {
        used.add(edgeKey);
        current = candidate;
        found = true;
        break;
      }
    }
    
    if (!found) break;
  }

  return polygon;
}

export function extractWallOutlines(dungeon: Dungeon, cellSize: number): Point[][] {
  const { width, height, grid } = dungeon;
  const outlines: Point[][] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = grid[y]?.[x];
      if (!cell || cell.type !== CellType.Wall) continue;

      const isBoundary = 
        (y === 0 || !isWalkable(grid[y - 1]?.[x])) ||
        (y === height - 1 || !isWalkable(grid[y + 1]?.[x])) ||
        (x === 0 || !isWalkable(grid[y]?.[x - 1])) ||
        (x === width - 1 || !isWalkable(grid[y]?.[x + 1]));

      if (isBoundary) {
        const px = x * cellSize;
        const py = y * cellSize;
        outlines.push([
          { x: px, y: py },
          { x: px + cellSize, y: py },
          { x: px + cellSize, y: py + cellSize },
          { x: px, y: py + cellSize },
        ]);
      }
    }
  }

  return outlines;
}
