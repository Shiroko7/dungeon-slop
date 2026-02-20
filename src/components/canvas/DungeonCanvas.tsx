import { useRef, useEffect, useCallback, useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { SvgOverlay } from "./SvgOverlay.tsx";
import { RoomTooltip } from "./RoomTooltip.tsx";
import { CorridorTooltip } from "./CorridorTooltip.tsx";
import { EditToolPalette } from "./EditToolPalette.tsx";
import { CellType, FeatureType } from "../../engine/types.ts";
import type { Dungeon, Room, Feature } from "../../engine/types.ts";
import { cloneGrid, getCell } from "../../engine/grid.ts";
import type { EditTool } from "../../store/ui-store.ts";

const CELL_SIZE = 16;

// ─── Coordinate helpers ──────────────────────────────────────────────────────

function screenToGrid(
  canvasX: number,
  canvasY: number,
  panX: number,
  panY: number,
  zoom: number,
): { x: number; y: number } {
  return {
    x: Math.floor((canvasX - panX) / zoom / CELL_SIZE),
    y: Math.floor((canvasY - panY) / zoom / CELL_SIZE),
  };
}

function findRoomAtPosition(
  dungeon: Dungeon,
  canvasX: number,
  canvasY: number,
  panX: number,
  panY: number,
  zoom: number,
): Room | null {
  const { x: gridX, y: gridY } = screenToGrid(canvasX, canvasY, panX, panY, zoom);
  if (gridY < 0 || gridY >= dungeon.height || gridX < 0 || gridX >= dungeon.width) return null;
  const cell = dungeon.grid[gridY]?.[gridX];
  if (!cell || cell.roomId === null) return null;
  return dungeon.rooms.find((r) => r.id === cell.roomId) ?? null;
}

function findCorridorAtPosition(
  dungeon: Dungeon,
  canvasX: number,
  canvasY: number,
  panX: number,
  panY: number,
  zoom: number,
): number | null {
  const { x: gridX, y: gridY } = screenToGrid(canvasX, canvasY, panX, panY, zoom);
  if (gridY < 0 || gridY >= dungeon.height || gridX < 0 || gridX >= dungeon.width) return null;
  const cell = dungeon.grid[gridY]?.[gridX];
  if (!cell || cell.corridorId === null) return null;
  return cell.corridorId;
}

// ─── Edit helpers ─────────────────────────────────────────────────────────────

function deepCloneDungeon(d: Dungeon): Dungeon {
  return {
    ...d,
    grid: cloneGrid(d.grid),
    rooms: d.rooms.map((r) => ({ ...r, connections: [...r.connections], features: [...r.features] })),
    features: d.features.map((f) => ({ ...f })),
  };
}

function toolGhostColor(tool: EditTool): string {
  if (tool === "erase") return "rgba(220,50,50,0.35)";
  if (tool === "paint") return "rgba(180,160,120,0.5)";
  if (tool === "room") return "rgba(105,101,219,0.2)";
  return "rgba(105,101,219,0.35)";
}

// Find which room to assign a painted cell to: cell's own roomId first, then nearest
// room within `radius` cells (Manhattan distance).
function inferRoomFromCell(d: Dungeon, gridX: number, gridY: number, radius = 5): number | null {
  const cell = getCell(d.grid, gridX, gridY);
  if (cell && cell.roomId !== null) return cell.roomId;

  let bestId: number | null = null;
  let bestDist = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nb = getCell(d.grid, gridX + dx, gridY + dy);
      if (nb && nb.roomId !== null) {
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < bestDist) { bestDist = dist; bestId = nb.roomId; }
      }
    }
  }
  return bestId;
}

function applyToolAt(d: Dungeon, x: number, y: number, tool: EditTool, paintRoomId: number | null): void {
  const cell = getCell(d.grid, x, y);
  if (!cell) return;

  if (tool === "paint") {
    cell.type = CellType.Floor;
    if (paintRoomId !== null) cell.roomId = paintRoomId;
    // Auto-wall all 8 adjacent empty cells
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nb = getCell(d.grid, x + dx, y + dy);
        if (nb && nb.type === CellType.Empty) nb.type = CellType.Wall;
      }
    }
    return;
  }

  if (tool === "erase") {
    const WALKABLE = new Set([
      CellType.Floor, CellType.Corridor, CellType.Door,
      CellType.SecretDoor, CellType.StairsUp, CellType.StairsDown,
    ]);
    if (!WALKABLE.has(cell.type)) return; // ignore empty/wall cells

    if (cell.featureId !== null) {
      const fid = cell.featureId;
      d.features = d.features.filter((f) => f.id !== fid);
      for (const room of d.rooms) {
        room.features = room.features.filter((f) => f.id !== fid);
      }
    }
    cell.type = CellType.Empty;
    cell.roomId = null;
    cell.corridorId = null;
    cell.featureId = null;

    // Clean up any adjacent wall cells that are now orphaned (no walkable neighbors)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nb = getCell(d.grid, x + dx, y + dy);
        if (!nb || nb.type !== CellType.Wall) continue;
        let hasWalkable = false;
        for (const [ddx, ddy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const n2 = getCell(d.grid, x + dx + ddx, y + dy + ddy);
          if (n2 && WALKABLE.has(n2.type)) { hasWalkable = true; break; }
        }
        if (!hasWalkable) nb.type = CellType.Empty;
      }
    }
    return;
  }

  // Feature tools — only on walkable cells
  if (cell.type === CellType.Empty || cell.type === CellType.Wall) return;

  // Remove existing feature
  if (cell.featureId !== null) {
    const fid = cell.featureId;
    d.features = d.features.filter((f) => f.id !== fid);
    for (const room of d.rooms) {
      room.features = room.features.filter((f) => f.id !== fid);
    }
    cell.featureId = null;
  }

  type ToolMapping = { cellType?: CellType; featureType: FeatureType };
  const mapping: Record<string, ToolMapping> = {
    door:         { cellType: CellType.Door,       featureType: FeatureType.Door },
    locked_door:  { cellType: CellType.Door,       featureType: FeatureType.LockedDoor },
    secret_door:  { cellType: CellType.SecretDoor, featureType: FeatureType.SecretDoor },
    portcullis:   { cellType: CellType.Door,       featureType: FeatureType.Portcullis },
    archway:      { cellType: CellType.Door,       featureType: FeatureType.Archway },
    trapped_door: { cellType: CellType.Door,       featureType: FeatureType.TrappedDoor },
    trap:         { featureType: FeatureType.Trap },
    treasure:     { featureType: FeatureType.Treasure },
    stairs_up:    { cellType: CellType.StairsUp,   featureType: FeatureType.StairsUp },
    stairs_down:  { cellType: CellType.StairsDown, featureType: FeatureType.StairsDown },
  };

  const m = mapping[tool];
  if (!m) return;

  if (m.cellType !== undefined) cell.type = m.cellType;

  const nextId = d.features.reduce((max, f) => Math.max(max, f.id), -1) + 1;
  const feature: Feature = { id: nextId, type: m.featureType, x, y };
  d.features.push(feature);
  cell.featureId = nextId;

  if (cell.roomId !== null) {
    const room = d.rooms.find((r) => r.id === cell.roomId);
    if (room) room.features.push(feature);
  }
}

function finalizeRoom(
  d: Dungeon,
  start: { x: number; y: number },
  end: { x: number; y: number },
): void {
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxX = Math.max(start.x, end.x);
  const maxY = Math.max(start.y, end.y);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (w < 3 || h < 3) return;

  const roomId = d.rooms.reduce((max, r) => Math.max(max, r.id), -1) + 1;
  const room: Room = {
    id: roomId,
    x: minX,
    y: minY,
    width: w,
    height: h,
    centerX: Math.floor((minX + maxX) / 2),
    centerY: Math.floor((minY + maxY) / 2),
    shape: "Rectangular",
    connections: [],
    features: [],
  };

  for (let ry = minY; ry <= maxY; ry++) {
    for (let rx = minX; rx <= maxX; rx++) {
      const c = getCell(d.grid, rx, ry);
      if (!c) continue;
      c.type = CellType.Floor;
      c.roomId = roomId;
      c.corridorId = null;
      c.featureId = null;
    }
  }

  // Auto-wall the border ring
  for (let ry = minY - 1; ry <= maxY + 1; ry++) {
    for (let rx = minX - 1; rx <= maxX + 1; rx++) {
      const c = getCell(d.grid, rx, ry);
      if (c && c.type === CellType.Empty) c.type = CellType.Wall;
    }
  }

  d.rooms.push(room);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

interface CellColors {
  empty: string; floor: string; wall: string; corridor: string;
  door: string; secret: string; stairsUp: string; stairsDown: string;
  grid: string; select: string; selectStroke: string;
  hover: string; hoverStroke: string; roomOutline: string;
  doorInk: string;
}

function getCellColors(): CellColors {
  const style = getComputedStyle(document.documentElement);
  return {
    empty:       style.getPropertyValue("--cell-empty").trim()             || "#e8e2d6",
    floor:       style.getPropertyValue("--cell-floor").trim()             || "#d4c9b0",
    wall:        style.getPropertyValue("--cell-wall").trim()              || "#8a7e6c",
    corridor:    style.getPropertyValue("--cell-corridor").trim()          || "#c8bca2",
    door:        style.getPropertyValue("--cell-door").trim()              || "#a07830",
    secret:      style.getPropertyValue("--cell-secret").trim()            || "#7a6838",
    stairsUp:    style.getPropertyValue("--cell-stairs-up").trim()         || "#5a8a50",
    stairsDown:  style.getPropertyValue("--cell-stairs-down").trim()       || "#8a4a4a",
    grid:        style.getPropertyValue("--cell-grid").trim()              || "rgba(0,0,0,0.06)",
    select:      style.getPropertyValue("--cell-select").trim()            || "rgba(105,101,219,0.3)",
    selectStroke:style.getPropertyValue("--cell-select-stroke").trim()     || "rgba(105,101,219,0.8)",
    hover:       style.getPropertyValue("--cell-hover-highlight").trim()   || "rgba(105,101,219,0.18)",
    hoverStroke: style.getPropertyValue("--cell-hover-stroke").trim()      || "rgba(105,101,219,0.6)",
    roomOutline: style.getPropertyValue("--cell-room-outline").trim()      || "rgba(0,0,0,0.35)",
    doorInk:     style.getPropertyValue("--cell-door-ink").trim()          || "#1e1c18",
  };
}

// ─── Door cartographic symbols ────────────────────────────────────────────────

const DOOR_FEATURE_SET = new Set<FeatureType>([
  FeatureType.Door,
  FeatureType.LockedDoor,
  FeatureType.SecretDoor,
  FeatureType.Portcullis,
  FeatureType.Archway,
  FeatureType.TrappedDoor,
]);

function getDoorOrientation(dungeon: Dungeon, x: number, y: number): "ns" | "ew" {
  const PASSABLE = new Set([
    CellType.Floor, CellType.Corridor, CellType.Door, CellType.SecretDoor,
    CellType.StairsUp, CellType.StairsDown,
  ]);
  const above = dungeon.grid[y - 1]?.[x];
  const below = dungeon.grid[y + 1]?.[x];
  const ns = (above != null && PASSABLE.has(above.type)) || (below != null && PASSABLE.has(below.type));
  return ns ? "ns" : "ew";
}

function drawDoorSymbol(
  ctx: CanvasRenderingContext2D,
  type: FeatureType,
  px: number,
  py: number,
  cs: number,
  orientation: "ns" | "ew",
  ink: string,
): void {
  const sw = Math.round(cs * 0.27);  // stub width  ≈ 4 for cs=16
  const sh = Math.round(cs * 0.5);   // stub length ≈ 8 for cs=16
  const off = Math.round((cs - sh) / 2); // centering offset

  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;

  if (orientation === "ns") {
    // Passage runs N↔S — stubs on left and right edges, centered vertically
    ctx.fillRect(px,           py + off, sw, sh);  // left stub
    ctx.fillRect(px + cs - sw, py + off, sw, sh);  // right stub

    const x1 = px + sw;
    const x2 = px + cs - sw;
    const midY = py + cs / 2;

    switch (type) {
      case FeatureType.Archway: break; // stubs only

      case FeatureType.Portcullis: {
        ctx.lineWidth = 1;
        ctx.beginPath();
        const n = 3;
        const step = sh / (n + 1);
        for (let i = 1; i <= n; i++) {
          const ly = py + off + step * i;
          ctx.moveTo(x1, ly); ctx.lineTo(x2, ly);
        }
        ctx.stroke();
        break;
      }

      case FeatureType.Door: {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, midY); ctx.lineTo(x2, midY);
        ctx.stroke();
        break;
      }

      case FeatureType.LockedDoor: {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, midY); ctx.lineTo(x2, midY);
        ctx.stroke();
        const r = Math.max(1.5, cs * 0.12);
        ctx.beginPath();
        ctx.arc((x1 + x2) / 2, midY, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case FeatureType.TrappedDoor: {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, midY); ctx.lineTo(x2, midY);
        ctx.stroke();
        const xs = cs * 0.14;
        const cx = (x1 + x2) / 2;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - xs, midY - xs); ctx.lineTo(cx + xs, midY + xs);
        ctx.moveTo(cx + xs, midY - xs); ctx.lineTo(cx - xs, midY + xs);
        ctx.stroke();
        break;
      }

      case FeatureType.SecretDoor: {
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 1.5]);
        ctx.beginPath();
        ctx.moveTo(x1, midY); ctx.lineTo(x2, midY);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
    }
  } else {
    // Passage runs E↔W — stubs on top and bottom edges, centered horizontally
    ctx.fillRect(px + off,      py,           sh, sw);  // top stub
    ctx.fillRect(px + off,      py + cs - sw, sh, sw);  // bottom stub

    const y1 = py + sw;
    const y2 = py + cs - sw;
    const midX = px + cs / 2;

    switch (type) {
      case FeatureType.Archway: break;

      case FeatureType.Portcullis: {
        ctx.lineWidth = 1;
        ctx.beginPath();
        const n = 3;
        const step = sh / (n + 1);
        for (let i = 1; i <= n; i++) {
          const lx = px + off + step * i;
          ctx.moveTo(lx, y1); ctx.lineTo(lx, y2);
        }
        ctx.stroke();
        break;
      }

      case FeatureType.Door: {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(midX, y1); ctx.lineTo(midX, y2);
        ctx.stroke();
        break;
      }

      case FeatureType.LockedDoor: {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(midX, y1); ctx.lineTo(midX, y2);
        ctx.stroke();
        const r = Math.max(1.5, cs * 0.12);
        ctx.beginPath();
        ctx.arc(midX, (y1 + y2) / 2, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case FeatureType.TrappedDoor: {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(midX, y1); ctx.lineTo(midX, y2);
        ctx.stroke();
        const xs = cs * 0.14;
        const cy = (y1 + y2) / 2;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(midX - xs, cy - xs); ctx.lineTo(midX + xs, cy + xs);
        ctx.moveTo(midX + xs, cy - xs); ctx.lineTo(midX - xs, cy + xs);
        ctx.stroke();
        break;
      }

      case FeatureType.SecretDoor: {
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 1.5]);
        ctx.beginPath();
        ctx.moveTo(midX, y1); ctx.lineTo(midX, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
    }
  }
}

function drawDoorSymbols(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  inkColor: string,
): void {
  for (const feature of dungeon.features) {
    if (!DOOR_FEATURE_SET.has(feature.type)) continue;
    const orientation = getDoorOrientation(dungeon, feature.x, feature.y);
    drawDoorSymbol(ctx, feature.type, feature.x * CELL_SIZE, feature.y * CELL_SIZE, CELL_SIZE, orientation, inkColor);
  }
}

function drawRoomBorders(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  strokeStyle: string,
  lineWidth: number,
  filterRoomId?: number,
) {
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();

  for (let y = 0; y < dungeon.height; y++) {
    const row = dungeon.grid[y];
    if (!row) continue;
    for (let x = 0; x < dungeon.width; x++) {
      const cell = row[x];
      if (!cell || cell.roomId === null) continue;
      if (filterRoomId !== undefined && cell.roomId !== filterRoomId) continue;

      const rid = cell.roomId;
      const px = x * CELL_SIZE;
      const py = y * CELL_SIZE;

      if (y === 0 || dungeon.grid[y - 1]?.[x]?.roomId !== rid) {
        ctx.moveTo(px, py); ctx.lineTo(px + CELL_SIZE, py);
      }
      if (y === dungeon.height - 1 || dungeon.grid[y + 1]?.[x]?.roomId !== rid) {
        ctx.moveTo(px, py + CELL_SIZE); ctx.lineTo(px + CELL_SIZE, py + CELL_SIZE);
      }
      if (x === 0 || row[x - 1]?.roomId !== rid) {
        ctx.moveTo(px, py); ctx.lineTo(px, py + CELL_SIZE);
      }
      if (x === dungeon.width - 1 || row[x + 1]?.roomId !== rid) {
        ctx.moveTo(px + CELL_SIZE, py); ctx.lineTo(px + CELL_SIZE, py + CELL_SIZE);
      }
    }
  }
  ctx.stroke();
}

function drawDungeon(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  panX: number,
  panY: number,
  zoom: number,
  selectedRoomId: number | null,
  hoveredRoomId: number | null,
  hoveredCorridorId: number | null,
) {
  const canvas = ctx.canvas;
  const colors = getCellColors();

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  ctx.fillStyle = colors.wall;
  ctx.fillRect(0, 0, dungeon.width * CELL_SIZE, dungeon.height * CELL_SIZE);

  for (let y = 0; y < dungeon.height; y++) {
    const row = dungeon.grid[y];
    if (!row) continue;
    for (let x = 0; x < dungeon.width; x++) {
      const cell = row[x];
      if (!cell || cell.type === CellType.Empty) continue;
      const px = x * CELL_SIZE;
      const py = y * CELL_SIZE;
      switch (cell.type) {
        case CellType.Floor:      ctx.fillStyle = colors.floor; break;
        case CellType.Wall:       ctx.fillStyle = colors.wall; break;
        case CellType.Corridor:   ctx.fillStyle = colors.corridor; break;
        case CellType.Door:       ctx.fillStyle = colors.corridor; break;
        case CellType.SecretDoor: ctx.fillStyle = colors.corridor; break;
        case CellType.StairsUp:   ctx.fillStyle = colors.stairsUp; break;
        case CellType.StairsDown: ctx.fillStyle = colors.stairsDown; break;
        default: continue;
      }
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
    }
  }

  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 0.5;
  for (let y = 0; y < dungeon.height; y++) {
    const row = dungeon.grid[y];
    if (!row) continue;
    for (let x = 0; x < dungeon.width; x++) {
      const cell = row[x];
      if (!cell || cell.type === CellType.Empty || cell.type === CellType.Wall) continue;
      ctx.strokeRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }
  }

  drawRoomBorders(ctx, dungeon, colors.roomOutline, 1.5);
  drawDoorSymbols(ctx, dungeon, colors.doorInk);

  if (hoveredRoomId !== null && hoveredRoomId !== selectedRoomId) {
    ctx.fillStyle = colors.hover;
    for (let y = 0; y < dungeon.height; y++) {
      const row = dungeon.grid[y];
      if (!row) continue;
      for (let x = 0; x < dungeon.width; x++) {
        const cell = row[x];
        if (cell && cell.roomId === hoveredRoomId) ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }
    drawRoomBorders(ctx, dungeon, colors.hoverStroke, 2, hoveredRoomId);
  }

  if (hoveredCorridorId !== null) {
    ctx.fillStyle = "rgba(220,175,40,0.28)";
    for (let y = 0; y < dungeon.height; y++) {
      const row = dungeon.grid[y];
      if (!row) continue;
      for (let x = 0; x < dungeon.width; x++) {
        const cell = row[x];
        if (cell && cell.corridorId === hoveredCorridorId) {
          ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }
    }
  }

  if (selectedRoomId !== null) {
    ctx.fillStyle = colors.select;
    for (let y = 0; y < dungeon.height; y++) {
      const row = dungeon.grid[y];
      if (!row) continue;
      for (let x = 0; x < dungeon.width; x++) {
        const cell = row[x];
        if (cell && cell.roomId === selectedRoomId) ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }
    drawRoomBorders(ctx, dungeon, colors.selectStroke, 2.5, selectedRoomId);
  }

  ctx.restore();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DungeonCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // View-mode pan state
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  // Edit-mode state
  const workingDungeon = useRef<Dungeon | null>(null);
  const isPainting = useRef(false);
  const hasDragged = useRef(false);
  const paintStart = useRef<{ x: number; y: number } | null>(null);
  const paintStartPixel = useRef<{ x: number; y: number } | null>(null);
  const lastPaintedKey = useRef<string | null>(null);
  const workingPaintRoomId = useRef<number | null>(null);
  const [ghostCell, setGhostCell] = useState<{ x: number; y: number } | null>(null);
  // Room highlighted in paint mode (inferred or locked) — for hover overlay
  const [paintHoverRoomId, setPaintHoverRoomId] = useState<number | null>(null);

  const dungeon = useDungeonStore((s) => s.dungeon);
  const patchDungeon = useDungeonStore((s) => s.patchDungeon);

  const panX = useUIStore((s) => s.panX);
  const panY = useUIStore((s) => s.panY);
  const zoom = useUIStore((s) => s.zoom);
  const selectedRoomId = useUIStore((s) => s.selectedRoomId);
  const hoveredRoomId = useUIStore((s) => s.hoveredRoomId);
  const hoveredCorridorId = useUIStore((s) => s.hoveredCorridorId);
  const setHoveredCorridorId = useUIStore((s) => s.setHoveredCorridorId);
  const setPan = useUIStore((s) => s.setPan);
  const setZoom = useUIStore((s) => s.setZoom);
  const setSelectedRoomId = useUIStore((s) => s.setSelectedRoomId);
  const setHoveredRoomId = useUIStore((s) => s.setHoveredRoomId);
  const darkMode = useUIStore((s) => s.darkMode);
  const editMode = useUIStore((s) => s.editMode);
  const activeTool = useUIStore((s) => s.activeTool);
  const paintRoomLocked = useUIStore((s) => s.paintRoomLocked);
  const lockPaintRoom = useUIStore((s) => s.lockPaintRoom);
  const unlockPaintRoom = useUIStore((s) => s.unlockPaintRoom);

  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // Resize canvas to fill container
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      canvas.width = entry.contentRect.width;
      canvas.height = entry.contentRect.height;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── redrawCanvas ──────────────────────────────────────────────────────────
  const redrawCanvas = useCallback(
    (ghost: { x: number; y: number } | null = null, paintStartOverride: { x: number; y: number } | null = null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const d = workingDungeon.current ?? dungeon;
      if (!d) return;

      drawDungeon(ctx, d, panX, panY, zoom, selectedRoomId, hoveredRoomId, hoveredCorridorId);

      // Paint-mode room highlight overlay (locked or inferred)
      const { paintRoomId: lockedId, paintRoomLocked: locked } = useUIStore.getState();
      const highlightRoom = locked ? lockedId : paintHoverRoomId;
      if (editMode && activeTool === "paint" && highlightRoom !== null) {
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);
        ctx.fillStyle = locked ? "rgba(105,101,219,0.18)" : "rgba(200,180,80,0.18)";
        for (let hy = 0; hy < d.height; hy++) {
          const row = d.grid[hy];
          if (!row) continue;
          for (let hx = 0; hx < d.width; hx++) {
            const hcell = row[hx];
            if (hcell && hcell.roomId === highlightRoom) {
              ctx.fillRect(hx * CELL_SIZE, hy * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            }
          }
        }
        drawRoomBorders(ctx, d, locked ? "rgba(105,101,219,0.6)" : "rgba(200,180,80,0.5)", 2, highlightRoom);
        ctx.restore();
      }

      // Ghost cursor overlay
      if (editMode && ghost) {
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);

        ctx.fillStyle = toolGhostColor(activeTool);
        ctx.fillRect(ghost.x * CELL_SIZE, ghost.y * CELL_SIZE, CELL_SIZE, CELL_SIZE);

        // Room drag preview rectangle
        const ps = paintStartOverride ?? paintStart.current;
        if (activeTool === "room" && ps && isPainting.current) {
          const rx = Math.min(ps.x, ghost.x) * CELL_SIZE;
          const ry = Math.min(ps.y, ghost.y) * CELL_SIZE;
          const rw = (Math.abs(ghost.x - ps.x) + 1) * CELL_SIZE;
          const rh = (Math.abs(ghost.y - ps.y) + 1) * CELL_SIZE;
          ctx.strokeStyle = "rgba(105,101,219,0.8)";
          ctx.lineWidth = 1.5 / zoom;
          ctx.strokeRect(rx, ry, rw, rh);
        }

        ctx.restore();
      }
    },
    [dungeon, panX, panY, zoom, selectedRoomId, hoveredRoomId, hoveredCorridorId, darkMode, editMode, activeTool, paintHoverRoomId, paintRoomLocked],
  );

  // Re-render on state changes
  useEffect(() => {
    redrawCanvas(ghostCell);
  }, [dungeon, panX, panY, zoom, selectedRoomId, hoveredRoomId, hoveredCorridorId, darkMode, editMode, activeTool, paintHoverRoomId, paintRoomLocked]);

  // ── commitEdit ────────────────────────────────────────────────────────────
  const commitEdit = useCallback(() => {
    if (!workingDungeon.current || !dungeon) return;
    useDungeonStore.getState().pushEditSnapshot();
    const committed = workingDungeon.current;
    patchDungeon(() => committed);
  }, [dungeon, patchDungeon]);

  // ── Mouse handlers ────────────────────────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!editMode || activeTool === "select") {
        isDragging.current = true;
        dragStart.current = { x: e.clientX - panX, y: e.clientY - panY };
        return;
      }
      if (!dungeon) return;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { x: gridX, y: gridY } = screenToGrid(e.clientX - rect.left, e.clientY - rect.top, panX, panY, zoom);

      workingDungeon.current = deepCloneDungeon(dungeon);
      isPainting.current = true;
      hasDragged.current = false;
      paintStart.current = { x: gridX, y: gridY };
      paintStartPixel.current = { x: e.clientX, y: e.clientY };
      lastPaintedKey.current = `${gridX},${gridY}`;

      // For "paint": defer application until the user drags (to distinguish click-to-lock from paint stroke)
      // For all other tools: apply immediately on mouseDown
      if (activeTool !== "room" && activeTool !== "paint") {
        applyToolAt(workingDungeon.current, gridX, gridY, activeTool, null);
        redrawCanvas({ x: gridX, y: gridY });
      }
    },
    [editMode, activeTool, dungeon, panX, panY, zoom, redrawCanvas],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      const { x: gridX, y: gridY } = screenToGrid(canvasX, canvasY, panX, panY, zoom);
      const ghost = { x: gridX, y: gridY };

      if (!editMode || activeTool === "select") {
        // View mode: pan or hover
        if (isDragging.current) {
          setPan(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y);
          return;
        }
        if (!dungeon) return;
        const room = findRoomAtPosition(dungeon, canvasX, canvasY, panX, panY, zoom);
        setHoveredRoomId(room?.id ?? null);
        const cid = room ? null : findCorridorAtPosition(dungeon, canvasX, canvasY, panX, panY, zoom);
        setHoveredCorridorId(cid);
        setTooltipPos(room || cid !== null ? { x: e.clientX, y: e.clientY } : null);
        return;
      }

      // Edit mode: update ghost
      setGhostCell(ghost);

      if (isPainting.current && workingDungeon.current) {
        if (activeTool === "room") {
          redrawCanvas(ghost);
        } else if (activeTool === "paint") {
          // Detect transition from click→drag (5px threshold)
          if (!hasDragged.current && paintStartPixel.current) {
            const pdx = Math.abs(e.clientX - paintStartPixel.current.x);
            const pdy = Math.abs(e.clientY - paintStartPixel.current.y);
            if (pdx >= 5 || pdy >= 5) {
              hasDragged.current = true;
              // Determine room for this entire stroke
              const { paintRoomId: lockedId, paintRoomLocked: locked } = useUIStore.getState();
              workingPaintRoomId.current = locked
                ? lockedId
                : inferRoomFromCell(workingDungeon.current, paintStart.current!.x, paintStart.current!.y);
              // Apply paint at the original click position
              applyToolAt(workingDungeon.current, paintStart.current!.x, paintStart.current!.y, "paint", workingPaintRoomId.current);
            }
          }
          if (hasDragged.current) {
            const key = `${gridX},${gridY}`;
            if (key !== lastPaintedKey.current) {
              lastPaintedKey.current = key;
              applyToolAt(workingDungeon.current, gridX, gridY, "paint", workingPaintRoomId.current);
            }
          }
          redrawCanvas(ghost);
        } else {
          // Other tools (erase, feature tools): apply on every new cell
          const key = `${gridX},${gridY}`;
          if (key !== lastPaintedKey.current) {
            lastPaintedKey.current = key;
            applyToolAt(workingDungeon.current, gridX, gridY, activeTool, null);
            redrawCanvas(ghost);
          }
        }
      } else {
        redrawCanvas(ghost);
      }

      // Update hover highlight for paint tool (shows which room will be targeted)
      if (activeTool === "paint" && dungeon) {
        const { paintRoomId: lockedId, paintRoomLocked: locked } = useUIStore.getState();
        const hovered = locked ? lockedId : inferRoomFromCell(dungeon, gridX, gridY);
        setPaintHoverRoomId(hovered);
      }
    },
    [editMode, activeTool, dungeon, panX, panY, zoom, setPan, setHoveredRoomId, setHoveredCorridorId, redrawCanvas],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!editMode || activeTool === "select") {
        // View mode: click to select if not dragged
        const wasDragging = isDragging.current;
        isDragging.current = false;
        if (wasDragging) {
          const dx = Math.abs(e.clientX - (dragStart.current.x + panX));
          const dy = Math.abs(e.clientY - (dragStart.current.y + panY));
          if (dx > 3 || dy > 3) return;
        }
        if (!dungeon) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const room = findRoomAtPosition(dungeon, e.clientX - rect.left, e.clientY - rect.top, panX, panY, zoom);
        setSelectedRoomId(room?.id ?? null);
        return;
      }

      if (!isPainting.current) return;

      const wasDragged = hasDragged.current;

      if (activeTool === "paint" && !wasDragged) {
        // It was a click, not a drag — handle as lock/unlock
        if (dungeon && paintStart.current) {
          const cell = dungeon.grid[paintStart.current.y]?.[paintStart.current.x];
          const rid = cell?.roomId ?? null;
          const { paintRoomId: lockedId, paintRoomLocked: locked } = useUIStore.getState();
          if (rid !== null) {
            if (locked && lockedId === rid) {
              unlockPaintRoom(); // clicking same locked room → toggle off
            } else {
              lockPaintRoom(rid); // lock to this room
            }
          } else if (locked) {
            unlockPaintRoom(); // clicking empty/corridor → unlock
          }
        }
        // Discard draft (no edit committed)
        isPainting.current = false;
        hasDragged.current = false;
        paintStart.current = null;
        paintStartPixel.current = null;
        lastPaintedKey.current = null;
        workingPaintRoomId.current = null;
        workingDungeon.current = null;
        redrawCanvas(ghostCell);
        return;
      }

      if (workingDungeon.current) {
        if (activeTool === "room" && paintStart.current) {
          const canvas = canvasRef.current;
          if (canvas) {
            const rect = canvas.getBoundingClientRect();
            const { x: gridX, y: gridY } = screenToGrid(e.clientX - rect.left, e.clientY - rect.top, panX, panY, zoom);
            finalizeRoom(workingDungeon.current, paintStart.current, { x: gridX, y: gridY });
          }
        }
        commitEdit();
      }

      isPainting.current = false;
      hasDragged.current = false;
      paintStart.current = null;
      paintStartPixel.current = null;
      lastPaintedKey.current = null;
      workingPaintRoomId.current = null;
      workingDungeon.current = null;
      redrawCanvas(ghostCell);
    },
    [editMode, activeTool, dungeon, panX, panY, zoom, setSelectedRoomId, commitEdit, ghostCell, redrawCanvas, lockPaintRoom, unlockPaintRoom],
  );

  const handleMouseLeave = useCallback(() => {
    setGhostCell(null);
    setPaintHoverRoomId(null);

    if (editMode && isPainting.current) {
      // Cancel in-progress edit
      isPainting.current = false;
      hasDragged.current = false;
      paintStart.current = null;
      paintStartPixel.current = null;
      workingPaintRoomId.current = null;
      workingDungeon.current = null;
      redrawCanvas(null);
    }

    isDragging.current = false;
    setHoveredRoomId(null);
    setHoveredCorridorId(null);
    setTooltipPos(null);
  }, [editMode, setHoveredRoomId, setHoveredCorridorId, redrawCanvas]);

  // Space → temporary select/pan tool
  const spaceHeld = useRef(false);
  const toolBeforeSpace = useRef<EditTool | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (spaceHeld.current) return;
      const { editMode: em, activeTool: at, setActiveTool: sat } = useUIStore.getState();
      if (!em || at === "select") return;
      e.preventDefault();
      spaceHeld.current = true;
      toolBeforeSpace.current = at;
      sat("select");
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (!spaceHeld.current) return;
      spaceHeld.current = false;
      if (toolBeforeSpace.current !== null) {
        useUIStore.getState().setActiveTool(toolBeforeSpace.current);
        toolBeforeSpace.current = null;
      }
    };

    const onBlur = () => {
      if (!spaceHeld.current) return;
      spaceHeld.current = false;
      if (toolBeforeSpace.current !== null) {
        useUIStore.getState().setActiveTool(toolBeforeSpace.current);
        toolBeforeSpace.current = null;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Wheel zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(Math.max(0.2, Math.min(3, zoom + delta)));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoom, setZoom]);

  return (
    <div
      ref={containerRef}
      className="dungeon-canvas-wrapper"
      data-tool={editMode ? activeTool : undefined}
    >
      <canvas
        ref={canvasRef}
        className="dungeon-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
      {dungeon && <SvgOverlay />}
      {editMode && <EditToolPalette />}
      {!editMode && hoveredRoomId !== null && tooltipPos && (
        <RoomTooltip position={tooltipPos} roomId={hoveredRoomId} />
      )}
      {!editMode && hoveredCorridorId !== null && tooltipPos && (
        <CorridorTooltip position={tooltipPos} corridorId={hoveredCorridorId} />
      )}
    </div>
  );
}
