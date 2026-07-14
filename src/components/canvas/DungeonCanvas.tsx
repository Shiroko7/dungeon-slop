import { useRef, useEffect, useCallback, useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { SvgOverlay } from "./SvgOverlay.tsx";
import { RoomTooltip } from "./RoomTooltip.tsx";
import { CorridorTooltip } from "./CorridorTooltip.tsx";
import { EditToolPalette } from "./EditToolPalette.tsx";
import { EditEngine } from "../../engine/edit-engine.ts";
import type { EditTool } from "../../engine/edit-engine.ts";
import { CellType, FeatureType } from "../../engine/types.ts";
import type { Dungeon, Room } from "../../engine/types.ts";
import { getTheme, type ThemePalette } from "../../renderer/themes/theme-engine.ts";
import {
  renderFloorPlan,
  buildDungeonBuffer,
} from "../../renderer/canvas-renderer.ts";
import { getRoomGeometry, createRoomPath } from "../../renderer/room-shapes.ts";

const CELL_SIZE = 16;

// Per-tool overlay colors (stroke-in-progress and ghost-hover)
const TOOL_STROKE_COLORS: Record<EditTool, string> = {
  select:      "rgba(0,0,0,0)",
  floor:       "rgba(200,188,160,0.72)",
  corridor:    "rgba(175,165,140,0.72)",
  wall:        "rgba(90,85,75,0.80)",
  erase:       "rgba(210,55,55,0.55)",
  door:        "rgba(155,110,35,0.72)",
  stairs_up:   "rgba(70,125,65,0.72)",
  stairs_down: "rgba(125,65,65,0.72)",
};

const TOOL_GHOST_COLORS: Record<EditTool, string> = {
  select:      "rgba(0,0,0,0)",
  floor:       "rgba(200,188,160,0.38)",
  corridor:    "rgba(175,165,140,0.38)",
  wall:        "rgba(90,85,75,0.42)",
  erase:       "rgba(210,55,55,0.30)",
  door:        "rgba(155,110,35,0.38)",
  stairs_up:   "rgba(70,125,65,0.38)",
  stairs_down: "rgba(125,65,65,0.38)",
};

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

// ─── Rendering helpers ────────────────────────────────────────────────────────

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
    empty:        style.getPropertyValue("--cell-empty").trim()          || "#e8e2d6",
    floor:        style.getPropertyValue("--cell-floor").trim()          || "#d4c9b0",
    wall:         style.getPropertyValue("--cell-wall").trim()           || "#8a7e6c",
    corridor:     style.getPropertyValue("--cell-corridor").trim()       || "#c8bca2",
    door:         style.getPropertyValue("--cell-door").trim()           || "#a07830",
    secret:       style.getPropertyValue("--cell-secret").trim()         || "#7a6838",
    stairsUp:     style.getPropertyValue("--cell-stairs-up").trim()      || "#5a8a50",
    stairsDown:   style.getPropertyValue("--cell-stairs-down").trim()    || "#8a4a4a",
    grid:         style.getPropertyValue("--cell-grid").trim()           || "rgba(0,0,0,0.06)",
    select:       style.getPropertyValue("--cell-select").trim()         || "rgba(105,101,219,0.3)",
    selectStroke: style.getPropertyValue("--cell-select-stroke").trim()  || "rgba(105,101,219,0.8)",
    hover:        style.getPropertyValue("--cell-hover-highlight").trim()|| "rgba(105,101,219,0.18)",
    hoverStroke:  style.getPropertyValue("--cell-hover-stroke").trim()   || "rgba(105,101,219,0.6)",
    roomOutline:  style.getPropertyValue("--cell-room-outline").trim()   || "rgba(0,0,0,0.35)",
    doorInk:      style.getPropertyValue("--cell-door-ink").trim()       || "#1e1c18",
  };
}

// ─── Door cartographic symbols ────────────────────────────────────────────────

const DOOR_FEATURE_SET = new Set<FeatureType>([
  FeatureType.Door, FeatureType.LockedDoor, FeatureType.SecretDoor,
  FeatureType.Portcullis, FeatureType.Archway, FeatureType.TrappedDoor,
]);

function getDoorOrientation(dungeon: Dungeon, x: number, y: number): "ns" | "ew" {
  const north = dungeon.grid[y - 1]?.[x];
  const south = dungeon.grid[y + 1]?.[x];
  if ((north !== undefined && north.roomId !== null) ||
      (south !== undefined && south.roomId !== null)) return "ns";
  return "ew";
}

function drawDoorSymbol(
  ctx: CanvasRenderingContext2D,
  type: FeatureType,
  px: number,
  py: number,
  cs: number,
  orientation: "ns" | "ew",
  ink: string,
  spanCells = 1,
): void {
  const sw = Math.round(cs * 0.27);
  const sh = Math.round(cs * 0.5);
  const off = Math.round((cs - sh) / 2);
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;

  if (orientation === "ns") {
    const totalW = spanCells * cs;
    ctx.fillRect(px,               py + off, sw, sh);
    ctx.fillRect(px + totalW - sw, py + off, sw, sh);
    const x1 = px + sw, x2 = px + totalW - sw, midY = py + cs / 2;
    switch (type) {
      case FeatureType.Archway: break;
      case FeatureType.Portcullis: {
        ctx.lineWidth = 1; ctx.beginPath();
        const step = sh / 4;
        for (let i = 1; i <= 3; i++) { const ly = py + off + step * i; ctx.moveTo(x1, ly); ctx.lineTo(x2, ly); }
        ctx.stroke(); break;
      }
      case FeatureType.Door: ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x1, midY); ctx.lineTo(x2, midY); ctx.stroke(); break;
      case FeatureType.LockedDoor: {
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x1, midY); ctx.lineTo(x2, midY); ctx.stroke();
        ctx.beginPath(); ctx.arc((x1 + x2) / 2, midY, Math.max(1.5, cs * 0.12), 0, Math.PI * 2); ctx.fill(); break;
      }
      case FeatureType.TrappedDoor: {
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x1, midY); ctx.lineTo(x2, midY); ctx.stroke();
        const xs = cs * 0.14, cx = (x1 + x2) / 2;
        ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(cx - xs, midY - xs); ctx.lineTo(cx + xs, midY + xs);
        ctx.moveTo(cx + xs, midY - xs); ctx.lineTo(cx - xs, midY + xs);
        ctx.stroke(); break;
      }
      case FeatureType.SecretDoor:
        ctx.lineWidth = 1; ctx.setLineDash([2, 1.5]);
        ctx.beginPath(); ctx.moveTo(x1, midY); ctx.lineTo(x2, midY); ctx.stroke();
        ctx.setLineDash([]); break;
    }
  } else {
    const totalH = spanCells * cs;
    ctx.fillRect(px + off, py,               sh, sw);
    ctx.fillRect(px + off, py + totalH - sw, sh, sw);
    const y1 = py + sw, y2 = py + totalH - sw, midX = px + cs / 2;
    switch (type) {
      case FeatureType.Archway: break;
      case FeatureType.Portcullis: {
        ctx.lineWidth = 1; ctx.beginPath();
        const step = sh / 4;
        for (let i = 1; i <= 3; i++) { const lx = px + off + step * i; ctx.moveTo(lx, y1); ctx.lineTo(lx, y2); }
        ctx.stroke(); break;
      }
      case FeatureType.Door: ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(midX, y1); ctx.lineTo(midX, y2); ctx.stroke(); break;
      case FeatureType.LockedDoor: {
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(midX, y1); ctx.lineTo(midX, y2); ctx.stroke();
        ctx.beginPath(); ctx.arc(midX, (y1 + y2) / 2, Math.max(1.5, cs * 0.12), 0, Math.PI * 2); ctx.fill(); break;
      }
      case FeatureType.TrappedDoor: {
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(midX, y1); ctx.lineTo(midX, y2); ctx.stroke();
        const xs = cs * 0.14, cy = (y1 + y2) / 2;
        ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(midX - xs, cy - xs); ctx.lineTo(midX + xs, cy + xs);
        ctx.moveTo(midX + xs, cy - xs); ctx.lineTo(midX - xs, cy + xs);
        ctx.stroke(); break;
      }
      case FeatureType.SecretDoor:
        ctx.lineWidth = 1; ctx.setLineDash([2, 1.5]);
        ctx.beginPath(); ctx.moveTo(midX, y1); ctx.lineTo(midX, y2); ctx.stroke();
        ctx.setLineDash([]); break;
    }
  }
}

function drawDoorSymbols(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  inkColor: string,
  hidden: ReadonlySet<FeatureType> = new Set(),
): void {
  const featureCells = new Map<number, Array<{ x: number; y: number }>>();
  for (let y = 0; y < dungeon.height; y++) {
    const row = dungeon.grid[y];
    if (!row) continue;
    for (let x = 0; x < dungeon.width; x++) {
      const cell = row[x];
      if (!cell || cell.featureId === null) continue;
      if (cell.type !== CellType.Door && cell.type !== CellType.SecretDoor) continue;
      const fid = cell.featureId;
      if (!featureCells.has(fid)) featureCells.set(fid, []);
      featureCells.get(fid)!.push({ x, y });
    }
  }
  for (const feature of dungeon.features) {
    if (!DOOR_FEATURE_SET.has(feature.type)) continue;
    if (hidden.has(feature.type)) continue;
    const cells = featureCells.get(feature.id) ?? [{ x: feature.x, y: feature.y }];
    const sampleCell = cells[0] ?? { x: feature.x, y: feature.y };
    const orientation = getDoorOrientation(dungeon, sampleCell.x, sampleCell.y);
    let minX = feature.x, minY = feature.y;
    for (const c of cells) { if (c.x < minX) minX = c.x; if (c.y < minY) minY = c.y; }
    drawDoorSymbol(ctx, feature.type, minX * CELL_SIZE, minY * CELL_SIZE, CELL_SIZE, orientation, inkColor, cells.length);
  }
}

function drawRoomBorders(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  strokeStyle: string,
  lineWidth: number,
  filterRoomId?: number,
): void {
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
      const px = x * CELL_SIZE, py = y * CELL_SIZE;
      if (y === 0 || dungeon.grid[y - 1]?.[x]?.roomId !== rid) { ctx.moveTo(px, py); ctx.lineTo(px + CELL_SIZE, py); }
      if (y === dungeon.height - 1 || dungeon.grid[y + 1]?.[x]?.roomId !== rid) { ctx.moveTo(px, py + CELL_SIZE); ctx.lineTo(px + CELL_SIZE, py + CELL_SIZE); }
      if (x === 0 || row[x - 1]?.roomId !== rid) { ctx.moveTo(px, py); ctx.lineTo(px, py + CELL_SIZE); }
      if (x === dungeon.width - 1 || row[x + 1]?.roomId !== rid) { ctx.moveTo(px + CELL_SIZE, py); ctx.lineTo(px + CELL_SIZE, py + CELL_SIZE); }
    }
  }
  ctx.stroke();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DungeonCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Pan state
  const isDragging = useRef(false);
  const dragStart  = useRef({ x: 0, y: 0 });

  // Dungeon buffer
  const dungeonBuffer    = useRef<OffscreenCanvas | null>(null);
  const dungeonBufferFor = useRef<Dungeon | null>(null);
  const bufferScaleRef   = useRef(1);
  // Canvas viewport: CSS size + devicePixelRatio (backing store is device px)
  const viewRef          = useRef({ cssW: 0, cssH: 0, dpr: 1 });
  const cellColorsRef    = useRef<CellColors>(getCellColors());
  const themeRef         = useRef<ThemePalette>(getTheme("Default"));
  const rafHandle        = useRef<number>(0);
  const hiddenSetRef     = useRef<Set<FeatureType>>(new Set());

  // Edit mode
  const editEngineRef       = useRef(new EditEngine());
  const hoverGridCellRef    = useRef<{ x: number; y: number } | null>(null);
  const isSpaceHeld         = useRef(false);
  const prevToolBeforeSpace = useRef<EditTool | null>(null);

  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // ── Store subscriptions ───────────────────────────────────────────────────
  const dungeon           = useDungeonStore((s) => s.dungeon);
  const hoveredRoomId     = useUIStore((s) => s.hoveredRoomId);
  const hoveredCorridorId = useUIStore((s) => s.hoveredCorridorId);
  const darkMode          = useUIStore((s) => s.darkMode);
  const editMode          = useUIStore((s) => s.editMode);

  useEffect(() => { cellColorsRef.current = getCellColors(); }, [darkMode]);
  useEffect(() => { if (dungeon) themeRef.current = getTheme(dungeon.config.motif); }, [dungeon, darkMode]);

  // ── OffscreenCanvas buffer ─────────────────────────────────────────────────
  useEffect(() => {
    if (!dungeon) { dungeonBuffer.current = null; dungeonBufferFor.current = null; return; }
    const theme = getTheme(dungeon.config.motif);
    const scale = window.devicePixelRatio || 1;
    dungeonBuffer.current = buildDungeonBuffer(dungeon, CELL_SIZE, theme, scale);
    bufferScaleRef.current = scale;
    dungeonBufferFor.current = dungeon;
  }, [dungeon]);

  // ── Resize canvas (backing store in device px, layout stays CSS-driven) ───
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const cssW = entry.contentRect.width;
      const cssH = entry.contentRect.height;
      const dpr = window.devicePixelRatio || 1;
      const box = entry.devicePixelContentBoxSize?.[0];
      const dw = box ? box.inlineSize : Math.round(cssW * dpr);
      const dh = box ? box.blockSize  : Math.round(cssH * dpr);
      canvas.width  = dw;
      canvas.height = dh;
      viewRef.current = { cssW, cssH, dpr: cssW > 0 ? dw / cssW : dpr };
      useUIStore.getState().setCanvasSize(cssW, cssH);
    });
    // device-pixel-content-box also fires on devicePixelRatio changes
    try {
      observer.observe(container, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(container);
    }
    return () => observer.disconnect();
  }, []);

  // ── RAF rendering loop ─────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = editEngineRef;
    const hoverCell = hoverGridCellRef;

    const frame = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) { rafHandle.current = requestAnimationFrame(frame); return; }

      const {
        panX, panY, zoom,
        hoveredRoomId, hoveredCorridorId, selectedRoomId,
        hiddenFeatureTypes,
        editMode: isEditing,
        activeTool,
        roomIdInspectMode,
      } = useUIStore.getState();

      const d = useDungeonStore.getState().dungeon;

      // DPR can change without a resize event (window moved across monitors)
      const dpr = window.devicePixelRatio || 1;
      const view = viewRef.current;
      if (dpr !== view.dpr && view.cssW > 0) {
        canvas.width  = Math.round(view.cssW * dpr);
        canvas.height = Math.round(view.cssH * dpr);
        view.dpr = dpr;
      }
      const cssW = view.cssW || canvas.width / view.dpr;
      const cssH = view.cssH || canvas.height / view.dpr;
      // All drawing below happens in CSS-px coordinates on a device-px store
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

      if (!d) {
        ctx.clearRect(0, 0, cssW, cssH);
        rafHandle.current = requestAnimationFrame(frame);
        return;
      }

      // Rebuild the buffer if DPR changed since it was built
      if (dungeonBuffer.current && bufferScaleRef.current !== view.dpr) {
        dungeonBuffer.current = buildDungeonBuffer(d, CELL_SIZE, themeRef.current, view.dpr);
        bufferScaleRef.current = view.dpr;
        dungeonBufferFor.current = d;
      }

      const theme  = themeRef.current;
      const colors = cellColorsRef.current;
      hiddenSetRef.current.clear();
      for (const t of hiddenFeatureTypes) hiddenSetRef.current.add(t);
      const hidden = hiddenSetRef.current;

      ctx.fillStyle = theme.wall;
      ctx.fillRect(0, 0, cssW, cssH);

      ctx.save();
      ctx.translate(panX, panY);
      ctx.scale(zoom, zoom);

      // Blit the static pre-rendered buffer (fast GPU drawImage).
      // The buffer is rendered at bufferScale× resolution; map it back to
      // world CSS-px size so the transform stays scale-agnostic.
      if (dungeonBuffer.current) {
        const buf = dungeonBuffer.current;
        ctx.drawImage(
          buf,
          0, 0, buf.width, buf.height,
          0, 0, d.width * CELL_SIZE, d.height * CELL_SIZE,
        );
      } else {
        renderFloorPlan(ctx, d, CELL_SIZE, theme, false);
      }

      drawDoorSymbols(ctx, d, colors.doorInk, hidden);

      // RoomID inspect overlay — paint every room-owned cell with a stable
      // per-roomId color so grid ownership is visible at a glance.
      if (roomIdInspectMode) {
        for (let y = 0; y < d.height; y++) {
          const row = d.grid[y]; if (!row) continue;
          for (let x = 0; x < d.width; x++) {
            const cell = row[x];
            if (!cell || cell.roomId === null) continue;
            // Golden-angle hue distribution → maximally distinct colors per ID
            const hue = (cell.roomId * 137.508) % 360;
            ctx.fillStyle = `hsla(${hue},68%,52%,0.55)`;
            ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
          }
        }
      }

      if (isEditing && activeTool !== "select") {
        // ── Edit mode overlay (painting tools) ───────────────────────────────
        const strokeColor = TOOL_STROKE_COLORS[activeTool];
        const ghostColor  = TOOL_GHOST_COLORS[activeTool];
        const cs = CELL_SIZE;

        // Draw active stroke cells
        if (engine.current.isPainting) {
          ctx.fillStyle = strokeColor;
          for (const { x, y } of engine.current.activeStroke) {
            ctx.fillRect(x * cs, y * cs, cs, cs);
          }
        }

        // Draw ghost cell at hover position (when not actively painting)
        const hover = hoverCell.current;
        if (hover && !engine.current.isPainting) {
          ctx.fillStyle = ghostColor;
          ctx.fillRect(hover.x * cs, hover.y * cs, cs, cs);
          ctx.strokeStyle = theme.ink;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 2]);
          ctx.strokeRect(hover.x * cs + 0.5, hover.y * cs + 0.5, cs - 1, cs - 1);
          ctx.setLineDash([]);
        }
      }

      // ── Hover + selection — shown in normal mode and select-tool edit mode ──
      if (!isEditing || activeTool === "select") {
        // Hover: room
        if (hoveredRoomId !== null && hoveredRoomId !== selectedRoomId) {
          ctx.fillStyle = colors.hover;
          const hovRoom = d.rooms.find((r) => r.id === hoveredRoomId);
          if (hovRoom && hovRoom.shape !== "Cave") {
            ctx.fill(createRoomPath(getRoomGeometry(hovRoom, CELL_SIZE)));
          } else {
            for (let y = 0; y < d.height; y++) {
              const row = d.grid[y]; if (!row) continue;
              for (let x = 0; x < d.width; x++) {
                const cell = row[x];
                if (cell && cell.roomId === hoveredRoomId) ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
              }
            }
            drawRoomBorders(ctx, d, colors.hoverStroke, 2, hoveredRoomId);
          }
        }

        // Hover: corridor
        if (hoveredCorridorId !== null) {
          ctx.fillStyle = "rgba(220,175,40,0.28)";
          for (let y = 0; y < d.height; y++) {
            const row = d.grid[y]; if (!row) continue;
            for (let x = 0; x < d.width; x++) {
              const cell = row[x];
              if (cell && cell.corridorId === hoveredCorridorId) ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            }
          }
        }

        // Selection
        if (selectedRoomId !== null) {
          ctx.fillStyle = colors.select;
          const selRoom = d.rooms.find((r) => r.id === selectedRoomId);
          if (selRoom && selRoom.shape !== "Cave") {
            ctx.fill(createRoomPath(getRoomGeometry(selRoom, CELL_SIZE)));
          } else {
            for (let y = 0; y < d.height; y++) {
              const row = d.grid[y]; if (!row) continue;
              for (let x = 0; x < d.width; x++) {
                const cell = row[x];
                if (cell && cell.roomId === selectedRoomId) ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
              }
            }
            drawRoomBorders(ctx, d, colors.selectStroke, 2.5, selectedRoomId);
          }
        }
      }

      ctx.restore();
      rafHandle.current = requestAnimationFrame(frame);
    };

    rafHandle.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafHandle.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mouse handlers ────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { panX, panY, zoom, editMode: isEditing, activeTool, setEditLockedRoomId } = useUIStore.getState();

    if (isEditing) {
      if (activeTool === "select") {
        // Select tool: pan, same as normal mode
        isDragging.current = true;
        dragStart.current  = { x: e.clientX - panX, y: e.clientY - panY };
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { x, y } = screenToGrid(e.clientX - rect.left, e.clientY - rect.top, panX, panY, zoom);
      const { dungeon } = useDungeonStore.getState();
      if (!dungeon || x < 0 || y < 0 || x >= dungeon.width || y >= dungeon.height) return;

      if (activeTool === "floor") {
        const cell = dungeon.grid[y]?.[x];
        setEditLockedRoomId(cell?.roomId ?? null);
      } else {
        setEditLockedRoomId(null);
      }

      editEngineRef.current.startStroke(x, y, activeTool);
      return;
    }

    // Normal mode: pan
    isDragging.current = true;
    dragStart.current  = { x: e.clientX - panX, y: e.clientY - panY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect    = canvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    const { panX, panY, zoom, editMode: isEditing, activeTool, setHoveredRoomId, setHoveredCorridorId, setPan } = useUIStore.getState();

    if (isEditing) {
      const { x, y } = screenToGrid(canvasX, canvasY, panX, panY, zoom);
      hoverGridCellRef.current = { x, y };

      if (activeTool === "select") {
        if (isDragging.current) {
          setPan(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y);
          return;
        }
        // Hover detection — identical to normal mode
        const { dungeon: d } = useDungeonStore.getState();
        if (d) {
          const room = findRoomAtPosition(d, canvasX, canvasY, panX, panY, zoom);
          setHoveredRoomId(room?.id ?? null);
          const cid = room ? null : findCorridorAtPosition(d, canvasX, canvasY, panX, panY, zoom);
          setHoveredCorridorId(cid);
          setTooltipPos(room || cid !== null ? { x: e.clientX, y: e.clientY } : null);
        }
        return;
      }

      if (editEngineRef.current.isPainting) {
        const { dungeon } = useDungeonStore.getState();
        if (dungeon && x >= 0 && y >= 0 && x < dungeon.width && y < dungeon.height) {
          editEngineRef.current.extendStroke(x, y);
        }
      }
      return;
    }

    // Normal mode
    if (isDragging.current) {
      setPan(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y);
      return;
    }

    const { dungeon } = useDungeonStore.getState();
    if (!dungeon) return;
    const room = findRoomAtPosition(dungeon, canvasX, canvasY, panX, panY, zoom);
    setHoveredRoomId(room?.id ?? null);
    const cid = room ? null : findCorridorAtPosition(dungeon, canvasX, canvasY, panX, panY, zoom);
    setHoveredCorridorId(cid);
    setTooltipPos(room || cid !== null ? { x: e.clientX, y: e.clientY } : null);
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { panX, panY, zoom, editMode: isEditing, activeTool, setSelectedRoomId, setEditLockedRoomId } = useUIStore.getState();

    if (isEditing) {
      if (activeTool === "select") {
        isDragging.current = false;
        return;
      }
      if (editEngineRef.current.isPainting) {
        editEngineRef.current.commitStroke();
        setEditLockedRoomId(null);
      }
      return;
    }

    // Normal mode: click-to-select
    const wasDragging  = isDragging.current;
    isDragging.current = false;

    if (wasDragging) {
      const dx = Math.abs(e.clientX - (dragStart.current.x + panX));
      const dy = Math.abs(e.clientY - (dragStart.current.y + panY));
      if (dx > 3 || dy > 3) return;
    }

    const { dungeon } = useDungeonStore.getState();
    if (!dungeon) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const room = findRoomAtPosition(dungeon, e.clientX - rect.left, e.clientY - rect.top, panX, panY, zoom);
    setSelectedRoomId(room?.id ?? null);
  }, []);

  const handleMouseLeave = useCallback(() => {
    const { editMode: isEditing, activeTool, setHoveredRoomId, setHoveredCorridorId, setEditLockedRoomId } = useUIStore.getState();

    hoverGridCellRef.current = null;

    if (isEditing) {
      if (activeTool === "select") {
        isDragging.current = false;
        setHoveredRoomId(null);
        setHoveredCorridorId(null);
        setTooltipPos(null);
        return;
      }
      if (editEngineRef.current.isPainting) {
        editEngineRef.current.commitStroke();
        setEditLockedRoomId(null);
      }
      return;
    }

    isDragging.current = false;
    setHoveredRoomId(null);
    setHoveredCorridorId(null);
    setTooltipPos(null);
  }, []);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      // Multiplicative, anchored at the cursor: the grid point under the
      // pointer stays fixed while zooming.
      useUIStore.getState().zoomAtAnchor(
        e.clientX - rect.left,
        e.clientY - rect.top,
        Math.exp(-e.deltaY * 0.0012),
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ── Spacebar: temporary pan mode ──────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      e.preventDefault(); // prevent page scroll
      if (e.repeat || isSpaceHeld.current) return;
      const { editMode, activeTool, setActiveTool } = useUIStore.getState();
      if (!editMode || activeTool === "select") return;
      isSpaceHeld.current = true;
      prevToolBeforeSpace.current = activeTool;
      setActiveTool("select");
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !isSpaceHeld.current) return;
      isSpaceHeld.current = false;
      const prev = prevToolBeforeSpace.current;
      prevToolBeforeSpace.current = null;
      isDragging.current = false;
      if (prev) useUIStore.getState().setActiveTool(prev);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Active tool data-attribute (drives CSS cursor) ────────────────────────
  const activeTool         = useUIStore((s) => s.activeTool);
  const roomIdInspectMode  = useUIStore((s) => s.roomIdInspectMode);
  const toggleRoomIdInspectMode = useUIStore((s) => s.toggleRoomIdInspectMode);

  return (
    <div
      ref={containerRef}
      className="dungeon-canvas-wrapper"
      data-tool={editMode ? activeTool : undefined}
    >
      <canvas
        ref={canvasRef}
        className="dungeon-canvas"
        style={editMode && activeTool !== "select" ? { cursor: "crosshair" } : undefined}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
      {dungeon && (!editMode || activeTool === "select") && <SvgOverlay />}
      {editMode && dungeon && <EditToolPalette />}
      {dungeon && (
        <button
          className={`roomid-inspect-toggle${roomIdInspectMode ? " roomid-inspect-toggle--active" : ""}`}
          onClick={toggleRoomIdInspectMode}
          title={roomIdInspectMode
            ? "RoomID inspect ON — hover highlights all cells sharing the same roomId\nClick to restore normal hover"
            : "Click to enable RoomID inspect mode\nHover a room to see its exact grid ownership"}
        >
          RoomId
        </button>
      )}
      {(!editMode || activeTool === "select") && hoveredRoomId !== null && tooltipPos && (
        <RoomTooltip position={tooltipPos} roomId={hoveredRoomId} />
      )}
      {(!editMode || activeTool === "select") && hoveredCorridorId !== null && tooltipPos && (
        <CorridorTooltip position={tooltipPos} corridorId={hoveredCorridorId} />
      )}
    </div>
  );
}
