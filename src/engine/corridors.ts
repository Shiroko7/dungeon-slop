import type { DungeonConfig } from "../ai/schema.ts";
import { CellType } from "./types.ts";
import type { Cell, Room, Corridor } from "./types.ts";
import type { Edge } from "./graph.ts";
import type { SeededRandom } from "../lib/random.ts";
import { getCell, setCellType, isInBounds, isInterior, getNeighbors } from "./grid.ts";
import { MinHeap } from "../lib/heap.ts";

function carveLine(
  grid: Cell[][],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  corridorId: number,
  path: Array<{ x: number; y: number }>,
  seen: Set<string>,
): void {
  let cx = x1;
  let cy = y1;

  while (cx !== x2) {
    const key = `${cx},${cy}`;
    if (!seen.has(key) && isInterior(grid, cx, cy)) {
      seen.add(key);
      const cell = getCell(grid, cx, cy);
      // Only carve and claim cells that are truly empty — skip room floors and
      // existing corridors so no two corridors share cells or steal ownership.
      if (cell !== undefined && cell.type !== CellType.Floor && cell.type !== CellType.Corridor) {
        setCellType(grid, cx, cy, CellType.Corridor);
        cell.corridorId = corridorId;
        path.push({ x: cx, y: cy });
      }
    }
    cx += cx < x2 ? 1 : -1;
  }

  while (cy !== y2) {
    const key = `${cx},${cy}`;
    if (!seen.has(key) && isInterior(grid, cx, cy)) {
      seen.add(key);
      const cell = getCell(grid, cx, cy);
      if (cell !== undefined && cell.type !== CellType.Floor && cell.type !== CellType.Corridor) {
        setCellType(grid, cx, cy, CellType.Corridor);
        cell.corridorId = corridorId;
        path.push({ x: cx, y: cy });
      }
    }
    cy += cy < y2 ? 1 : -1;
  }

  // Final cell
  const key = `${cx},${cy}`;
  if (!seen.has(key) && isInterior(grid, cx, cy)) {
    seen.add(key);
    const cell = getCell(grid, cx, cy);
    if (cell !== undefined && cell.type !== CellType.Floor && cell.type !== CellType.Corridor) {
      setCellType(grid, cx, cy, CellType.Corridor);
      cell.corridorId = corridorId;
      path.push({ x: cx, y: cy });
    }
  }
}

function countLineRoomCells(
  grid: Cell[][],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  excludeA: number | null,
  excludeB: number | null,
): number {
  let count = 0;
  let cx = x1;
  let cy = y1;
  while (cx !== x2) {
    const cell = getCell(grid, cx, cy);
    if (
      cell !== undefined &&
      cell.type === CellType.Floor &&
      cell.roomId !== null &&
      cell.roomId !== excludeA &&
      cell.roomId !== excludeB
    ) {
      count++;
    }
    cx += cx < x2 ? 1 : -1;
  }
  while (cy !== y2) {
    const cell = getCell(grid, cx, cy);
    if (
      cell !== undefined &&
      cell.type === CellType.Floor &&
      cell.roomId !== null &&
      cell.roomId !== excludeA &&
      cell.roomId !== excludeB
    ) {
      count++;
    }
    cy += cy < y2 ? 1 : -1;
  }
  return count;
}

function carveStraight(
  grid: Cell[][],
  roomA: Room,
  roomB: Room,
  corridorId: number,
  rng: SeededRandom,
): Array<{ x: number; y: number }> {
  const path: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();

  // Count intermediate room cells for each L-shape orientation, prefer fewer.
  // Orientation H: horizontal leg at roomA.centerY, then vertical.
  // Orientation V: vertical leg at roomA.centerX, then horizontal.
  const costH =
    countLineRoomCells(grid, roomA.centerX, roomA.centerY, roomB.centerX, roomA.centerY, roomA.id, roomB.id) +
    countLineRoomCells(grid, roomB.centerX, roomA.centerY, roomB.centerX, roomB.centerY, roomA.id, roomB.id);
  const costV =
    countLineRoomCells(grid, roomA.centerX, roomA.centerY, roomA.centerX, roomB.centerY, roomA.id, roomB.id) +
    countLineRoomCells(grid, roomA.centerX, roomB.centerY, roomB.centerX, roomB.centerY, roomA.id, roomB.id);

  const useH = costH < costV || (costH === costV && rng.chance(0.5));

  if (useH) {
    carveLine(grid, roomA.centerX, roomA.centerY, roomB.centerX, roomA.centerY, corridorId, path, seen);
    carveLine(grid, roomB.centerX, roomA.centerY, roomB.centerX, roomB.centerY, corridorId, path, seen);
  } else {
    carveLine(grid, roomA.centerX, roomA.centerY, roomA.centerX, roomB.centerY, corridorId, path, seen);
    carveLine(grid, roomA.centerX, roomB.centerY, roomB.centerX, roomB.centerY, corridorId, path, seen);
  }
  return path;
}

const DIRECTIONS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

/**
 * Shared A* pathfinder used by both Labyrinth and Winding corridor styles.
 *
 * strictAdjacency=true  → cells adjacent to third-party rooms/corridors are impassable.
 * strictAdjacency=false → adjacency carries a heavy +20 cost penalty as last resort.
 * turnPenalty           → extra cost for direction changes (0=free-form, 20=L-shape only).
 *
 * Returns a path from (startX,startY) to (endX,endY), or null if unreachable.
 */
function runCorridorAStar(
  grid: Cell[][],
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  roomAId: number,
  roomBId: number,
  noiseSeed: number,
  strictAdjacency: boolean,
  turnPenalty: number,
): Array<{ x: number; y: number }> | null {
  const width = grid[0]?.length ?? 0;
  const height = grid.length;

  function noiseCost(x: number, y: number): number {
    const hash = ((x * 374761393 + y * 668265263 + noiseSeed) ^ (noiseSeed * 1274126177)) >>> 0;
    return (hash % 5) + 1;
  }

  const gScore: number[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => Infinity),
  );
  const cameFrom: Array<Array<{ x: number; y: number } | null>> = Array.from(
    { length: height },
    () => Array.from({ length: width }, () => null),
  );

  gScore[startY]![startX] = 0;
  const heuristic = Math.abs(endX - startX) + Math.abs(endY - startY);

  const open = new MinHeap<{ x: number; y: number }>();
  open.push({ x: startX, y: startY }, heuristic);
  const closed = new Set<string>();

  let found = false;

  while (open.size > 0) {
    const current = open.pop()!;

    if (current.x === endX && current.y === endY) {
      found = true;
      break;
    }

    const key = `${current.x},${current.y}`;
    if (closed.has(key)) continue;
    closed.add(key);

    for (const dir of DIRECTIONS) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;

      if (!isInterior(grid, nx, ny)) continue;
      if (closed.has(`${nx},${ny}`)) continue;

      const cell = getCell(grid, nx, ny);

      // Never route through a room that isn't the source or destination.
      if (
        cell !== undefined &&
        cell.type === CellType.Floor &&
        cell.roomId !== null &&
        cell.roomId !== roomAId &&
        cell.roomId !== roomBId
      ) {
        continue;
      }

      // Never route through an existing corridor — each path must be distinct.
      if (cell !== undefined && cell.type === CellType.Corridor) {
        continue;
      }

      let moveCost = 1;
      if (cell !== undefined && cell.type === CellType.Wall) {
        moveCost = 3 + noiseCost(nx, ny);
      } else if (cell !== undefined && cell.type === CellType.Empty) {
        moveCost = 2 + noiseCost(nx, ny);
      }

      // 1-cell gap enforcement (only for Empty/Wall candidate cells, not room/corridor cells).
      //
      // A candidate cell is rejected (pass 1) or penalised (pass 2) when any of its
      // cardinal neighbours (other than the cell we just came from) is:
      //   • a third-party room floor   — prevents corridors running along room walls
      //   • an existing corridor cell  — prevents parallel corridors from touching
      //
      // Pass 1 (strict): hard block → path will never run adjacent to rooms or corridors.
      // Pass 2 (relaxed): +20 cost   → adjacency is allowed as a last resort, but the
      //   high cost ensures A* prefers any non-adjacent route, and the uniformly-high
      //   penalty means the path stays consistently close/far rather than oscillating.
      if (cell !== undefined && cell.type !== CellType.Corridor && cell.type !== CellType.Floor) {
        let shouldBlock = false;
        for (const adj of DIRECTIONS) {
          const ax = nx + adj.dx;
          const ay = ny + adj.dy;
          if (ax === current.x && ay === current.y) continue;
          const adjCell = getCell(grid, ax, ay);
          if (adjCell === undefined) continue;

          // 1-cell gap from third-party rooms.
          if (
            adjCell.type === CellType.Floor &&
            adjCell.roomId !== null &&
            adjCell.roomId !== roomAId &&
            adjCell.roomId !== roomBId
          ) {
            shouldBlock = true;
            break;
          }

          // 1-cell gap from existing corridors.
          if (adjCell.type === CellType.Corridor) {
            shouldBlock = true;
            break;
          }
        }

        if (shouldBlock) {
          if (strictAdjacency) {
            continue; // pass 1: hard block — skip this cell entirely
          }
          moveCost += 100; // pass 2: heavy penalty, allowed when no clean route exists
        }
      }

      // Turn penalty: penalise any change of direction from the incoming heading.
      if (turnPenalty > 0) {
        const prev = cameFrom[current.y]![current.x];
        if (prev !== null) {
          const inDx = current.x - prev.x;
          const inDy = current.y - prev.y;
          if (inDx !== dir.dx || inDy !== dir.dy) {
            moveCost += turnPenalty;
          }
        }
      }

      const tentativeG = gScore[current.y]![current.x]! + moveCost;
      if (tentativeG < gScore[ny]![nx]!) {
        gScore[ny]![nx] = tentativeG;
        const f = tentativeG + Math.abs(endX - nx) + Math.abs(endY - ny);
        cameFrom[ny]![nx] = { x: current.x, y: current.y };
        open.push({ x: nx, y: ny }, f);
      }
    }
  }

  if (!found) return null;

  const path: Array<{ x: number; y: number }> = [];
  let cx = endX;
  let cy = endY;
  while (cx !== startX || cy !== startY) {
    path.push({ x: cx, y: cy });
    const prev = cameFrom[cy]![cx];
    if (prev === null) return null;
    cx = prev.x;
    cy = prev.y;
  }
  path.push({ x: startX, y: startY });
  path.reverse();
  return path;
}

/**
 * Winding corridors: A* routed through 1–2 random waypoints.
 *
 * Retries with fresh random waypoints before falling back to the relaxed
 * (penalty-based) pass. Different waypoints change the path geometry, giving
 * a genuine chance to find a gap-respecting route that the first attempt missed.
 *
 * Retry schedule:
 *   Phase 1 — up to 5 attempts with strict gap enforcement (new waypoints each time)
 *   Phase 2 — up to 3 attempts with relaxed gap enforcement (adjacency penalised)
 *   Fallback — carveStraight
 */
function carveWinding(
  grid: Cell[][],
  roomA: Room,
  roomB: Room,
  corridorId: number,
  rng: SeededRandom,
  layoutStyle: string,
): Array<{ x: number; y: number }> {
  const minX = Math.min(roomA.centerX, roomB.centerX);
  const maxX = Math.max(roomA.centerX, roomB.centerX);
  const minY = Math.min(roomA.centerY, roomB.centerY);
  const maxY = Math.max(roomA.centerY, roomB.centerY);

  if (minX === maxX || minY === maxY) {
    return carveStraight(grid, roomA, roomB, corridorId, rng);
  }

  // Mild turn penalty: constructed paths trend toward waypoints with soft bends;
  // organic paths are fully free-form between waypoints.
  const turnPenalty = layoutStyle === "constructed" ? 3 : 0;

  // Try one random waypoint configuration.
  // Consumes RNG (waypoints + noiseSeed). Returns computed segments or null.
  function tryConfig(strict: boolean): Array<Array<{ x: number; y: number }>> | null {
    const waypointCount = rng.nextInt(1, 2);
    const waypoints: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < waypointCount; i++) {
      waypoints.push({ x: rng.nextInt(minX, maxX), y: rng.nextInt(minY, maxY) });
    }
    const noiseSeed = rng.nextInt(0, 100000);

    const allPoints = [
      { x: roomA.centerX, y: roomA.centerY },
      ...waypoints,
      { x: roomB.centerX, y: roomB.centerY },
    ];

    // Compute all segment paths before carving so gap checks see only
    // pre-existing corridors, not sibling segments from this corridor.
    const segments: Array<Array<{ x: number; y: number }>> = [];
    for (let i = 0; i < allPoints.length - 1; i++) {
      const from = allPoints[i]!;
      const to = allPoints[i + 1]!;
      const seg = runCorridorAStar(
        grid, from.x, from.y, to.x, to.y,
        roomA.id, roomB.id, noiseSeed, strict, turnPenalty,
      );
      if (seg === null) return null;
      segments.push(seg);
    }
    return segments;
  }

  function carveSegments(
    segments: Array<Array<{ x: number; y: number }>>,
  ): Array<{ x: number; y: number }> {
    const path: Array<{ x: number; y: number }> = [];
    const seen = new Set<string>();
    for (const seg of segments) {
      for (const pos of seg) {
        const key = `${pos.x},${pos.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cell = getCell(grid, pos.x, pos.y);
        if (cell !== undefined && cell.type !== CellType.Floor) {
          if (cell.type !== CellType.Corridor) {
            setCellType(grid, pos.x, pos.y, CellType.Corridor);
            cell.corridorId = corridorId;
          }
          path.push(pos);
        } else if (cell !== undefined) {
          path.push(pos);
        }
      }
    }
    return path.length > 0 ? path : carveStraight(grid, roomA, roomB, corridorId, rng);
  }

  // Phase 1: try up to 5 different waypoint configs with strict gap enforcement.
  for (let attempt = 0; attempt < 5; attempt++) {
    const segs = tryConfig(true);
    if (segs !== null) return carveSegments(segs);
  }

  // Phase 2: try up to 3 different waypoint configs with relaxed gap enforcement
  // (adjacency penalised but allowed as last resort).
  for (let attempt = 0; attempt < 3; attempt++) {
    const segs = tryConfig(false);
    if (segs !== null) return carveSegments(segs);
  }

  return carveStraight(grid, roomA, roomB, corridorId, rng);
}

function carveLabyrinth(
  grid: Cell[][],
  roomA: Room,
  roomB: Room,
  corridorId: number,
  rng: SeededRandom,
  layoutStyle: string,
): Array<{ x: number; y: number }> {
  // Constructed layout: strong turn penalty → paths strongly prefer staying in the current
  // direction, producing clean L-shapes that only turn when needed (one 90° bend per corridor).
  // Organic layout: no turn penalty → free-form maze-like routing.
  const turnPenalty = layoutStyle === "constructed" ? 20 : 0;

  // Retry schedule (same as carveWinding):
  //   Phase 1 — up to 5 noiseSeeds with strict gap enforcement
  //   Phase 2 — up to 3 noiseSeeds with relaxed gap enforcement (adjacency penalised)
  //   Fallback — carveStraight
  // Different noiseSeeds perturb per-cell costs, guiding A* toward different paths
  // that may respect gaps where the first seed failed.

  function tryPath(strict: boolean): Array<{ x: number; y: number }> | null {
    const noiseSeed = rng.nextInt(0, 100000);
    return runCorridorAStar(
      grid, roomA.centerX, roomA.centerY, roomB.centerX, roomB.centerY,
      roomA.id, roomB.id, noiseSeed, strict, turnPenalty,
    );
  }

  let pathCells: Array<{ x: number; y: number }> | null = null;

  for (let attempt = 0; attempt < 5 && pathCells === null; attempt++) {
    pathCells = tryPath(true);
  }
  for (let attempt = 0; attempt < 3 && pathCells === null; attempt++) {
    pathCells = tryPath(false);
  }

  if (pathCells === null) {
    return carveStraight(grid, roomA, roomB, corridorId, rng);
  }

  for (const pos of pathCells) {
    const cell = getCell(grid, pos.x, pos.y);
    if (cell !== undefined && cell.type !== CellType.Floor) {
      setCellType(grid, pos.x, pos.y, CellType.Corridor);
      cell.corridorId = corridorId;
    }
  }

  return pathCells;
}

// ─── Corridor width helpers ───────────────────────────────────────────────────

/**
 * Compute the maximum BFS expansion radius based on room_size and grid scale.
 * radius=0 → 1-cell-wide corridors only.
 * radius=1 → corridors can be up to 3 cells wide (center ± 1).
 */
function computeMaxRadius(config: DungeonConfig): number {
  const gridScale = Math.min(config.grid_width, config.grid_height);
  const minFracs: Record<string, number> = {
    Tiny:   0.06,
    Small:  0.08,
    Medium: 0.10,
    Large:  0.16,
    Huge:   0.24,
  };
  const minFrac = minFracs[config.room_size] ?? 0.10;
  const minRoomSize = Math.max(3, Math.round(minFrac * gridScale));
  // Divisor 6: expansion only kicks in when minRoomSize ≥ 6
  // (e.g., Large+ rooms at 50×50, or Medium+ rooms at 100×100+).
  return Math.min(1, Math.floor(minRoomSize / 6));
}

/**
 * Expand a carved corridor outward by `radius` BFS steps, carving additional
 * cells onto the grid to make the corridor wider.
 *
 * Rules respected during expansion:
 * - Never expand into room floor cells.
 * - Never expand into existing corridor cells (another corridor's territory).
 * - Never expand to a cell adjacent to a third-party room floor
 *   (maintains 1-cell visual gap from rooms).
 * - Never expand to a cell adjacent to a different corridor
 *   (maintains 1-cell visual gap from other corridors).
 */
function expandCorridorPath(
  grid: Cell[][],
  path: Array<{ x: number; y: number }>,
  corridorId: number,
  roomAId: number,
  roomBId: number,
  radius: number,
): void {
  if (radius <= 0) return;

  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

  // corridorSet tracks all cells belonging to this corridor (center + expanded).
  const corridorSet = new Set<string>(path.map(p => `${p.x},${p.y}`));
  let frontier = new Set<string>(corridorSet);

  for (let step = 0; step < radius; step++) {
    const nextFrontier = new Set<string>();

    for (const key of frontier) {
      const [xs, ys] = key.split(",");
      const x = Number(xs), y = Number(ys);

      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        const nkey = `${nx},${ny}`;
        if (corridorSet.has(nkey) || nextFrontier.has(nkey)) continue;
        if (!isInterior(grid, nx, ny)) continue;

        const cell = getCell(grid, nx, ny);
        if (cell === undefined) continue;
        // Can't carve into room floors or existing (other) corridors.
        if (cell.type === CellType.Floor) continue;
        if (cell.type === CellType.Corridor) continue;

        // Check adjacency constraints: no touching third-party rooms or other corridors.
        let blocked = false;
        for (const [adx, ady] of dirs) {
          const ax = nx + adx, ay = ny + ady;
          const adjKey = `${ax},${ay}`;
          // Cells already part of this corridor are fine neighbours.
          if (corridorSet.has(adjKey) || nextFrontier.has(adjKey)) continue;

          const adjCell = getCell(grid, ax, ay);
          if (adjCell === undefined) continue;

          if (
            adjCell.type === CellType.Floor &&
            adjCell.roomId !== null &&
            adjCell.roomId !== roomAId &&
            adjCell.roomId !== roomBId
          ) {
            blocked = true;
            break;
          }
          if (adjCell.type === CellType.Corridor) {
            // Touches a different corridor — maintain 1-cell gap.
            blocked = true;
            break;
          }
        }

        if (!blocked) {
          nextFrontier.add(nkey);
        }
      }
    }

    // Carve the newly discovered cells.
    for (const key of nextFrontier) {
      const [xs, ys] = key.split(",");
      const x = Number(xs), y = Number(ys);
      const cell = getCell(grid, x, y);
      if (cell !== undefined) {
        setCellType(grid, x, y, CellType.Corridor);
        cell.corridorId = corridorId;
        corridorSet.add(key);
      }
    }

    frontier = nextFrontier;
    if (frontier.size === 0) break; // expansion exhausted
  }
}

// ─── Post-processing ──────────────────────────────────────────────────────────

/**
 * Post-processing pass: remove corridor cells that form 2x2+ clusters.
 * Iteratively finds 2x2 blocks of corridor-only cells (no roomId) and
 * removes one cell per block, choosing the most redundant cell that
 * can be removed without orphaning any neighbor.
 */
export function thinCorridors(grid: Cell[][]): void {
  const width = grid[0]?.length ?? 0;
  const height = grid.length;

  function isOpenCorridor(x: number, y: number): boolean {
    const cell = getCell(grid, x, y);
    return cell !== undefined && cell.type === CellType.Corridor && cell.roomId === null;
  }

  function isTraversable(cell: Cell): boolean {
    return (
      cell.type === CellType.Floor ||
      cell.type === CellType.Corridor ||
      cell.type === CellType.Door ||
      cell.type === CellType.SecretDoor ||
      cell.type === CellType.StairsUp ||
      cell.type === CellType.StairsDown
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        // Check for 2x2 block of corridor-only cells
        if (
          !isOpenCorridor(x, y) ||
          !isOpenCorridor(x + 1, y) ||
          !isOpenCorridor(x, y + 1) ||
          !isOpenCorridor(x + 1, y + 1)
        ) {
          continue;
        }

        // Skip 2×2 blocks where all 4 cells share the same corridorId —
        // that's intentional width from expandCorridorPath, not an unwanted blob.
        const id0 = getCell(grid, x, y)?.corridorId;
        const id1 = getCell(grid, x + 1, y)?.corridorId;
        const id2 = getCell(grid, x, y + 1)?.corridorId;
        const id3 = getCell(grid, x + 1, y + 1)?.corridorId;
        if (id0 !== null && id0 !== undefined && id0 === id1 && id0 === id2 && id0 === id3) {
          continue;
        }

        // Try to remove one cell from this block.
        // Score each candidate by number of traversable neighbors (higher = more redundant).
        const candidates: Array<{ cx: number; cy: number; score: number }> = [];
        for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]] as const) {
          const cell = getCell(grid, cx, cy);
          if (!cell || cell.featureId !== null) continue;

          const neighbors = getNeighbors(grid, cx, cy);
          const traversableCount = neighbors.filter((n) => isTraversable(n.cell)).length;
          candidates.push({ cx, cy, score: traversableCount });
        }

        // Sort descending — try the most redundant cell first
        candidates.sort((a, b) => b.score - a.score);

        for (const cand of candidates) {
          if (cand.score <= 1) continue; // Don't remove cells that are endpoints

          // Safety check: every traversable neighbor must still have at least 1
          // traversable neighbor (other than the cell we're removing)
          const neighbors = getNeighbors(grid, cand.cx, cand.cy);
          const traversableNeighbors = neighbors.filter((n) => isTraversable(n.cell));

          let safe = true;
          for (const tn of traversableNeighbors) {
            const nnNeighbors = getNeighbors(grid, tn.x, tn.y);
            const remainingTraversable = nnNeighbors.filter(
              (nn) =>
                !(nn.x === cand.cx && nn.y === cand.cy) &&
                isTraversable(nn.cell),
            );
            if (remainingTraversable.length === 0) {
              safe = false;
              break;
            }
          }

          if (safe) {
            const cell = getCell(grid, cand.cx, cand.cy)!;
            cell.type = CellType.Wall;
            cell.corridorId = null;
            changed = true;
            break;
          }
        }
      }
    }
  }
}

export function carveCorridors(
  grid: Cell[][],
  rooms: Room[],
  edges: Edge[],
  config: DungeonConfig,
  rng: SeededRandom,
  startId = 0,
): Corridor[] {
  const style = config.corridors;
  const corridors: Corridor[] = [];
  const maxRadius = computeMaxRadius(config);

  for (const edge of edges) {
    const roomA = rooms[edge.a];
    const roomB = rooms[edge.b];
    if (roomA === undefined || roomB === undefined) continue;

    const corridorId = startId + corridors.length;
    let path: Array<{ x: number; y: number }>;

    switch (style) {
      case "Winding":
        path = carveWinding(grid, roomA, roomB, corridorId, rng, config.layout_style);
        break;
      case "Labyrinth":
        path = carveLabyrinth(grid, roomA, roomB, corridorId, rng, config.layout_style);
        break;
      case "Straight":
      default:
        path = carveStraight(grid, roomA, roomB, corridorId, rng);
        break;
    }

    // Expand the corridor to its chosen width immediately after carving so that
    // subsequent corridors' A* sees the full footprint and respects the 1-cell gap.
    const radius = maxRadius > 0 ? rng.nextInt(0, maxRadius) : 0;
    if (radius > 0) {
      expandCorridorPath(grid, path, corridorId, roomA.id, roomB.id, radius);
    }

    roomA.connections.push(roomB.id);
    roomB.connections.push(roomA.id);

    corridors.push({
      id: corridorId,
      roomA: roomA.id,
      roomB: roomB.id,
      path,
      width: 1 + 2 * radius, // 1 = single-cell, 3 = triple-wide (center ± 1)
    });
  }

  return corridors;
}
