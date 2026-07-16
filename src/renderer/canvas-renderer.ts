import rough from "roughjs";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Dungeon, Cell } from "../engine/types.ts";
import { CellType, FeatureType } from "../engine/types.ts";
import type { ThemePalette } from "./themes/theme-engine.ts";
import { getRoomGeometry, createRoomPath } from "./room-shapes.ts";
import { drawDoorSymbols } from "./door-symbols.ts";

export interface RenderOptions {
  cellSize: number;
  showGrid: boolean;
  theme: ThemePalette;
  selectedRoomId: number | null;
  hoveredRoomId: number | null;
  hiddenFeatureTypes?: ReadonlySet<FeatureType>;
}

/** Options for the static (non-interactive) layer stack. */
export interface StaticLayerOptions {
  cellSize: number;
  theme: ThemePalette;
  showGrid: boolean;
  hiddenFeatureTypes?: ReadonlySet<FeatureType>;
  /** Ink color for door symbols; defaults to theme.ink. */
  doorInk?: string;
  includeRoomLabels?: boolean;
}

const WALKABLE = new Set([CellType.Floor, CellType.Corridor, CellType.Door, CellType.SecretDoor, CellType.StairsUp, CellType.StairsDown]);

// ─── Stroke-then-Fill floor rendering ────────────────────────────────────────
//
// All rooms (except Cave) are rendered as smooth geometric Path2D shapes.
// Cave room cells and all corridor/walkable cells are rendered as individual
// cellSize×cellSize rectangles.  Corridor rects adjacent to a geometric room
// are over-extended by one cellSize toward the room so they always penetrate
// into the smooth shape boundary and connect seamlessly.
//
// Render passes:
//   Pass 1 — thick stroke  (2× wall thickness): draws wall outline everywhere
//   Pass 2 — parchment fill: erases the inner half of every stroke, leaving
//             only the outer perimeter visible as the wall, and seamlessly
//             covers any corridor over-extensions or shape overlaps inside rooms
//   Pass 3 — optional grid dots, clipped to the floor area

// Final wall half-thickness as fraction of cellSize.
// The stroke is drawn at 2× this width; the fill erases the inner half.
const WALL_THICKNESS_FRACTION = 0.12;

const floorPathCache = new WeakMap<Dungeon, Map<number, Path2D>>();

function getCachedFloorPath(dungeon: Dungeon, cellSize: number): Path2D {
  let bySize = floorPathCache.get(dungeon);
  if (!bySize) {
    bySize = new Map();
    floorPathCache.set(dungeon, bySize);
  }
  const cached = bySize.get(cellSize);
  if (cached) return cached;
  const path = buildFloorPath(dungeon, cellSize);
  bySize.set(cellSize, path);
  return path;
}

function buildFloorPath(dungeon: Dungeon, cellSize: number): Path2D {
  const { grid, width, height, rooms } = dungeon;
  const path = new Path2D();

  // All non-Cave rooms get a smooth geometric path (rect, ellipse, or polygon).
  const geometricRoomIds = new Set<number>();
  for (const room of rooms) {
    if (room.shape === "Cave") continue;
    geometricRoomIds.add(room.id);
    path.addPath(createRoomPath(getRoomGeometry(room, cellSize)));
  }

  // Every walkable cell not covered by a geometric room is added as a
  // cellSize×cellSize rect.  Where that cell borders a geometric room, extend
  // the rect by one extra cellSize in that direction so the corridor visually
  // penetrates the smooth room boundary (the fill in Pass 2 will erase any
  // over-extension that lands inside the room).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = grid[y]?.[x];
      if (!cell || !WALKABLE.has(cell.type)) continue;
      if (cell.roomId !== null && geometricRoomIds.has(cell.roomId)) continue;

      const px = x * cellSize;
      const py = y * cellSize;
      let minX = px, minY = py, maxX = px + cellSize, maxY = py + cellSize;

      const nRid = grid[y - 1]?.[x]?.roomId ?? null;
      const sRid = grid[y + 1]?.[x]?.roomId ?? null;
      const wRid = grid[y]?.[x - 1]?.roomId ?? null;
      const eRid = grid[y]?.[x + 1]?.roomId ?? null;
      if (nRid !== null && geometricRoomIds.has(nRid)) minY -= cellSize;
      if (sRid !== null && geometricRoomIds.has(sRid)) maxY += cellSize;
      if (wRid !== null && geometricRoomIds.has(wRid)) minX -= cellSize;
      if (eRid !== null && geometricRoomIds.has(eRid)) maxX += cellSize;

      path.rect(minX, minY, maxX - minX, maxY - minY);
    }
  }

  return path;
}

export function renderFloorPlan(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  cellSize: number,
  theme: ThemePalette,
  showGrid = false,
): void {
  const floorPath = getCachedFloorPath(dungeon, cellSize);
  const wallThickness = Math.max(1.5, cellSize * WALL_THICKNESS_FRACTION);

  // Pass 1: Thick stroke — wall outline at 2× the desired final thickness.
  // The inner half will be painted over by the floor fill in Pass 2.
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = wallThickness * 2;
  ctx.lineCap = "square";
  ctx.lineJoin = "miter";
  ctx.stroke(floorPath);

  // Pass 2: Parchment fill — erases the interior half of every stroke and
  // covers all corridor over-extensions / shape overlaps inside rooms, leaving
  // a clean outer wall perimeter and seamless corridor connections.
  ctx.fillStyle = theme.parchment;
  ctx.fill(floorPath, "nonzero");

  // Pass 3: Grid dots, clipped to the floor area so they only appear on floor.
  if (showGrid) {
    ctx.save();
    ctx.clip(floorPath, "nonzero");
    drawGridDots(ctx, dungeon.width, dungeon.height, cellSize, theme);
    ctx.restore();
  }
}

/**
 * Render every static (non-interactive) layer of the dungeon in world px:
 * background, floor + walls, grid dots, door symbols, stairs, trap/treasure
 * glyphs, and room labels. This is the single choke point shared by the live
 * offscreen buffer and PNG/PDF/VTT exports — style changes here propagate
 * everywhere.
 */
export function renderStaticLayers(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  opts: StaticLayerOptions,
): void {
  const {
    cellSize, theme, showGrid, hiddenFeatureTypes,
    doorInk = theme.ink,
    includeRoomLabels = true,
  } = opts;

  ctx.fillStyle = theme.wall;
  ctx.fillRect(0, 0, dungeon.width * cellSize, dungeon.height * cellSize);

  renderFloorPlan(ctx, dungeon, cellSize, theme, showGrid);

  const rc = rough.canvas(ctx.canvas as HTMLCanvasElement);
  drawSpecialCells(rc, ctx, dungeon, cellSize, theme, hiddenFeatureTypes);
  drawDoorSymbols(ctx, dungeon, cellSize, doorInk, hiddenFeatureTypes);

  if (includeRoomLabels) {
    drawRoomLabels(ctx, dungeon, cellSize, theme);
  }
}

export function renderDungeon(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  options: RenderOptions
): void {
  const { cellSize, showGrid, theme, selectedRoomId, hoveredRoomId, hiddenFeatureTypes } = options;

  renderStaticLayers(ctx, dungeon, { cellSize, theme, showGrid, hiddenFeatureTypes });

  if (selectedRoomId !== null) {
    drawRoomOverlay(ctx, dungeon, selectedRoomId, cellSize, theme.roomHighlight);
  }

  if (hoveredRoomId !== null && hoveredRoomId !== selectedRoomId) {
    drawRoomOverlay(ctx, dungeon, hoveredRoomId, cellSize, theme.roomHover);
  }
}

function isWalkable(cell: Cell | undefined): boolean {
  return cell !== undefined && WALKABLE.has(cell.type);
}

function shadowVertexDepth(saltedSeed: number, vx: number, vy: number, base: number): number {
  let h = (saltedSeed ^ (vx * 374761393) ^ (vy * 1779033703)) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), 2246822519)) >>> 0;
  h = (Math.imul(h ^ (h >>> 16), 1013904223)) >>> 0;
  return base * (0.85 + (h / 0xffffffff) * 0.3);
}

export function drawWallShadows(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  cellSize: number,
): void {
  const { width, height, grid } = dungeon;
  const base = Math.max(4, cellSize * 0.40);
  const nSeed = dungeon.seed ^ 0x4a9b3d1f;
  const wSeed = dungeon.seed ^ 0x7c3e9a2b;

  // All shadow geometry is drawn at full opacity onto an offscreen canvas,
  // then composited once at a fixed alpha. This prevents overlap darkening
  // where the N-shadow and W-shadow meet at concave (NW inner) corners.
  const offscreen = document.createElement("canvas");
  offscreen.width  = width  * cellSize;
  offscreen.height = height * cellSize;
  const off = offscreen.getContext("2d");
  if (!off) return;

  off.fillStyle = "#000";

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = grid[y]?.[x];
      if (!cell || !WALKABLE.has(cell.type)) continue;

      const px = x * cellSize;
      const py = y * cellSize;

      const wallN = y > 0 && !isWalkable(grid[y - 1]?.[x]);
      const wallW = x > 0 && !isWalkable(grid[y]?.[x - 1]);

      if (wallN) {
        const ld = shadowVertexDepth(nSeed, x,     y, base);
        const rd = shadowVertexDepth(nSeed, x + 1, y, base);
        off.beginPath();
        off.moveTo(px,            py);
        off.lineTo(px + cellSize, py);
        off.lineTo(px + cellSize, py + rd);
        off.lineTo(px,            py + ld);
        off.closePath();
        off.fill();
      }

      if (wallW) {
        const td = shadowVertexDepth(wSeed, x, y,     base);
        const bd = shadowVertexDepth(wSeed, x, y + 1, base);
        const topClip = wallN ? shadowVertexDepth(nSeed, x, y, base) : 0;
        const frac    = topClip / cellSize;
        const wAtClip = td + (bd - td) * frac;
        off.beginPath();
        off.moveTo(px,           py + topClip);
        off.lineTo(px + wAtClip, py + topClip);
        off.lineTo(px + bd,      py + cellSize);
        off.lineTo(px,           py + cellSize);
        off.closePath();
        off.fill();
      }

      // 270° concave corner fill — seam between N and W shadows
      if (y > 0 && x > 0
          && isWalkable(grid[y - 1]?.[x])
          && isWalkable(grid[y]?.[x - 1])
          && !isWalkable(grid[y - 1]?.[x - 1])) {
        const nd = shadowVertexDepth(nSeed, x, y, base);
        const wd = shadowVertexDepth(wSeed, x, y, base);
        off.fillRect(px, py, wd, nd);
      }
    }
  }

  ctx.save();
  ctx.globalAlpha = 0.30;
  ctx.drawImage(offscreen, 0, 0);
  ctx.restore();
}

export function drawOutwardShadows(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  cellSize: number,
): void {
  const { width, height, grid } = dungeon;
  const base = Math.max(6, cellSize * 0.62);
  // N/W seeds match drawWallShadows so vertex depths align at the floor boundary
  const nSeed = dungeon.seed ^ 0x4a9b3d1f;
  const sSeed = dungeon.seed ^ 0x9f2c7e8d;
  const wSeed = dungeon.seed ^ 0x7c3e9a2b;
  const eSeed = dungeon.seed ^ 0x3b5f1d9c;

  // Paint all shapes onto an offscreen canvas at full opacity then composite
  // once at a low alpha — this eliminates overlap darkening at seams and corners.
  const offscreen = document.createElement("canvas");
  offscreen.width = width * cellSize;
  offscreen.height = height * cellSize;
  const off = offscreen.getContext("2d");
  if (!off) return;

  off.fillStyle = "#000";

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = grid[y]?.[x];
      if (!cell || !WALKABLE.has(cell.type)) continue;

      const px = x * cellSize;
      const py = y * cellSize;

      const wallN = y > 0           && !isWalkable(grid[y - 1]?.[x]);
      const wallS = y < height - 1  && !isWalkable(grid[y + 1]?.[x]);
      const wallW = x > 0           && !isWalkable(grid[y]?.[x - 1]);
      const wallE = x < width  - 1  && !isWalkable(grid[y]?.[x + 1]);

      if (wallN) {
        const ld = shadowVertexDepth(nSeed, x,     y, base);
        const rd = shadowVertexDepth(nSeed, x + 1, y, base);
        off.beginPath();
        off.moveTo(px,            py);
        off.lineTo(px + cellSize, py);
        off.lineTo(px + cellSize, py - rd);
        off.lineTo(px,            py - ld);
        off.closePath();
        off.fill();
      }

      if (wallS) {
        const ld = shadowVertexDepth(sSeed, x,     y + 1, base);
        const rd = shadowVertexDepth(sSeed, x + 1, y + 1, base);
        off.beginPath();
        off.moveTo(px,            py + cellSize);
        off.lineTo(px + cellSize, py + cellSize);
        off.lineTo(px + cellSize, py + cellSize + rd);
        off.lineTo(px,            py + cellSize + ld);
        off.closePath();
        off.fill();
      }

      if (wallW) {
        const td = shadowVertexDepth(wSeed, x, y,     base);
        const bd = shadowVertexDepth(wSeed, x, y + 1, base);
        off.beginPath();
        off.moveTo(px,      py);
        off.lineTo(px - td, py);
        off.lineTo(px - bd, py + cellSize);
        off.lineTo(px,      py + cellSize);
        off.closePath();
        off.fill();
      }

      if (wallE) {
        const td = shadowVertexDepth(eSeed, x + 1, y,     base);
        const bd = shadowVertexDepth(eSeed, x + 1, y + 1, base);
        off.beginPath();
        off.moveTo(px + cellSize,      py);
        off.lineTo(px + cellSize + td, py);
        off.lineTo(px + cellSize + bd, py + cellSize);
        off.lineTo(px + cellSize,      py + cellSize);
        off.closePath();
        off.fill();
      }

      // Corner accents — fill the gap in each diagonal wall cell left by adjacent
      // cardinal shadows. Safe to overlap here since we're on the offscreen canvas.
      if (x > 0 && y > 0 && !isWalkable(grid[y - 1]?.[x - 1])) {
        const wd = shadowVertexDepth(wSeed, x, y, base);
        const nd = shadowVertexDepth(nSeed, x, y, base);
        off.fillRect(px - wd, py - nd, wd, nd);
      }
      if (x < width - 1 && y > 0 && !isWalkable(grid[y - 1]?.[x + 1])) {
        const ed = shadowVertexDepth(eSeed, x + 1, y, base);
        const nd = shadowVertexDepth(nSeed, x + 1, y, base);
        off.fillRect(px + cellSize, py - nd, ed, nd);
      }
      if (x > 0 && y < height - 1 && !isWalkable(grid[y + 1]?.[x - 1])) {
        const wd = shadowVertexDepth(wSeed, x,     y + 1, base);
        const sd = shadowVertexDepth(sSeed, x,     y + 1, base);
        off.fillRect(px - wd, py + cellSize, wd, sd);
      }
      if (x < width - 1 && y < height - 1 && !isWalkable(grid[y + 1]?.[x + 1])) {
        const ed = shadowVertexDepth(eSeed, x + 1, y + 1, base);
        const sd = shadowVertexDepth(sSeed, x + 1, y + 1, base);
        off.fillRect(px + cellSize, py + cellSize, ed, sd);
      }
    }
  }

  // Single composite pass — all overlap was already absorbed into opaque black
  ctx.save();
  ctx.globalAlpha = 0.20;
  ctx.drawImage(offscreen, 0, 0);
  ctx.restore();
}

export function drawSpecialCells(
  rc: RoughCanvas,
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  cellSize: number,
  theme: ThemePalette,
  hidden: ReadonlySet<FeatureType> = new Set()
): void {
  const { width, height, grid } = dungeon;

  // Doors/secret doors are rendered as cartographic symbols by drawDoorSymbols;
  // only stairs remain cell-driven here.
  for (let y = 0; y < height; y++) {
    const row = grid[y];
    if (!row) continue;
    for (let x = 0; x < width; x++) {
      const cell = row[x];
      if (!cell) continue;

      const px = x * cellSize;
      const py = y * cellSize;

      switch (cell.type) {
        case CellType.StairsUp:
          if (!hidden.has(FeatureType.StairsUp)) drawStairs(rc, px, py, cellSize, theme, true);
          break;
        case CellType.StairsDown:
          if (!hidden.has(FeatureType.StairsDown)) drawStairs(rc, px, py, cellSize, theme, false);
          break;
      }
    }
  }

  // Trap and Treasure sit on Floor cells — iterate features directly
  const fontSize = Math.max(8, cellSize * 0.6);
  ctx.font = `${fontSize}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const feature of dungeon.features) {
    if (feature.type === FeatureType.Trap && !hidden.has(FeatureType.Trap)) {
      ctx.fillStyle = theme.trap;
      ctx.fillText("\u26A0", feature.x * cellSize + cellSize / 2, feature.y * cellSize + cellSize / 2);
    } else if (feature.type === FeatureType.Treasure && !hidden.has(FeatureType.Treasure)) {
      ctx.fillStyle = theme.treasure;
      ctx.fillText("$", feature.x * cellSize + cellSize / 2, feature.y * cellSize + cellSize / 2);
    }
  }
}

function drawStairs(
  rc: RoughCanvas,
  px: number,
  py: number,
  cellSize: number,
  theme: ThemePalette,
  isUp: boolean
): void {
  const steps = 4;
  const stepHeight = cellSize / steps;
  const margin = cellSize * 0.15;

  for (let i = 0; i < steps; i++) {
    const stepY = isUp
      ? py + margin + i * stepHeight
      : py + cellSize - margin - (i + 1) * stepHeight;
    const stepWidth = cellSize - margin * 2;
    const stepH = stepHeight * 0.6;

    if (stepWidth > 0 && stepH > 0) {
      rc.rectangle(px + margin, stepY, stepWidth, stepH, {
        stroke: theme.ink,
        strokeWidth: 1,
        roughness: 0.5,
        fill: "none",
      });
    }
  }
}

// Grid dots path cache — keyed by "width:height:cellSize".
// The path is position-independent so it can be reused across buffer rebuilds for
// the same dungeon dimensions.  A single Path2D with moveTo+arc per intersection
// gives one ctx.fill() call (one GPU pass) instead of ~10K individual fill() calls.
const gridDotsPathCache = new Map<string, Path2D>();

function getGridDotsPath(width: number, height: number, cellSize: number): Path2D {
  const key = `${width}:${height}:${cellSize}`;
  const cached = gridDotsPathCache.get(key);
  if (cached) return cached;

  const path = new Path2D();
  for (let x = 0; x <= width; x++) {
    for (let y = 0; y <= height; y++) {
      const px = x * cellSize;
      const py = y * cellSize;
      // moveTo start of arc to avoid implicit lineTo connectors between dots.
      path.moveTo(px + 1, py);
      path.arc(px, py, 1, 0, Math.PI * 2);
    }
  }
  gridDotsPathCache.set(key, path);
  return path;
}

function drawGridDots(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cellSize: number,
  theme: ThemePalette
): void {
  const path = getGridDotsPath(width, height, cellSize);
  ctx.fillStyle = theme.grid;
  ctx.globalAlpha = 0.2;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

function drawRoomLabels(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  cellSize: number,
  theme: ThemePalette
): void {
  ctx.fillStyle = theme.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fontSize = Math.max(8, Math.min(cellSize * 0.6, 14));
  ctx.font = `${fontSize}px sans-serif`;

  for (const room of dungeon.rooms) {
    const cx = (room.centerX + 0.5) * cellSize;
    const cy = (room.centerY + 0.5) * cellSize;
    ctx.fillText(String(room.id), cx, cy);
  }
}

function drawRoomOverlay(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  roomId: number,
  cellSize: number,
  color: string
): void {
  const room = dungeon.rooms.find((r) => r.id === roomId);
  if (!room) return;

  ctx.fillStyle = color;

  if (room.shape !== "Cave") {
    // All non-Cave rooms have a smooth geometric path (rect, ellipse, polygon, cross)
    ctx.fill(createRoomPath(getRoomGeometry(room, cellSize)));
  } else {
    // Cave rooms: cell-by-cell (irregular organic shape)
    const { width, height, grid } = dungeon;
    for (let y = 0; y < height; y++) {
      const row = grid[y];
      if (!row) continue;
      for (let x = 0; x < width; x++) {
        const cell = row[x];
        if (!cell) continue;
        if (cell.roomId === roomId) {
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        }
      }
    }
  }
}

export function getCellAtPixel(
  px: number,
  py: number,
  cellSize: number,
  panX: number,
  panY: number,
  zoom: number
): { x: number; y: number } {
  const x = Math.floor((px - panX) / (cellSize * zoom));
  const y = Math.floor((py - panY) / (cellSize * zoom));
  return { x, y };
}

export function getRoomAtCell(
  dungeon: Dungeon,
  x: number,
  y: number
): number | null {
  if (x < 0 || y < 0 || x >= dungeon.width || y >= dungeon.height) {
    return null;
  }
  const row = dungeon.grid[y];
  if (!row) return null;
  const cell = row[x];
  if (!cell) return null;
  return cell.roomId;
}

// ─── OffscreenCanvas buffer ───────────────────────────────────────────────────

/**
 * Pre-render the full static layer stack onto an OffscreenCanvas (floor, walls,
 * grid, door symbols, stairs, glyphs, labels — everything but interactive
 * overlays). Callers blit it with drawImage() during pan/zoom for near-zero cost.
 *
 * `scale` multiplies the buffer's pixel resolution (e.g. devicePixelRatio ×
 * zoom bucket) while all drawing stays in world CSS-px coordinates; blit with
 * 9-arg drawImage back to `width*cellSize × height*cellSize` world units.
 */
export function buildDungeonBuffer(
  dungeon: Dungeon,
  opts: StaticLayerOptions,
  scale = 1,
): OffscreenCanvas {
  const { cellSize } = opts;
  const buf = new OffscreenCanvas(
    Math.ceil(dungeon.width * cellSize * scale),
    Math.ceil(dungeon.height * cellSize * scale),
  );
  const ctx = buf.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.scale(scale, scale);
  renderStaticLayers(ctx, dungeon, opts);
  return buf;
}

/**
 * Invalidate the cached floor Path2D for a dungeon.
 * Must be called after any in-place mutation of dungeon.grid so that the next
 * renderFloorPlan() call rebuilds the path rather than using the stale cached one.
 */
export function invalidateFloorPathCache(dungeon: Dungeon): void {
  floorPathCache.delete(dungeon);
}
