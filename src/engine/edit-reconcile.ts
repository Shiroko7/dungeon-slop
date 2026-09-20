import { CellType, FeatureType } from "./types.ts";
import type { Cell, Corridor, Dungeon, Feature, Room } from "./types.ts";

export interface ReconcileOptions {
  /** Room IDs touched before or during the edit. */
  affectedRoomIds?: ReadonlySet<number>;
}

type Point = { x: number; y: number };

const WALKABLE = new Set<CellType>([
  CellType.Floor,
  CellType.Corridor,
  CellType.Door,
  CellType.SecretDoor,
  CellType.StairsUp,
  CellType.StairsDown,
]);

function key(point: Point): string {
  return `${point.x},${point.y}`;
}

function inBounds(dungeon: Dungeon, point: Point): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < dungeon.width && point.y < dungeon.height;
}

function neighbours(point: Point): Point[] {
  return [
    { x: point.x - 1, y: point.y },
    { x: point.x + 1, y: point.y },
    { x: point.x, y: point.y - 1 },
    { x: point.x, y: point.y + 1 },
  ];
}

function components(points: Point[]): Point[][] {
  const remaining = new Map(points.map((point) => [key(point), point]));
  const result: Point[][] = [];
  while (remaining.size > 0) {
    const first = remaining.values().next().value as Point;
    remaining.delete(key(first));
    const component = [first];
    const queue = [first];
    while (queue.length > 0) {
      const point = queue.shift()!;
      for (const next of neighbours(point)) {
        const found = remaining.get(key(next));
        if (found === undefined) continue;
        remaining.delete(key(next));
        component.push(found);
        queue.push(found);
      }
    }
    result.push(component);
  }
  return result;
}

function bounds(points: Point[]): Pick<Room, "x" | "y" | "width" | "height" | "centerX" | "centerY"> {
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centerX: Math.floor((minX + maxX) / 2),
    centerY: Math.floor((minY + maxY) / 2),
  };
}

function roomCells(grid: Cell[][], roomId: number): Point[] {
  const points: Point[] = [];
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y] ?? [];
    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      if (cell?.roomId === roomId && WALKABLE.has(cell.type) && cell.type !== CellType.Corridor) {
        points.push({ x, y });
      }
    }
  }
  return points;
}

/** Remove stale ownership left behind when a wall or empty cell is painted over. */
function normalizeGridOwnership(grid: Cell[][]): void {
  for (const row of grid) {
    for (const cell of row) {
      if (cell.type === CellType.Empty || cell.type === CellType.Wall) {
        cell.roomId = null;
        cell.corridorId = null;
        cell.featureId = null;
      } else if (cell.type === CellType.Corridor) {
        cell.roomId = null;
      } else if (cell.type === CellType.Floor) {
        cell.corridorId = null;
      }
    }
  }
}

function componentContaining(points: Point[][], anchor: Point): Point[] | undefined {
  return points.find((component) => component.some((point) => point.x === anchor.x && point.y === anchor.y));
}

function largestComponent(points: Point[][]): Point[] {
  return [...points].sort((a, b) => b.length - a.length)[0] ?? [];
}

function nextId(used: Set<number>): number {
  let id = 1;
  while (used.has(id)) id++;
  used.add(id);
  return id;
}

function roomFromCells(room: Room, points: Point[], options: { keepIdentity: boolean }): Room {
  const shape = options.keepIdentity ? room.shape : "Cave";
  const next: Room = {
    ...room,
    ...bounds(points),
    shape,
    connections: [],
    features: [],
    footprint: points
      .slice()
      .sort((a, b) => a.y - b.y || a.x - b.x),
  };
  if (!options.keepIdentity) {
    delete next.role;
    delete next.tier;
    delete next.onCriticalPath;
    delete next.plan;
    delete next.description;
  }
  return next;
}

function reconcileRooms(
  dungeon: Dungeon,
  grid: Cell[][],
  affected: Set<number>,
): Room[] {
  const used = new Set(dungeon.rooms.map((room) => room.id));
  const rooms: Room[] = [];

  for (const room of dungeon.rooms) {
    const points = roomCells(grid, room.id);
    if (points.length === 0) continue;
    const groups = components(points);
    const shouldUseFootprint = affected.has(room.id) || room.footprint !== undefined;
    const anchor = { x: room.centerX, y: room.centerY };
    const survivor = componentContaining(groups, anchor) ?? largestComponent(groups);
    const keepIndex = groups.indexOf(survivor);

    groups.forEach((group, index) => {
      if (index === keepIndex) {
        rooms.push(
          shouldUseFootprint
            ? roomFromCells(room, group, { keepIdentity: true })
            : { ...room, connections: [], features: [] },
        );
        return;
      }
      const id = nextId(used);
      for (const point of group) {
        const cell = grid[point.y]?.[point.x];
        if (cell) cell.roomId = id;
      }
      rooms.push(roomFromCells({ ...room, id }, group, { keepIdentity: false }));
      affected.add(id);
    });
  }

  // A floor stroke can create a room without adding it to the original list.
  const known = new Set(rooms.map((room) => room.id));
  const idsInGrid = new Set<number>();
  for (const row of grid) {
    for (const cell of row) if (cell.roomId !== null) idsInGrid.add(cell.roomId);
  }
  for (const id of idsInGrid) {
    if (known.has(id)) continue;
    const points = roomCells(grid, id);
    if (points.length === 0) continue;
    rooms.push(
      roomFromCells(
        {
          id,
          ...bounds(points),
          shape: "Cave",
          connections: [],
          features: [],
        },
        points,
        { keepIdentity: false },
      ),
    );
    affected.add(id);
  }

  return rooms.sort((a, b) => a.id - b.id);
}

function featureMatchesCell(feature: Feature, cell: Cell): boolean {
  if (feature.type === FeatureType.Trap || feature.type === FeatureType.Treasure)
    return cell.type === CellType.Floor;
  if (
    feature.type === FeatureType.Door ||
    feature.type === FeatureType.SecretDoor ||
    feature.type === FeatureType.LockedDoor ||
    feature.type === FeatureType.Portcullis ||
    feature.type === FeatureType.Archway ||
    feature.type === FeatureType.TrappedDoor
  )
    return cell.type === CellType.Door || cell.type === CellType.SecretDoor;
  if (feature.type === FeatureType.StairsUp) return cell.type === CellType.StairsUp;
  if (feature.type === FeatureType.StairsDown) return cell.type === CellType.StairsDown;
  return false;
}

function reconcileFeatures(grid: Cell[][], width: number, height: number, features: Feature[]): Feature[] {
  const byCell = new Map<string, Feature[]>();
  for (const feature of features) {
    if (feature.x < 0 || feature.y < 0 || feature.x >= width || feature.y >= height) continue;
    const cell = grid[feature.y]?.[feature.x];
    if (!cell || !featureMatchesCell(feature, cell)) continue;
    const list = byCell.get(key(feature)) ?? [];
    list.push(feature);
    byCell.set(key(feature), list);
  }

  const kept: Feature[] = [];
  const keptById = new Map<number, Feature>();
  for (const [cellKey, candidates] of byCell) {
    const [xs, ys] = cellKey.split(",");
    const cell = grid[Number(ys)]?.[Number(xs)];
    if (!cell) continue;
    const selected = candidates.find((feature) => cell.featureId === feature.id) ?? candidates[0]!;
    kept.push(selected);
    keptById.set(selected.id, selected);
    cell.featureId = selected.id;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = grid[y]?.[x];
      if (cell && cell.featureId !== null && !keptById.has(cell.featureId)) cell.featureId = null;
    }
  }
  return kept.sort((a, b) => a.id - b.id);
}

function corridorComponents(grid: Cell[][], corridorId: number, path: Point[]): Point[][] {
  const candidates = new Map<string, Point>();
  for (const point of path) {
    const cell = grid[point.y]?.[point.x];
    if (cell?.corridorId === corridorId) candidates.set(key(point), point);
  }
  // Include cells whose ownership survived but whose old path was incomplete.
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < (grid[y]?.length ?? 0); x++) {
      if (grid[y]?.[x]?.corridorId === corridorId) candidates.set(`${x},${y}`, { x, y });
    }
  }
  return components([...candidates.values()]);
}

function orderedPath(group: Point[], original: Point[]): Point[] {
  const order = new Map(original.map((point, index) => [key(point), index]));
  return group.slice().sort((a, b) => (order.get(key(a)) ?? Number.MAX_SAFE_INTEGER) - (order.get(key(b)) ?? Number.MAX_SAFE_INTEGER));
}

function corridorRooms(grid: Cell[][], path: Point[], width: number, height: number): [number, number] {
  const adjacent = new Set<number>();
  for (const point of path) {
    for (const next of neighbours(point)) {
      if (next.x < 0 || next.y < 0 || next.x >= width || next.y >= height) continue;
      const roomId = grid[next.y]?.[next.x]?.roomId;
      if (roomId !== null && roomId !== undefined) adjacent.add(roomId);
    }
  }
  const ids = [...adjacent].sort((a, b) => a - b);
  return [ids[0] ?? -1, ids[1] ?? -1];
}

function reconcileCorridors(dungeon: Dungeon, grid: Cell[][], rooms: Room[]): Corridor[] {
  const used = new Set(dungeon.corridors.map((corridor) => corridor.id));
  const corridors: Corridor[] = [];
  for (const corridor of dungeon.corridors) {
    const groups = corridorComponents(grid, corridor.id, corridor.path);
    groups.forEach((group, index) => {
      if (group.length === 0) return;
      const id = index === 0 ? corridor.id : nextId(used);
      for (const point of group) {
        const cell = grid[point.y]?.[point.x];
        if (cell) cell.corridorId = id;
      }
      const path = orderedPath(group, corridor.path);
      const [roomA, roomB] = corridorRooms(grid, path, dungeon.width, dungeon.height);
      corridors.push({ ...corridor, id, path, roomA, roomB });
    });
  }
  const knownIds = new Set(corridors.map((corridor) => corridor.id));
  for (const row of grid) {
    for (const cell of row) {
      if (cell.corridorId !== null && !knownIds.has(cell.corridorId)) cell.corridorId = null;
    }
  }
  const byId = new Map(rooms.map((room) => [room.id, room]));
  for (const room of rooms) room.connections = [];
  for (const corridor of corridors) {
    if (corridor.roomA < 0 || corridor.roomB < 0 || corridor.roomA === corridor.roomB) continue;
    const a = byId.get(corridor.roomA);
    const b = byId.get(corridor.roomB);
    if (!a || !b) continue;
    if (!a.connections.includes(b.id)) a.connections.push(b.id);
    if (!b.connections.includes(a.id)) b.connections.push(a.id);
  }
  return corridors.sort((a, b) => a.id - b.id);
}

function refreshRoomFeatures(rooms: Room[], features: Feature[], grid: Cell[][]): void {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  for (const room of rooms) room.features = [];
  for (const feature of features) {
    const roomId = grid[feature.y]?.[feature.x]?.roomId;
    const room = roomId === undefined || roomId === null ? undefined : byId.get(roomId);
    room?.features.push(feature);
  }
}

function refreshReport(dungeon: Dungeon, rooms: Room[], corridors: Corridor[]): Dungeon["report"] {
  const graph = new Map(rooms.map((room) => [room.id, room.connections]));
  const root = rooms.find((room) => room.role === "entrance")?.id ?? rooms[0]?.id;
  const visited = new Set<number>();
  if (root !== undefined) {
    const queue = [root];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const next of graph.get(id) ?? []) if (!visited.has(next)) queue.push(next);
    }
  }
  let edges = 0;
  for (const room of rooms) edges += room.connections.length;
  edges /= 2;
  return {
    requestedRooms: dungeon.report?.requestedRooms ?? dungeon.config.room_count ?? rooms.length,
    deliveredRooms: rooms.filter((room) => room.role !== "junction").length,
    capacityRooms: dungeon.report?.capacityRooms ?? rooms.length,
    junctionsAdded: rooms.filter((room) => room.role === "junction").length,
    longestCorridorCells: corridors.reduce((max, corridor) => Math.max(max, corridor.path.length), 0),
    hasLoop: edges >= rooms.length && rooms.length > 0,
  };
}

/** Reconcile all derived geometry after one manual edit or an undo/redo. */
export function reconcileDungeon(dungeon: Dungeon, options: ReconcileOptions = {}): Dungeon {
  const affected = new Set(options.affectedRoomIds ?? []);
  const grid = dungeon.grid.map((row) => row.map((cell) => ({ ...cell })));
  normalizeGridOwnership(grid);
  const rooms = reconcileRooms(dungeon, grid, affected);
  const features = reconcileFeatures(grid, dungeon.width, dungeon.height, dungeon.features);
  const corridors = reconcileCorridors(dungeon, grid, rooms);
  refreshRoomFeatures(rooms, features, grid);
  const disconnected = rooms.length === 0
    ? []
    : (() => {
        const graph = new Map(rooms.map((room) => [room.id, room.connections]));
        const root = rooms.find((room) => room.role === "entrance")?.id ?? rooms[0]!.id;
        const seen = new Set<number>([root]);
        const queue = [root];
        while (queue.length > 0) {
          const id = queue.shift()!;
          for (const next of graph.get(id) ?? []) if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
        return rooms.map((room) => room.id).filter((id) => !seen.has(id));
      })();
  return {
    ...dungeon,
    grid,
    rooms,
    corridors,
    features,
    report: refreshReport(dungeon, rooms, corridors),
    editStatus: {
      narrativeStale: affected.size > 0 || corridors.length !== dungeon.corridors.length || features.length !== dungeon.features.length,
      planStale: affected.size > 0 || corridors.length !== dungeon.corridors.length,
      disconnectedRoomIds: disconnected,
    },
  };
}
