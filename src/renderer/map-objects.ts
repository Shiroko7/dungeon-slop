/**
 * Objects placed on the map with the Stamp tool: drawing, measuring and
 * hit-testing. Coordinates are in grid cells; an object's height follows its
 * image's aspect ratio (square until the image has loaded).
 */
import type { Dungeon, MapObject } from "../engine/types.ts";
import { textureImage } from "./floor-textures.ts";

export interface ObjectBox {
  /** Centre, cells. */
  cx: number;
  cy: number;
  /** Full width and height, cells. */
  w: number;
  h: number;
  /** Radians clockwise. */
  angle: number;
}

/** Height ÷ width of an asset's image, 1 until it has loaded. */
export function assetAspect(asset: string): number {
  const img = textureImage(asset);
  return img && img.width > 0 ? img.height / img.width : 1;
}

export function objectBox(o: MapObject, aspect = assetAspect(o.asset)): ObjectBox {
  return { cx: o.x, cy: o.y, w: o.size, h: o.size * aspect, angle: ((o.rotation ?? 0) * Math.PI) / 180 };
}

/** Is the point (cells) inside the object's rotated box? */
export function containsPoint(box: ObjectBox, px: number, py: number): boolean {
  const dx = px - box.cx, dy = py - box.cy;
  const c = Math.cos(-box.angle), s = Math.sin(-box.angle);
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) <= box.w / 2 && Math.abs(ly) <= box.h / 2;
}

/** The topmost object under a point (cells), or undefined. */
export function objectAt(objects: readonly MapObject[], px: number, py: number, aspect: (asset: string) => number = assetAspect): MapObject | undefined {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i]!;
    if (containsPoint(objectBox(o, aspect(o.asset)), px, py)) return o;
  }
  return undefined;
}

/** The room whose floor is under the object's centre, or null (corridor, rock). */
export function objectRoomId(d: Dungeon, o: Pick<MapObject, "x" | "y">): number | null {
  return d.grid[Math.floor(o.y)]?.[Math.floor(o.x)]?.roomId ?? null;
}

/**
 * Draw one object. `ghost` draws it translucent (the stamp preview under the
 * cursor). Shadow sizes are in device pixels, so they are scaled by the
 * context's current transform to look the same at every zoom and export size.
 */
export function drawMapObject(ctx: CanvasRenderingContext2D, o: MapObject, cellSize: number, ghost = false): boolean {
  const img = textureImage(o.asset);
  if (!img) return false;
  const box = objectBox(o, img.height / img.width);
  const w = box.w * cellSize, h = box.h * cellSize;
  ctx.save();
  ctx.translate(box.cx * cellSize, box.cy * cellSize);
  ctx.rotate(box.angle);
  if (o.flipX) ctx.scale(-1, 1);
  ctx.globalAlpha = (o.opacity ?? 1) * (ghost ? 0.6 : 1);
  if (o.shadow !== false) {
    const t = ctx.getTransform();
    const px = Math.hypot(t.a, t.b);
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = cellSize * 0.35 * px;
    ctx.shadowOffsetX = cellSize * 0.12 * px;
    ctx.shadowOffsetY = cellSize * 0.18 * px;
  }
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  return true;
}

/** Draw every placed object, clipped to the floor so nothing spills over walls. */
export function drawMapObjects(ctx: CanvasRenderingContext2D, dungeon: Dungeon, cellSize: number, floorPath: Path2D): void {
  const objects = dungeon.style?.objects;
  if (!objects?.length) return;
  ctx.save();
  ctx.clip(floorPath, "nonzero");
  for (const o of objects) drawMapObject(ctx, o, cellSize);
  ctx.restore();
}

/** Selection frame around an object: dashed rotated box. */
export function drawObjectSelection(ctx: CanvasRenderingContext2D, o: MapObject, cellSize: number, color: string, lineWidth: number): void {
  const box = objectBox(o);
  ctx.save();
  ctx.translate(box.cx * cellSize, box.cy * cellSize);
  ctx.rotate(box.angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([lineWidth * 4, lineWidth * 3]);
  const pad = cellSize * 0.1;
  ctx.strokeRect(-box.w * cellSize / 2 - pad, -box.h * cellSize / 2 - pad, box.w * cellSize + 2 * pad, box.h * cellSize + 2 * pad);
  ctx.restore();
}
