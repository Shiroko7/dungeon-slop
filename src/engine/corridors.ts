import type { DungeonConfig } from "../ai/schema.ts";
import { CellType } from "./types.ts";
import type { Room, Corridor, Cell } from "./types.ts";
import type { SeededRandom } from "../lib/random.ts";
import { getCell, setCellType, isInterior, isInBounds } from "./grid.ts";
import { collapseDeadEnds } from "./features.ts";
import { MinHeap } from "../lib/heap.ts";

// ─── Union-Find (Kruskal's MST) ───────────────────────────────────────────────

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array<number>(n).fill(0);
  }

  find(x: number): number {
    const px = this.parent[x];
    if (px === undefined) return x;
    if (px !== x) this.parent[x] = this.find(px);
    return this.parent[x] ?? x;
  }

  union(x: number, y: number): boolean {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return false;
    const rankX = this.rank[rx] ?? 0;
    const rankY = this.rank[ry] ?? 0;
    if (rankX < rankY) {
      this.parent[rx] = ry;
    } else if (rankX > rankY) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx] = rankX + 1;
    }
    return true;
  }
}

// ─── Graph Builder (MST + extra edges) ───────────────────────────────────────

type RoomPair = { a: Room; b: Room };

function buildCorridorGraph(
  rooms: Room[],
  complexity: number,
  rng: SeededRandom,
): { mst: RoomPair[]; extra: RoomPair[] } {
  if (rooms.length < 2) return { mst: [], extra: [] };

  type Edge = { a: number; b: number; dist: number };
  const edges: Edge[] = [];

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const ra = rooms[i]!;
      const rb = rooms[j]!;
      const dx = ra.centerX - rb.centerX;
      const dy = ra.centerY - rb.centerY;
      edges.push({ a: i, b: j, dist: Math.sqrt(dx * dx + dy * dy) });
    }
  }

  edges.sort((a, b) => a.dist - b.dist);

  const uf = new UnionFind(rooms.length);
  const mstEdges: Edge[] = [];
  const extraEdges: Edge[] = [];

  for (const edge of edges) {
    if (uf.union(edge.a, edge.b)) {
      mstEdges.push(edge);
    } else {
      extraEdges.push(edge);
    }
  }

  const mst: RoomPair[] = mstEdges.map((e) => ({ a: rooms[e.a]!, b: rooms[e.b]! }));

  // Extra edges are selected by complexity probability, sorted shortest-first.
  // Collision filtering happens later in carveCorridors once cells are carved.
  const extra: RoomPair[] = [];
  for (const edge of extraEdges) {
    if (rng.chance(complexity * 0.3)) {
      extra.push({ a: rooms[edge.a]!, b: rooms[edge.b]! });
    }
  }

  return { mst, extra };
}

// ─── Corridor Overlap Estimator ───────────────────────────────────────────────

/**
 * Walks a simple L-shape path between two room centers and returns the fraction
 * of cells that are already carved as Corridor/Door cells.
 * Used to skip extra corridors that would mostly re-trace existing paths.
 */
function estimateCorridorOverlap(grid: Cell[][], a: Room, b: Room): number {
  const x1 = a.centerX, y1 = a.centerY;
  const x2 = b.centerX, y2 = b.centerY;
  let total = 0, alreadyCarved = 0;

  const xStep = x2 >= x1 ? 1 : -1;
  for (let x = x1; x !== x2 + xStep; x += xStep) {
    const cell = getCell(grid, x, y1);
    if (cell) {
      total++;
      if (cell.type === CellType.Corridor || cell.type === CellType.Door) alreadyCarved++;
    }
  }
  const yStep = y2 >= y1 ? 1 : -1;
  for (let y = y1 + yStep; y !== y2 + yStep; y += yStep) {
    const cell = getCell(grid, x2, y);
    if (cell) {
      total++;
      if (cell.type === CellType.Corridor || cell.type === CellType.Door) alreadyCarved++;
    }
  }

  return total > 0 ? alreadyCarved / total : 0;
}

// ─── Cell Carving Helper ──────────────────────────────────────────────────────

/**
 * Attempt to carve (x, y) as a corridor cell owned by `id`.
 * - Room floor cells belonging to roomA or roomB: added to path unchanged.
 * - Third-party room floor cells: skipped entirely.
 * - Existing Corridor/Door/Stairs cells: added to path without changing ownership.
 * - Empty or Wall cells: carved as Corridor, corridorId set, roomId cleared.
 */
function carveCell(
  grid: Cell[][],
  x: number,
  y: number,
  id: number,
  roomAId: number,
  roomBId: number,
  path: Array<{ x: number; y: number }>,
): void {
  if (!isInterior(grid, x, y)) return;
  const cell = getCell(grid, x, y);
  if (!cell) return;

  if (cell.type === CellType.Floor) {
    // Own endpoint room: pass through without changing cell ownership
    if (cell.roomId === roomAId || cell.roomId === roomBId) {
      path.push({ x, y });
    }
    // Third-party room: skip
    return;
  }

  if (
    cell.type === CellType.Corridor ||
    cell.type === CellType.Door ||
    cell.type === CellType.SecretDoor ||
    cell.type === CellType.StairsUp ||
    cell.type === CellType.StairsDown
  ) {
    // Already walkable — add to path without overwriting ownership
    path.push({ x, y });
    return;
  }

  // Empty or Wall: carve as corridor
  setCellType(grid, x, y, CellType.Corridor);
  cell.roomId = null;
  cell.corridorId = id;
  path.push({ x, y });
}

// ─── Straight Carver ──────────────────────────────────────────────────────────

function carveStraight(
  grid: Cell[][],
  roomA: Room,
  roomB: Room,
  id: number,
  rng: SeededRandom,
): Corridor {
  const path: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();

  const tx = roomB.centerX, ty = roomB.centerY;

  const carveSegH = (fromX: number, toX: number, y: number) => {
    const step = toX >= fromX ? 1 : -1;
    for (let x = fromX; x !== toX + step; x += step) {
      const k = `${x},${y}`;
      if (!seen.has(k)) { seen.add(k); carveCell(grid, x, y, id, roomA.id, roomB.id, path); }
    }
  };

  const carveSegV = (fromY: number, toY: number, x: number) => {
    const step = toY >= fromY ? 1 : -1;
    for (let y = fromY; y !== toY + step; y += step) {
      const k = `${x},${y}`;
      if (!seen.has(k)) { seen.add(k); carveCell(grid, x, y, id, roomA.id, roomB.id, path); }
    }
  };

  let cx = roomA.centerX, cy = roomA.centerY;
  let hTurn = rng.chance(0.5);

  // Alternate H/V segments. At each step, 50% chance to cover only a partial
  // amount of the remaining distance — creating extra bends (S/Z/staircase).
  // Guaranteed to terminate: every segment advances ≥1 cell toward the target.
  for (;;) {
    const remX = tx - cx;
    const remY = ty - cy;

    if (remX === 0 && remY === 0) break;

    if (remX === 0) { carveSegV(cy, ty, cx); cy = ty; break; }
    if (remY === 0) { carveSegH(cx, tx, cy); cx = tx; break; }

    if (hTurn) {
      const absRemX = Math.abs(remX);
      const targetX = (absRemX <= 1 || rng.chance(0.33))
        ? tx
        : cx + Math.sign(remX) * rng.nextInt(1, absRemX - 1);
      carveSegH(cx, targetX, cy);
      cx = targetX;
      hTurn = false;
    } else {
      const absRemY = Math.abs(remY);
      const targetY = (absRemY <= 1 || rng.chance(0.33))
        ? ty
        : cy + Math.sign(remY) * rng.nextInt(1, absRemY - 1);
      carveSegV(cy, targetY, cx);
      cy = targetY;
      hTurn = true;
    }
  }

  return { id, roomA: roomA.id, roomB: roomB.id, path, width: 1 };
}

// ─── Winding Carver ───────────────────────────────────────────────────────────

function carveWinding(
  grid: Cell[][],
  roomA: Room,
  roomB: Room,
  id: number,
  rng: SeededRandom,
): Corridor {
  const x1 = roomA.centerX, y1 = roomA.centerY;
  const x2 = roomB.centerX, y2 = roomB.centerY;
  const dx0 = x2 - x1, dy0 = y2 - y1;
  const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0);
  const maxSteps = Math.max(60, Math.floor(dist * 4));

  const path: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();

  // Carve the start cell
  carveCell(grid, x1, y1, id, roomA.id, roomB.id, path);
  seen.add(`${x1},${y1}`);

  let cx = x1, cy = y1;
  let ndx = 0, ndy = 0; // current direction, re-evaluated every 2 steps

  for (let step = 0; step < maxSteps; step++) {
    if (cx === x2 && cy === y2) break;

    const tdx = x2 - cx, tdy = y2 - cy;

    // Re-evaluate direction every 3 steps
    if (step % 3 === 0) {
      // Choose bias direction toward target (prefer the longer axis)
      if (tdx === 0 && tdy === 0) break;
      if (Math.abs(tdx) >= Math.abs(tdy) && tdx !== 0) {
        ndx = Math.sign(tdx); ndy = 0;
      } else if (tdy !== 0) {
        ndx = 0; ndy = Math.sign(tdy);
      } else {
        ndx = Math.sign(tdx); ndy = 0;
      }

      // 50% chance to deviate ±90°
      if (rng.chance(0.5)) {
        if (rng.chance(0.5)) {
          [ndx, ndy] = [-ndy, ndx]; // rotate left
        } else {
          [ndx, ndy] = [ndy, -ndx]; // rotate right
        }
      }
    }

    // Try chosen direction; if blocked, fall back to bias direction
    const tryDir = (ddx: number, ddy: number): { x: number; y: number } | null => {
      const nx = cx + ddx, ny = cy + ddy;
      if (!isInterior(grid, nx, ny)) return null;
      const nc = getCell(grid, nx, ny);
      if (!nc) return null;
      // Skip third-party room floors
      if (
        nc.type === CellType.Floor &&
        nc.roomId !== null &&
        nc.roomId !== roomA.id &&
        nc.roomId !== roomB.id
      ) return null;
      return { x: nx, y: ny };
    };

    // Compute the direct bias direction (may equal ndx,ndy)
    const biasDx = (Math.abs(tdx) >= Math.abs(tdy) && tdx !== 0)
      ? Math.sign(tdx) : (tdy !== 0 ? 0 : Math.sign(tdx));
    const biasDy = (Math.abs(tdx) >= Math.abs(tdy) && tdx !== 0)
      ? 0 : (tdy !== 0 ? Math.sign(tdy) : 0);

    const next =
      tryDir(ndx, ndy) ??
      (ndx !== biasDx || ndy !== biasDy ? tryDir(biasDx, biasDy) : null);

    if (!next) break; // stuck — rely on fallback below

    cx = next.x; cy = next.y;
    const key = `${cx},${cy}`;
    if (!seen.has(key)) {
      seen.add(key);
      carveCell(grid, cx, cy, id, roomA.id, roomB.id, path);
    }
  }

  // If we didn't reach the target, append a straight L-shape fallback
  if (cx !== x2 || cy !== y2) {
    const xStep = x2 >= cx ? 1 : -1;
    for (let x = cx; x !== x2 + xStep; x += xStep) {
      const key = `${x},${cy}`;
      if (!seen.has(key)) {
        seen.add(key);
        carveCell(grid, x, cy, id, roomA.id, roomB.id, path);
      }
    }
    const yStep = y2 >= cy ? 1 : -1;
    for (let y = cy + yStep; y !== y2 + yStep; y += yStep) {
      const key = `${x2},${y}`;
      if (!seen.has(key)) {
        seen.add(key);
        carveCell(grid, x2, y, id, roomA.id, roomB.id, path);
      }
    }
  }

  return { id, roomA: roomA.id, roomB: roomB.id, path, width: 1 };
}

// ─── Labyrinth Carver (A*) ────────────────────────────────────────────────────

/**
 * A* from (startX,startY) to (endX,endY).
 * Pass 1 (usePenalty=false): hard-blocks cells adjacent to third-party rooms.
 * Pass 2 (usePenalty=true):  applies +20 cost for third-party adjacency instead.
 */
function runAStar(
  grid: Cell[][],
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  roomA: Room,
  roomB: Room,
  usePenalty: boolean,
): Array<{ x: number; y: number }> | null {
  const heap = new MinHeap<{ x: number; y: number; g: number }>();
  const gMap = new Map<string, number>();
  const parentMap = new Map<string, string | null>();

  const startKey = `${startX},${startY}`;
  gMap.set(startKey, 0);
  parentMap.set(startKey, null);
  heap.push(
    { x: startX, y: startY, g: 0 },
    Math.abs(endX - startX) + Math.abs(endY - startY),
  );

  const ADJACENCY_PENALTY = 20;

  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

  while (heap.size > 0) {
    const node = heap.pop();
    if (!node) break;
    const { x, y, g } = node;
    const key = `${x},${y}`;

    if (g > (gMap.get(key) ?? Infinity)) continue; // stale

    if (x === endX && y === endY) {
      // Reconstruct path from end to start
      const result: Array<{ x: number; y: number }> = [];
      let k: string | null = key;
      while (k !== null) {
        const comma = k.indexOf(",");
        result.unshift({ x: Number(k.slice(0, comma)), y: Number(k.slice(comma + 1)) });
        const parent = parentMap.get(k);
        k = parent !== undefined ? parent : null;
      }
      return result;
    }

    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!isInterior(grid, nx, ny)) continue;
      const cell = getCell(grid, nx, ny);
      if (!cell) continue;

      // Is this cell itself a third-party room floor?
      const isThirdPartyFloor =
        cell.type === CellType.Floor &&
        cell.roomId !== null &&
        cell.roomId !== roomA.id &&
        cell.roomId !== roomB.id;

      if (!usePenalty && isThirdPartyFloor) continue;

      // Check if any cardinal neighbor of (nx,ny) is a third-party room floor
      let thirdPartyAdj = false;
      for (const [adx, ady] of DIRS) {
        const adj = getCell(grid, nx + adx, ny + ady);
        if (
          adj &&
          adj.type === CellType.Floor &&
          adj.roomId !== null &&
          adj.roomId !== roomA.id &&
          adj.roomId !== roomB.id
        ) {
          thirdPartyAdj = true;
          break;
        }
      }

      if (!usePenalty && thirdPartyAdj) continue;

      let stepCost = 1;
      if (usePenalty && (isThirdPartyFloor || thirdPartyAdj)) {
        stepCost += ADJACENCY_PENALTY;
      }

      const newG = g + stepCost;
      const nKey = `${nx},${ny}`;
      if (newG < (gMap.get(nKey) ?? Infinity)) {
        gMap.set(nKey, newG);
        parentMap.set(nKey, key);
        const h = Math.abs(endX - nx) + Math.abs(endY - ny);
        heap.push({ x: nx, y: ny, g: newG }, newG + h);
      }
    }
  }

  return null;
}

function carveLabyrinth(
  grid: Cell[][],
  roomA: Room,
  roomB: Room,
  id: number,
): Corridor {
  const path: Array<{ x: number; y: number }> = [];

  // Pass 1: strict — hard-block third-party adjacency
  let astarPath = runAStar(
    grid,
    roomA.centerX, roomA.centerY,
    roomB.centerX, roomB.centerY,
    roomA, roomB,
    false,
  );

  // Pass 2: penalty fallback — allow adjacency with +20 cost
  if (!astarPath) {
    astarPath = runAStar(
      grid,
      roomA.centerX, roomA.centerY,
      roomB.centerX, roomB.centerY,
      roomA, roomB,
      true,
    );
  }

  if (astarPath) {
    for (const { x, y } of astarPath) {
      carveCell(grid, x, y, id, roomA.id, roomB.id, path);
    }
  }

  return { id, roomA: roomA.id, roomB: roomB.id, path, width: 1 };
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

// Maximum fraction of a candidate corridor's path that may overlap with
// already-carved corridor cells before the corridor is skipped entirely.
const CORRIDOR_COLLISION_THRESHOLD = 0.5;

export function carveCorridors(
  grid: Cell[][],
  rooms: Room[],
  config: DungeonConfig,
  rng: SeededRandom,
): Corridor[] {
  const { mst, extra } = buildCorridorGraph(rooms, config.corridor_complexity, rng);
  const corridors: Corridor[] = [];
  let nextId = 0;

  const carveEdge = (a: Room, b: Room) => {
    const id = nextId++;
    let corridor: Corridor;
    switch (config.corridors) {
      case "Winding":
        corridor = carveWinding(grid, a, b, id, rng);
        break;
      case "Labyrinth":
        corridor = carveLabyrinth(grid, a, b, id);
        break;
      default: // "Straight"
        corridor = carveStraight(grid, a, b, id, rng);
        break;
    }
    corridors.push(corridor);
    if (!a.connections.includes(b.id)) a.connections.push(b.id);
    if (!b.connections.includes(a.id)) b.connections.push(a.id);
  };

  // MST edges are always carved — they guarantee full connectivity.
  for (const { a, b } of mst) {
    carveEdge(a, b);
  }

  // Extra edges are carved only if their estimated path doesn't mostly
  // re-trace already-carved corridor cells. This is the sole limiter:
  // corridors that would collide/overlap heavily are skipped, others aren't.
  for (const { a, b } of extra) {
    if (estimateCorridorOverlap(grid, a, b) <= CORRIDOR_COLLISION_THRESHOLD) {
      carveEdge(a, b);
    }
  }

  // Remove accidental dead-end stubs (no-op unless dead_ends === "None")
  collapseDeadEnds(grid, config, rng);

  return corridors;
}

// ─── Entry Corridor Carver ────────────────────────────────────────────────────

function getEntryCount(config: DungeonConfig, rng: SeededRandom): number {
  switch (config.entry_points) {
    case "None":  return 0;
    case "Few":   return rng.nextInt(1, 2);
    case "Many":  return rng.nextInt(3, 4);
    case "Exact": return config.entry_point_count ?? 1;
    default:      return 0;
  }
}

/**
 * Carve a single entry corridor from the grid border to the target room.
 * Border cells are carved directly (bypassing the isInterior guard).
 * Interior cells use standard carveCell logic with the target as both endpoints.
 */
function carveEntryLine(
  grid: Cell[][],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  id: number,
  targetRoomId: number,
  path: Array<{ x: number; y: number }>,
): void {
  const gridH = grid.length;
  const gridW = grid[0]?.length ?? 0;

  const carveSingleCell = (x: number, y: number) => {
    if (!isInBounds(grid, x, y)) return;
    const cell = getCell(grid, x, y);
    if (!cell) return;

    // If it's the target room's floor, include in path without modifying
    if (cell.type === CellType.Floor && cell.roomId === targetRoomId) {
      path.push({ x, y });
      return;
    }

    // Border cell (not interior): carve directly, bypassing isInterior guard
    const onBorder = x === 0 || y === 0 || x === gridW - 1 || y === gridH - 1;
    if (onBorder) {
      setCellType(grid, x, y, CellType.Corridor);
      cell.roomId = null;
      cell.corridorId = id;
      path.push({ x, y });
      return;
    }

    // Interior cell: use standard carveCell with target room as both endpoints
    carveCell(grid, x, y, id, targetRoomId, targetRoomId, path);
  };

  if (x1 === x2) {
    // Vertical
    const step = y2 >= y1 ? 1 : -1;
    for (let y = y1; y !== y2 + step; y += step) {
      carveSingleCell(x1, y);
    }
  } else {
    // Horizontal
    const step = x2 >= x1 ? 1 : -1;
    for (let x = x1; x !== x2 + step; x += step) {
      carveSingleCell(x, y1);
    }
  }
}

export function carveEntryCorridors(
  grid: Cell[][],
  rooms: Room[],
  config: DungeonConfig,
  rng: SeededRandom,
  startId: number,
): Corridor[] {
  if (rooms.length === 0) return [];

  const count = getEntryCount(config, rng);
  if (count === 0) return [];

  const gridH = grid.length;
  const gridW = grid[0]?.length ?? 0;

  const corridors: Corridor[] = [];

  // Shuffle edges so we pick without replacement
  const edges = ["N", "S", "E", "W"] as const;
  const shuffled = [...edges].sort(() => rng.chance(0.5) ? -1 : 1);
  let edgeIndex = 0;

  for (let i = 0; i < count; i++) {
    if (edgeIndex >= shuffled.length) {
      // Reshuffle if we need more entries than edges
      shuffled.sort(() => rng.chance(0.5) ? -1 : 1);
      edgeIndex = 0;
    }

    const edge = shuffled[edgeIndex++]!;
    const id = startId + i;
    const path: Array<{ x: number; y: number }> = [];

    // Find room closest to this edge
    let targetRoom: Room = rooms[0]!;
    if (edge === "N") {
      for (const r of rooms) {
        if (r.centerY < targetRoom.centerY) targetRoom = r;
      }
      // Carve from (centerX, 0) down to (centerX, room.y)
      carveEntryLine(grid, targetRoom.centerX, 0, targetRoom.centerX, targetRoom.y, id, targetRoom.id, path);
    } else if (edge === "S") {
      for (const r of rooms) {
        if (r.centerY > targetRoom.centerY) targetRoom = r;
      }
      // Carve from (centerX, gridH-1) up to (centerX, room.y + room.height - 1)
      carveEntryLine(grid, targetRoom.centerX, gridH - 1, targetRoom.centerX, targetRoom.y + targetRoom.height - 1, id, targetRoom.id, path);
    } else if (edge === "E") {
      for (const r of rooms) {
        if (r.centerX > targetRoom.centerX) targetRoom = r;
      }
      // Carve from (gridW-1, centerY) left to (room.x + room.width - 1, centerY)
      carveEntryLine(grid, gridW - 1, targetRoom.centerY, targetRoom.x + targetRoom.width - 1, targetRoom.centerY, id, targetRoom.id, path);
    } else {
      // West
      for (const r of rooms) {
        if (r.centerX < targetRoom.centerX) targetRoom = r;
      }
      // Carve from (0, centerY) right to (room.x, centerY)
      carveEntryLine(grid, 0, targetRoom.centerY, targetRoom.x, targetRoom.centerY, id, targetRoom.id, path);
    }

    corridors.push({ id, roomA: targetRoom.id, roomB: -1, path, width: 1 });
  }

  return corridors;
}
