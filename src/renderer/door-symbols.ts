import { CellType, FeatureType } from "../engine/types.ts";
import type { Dungeon } from "../engine/types.ts";

// ─── Door cartographic symbols ────────────────────────────────────────────────
//
// Doors render as two ink jamb blocks flanking the opening plus a type-specific
// mark (leaf line, lock dot, trap cross, portcullis bars, dashed secret line).
// Rendering is orientation-aware and spans multi-cell (wide) door features.

export const DOOR_FEATURE_SET = new Set<FeatureType>([
  FeatureType.Door, FeatureType.LockedDoor, FeatureType.SecretDoor,
  FeatureType.Portcullis, FeatureType.Archway, FeatureType.TrappedDoor,
]);

export function getDoorOrientation(dungeon: Dungeon, x: number, y: number): "ns" | "ew" {
  const north = dungeon.grid[y - 1]?.[x];
  const south = dungeon.grid[y + 1]?.[x];
  if ((north !== undefined && north.roomId !== null) ||
      (south !== undefined && south.roomId !== null)) return "ns";
  return "ew";
}

export function drawDoorSymbol(
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

export function drawDoorSymbols(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  cellSize: number,
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
    drawDoorSymbol(ctx, feature.type, minX * cellSize, minY * cellSize, cellSize, orientation, inkColor, cells.length);
  }
}
