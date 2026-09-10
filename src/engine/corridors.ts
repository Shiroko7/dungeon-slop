import type { DungeonConfig } from "../ai/schema.ts";
import { CellType } from "./types.ts";
import type { Room, Corridor, Cell } from "./types.ts";
import type { SeededRandom } from "../lib/random.ts";
import { getCell, setCellType, isInterior, isInBounds } from "./grid.ts";
import { collapseDeadEnds } from "./features.ts";
import { MinHeap } from "../lib/heap.ts";
import { delaunayTriangulation, minimumSpanningTree, type Edge } from "./graph.ts";
import { distance } from "../lib/math.ts";

// ─── Corridor Graph ──────────────────────────────────────────────────────────

type RoomPair = { a: Room; b: Room };

/*
 * Which rooms get joined.
 *
 * The edge candidates come from a Delaunay triangulation of the room centres,
 * NOT the complete graph. That distinction is the whole fix for absurd hallways:
 * a Delaunay edge only ever joins rooms that are spatial neighbours, so no
 * corridor can leap across the map past three rooms sitting in between. The
 * previous complete-graph version is exactly how Icecrown got an 810 ft corridor
 * from room 2 to room 4.
 *
 * Extra (non-tree) edges are chosen SHORTEST first and counted proportionally to
 * the number of rooms. As a per-pair probability it was quadratic - the same
 * corridor_complexity of 0.4 meant +7 corridors at 6 rooms and +117 at 48.
 */
function buildCorridorGraph(
  rooms: Room[],
  complexity: number,
  rng: SeededRandom,
): { mst: RoomPair[]; extra: RoomPair[] } {
  if (rooms.length < 2) return { mst: [], extra: [] };

  const points = rooms.map((r) => ({ x: r.centerX, y: r.centerY }));

  // Degenerate point sets (collinear centres, which symmetric layouts produce
  // readily) can leave the triangulation short of a spanning set. Falling back
  // to the complete graph keeps connectivity guaranteed; it is the long-corridor
  // risk, but a disconnected dungeon is not shippable at all.
  let candidates: Edge[] = delaunayTriangulation(points);
  let mstEdges = minimumSpanningTree(candidates, rooms.length);
  if (mstEdges.length < rooms.length - 1) {
    candidates = [];
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        candidates.push({ a: i, b: j, weight: distance(points[i]!, points[j]!) });
      }
    }
    mstEdges = minimumSpanningTree(candidates, rooms.length);
  }

  const key = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;
  const inMst = new Set(mstEdges.map((e) => key(e.a, e.b)));

  const nonMst = candidates
    .filter((e) => !inMst.has(key(e.a, e.b)))
    .sort((a, b) => a.weight - b.weight);

  // A little jitter so the loops picked are not identical run to run, while the
  // shortest-first bias still holds.
  // At least one loop on any map big enough to have one. A pure tree is the
  // classic procedural tell: every branch has to be retraced step for step, and
  // the layout has no shape a player can hold in their head.
  const wantsLoop = rooms.length >= 4 ? 1 : 0;
  const extraCount = Math.min(
    nonMst.length,
    Math.max(wantsLoop, Math.round(complexity * rooms.length * 0.6 * rng.nextFloat(0.75, 1.25))),
  );

  return {
    mst: mstEdges.map((e) => ({ a: rooms[e.a]!, b: rooms[e.b]! })),
    extra: nonMst.slice(0, Math.max(0, extraCount)).map((e) => ({ a: rooms[e.a]!, b: rooms[e.b]! })),
  };
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

// ─── Routing ──────────────────────────────────────────────────────────────────

type Point = { x: number; y: number };

/**
 * A corridor is never part of a room.
 *
 * There is no exemption for its own endpoints. A corridor runs from one room's
 * boundary to another's and meets each only at a door, so no cell it owns may
 * belong to any room at all. Routing therefore treats every room cell as solid,
 * and the carvers below plan a route before touching the grid so an unroutable
 * attempt leaves nothing behind.
 */
function isRoomCell(grid: Cell[][], x: number, y: number): boolean {
  const cell = getCell(grid, x, y);
  return cell !== undefined && cell.roomId !== null;
}

function isThirdPartyRoomCell(grid: Cell[][], x: number, y: number, a: number, b: number): boolean {
  const cell = getCell(grid, x, y);
  return cell !== undefined && cell.roomId !== null && cell.roomId !== a && cell.roomId !== b;
}

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

function adjacentToRoom(grid: Cell[][], x: number, y: number, roomId: number): boolean {
  for (const [dx, dy] of DIRS) {
    const cell = getCell(grid, x + dx, y + dy);
    if (cell !== undefined && cell.roomId === roomId) return true;
  }
  return false;
}

/** Do these two rooms already touch, leaving nothing for a corridor to do? */
function roomsAdjoin(grid: Cell[][], a: Room, b: Room): boolean {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const x0 = Math.max(0, Math.min(a.x, b.x) - 1);
  const x1 = Math.min(width - 1, Math.max(a.x + a.width, b.x + b.width) + 1);
  const y0 = Math.max(0, Math.min(a.y, b.y) - 1);
  const y1 = Math.min(height - 1, Math.max(a.y + a.height, b.y + b.height) + 1);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cell = getCell(grid, x, y);
      if (cell?.roomId !== a.id) continue;
      if (adjacentToRoom(grid, x, y, b.id)) return true;
    }
  }
  return false;
}

/**
 * Cells just outside a room, ordered by how close they are to `toward`.
 *
 * These are where a corridor may begin: adjacent to the room it serves, but not
 * part of it. Cells that already belong to some other room are excluded, so a
 * corridor can never start life standing on a third party's floor.
 */
function exitCells(grid: Cell[][], room: Room, toward: Room): Point[] {
  const found: Point[] = [];
  const seen = new Set<string>();
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  for (let y = Math.max(0, room.y - 1); y <= Math.min(height - 1, room.y + room.height); y++) {
    for (let x = Math.max(0, room.x - 1); x <= Math.min(width - 1, room.x + room.width); x++) {
      const cell = getCell(grid, x, y);
      if (cell?.roomId !== room.id) continue;

      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        if (!isInterior(grid, nx, ny)) continue;
        if (isRoomCell(grid, nx, ny)) continue;
        seen.add(key);
        found.push({ x: nx, y: ny });
      }
    }
  }

  found.sort(
    (p, q) =>
      Math.abs(p.x - toward.centerX) + Math.abs(p.y - toward.centerY) -
      (Math.abs(q.x - toward.centerX) + Math.abs(q.y - toward.centerY)),
  );
  return found;
}

/** Is this a contiguous, room-free run? */
function isSoundRoute(grid: Cell[][], route: Point[]): boolean {
  for (let i = 0; i < route.length; i++) {
    const p = route[i]!;
    if (!isInterior(grid, p.x, p.y)) return false;
    if (isRoomCell(grid, p.x, p.y)) return false;
    if (i === 0) continue;
    const q = route[i - 1]!;
    if (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) !== 1) return false;
  }
  return true;
}

/**
 * Reduce a centre-to-centre walk to the corridor part of it.
 *
 * The walk starts and ends inside rooms, so both ends are trimmed back to the
 * boundary. Anything left that still touches a room means the walk cut through
 * one - the caller then reroutes rather than carving a corridor with a room in
 * the middle of it.
 */
function toRoute(grid: Cell[][], walk: Point[], a: Room, b: Room): Point[] | null {
  let start = 0;
  while (start < walk.length && isRoomCell(grid, walk[start]!.x, walk[start]!.y)) start++;
  let end = walk.length - 1;
  while (end >= start && isRoomCell(grid, walk[end]!.x, walk[end]!.y)) end--;
  if (start > end) return null;

  const deduped: Point[] = [];
  const seen = new Set<string>();
  for (const p of walk.slice(start, end + 1)) {
    const key = `${p.x},${p.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  if (!isSoundRoute(grid, deduped)) return null;

  // It has to actually reach both rooms, or it joins nothing.
  const first = deduped[0]!;
  const last = deduped[deduped.length - 1]!;
  if (!adjacentToRoom(grid, first.x, first.y, a.id)) return null;
  if (!adjacentToRoom(grid, last.x, last.y, b.id)) return null;

  return deduped;
}

// ─── Straight Planner ─────────────────────────────────────────────────────────

/** The classic L / staircase walk, centre to centre. Pure: reads nothing. */
function planStraight(roomA: Room, roomB: Room, rng: SeededRandom): Point[] {
  const walk: Point[] = [];
  const tx = roomB.centerX;
  const ty = roomB.centerY;

  const segH = (fromX: number, toX: number, y: number) => {
    const step = toX >= fromX ? 1 : -1;
    for (let x = fromX; x !== toX + step; x += step) walk.push({ x, y });
  };
  const segV = (fromY: number, toY: number, x: number) => {
    const step = toY >= fromY ? 1 : -1;
    for (let y = fromY; y !== toY + step; y += step) walk.push({ x, y });
  };

  let cx = roomA.centerX;
  let cy = roomA.centerY;
  let hTurn = rng.chance(0.5);
  walk.push({ x: cx, y: cy });

  // Alternate H/V segments. At each step, 50% chance to cover only a partial
  // amount of the remaining distance — creating extra bends (S/Z/staircase).
  // Guaranteed to terminate: every segment advances ≥1 cell toward the target.
  for (;;) {
    const remX = tx - cx;
    const remY = ty - cy;
    if (remX === 0 && remY === 0) break;

    if (remX === 0) { segV(cy, ty, cx); cy = ty; break; }
    if (remY === 0) { segH(cx, tx, cy); cx = tx; break; }

    if (hTurn) {
      const absRemX = Math.abs(remX);
      const targetX = (absRemX <= 1 || rng.chance(0.33))
        ? tx
        : cx + Math.sign(remX) * rng.nextInt(1, absRemX - 1);
      segH(cx, targetX, cy);
      cx = targetX;
      hTurn = false;
    } else {
      const absRemY = Math.abs(remY);
      const targetY = (absRemY <= 1 || rng.chance(0.33))
        ? ty
        : cy + Math.sign(remY) * rng.nextInt(1, absRemY - 1);
      segV(cy, targetY, cx);
      cy = targetY;
      hTurn = true;
    }
  }

  return walk;
}

// ─── Winding Planner ──────────────────────────────────────────────────────────

function planWinding(grid: Cell[][], roomA: Room, roomB: Room, rng: SeededRandom): Point[] {
  const x1 = roomA.centerX, y1 = roomA.centerY;
  const x2 = roomB.centerX, y2 = roomB.centerY;
  const dx0 = x2 - x1, dy0 = y2 - y1;
  const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0);
  const maxSteps = Math.max(60, Math.floor(dist * 4));

  const walk: Point[] = [{ x: x1, y: y1 }];
  let cx = x1, cy = y1;
  let ndx = 0, ndy = 0; // current direction, re-evaluated every 3 steps

  for (let step = 0; step < maxSteps; step++) {
    if (cx === x2 && cy === y2) break;
    const tdx = x2 - cx, tdy = y2 - cy;

    if (step % 3 === 0) {
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
        if (rng.chance(0.5)) [ndx, ndy] = [-ndy, ndx];
        else [ndx, ndy] = [ndy, -ndx];
      }
    }

    const tryDir = (ddx: number, ddy: number): Point | null => {
      const nx = cx + ddx, ny = cy + ddy;
      if (!isInterior(grid, nx, ny)) return null;
      if (isThirdPartyRoomCell(grid, nx, ny, roomA.id, roomB.id)) return null;
      return { x: nx, y: ny };
    };

    const biasDx = (Math.abs(tdx) >= Math.abs(tdy) && tdx !== 0)
      ? Math.sign(tdx) : (tdy !== 0 ? 0 : Math.sign(tdx));
    const biasDy = (Math.abs(tdx) >= Math.abs(tdy) && tdx !== 0)
      ? 0 : (tdy !== 0 ? Math.sign(tdy) : 0);

    const next =
      tryDir(ndx, ndy) ??
      (ndx !== biasDx || ndy !== biasDy ? tryDir(biasDx, biasDy) : null);
    if (!next) break;

    cx = next.x; cy = next.y;
    walk.push({ x: cx, y: cy });
  }

  // Didn't arrive — finish with a straight L so the walk still reaches the room.
  // It may cut a corner off a third room; toRoute() catches that and the caller
  // reroutes, which is why this is allowed to be naive.
  if (cx !== x2 || cy !== y2) {
    const xStep = x2 >= cx ? 1 : -1;
    for (let x = cx + xStep; x !== x2 + xStep; x += xStep) walk.push({ x, y: cy });
    const yStep = y2 >= cy ? 1 : -1;
    for (let y = cy + yStep; y !== y2 + yStep; y += yStep) walk.push({ x: x2, y });
  }

  return walk;
}

// ─── A* Planner ───────────────────────────────────────────────────────────────

const ADJACENCY_PENALTY = 20;

/**
 * Route from any cell just outside one room to any cell just outside the other,
 * with every room cell solid.
 *
 * Multi-source and multi-target on purpose: a room has many ways out, and the
 * one nearest the destination is often in a dead pocket a cave wall wraps around.
 * Seeding every exit at zero cost finds the best of them in a single search,
 * where trying the most promising few in turn both misses routes and costs more.
 *
 * `allowAdjacency` relaxes only the preference for keeping a gap between the
 * corridor and unrelated rooms; room cells themselves stay impassable in both
 * passes, because that is the invariant rather than a preference.
 */
function planAround(grid: Cell[][], a: Room, b: Room, allowAdjacency: boolean): Point[] | null {
  const starts = exitCells(grid, a, b);
  const goalCells = exitCells(grid, b, a);
  if (starts.length === 0 || goalCells.length === 0) return null;

  const goals = new Set(goalCells.map((p) => `${p.x},${p.y}`));

  const heap = new MinHeap<{ x: number; y: number; g: number }>();
  const gMap = new Map<string, number>();
  const parentMap = new Map<string, string | null>();

  for (const start of starts) {
    const key = `${start.x},${start.y}`;
    if (goals.has(key)) return [start]; // the two boundaries share a cell
    gMap.set(key, 0);
    parentMap.set(key, null);
    heap.push(
      { x: start.x, y: start.y, g: 0 },
      Math.abs(b.centerX - start.x) + Math.abs(b.centerY - start.y),
    );
  }

  while (heap.size > 0) {
    const node = heap.pop();
    if (!node) break;
    const { x, y, g } = node;
    const key = `${x},${y}`;
    if (g > (gMap.get(key) ?? Infinity)) continue; // stale

    if (goals.has(key)) {
      const result: Point[] = [];
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
      // Every room is solid. This is the invariant, not a heuristic.
      if (isRoomCell(grid, nx, ny)) continue;

      let thirdPartyAdj = false;
      for (const [adx, ady] of DIRS) {
        if (isThirdPartyRoomCell(grid, nx + adx, ny + ady, a.id, b.id)) {
          thirdPartyAdj = true;
          break;
        }
      }
      if (!allowAdjacency && thirdPartyAdj) continue;

      const newG = g + (thirdPartyAdj ? 1 + ADJACENCY_PENALTY : 1);
      const nKey = `${nx},${ny}`;
      if (newG < (gMap.get(nKey) ?? Infinity)) {
        gMap.set(nKey, newG);
        parentMap.set(nKey, key);
        heap.push(
          { x: nx, y: ny, g: newG },
          newG + Math.abs(b.centerX - nx) + Math.abs(b.centerY - ny),
        );
      }
    }
  }

  return null;
}

// ─── Carving ──────────────────────────────────────────────────────────────────

/**
 * Commit a validated route to the grid.
 *
 * Cells that are already walkable keep their existing ownership — two corridors
 * meeting is a junction, not a theft — while rock and wall become corridor.
 */
function carveRoute(grid: Cell[][], route: Point[], id: number, a: Room, b: Room): Corridor {
  const path: Point[] = [];

  for (const { x, y } of route) {
    const cell = getCell(grid, x, y);
    if (cell === undefined) continue;

    if (
      cell.type === CellType.Corridor ||
      cell.type === CellType.Door ||
      cell.type === CellType.SecretDoor ||
      cell.type === CellType.StairsUp ||
      cell.type === CellType.StairsDown
    ) {
      path.push({ x, y });
      continue;
    }

    setCellType(grid, x, y, CellType.Corridor);
    cell.roomId = null;
    cell.corridorId = id;
    path.push({ x, y });
  }

  return { id, roomA: a.id, roomB: b.id, path, width: 1 };
}

/**
 * Plan a corridor between two rooms, in the configured style, and carve it.
 *
 * The style is a preference; the invariant is not. A styled walk that would put
 * the corridor on a room's floor is discarded before anything is carved, and
 * the pair is rerouted around the obstruction instead.
 */
function carveBetween(
  grid: Cell[][],
  a: Room,
  b: Room,
  id: number,
  style: DungeonConfig["corridors"],
  rng: SeededRandom,
): Corridor | null {
  // Rooms that already touch need a door, not a hallway.
  if (roomsAdjoin(grid, a, b)) {
    return { id, roomA: a.id, roomB: b.id, path: [], width: 1 };
  }

  if (style !== "Labyrinth") {
    const walk = style === "Winding" ? planWinding(grid, a, b, rng) : planStraight(a, b, rng);
    const route = toRoute(grid, walk, a, b);
    if (route !== null) return carveRoute(grid, route, id, a, b);
  }

  const strict = planAround(grid, a, b, false);
  if (strict !== null) return carveRoute(grid, strict, id, a, b);

  const relaxed = planAround(grid, a, b, true);
  if (relaxed !== null) return carveRoute(grid, relaxed, id, a, b);

  // No room-free route exists between these two. Say so rather than punching
  // through a room to make the edge count come out right - the caller repairs
  // connectivity by joining a room it CAN legally reach.
  return null;
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
  /**
   * Room-index pairs to join instead of deriving them geometrically. A blueprint
   * has already decided what connects to what, and rediscovering that from the
   * room centres would throw away the only part the model was asked for.
   */
  explicitEdges?: Array<[number, number]>,
): Corridor[] {
  const { mst, extra } =
    explicitEdges === undefined
      ? buildCorridorGraph(rooms, config.corridor_complexity, rng)
      : {
          mst: explicitEdges
            .map(([a, b]) => ({ a: rooms[a], b: rooms[b] }))
            .filter((p): p is RoomPair => p.a !== undefined && p.b !== undefined),
          extra: [] as RoomPair[],
        };
  const corridors: Corridor[] = [];
  let nextId = 0;

  /** Returns false when no room-free route exists; nothing is carved or recorded. */
  const carveEdge = (a: Room, b: Room): boolean => {
    const corridor = carveBetween(grid, a, b, nextId, config.corridors, rng);
    if (corridor === null) return false;
    nextId++;
    corridors.push(corridor);
    if (!a.connections.includes(b.id)) a.connections.push(b.id);
    if (!b.connections.includes(a.id)) b.connections.push(a.id);
    return true;
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

  repairConnectivity(rooms, carveEdge);

  // Remove accidental dead-end stubs (no-op unless dead_ends === "None")
  collapseDeadEnds(grid, config, rng);

  return corridors;
}

/**
 * Join anything the graph left in its own component.
 *
 * An MST edge can be unroutable: a cave blob walled in by other blobs has no
 * room-free path to the partner distance picked for it, even though a legal
 * route to some nearer neighbour exists. Rather than drive a corridor through a
 * room to satisfy the edge, the edge is abandoned and the room is joined to
 * whichever room it can actually reach - closest first, so the repair is a short
 * hallway rather than a map-spanning one.
 */
function repairConnectivity(rooms: Room[], tryConnect: (a: Room, b: Room) => boolean): void {
  if (rooms.length < 2) return;

  const index = new Map(rooms.map((r, i) => [r.id, i]));
  const uf = new UnionFind(rooms.length);
  for (const room of rooms) {
    const from = index.get(room.id);
    if (from === undefined) continue;
    for (const other of room.connections) {
      const to = index.get(other);
      if (to !== undefined) uf.union(from, to);
    }
  }

  const components = () => new Set(rooms.map((_, i) => uf.find(i))).size;
  if (components() === 1) return;

  const pairs: Array<{ a: number; b: number; d: number }> = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const ra = rooms[i]!;
      const rb = rooms[j]!;
      const dx = ra.centerX - rb.centerX;
      const dy = ra.centerY - rb.centerY;
      pairs.push({ a: i, b: j, d: Math.sqrt(dx * dx + dy * dy) });
    }
  }
  pairs.sort((p, q) => p.d - q.d);

  for (const { a, b } of pairs) {
    if (uf.find(a) === uf.find(b)) continue;
    if (!tryConnect(rooms[a]!, rooms[b]!)) continue;
    uf.union(a, b);
    if (components() === 1) return;
  }
}

/** Kruskal's component tracker, used by the connectivity repair. */
class UnionFind {
  private parent: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
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
    this.parent[ry] = rx;
    return true;
  }
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
 *
 * It stops the moment it reaches room floor. Like every other corridor, an entry
 * corridor connects to a room at its boundary and never occupies part of it, so
 * the last cell it owns is the one outside the doorway.
 *
 * Border cells are carved directly, bypassing the isInterior guard that keeps
 * ordinary corridors off the map edge.
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

  void targetRoomId;

  /** Returns false once the line has arrived at a room and should stop. */
  const carveSingleCell = (x: number, y: number): boolean => {
    if (!isInBounds(grid, x, y)) return false;
    const cell = getCell(grid, x, y);
    if (!cell) return false;

    // Arrived at a room — any room. The corridor ends outside its wall.
    if (cell.roomId !== null) return false;

    // Border cell (not interior): carve directly, bypassing isInterior guard
    const onBorder = x === 0 || y === 0 || x === gridW - 1 || y === gridH - 1;
    if (onBorder) {
      setCellType(grid, x, y, CellType.Corridor);
      cell.roomId = null;
      cell.corridorId = id;
      path.push({ x, y });
      return true;
    }

    if (
      cell.type === CellType.Corridor ||
      cell.type === CellType.Door ||
      cell.type === CellType.SecretDoor ||
      cell.type === CellType.StairsUp ||
      cell.type === CellType.StairsDown
    ) {
      path.push({ x, y });
      return true;
    }

    setCellType(grid, x, y, CellType.Corridor);
    cell.roomId = null;
    cell.corridorId = id;
    path.push({ x, y });
    return true;
  };

  if (x1 === x2) {
    const step = y2 >= y1 ? 1 : -1;
    for (let y = y1; y !== y2 + step; y += step) {
      if (!carveSingleCell(x1, y)) break;
    }
  } else {
    const step = x2 >= x1 ? 1 : -1;
    for (let x = x1; x !== x2 + step; x += step) {
      if (!carveSingleCell(x, y1)) break;
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
