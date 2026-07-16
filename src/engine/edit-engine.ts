import { CellType, FeatureType } from "./types.ts";
import type { Dungeon, Room, Corridor, Cell, Feature } from "./types.ts";
import { useDungeonStore } from "../store/dungeon-store.ts";

export type EditTool =
  | "select"
  | "floor"
  | "corridor"
  | "erase"
  | "wall"
  | "door"
  | "stairs_up"
  | "stairs_down";

/**
 * Vanilla TS controller for the canvas map editor.
 * All mutable state lives here — no React renders happen during a stroke.
 * Only on commitStroke() does it patch the Zustand store (one React render).
 */
export class EditEngine {
  private strokeSet = new Set<string>();
  private _activeStroke: Array<{ x: number; y: number }> = [];
  private _activeTool: EditTool | null = null;
  private _strokeStartCell: { x: number; y: number } | null = null;
  private _isPainting = false;
  private _version = 0;

  get activeStroke(): ReadonlyArray<{ x: number; y: number }> {
    return this._activeStroke;
  }

  get isPainting(): boolean {
    return this._isPainting;
  }

  /** Monotonic counter bumped on every stroke mutation — lets the render loop
   *  detect changes without React state (no renders during a stroke by design). */
  get version(): number {
    return this._version;
  }

  startStroke(x: number, y: number, tool: EditTool): void {
    this.strokeSet.clear();
    this._activeStroke = [];
    this._activeTool = tool;
    this._strokeStartCell = { x, y };
    this._isPainting = true;
    this._pushCell(x, y);
  }

  extendStroke(x: number, y: number): void {
    if (!this._isPainting) return;
    this._pushCell(x, y);
  }

  private _pushCell(x: number, y: number): void {
    const key = `${x},${y}`;
    if (this.strokeSet.has(key)) return;
    this.strokeSet.add(key);
    this._activeStroke.push({ x, y });
    this._version++;
  }

  commitStroke(): void {
    if (!this._isPainting || !this._activeTool || this._activeStroke.length === 0) {
      this.clearStroke();
      return;
    }
    const cells = [...this._activeStroke];
    const tool = this._activeTool;
    const startCell = this._strokeStartCell;
    this.clearStroke();
    const store = useDungeonStore.getState();
    store.pushEditSnapshot();
    store.patchDungeon((dungeon) => applyEditStroke(dungeon, cells, tool, startCell));
  }

  clearStroke(): void {
    this.strokeSet.clear();
    this._activeStroke = [];
    this._activeTool = null;
    this._strokeStartCell = null;
    this._isPainting = false;
    this._version++;
  }
}

// ─── Stroke application (pure) ────────────────────────────────────────────────

function applyEditStroke(
  dungeon: Dungeon,
  cells: Array<{ x: number; y: number }>,
  tool: EditTool,
  startCell: { x: number; y: number } | null,
): Dungeon {
  const { width, height } = dungeon;
  const validCells = cells.filter(
    ({ x, y }) => x >= 0 && y >= 0 && x < width && y < height,
  );
  if (validCells.length === 0) return dungeon;

  // Shallow-clone each row so individual cell replacement doesn't mutate the original.
  const newGrid: Cell[][] = dungeon.grid.map((row) => [...row]);
  let newRooms = [...dungeon.rooms];
  let newCorridors = [...dungeon.corridors];
  let newFeatures = [...dungeon.features];

  switch (tool) {
    case "floor":
      newRooms = applyFloor(newGrid, validCells, startCell, dungeon, newRooms);
      autoGenerateWalls(newGrid, width, height, validCells);
      break;
    case "corridor":
      newCorridors = applyCorridor(newGrid, validCells, newCorridors);
      autoGenerateWalls(newGrid, width, height, validCells);
      break;
    case "wall":
      for (const { x, y } of validCells) {
        assignCell(newGrid, x, y, CellType.Wall, null, null, null);
      }
      break;
    case "erase":
      for (const { x, y } of validCells) {
        assignCell(newGrid, x, y, CellType.Empty, null, null, null);
      }
      break;
    case "door":
      newFeatures = applySpecialCell(newGrid, validCells, newFeatures, CellType.Door, FeatureType.Door);
      break;
    case "stairs_up":
      newFeatures = applySpecialCell(newGrid, validCells, newFeatures, CellType.StairsUp, FeatureType.StairsUp);
      break;
    case "stairs_down":
      newFeatures = applySpecialCell(newGrid, validCells, newFeatures, CellType.StairsDown, FeatureType.StairsDown);
      break;
  }

  return { ...dungeon, grid: newGrid, rooms: newRooms, corridors: newCorridors, features: newFeatures };
}

function assignCell(
  grid: Cell[][],
  x: number,
  y: number,
  type: CellType,
  roomId: number | null,
  corridorId: number | null,
  featureId: number | null,
): void {
  const row = grid[y];
  if (!row) return;
  row[x] = { type, roomId, corridorId, featureId };
}

function applyFloor(
  grid: Cell[][],
  cells: Array<{ x: number; y: number }>,
  startCell: { x: number; y: number } | null,
  dungeon: Dungeon,
  rooms: Room[],
): Room[] {
  let targetRoomId: number | null = null;

  if (startCell != null) {
    const origCell = dungeon.grid[startCell.y]?.[startCell.x];
    if (origCell != null && origCell.roomId !== null) {
      targetRoomId = origCell.roomId;
    }
  }

  if (targetRoomId === null) {
    const nextId = rooms.length > 0 ? Math.max(...rooms.map((r) => r.id)) + 1 : 1;
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const newRoom: Room = {
      id: nextId,
      x: minX, y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      centerX: Math.round((minX + maxX) / 2),
      centerY: Math.round((minY + maxY) / 2),
      shape: "Cave",
      connections: [],
      features: [],
    };
    rooms = [...rooms, newRoom];
    targetRoomId = nextId;
  } else {
    // Extend existing room bounds to encompass the new cells
    const existingRoom = rooms.find((r) => r.id === targetRoomId);
    if (existingRoom != null) {
      const xs = cells.map((c) => c.x);
      const ys = cells.map((c) => c.y);
      const newMinX = Math.min(existingRoom.x, ...xs);
      const newMaxX = Math.max(existingRoom.x + existingRoom.width - 1, ...xs);
      const newMinY = Math.min(existingRoom.y, ...ys);
      const newMaxY = Math.max(existingRoom.y + existingRoom.height - 1, ...ys);
      rooms = rooms.map((r) =>
        r.id !== targetRoomId ? r : {
          ...r,
          x: newMinX, y: newMinY,
          width: newMaxX - newMinX + 1,
          height: newMaxY - newMinY + 1,
          centerX: Math.round((newMinX + newMaxX) / 2),
          centerY: Math.round((newMinY + newMaxY) / 2),
        },
      );
    }
  }

  for (const { x, y } of cells) {
    assignCell(grid, x, y, CellType.Floor, targetRoomId, null, null);
  }

  return rooms;
}

function applyCorridor(
  grid: Cell[][],
  cells: Array<{ x: number; y: number }>,
  corridors: Corridor[],
): Corridor[] {
  const nextId = corridors.length > 0 ? Math.max(...corridors.map((c) => c.id)) + 1 : 1;
  const newCorridor: Corridor = {
    id: nextId,
    roomA: -1, // manually placed — no connected rooms yet
    roomB: -1,
    path: cells.map(({ x, y }) => ({ x, y })),
    width: 1,
  };
  for (const { x, y } of cells) {
    assignCell(grid, x, y, CellType.Corridor, null, nextId, null);
  }
  return [...corridors, newCorridor];
}

function applySpecialCell(
  grid: Cell[][],
  cells: Array<{ x: number; y: number }>,
  features: Feature[],
  cellType: CellType,
  featureType: FeatureType,
): Feature[] {
  const newFeatures = [...features];
  for (const { x, y } of cells) {
    const nextFid = newFeatures.length > 0 ? Math.max(...newFeatures.map((f) => f.id)) + 1 : 1;
    const existingCell = grid[y]?.[x];
    newFeatures.push({ id: nextFid, type: featureType, x, y });
    assignCell(grid, x, y, cellType, existingCell?.roomId ?? null, existingCell?.corridorId ?? null, nextFid);
  }
  return newFeatures;
}

function autoGenerateWalls(
  grid: Cell[][],
  width: number,
  height: number,
  paintedCells: Array<{ x: number; y: number }>,
): void {
  for (const { x, y } of paintedCells) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const row = grid[ny];
        if (!row) continue;
        const cell = row[nx];
        if (cell == null || cell.type === CellType.Empty) {
          row[nx] = { type: CellType.Wall, roomId: null, corridorId: null, featureId: null };
        }
      }
    }
  }
}
