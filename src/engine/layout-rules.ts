import { CellType } from "./types.ts";
import type { Cell, Corridor, Dungeon, Room, RoomRole } from "./types.ts";
import type { SeededRandom } from "../lib/random.ts";
import { getCell, setCellType } from "./grid.ts";

/**
 * The design rules a procedural layout has no opinion about on its own.
 *
 * A BSP + MST produces a *connected* map, which is the only property it was ever
 * asked for. It has nothing to say about whether the result is a good place to
 * play: whether corridors are transitions or journeys, whether there is a route
 * with a shape to it, whether backtracking is punished, whether a dead end is
 * worth walking down. Those are the rules encoded here, applied after geometry.
 */

/**
 * Longest corridor, in cells, before it stops being a connection and starts
 * being a walk. 24 cells is 120 ft - already a long hall at the table, and about
 * as far as a party will go without the map owing them something. Anything
 * longer is broken by an antechamber rather than left as featureless tunnel.
 */
export const MAX_CORRIDOR_CELLS = 24;

/** Junction chambers are small by design: they punctuate, they aren't destinations. */
const JUNCTION_MIN = 3;
const JUNCTION_MAX = 5;

// ─── Corridor budget ─────────────────────────────────────────────────────────

interface Placement {
  x: number;
  y: number;
  size: number;
}

const cellKey = (x: number, y: number) => `${x},${y}`;

/**
 * Which corridors list each cell in their path.
 *
 * A grid cell stores only ONE corridorId, but two corridors that cross both keep
 * the shared cell in their own path arrays - so the grid alone cannot tell you
 * whether a cell is safe to consume. Consuming a cell some other corridor still
 * lists leaves that corridor running through a room it does not belong to.
 */
function pathOwners(corridors: Corridor[]): Map<string, number[]> {
  const owners = new Map<string, number[]>();
  for (const corridor of corridors) {
    for (const pt of corridor.path) {
      const key = cellKey(pt.x, pt.y);
      const list = owners.get(key);
      if (list === undefined) owners.set(key, [corridor.id]);
      else if (!list.includes(corridor.id)) list.push(corridor.id);
    }
  }
  return owners;
}

/**
 * Can a size×size chamber sit centred on this corridor cell? Only rock, wall and
 * cells belonging to this same corridor may be consumed - carving over another
 * room or an unrelated corridor would silently sever it.
 */
function junctionFits(
  grid: Cell[][],
  cx: number,
  cy: number,
  size: number,
  corridorId: number,
  owners: Map<string, number[]>,
): Placement | null {
  const half = Math.floor(size / 2);
  const x0 = cx - half;
  const y0 = cy - half;

  for (let y = y0 - 1; y < y0 + size + 1; y++) {
    for (let x = x0 - 1; x < x0 + size + 1; x++) {
      const cell = getCell(grid, x, y);
      if (cell === undefined) return null; // would touch the map edge
      const inside = x >= x0 && x < x0 + size && y >= y0 && y < y0 + size;
      if (!inside) continue;
      if (cell.roomId !== null) return null;
      const listed = owners.get(cellKey(x, y));
      if (listed !== undefined && listed.some((id) => id !== corridorId)) return null;
      const consumable =
        cell.type === CellType.Empty ||
        cell.type === CellType.Wall ||
        ((cell.type === CellType.Corridor || cell.type === CellType.Door) &&
          cell.corridorId === corridorId);
      if (!consumable) return null;
    }
  }

  return { x: x0, y: y0, size };
}

const WALKABLE_TYPES = new Set<CellType>([
  CellType.Floor,
  CellType.Corridor,
  CellType.Door,
  CellType.SecretDoor,
  CellType.StairsUp,
  CellType.StairsDown,
]);

/** Does every step in this run move exactly one cell? */
function isContiguous(run: Array<{ x: number; y: number }>): boolean {
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1]!;
    const b = run[i]!;
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return false;
  }
  return true;
}

/** Is this cell carved AND orthogonally against the chamber's outer edge? */
function joinsChamber(grid: Cell[][], fit: Placement, pt: { x: number; y: number }): boolean {
  const cell = getCell(grid, pt.x, pt.y);
  if (cell === undefined || !WALKABLE_TYPES.has(cell.type)) return false;

  const withinX = pt.x >= fit.x && pt.x < fit.x + fit.size;
  const withinY = pt.y >= fit.y && pt.y < fit.y + fit.size;
  const onVerticalEdge = withinY && (pt.x === fit.x - 1 || pt.x === fit.x + fit.size);
  const onHorizontalEdge = withinX && (pt.y === fit.y - 1 || pt.y === fit.y + fit.size);
  return onVerticalEdge || onHorizontalEdge;
}

/**
 * Break one over-long corridor with a chamber, turning A→B into A→J→B.
 *
 * Returns null when no chamber will fit anywhere in the middle of the run, which
 * happens in tight maps; the corridor is then left long rather than forced.
 */
function splitCorridor(
  grid: Cell[][],
  corridor: Corridor,
  rooms: Room[],
  nextRoomId: number,
  nextCorridorId: number,
  owners: Map<string, number[]>,
  rng: SeededRandom,
): { room: Room; corridors: [Corridor, Corridor] } | null {
  const path = corridor.path;
  if (path.length < MAX_CORRIDOR_CELLS) return null;

  // Search outward from the midpoint so the split lands near the middle when it
  // can, keeping both halves under budget rather than shaving off one end.
  const mid = Math.floor(path.length / 2);
  const margin = Math.max(2, Math.floor(MAX_CORRIDOR_CELLS / 4));
  const order: number[] = [];
  for (let d = 0; d < path.length; d++) {
    for (const i of [mid - d, mid + d]) {
      if (i >= margin && i < path.length - margin && !order.includes(i)) order.push(i);
    }
  }

  for (const index of order) {
    const point = path[index]!;
    for (let size = JUNCTION_MAX; size >= JUNCTION_MIN; size--) {
      const fit = junctionFits(grid, point.x, point.y, size, corridor.id, owners);
      if (fit === null) continue;

      const inside = (pt: { x: number; y: number }) =>
        pt.x >= fit.x && pt.x < fit.x + fit.size && pt.y >= fit.y && pt.y < fit.y + fit.size;
      const headPath = path.slice(0, index).filter((pt) => !inside(pt));
      const tailPath = path.slice(index + 1).filter((pt) => !inside(pt));
      // An empty leg means the chamber swallowed a whole end of the run, which
      // would leave the room at that end with nothing joining it.
      if (headPath.length === 0 || tailPath.length === 0) continue;

      // A corridor may already run over its own destination's floor - cave rooms
      // in particular are carved irregularly, so a path enters the room well
      // before its last cell. Splitting past that point hands those cells to the
      // half that does NOT own the room, leaving a corridor crossing a third
      // party's floor. Only commit a split where both halves stay clean.
      const legIsClean = (leg: Array<{ x: number; y: number }>, aId: number, bId: number) =>
        leg.every((pt) => {
          const cell = getCell(grid, pt.x, pt.y);
          return cell === undefined || cell.roomId === null || cell.roomId === aId || cell.roomId === bId;
        });
      if (!legIsClean(headPath, corridor.roomA, nextRoomId)) continue;
      if (!legIsClean(tailPath, nextRoomId, corridor.roomB)) continue;

      // A corridor's path array and the carved grid can already disagree:
      // collapseDeadEnds walls off stubs without pruning them from the path. So
      // "there is a path cell here" is not evidence the chamber would join
      // anything - drop a chamber on a collapsed stretch and it is sealed in
      // rock. Demand a genuinely carved, orthogonally touching cell each side.
      const headEnd = headPath[headPath.length - 1]!;
      const tailStart = tailPath[0]!;
      if (!joinsChamber(grid, fit, headEnd) || !joinsChamber(grid, fit, tailStart)) continue;

      // A winding run can re-enter the chamber footprint after leaving it, so
      // the trim can lift a chunk out of the MIDDLE of a leg. Both halves have
      // to remain unbroken walks, not just meet the chamber at their ends.
      if (!isContiguous(headPath) || !isContiguous(tailPath)) continue;

      const room: Room = {
        id: nextRoomId,
        x: fit.x,
        y: fit.y,
        width: fit.size,
        height: fit.size,
        centerX: fit.x + Math.floor(fit.size / 2),
        centerY: fit.y + Math.floor(fit.size / 2),
        shape: "Rectangular",
        connections: [corridor.roomA, corridor.roomB],
        features: [],
        role: "junction",
      };

      for (let y = fit.y; y < fit.y + fit.size; y++) {
        for (let x = fit.x; x < fit.x + fit.size; x++) {
          setCellType(grid, x, y, CellType.Floor);
          const cell = getCell(grid, x, y);
          if (cell !== undefined) {
            cell.roomId = room.id;
            cell.corridorId = null;
          }
        }
      }

      const head: Corridor = {
        id: corridor.id,
        roomA: corridor.roomA,
        roomB: room.id,
        path: headPath,
        width: corridor.width,
      };
      const tail: Corridor = {
        id: nextCorridorId,
        roomA: room.id,
        roomB: corridor.roomB,
        path: tailPath,
        width: corridor.width,
      };

      // The tail's cells still carry the old corridor id; re-stamp the ones the
      // chamber didn't swallow so hover, features and exports agree.
      for (const p of tail.path) {
        const cell = getCell(grid, p.x, p.y);
        if (cell !== undefined && cell.roomId === null) cell.corridorId = tail.id;
      }

      const a = rooms.find((r) => r.id === corridor.roomA);
      const b = rooms.find((r) => r.id === corridor.roomB);
      if (a !== undefined) {
        a.connections = a.connections.filter((c) => c !== corridor.roomB);
        if (!a.connections.includes(room.id)) a.connections.push(room.id);
      }
      if (b !== undefined) {
        b.connections = b.connections.filter((c) => c !== corridor.roomA);
        if (!b.connections.includes(room.id)) b.connections.push(room.id);
      }
      void rng;

      return { room, corridors: [head, tail] };
    }
  }

  return null;
}

/**
 * Enforce the corridor budget across the whole map.
 *
 * Runs to a fixed point with a pass cap, because splitting a 60-cell corridor
 * leaves two ~30-cell halves that are themselves over budget.
 */
export function enforceCorridorBudget(
  grid: Cell[][],
  rooms: Room[],
  corridors: Corridor[],
  rng: SeededRandom,
): { rooms: Room[]; corridors: Corridor[]; junctionsAdded: number } {
  let working = [...corridors];
  let nextRoomId = rooms.reduce((m, r) => Math.max(m, r.id), -1) + 1;
  let nextCorridorId = working.reduce((m, c) => Math.max(m, c.id), -1) + 1;
  let junctionsAdded = 0;

  for (let pass = 0; pass < 4; pass++) {
    const over = working.filter((c) => c.path.length >= MAX_CORRIDOR_CELLS);
    if (over.length === 0) break;

    const owners = pathOwners(working);
    let changed = false;
    for (const corridor of over) {
      // Only split corridors that join two real rooms. Entry corridors and
      // dead-end stubs use -1 for the far end and have no second room to rejoin.
      if (corridor.roomA < 0 || corridor.roomB < 0) continue;

      const result = splitCorridor(grid, corridor, rooms, nextRoomId, nextCorridorId, owners, rng);
      if (result === null) continue;

      rooms.push(result.room);
      working = working.filter((c) => c.id !== corridor.id);
      working.push(result.corridors[0], result.corridors[1]);
      nextRoomId += 1;
      nextCorridorId += 1;
      junctionsAdded += 1;
      changed = true;
    }
    if (!changed) break;
  }

  if (junctionsAdded > 0) renumberCorridors(grid, working);

  return { rooms, corridors: working, junctionsAdded };
}

/**
 * Restore corridors[i].id === i.
 *
 * Splitting appends a tail with a fresh id, which leaves the array order and the
 * id sequence disagreeing. Plenty of code — exports, hover, feature placement —
 * indexes corridors by id, so the invariant is load-bearing rather than cosmetic.
 */
function renumberCorridors(grid: Cell[][], corridors: Corridor[]): void {
  const remap = new Map<number, number>();
  corridors.forEach((corridor, index) => {
    remap.set(corridor.id, index);
  });

  for (const row of grid) {
    for (const cell of row) {
      if (cell.corridorId === null) continue;
      const next = remap.get(cell.corridorId);
      cell.corridorId = next ?? null;
    }
  }

  corridors.forEach((corridor, index) => {
    corridor.id = index;
  });
}

// ─── Layout semantics ────────────────────────────────────────────────────────

function adjacency(rooms: Room[]): Map<number, number[]> {
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const adj = new Map<number, number[]>();
  for (const room of rooms) {
    adj.set(
      room.id,
      room.connections.filter((c) => byId.has(c)),
    );
  }
  return adj;
}

function bfsDepths(adj: Map<number, number[]>, from: number): Map<number, number> {
  const depth = new Map<number, number>([[from, 0]]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adj.get(current) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, (depth.get(current) ?? 0) + 1);
      queue.push(next);
    }
  }
  return depth;
}

/**
 * Which room the party walks in through. An entry corridor names it outright;
 * failing that it is the room nearest the map edge, which is where a way in
 * would plausibly be.
 */
function findEntrance(rooms: Room[], corridors: Corridor[], width: number, height: number): number {
  const entry = corridors.find((c) => c.roomA === -1 || c.roomB === -1);
  if (entry !== undefined) {
    const id = entry.roomA === -1 ? entry.roomB : entry.roomA;
    if (id >= 0 && rooms.some((r) => r.id === id)) return id;
  }

  let best = rooms[0]?.id ?? 0;
  let bestDistance = Infinity;
  for (const room of rooms) {
    const d = Math.min(room.centerX, room.centerY, width - room.centerX, height - room.centerY);
    if (d < bestDistance) {
      bestDistance = d;
      best = room.id;
    }
  }
  return best;
}

/**
 * Assign every room a role and a depth from the entrance.
 *
 * This is the layer the narrator was missing entirely. Without it a "dungeon" is
 * an undifferentiated bag of boxes and the model has to invent a progression
 * that the geometry does not have; with it, the deepest room really is the last
 * one, and the room in front of it really is the last thing before the boss.
 */
export function assignRoles(dungeon: Dungeon): void {
  const { rooms, corridors, width, height } = dungeon;
  if (rooms.length === 0) return;

  const adj = adjacency(rooms);
  const entranceId = findEntrance(rooms, corridors, width, height);
  const depths = bfsDepths(adj, entranceId);

  let bossId = entranceId;
  let bossDepth = -1;
  for (const room of rooms) {
    const d = depths.get(room.id);
    if (d !== undefined && d > bossDepth) {
      bossDepth = d;
      bossId = room.id;
    }
  }

  // The critical path is the route the party must take to finish: entrance to
  // boss, walked backwards down the BFS tree.
  const critical = new Set<number>();
  {
    let cursor = bossId;
    critical.add(cursor);
    let guard = rooms.length + 1;
    while (cursor !== entranceId && guard-- > 0) {
      const here = depths.get(cursor) ?? 0;
      const previous = (adj.get(cursor) ?? []).find((n) => (depths.get(n) ?? Infinity) === here - 1);
      if (previous === undefined) break;
      critical.add(previous);
      cursor = previous;
    }
  }

  for (const room of rooms) {
    const degree = (adj.get(room.id) ?? []).length;
    room.tier = depths.get(room.id) ?? null;
    room.onCriticalPath = critical.has(room.id);

    // A junction assigned by the corridor-budget pass keeps its role: it is
    // scenery by construction and must not be promoted to a boss room.
    if (room.role === "junction") continue;

    let role: RoomRole;
    if (room.id === entranceId) role = "entrance";
    else if (room.id === bossId) role = "boss";
    else if (degree === 1) role = "vault";
    else if (degree >= 3) role = "hub";
    else if (critical.has(room.id)) role = "gauntlet";
    else role = "chamber";
    room.role = role;
  }

  // The chokepoint is the last room on the critical path before the boss: the
  // place to put the gate, the guardian, or the point of no return.
  const bossNeighbours = (adj.get(bossId) ?? []).filter((n) => critical.has(n));
  const gate = bossNeighbours[0];
  if (gate !== undefined) {
    const room = rooms.find((r) => r.id === gate);
    if (room !== undefined && room.role !== "entrance" && room.role !== "junction") {
      room.role = "chokepoint";
    }
  }
}

/**
 * Does the room graph contain a cycle?
 *
 * A pure tree is the classic procedural failure: every branch you explore must
 * be retraced step for step, and the map has no shape to remember. At least one
 * loop is the cheapest possible fix.
 */
export function hasLoop(rooms: Room[]): boolean {
  const adj = adjacency(rooms);
  let edges = 0;
  for (const list of adj.values()) edges += list.length;
  edges /= 2;

  // Any connected graph with at least as many edges as nodes contains a cycle.
  return edges >= rooms.length && rooms.length > 0;
}
