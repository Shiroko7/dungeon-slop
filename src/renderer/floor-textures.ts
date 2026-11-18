/**
 * Floor textures from the asset library, painted over the parchment floor.
 *
 * Rendering is synchronous, image loading is not: `textureImage` returns the
 * image once it has loaded and starts the load otherwise, and listeners
 * registered with `onTextureLoaded` hear when a rebuild would now show more.
 * Outside a browser (tests, server) nothing loads and floors stay parchment.
 */
import type { Dungeon, Room, TextureRef } from "../engine/types.ts";
import { isCaveShape } from "../engine/types.ts";
import { createRoomPath, getRoomGeometry } from "./room-shapes.ts";

type Loaded = CanvasImageSource & { width: number; height: number };

interface Box { x: number; y: number; w: number; h: number }

const images = new Map<string, Loaded | "loading" | "failed">();
/** Bounds of each image's visible (non-transparent) content, measured on load. */
const contentBoxes = new Map<string, Box>();
const listeners = new Set<() => void>();

export function textureUrl(asset: string): string {
  return `/api/assets/${encodeURIComponent(asset)}.png`;
}

export function onTextureLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function textureImage(asset: string): Loaded | undefined {
  const entry = images.get(asset);
  if (entry !== undefined) return typeof entry === "string" ? undefined : entry;
  if (typeof Image === "undefined") return undefined;
  images.set(asset, "loading");
  const img = new Image();
  img.onload = () => {
    images.set(asset, img);
    contentBoxes.set(asset, measureContent(img));
    for (const l of listeners) l();
  };
  img.onerror = () => images.set(asset, "failed");
  img.src = textureUrl(asset);
  return undefined;
}

/**
 * Library images keep a transparent margin around their content; fitting one
 * to a room must fit the content, or the margin shows as a ring of the floor
 * underneath between the art and the wall.
 */
function measureContent(img: HTMLImageElement): Box {
  const full = { x: 0, y: 0, w: img.width, h: img.height };
  if (typeof OffscreenCanvas === "undefined") return full;
  const c = new OffscreenCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  if (!ctx) return full;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (data[(y * img.width + x) * 4 + 3]! <= 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? full : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const resampledCache = new Map<string, Loaded>();

/** `img` scaled to px×px by repeated halving (a box filter, roughly). */
function resampled(asset: string, img: Loaded, px: number): Loaded {
  if (px >= img.width || typeof OffscreenCanvas === "undefined") return img;
  const key = `${asset}@${px}`;
  const hit = resampledCache.get(key);
  if (hit) return hit;
  let src: Loaded = img;
  let w = img.width, h = img.height;
  while (w > px) {
    w = Math.max(px, Math.floor(w / 2));
    h = Math.max(1, Math.round((img.height * w) / img.width));
    const c = new OffscreenCanvas(w, h);
    const cctx = c.getContext("2d");
    if (!cctx) return img;
    cctx.imageSmoothingQuality = "high";
    cctx.drawImage(src, 0, 0, w, h);
    src = c as unknown as Loaded;
  }
  if (resampledCache.size > 64) resampledCache.clear();
  resampledCache.set(key, src);
  return src;
}

/** Every texture a dungeon's style uses. */
export function styleTextures(dungeon: Dungeon): TextureRef[] {
  const style = dungeon.style;
  if (!style) return [];
  const refs = [style.floor, style.background, ...Object.values(style.rooms ?? {}).map((r) => r.floor)].filter((t): t is TextureRef => !!t?.asset);
  return [
    ...refs,
    ...refs.flatMap((r) => (r.blend ? [{ asset: r.blend.asset }] : [])),
    ...refs.flatMap((r) => (r.variants ?? []).filter((v) => v !== r.asset).map((asset) => ({ asset }))),
  ];
}

/**
 * Fill an area with a texture repeating every `cells` grid cells, anchored at
 * the world origin. Tiles from a copy resampled to the size one repeat has on
 * screen: a pattern minifies its source without mipmaps, which aliases into
 * shimmer that differs between the map buffer and the live canvas around it.
 */
function fillPattern(
  ctx: CanvasRenderingContext2D, asset: string, img: Loaded, cells: number, rotation: number, cellSize: number, area: Box,
  variants?: { ids: string[]; seed: number },
): void {
  const span = Math.max(0.25, cells) * cellSize;
  const t = ctx.getTransform();
  const scale = Math.hypot(t.a, t.b);
  const px = Math.max(8, Math.min(img.width, Math.round(span * scale)));
  if (variants && variants.ids.length > 1) {
    fillVariantTiles(ctx, variants.ids, variants.seed, span, px, rotation, area, scale);
    return;
  }
  const source = resampled(asset, img, px);
  const pattern = ctx.createPattern(source, "repeat");
  if (!pattern) return;
  if (typeof DOMMatrix !== "undefined") {
    pattern.setTransform(new DOMMatrix().rotate(rotation).scale(span / source.width, span / source.height));
  }
  ctx.fillStyle = pattern;
  ctx.fillRect(area.x, area.y, area.w, area.h);
}

/** Which variant (0..n-1) a tile position shows: a fixed hash, so the layout is stable. */
export function variantIndex(i: number, j: number, seed: number, n: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x2545f491);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % n;
}

/**
 * Tile an area one tile at a time, each tile a variant picked by position.
 * Variants share their edges, so neighbours join seamlessly; each is drawn a
 * hair larger than its slot so no background shows between them.
 */
function fillVariantTiles(ctx: CanvasRenderingContext2D, ids: string[], seed: number, span: number, px: number, rotation: number, area: Box, scale: number): void {
  const sources = ids.map((id) => {
    const im = textureImage(id);
    return im ? resampled(id, im, Math.max(8, Math.min(im.width, px))) : undefined;
  });
  const fallback = sources.find(Boolean);
  if (!fallback) return;
  ctx.save();
  ctx.rotate((rotation * Math.PI) / 180);
  // The area's corners in the rotated frame, to know which tiles cover it.
  const a = (-rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const corners = [[area.x, area.y], [area.x + area.w, area.y], [area.x, area.y + area.h], [area.x + area.w, area.y + area.h]]
    .map(([x, y]) => [x! * cos - y! * sin, x! * sin + y! * cos]);
  const xs = corners.map((c) => c[0]!), ys = corners.map((c) => c[1]!);
  const i0 = Math.floor(Math.min(...xs) / span), i1 = Math.floor(Math.max(...xs) / span);
  const j0 = Math.floor(Math.min(...ys) / span), j1 = Math.floor(Math.max(...ys) / span);
  const pad = 0.75 / scale;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const src = sources[variantIndex(i, j, seed, ids.length)] ?? fallback;
      ctx.drawImage(src, i * span - pad, j * span - pad, span + 2 * pad, span + 2 * pad);
    }
  }
  ctx.restore();
}

/**
 * Fill `area` (world px; callers clip it to its real shape) with a texture:
 * tiled with the pattern anchored at the world origin, or, with `fit`, one
 * image covering `box`. Then darken by `shade`.
 */
function fillTexture(ctx: CanvasRenderingContext2D, ref: TextureRef, cellSize: number, area: Box, box?: Box, frame?: RadialFrame): void {
  const img = textureImage(ref.asset);
  if (!img) return;
  if (ref.layout === "radial" && box && frame && !ref.fit) {
    fillRadial(ctx, ref, img, cellSize, box, frame);
  } else if (ref.fit && box) {
    // Cover the box with the image's content, centred, keeping its aspect ratio.
    const src = contentBoxes.get(ref.asset) ?? { x: 0, y: 0, w: img.width, h: img.height };
    const s = Math.max(box.w / src.w, box.h / src.h);
    const dw = src.w * s, dh = src.h * s;
    ctx.save();
    ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
    if (ref.rotation) ctx.rotate((ref.rotation * Math.PI) / 180);
    ctx.drawImage(img, src.x, src.y, src.w, src.h, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  } else {
    fillPattern(ctx, ref.asset, img, ref.cells ?? 4, ref.rotation ?? 0, cellSize, area,
      ref.variants && ref.variants.length > 1 ? { ids: ref.variants, seed: ref.variantSeed ?? 0 } : undefined);
  }
  const blend = ref.blend;
  const over = blend ? textureImage(blend.asset) : undefined;
  if (blend && over) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, blend.amount ?? 0.5));
    const mode = blend.mode ?? "soft-light";
    ctx.globalCompositeOperation = mode === "normal" ? "source-over" : mode;
    fillPattern(ctx, blend.asset, over, blend.cells ?? 24, 0, cellSize, area);
    ctx.restore();
  }
  const shade = Math.min(1, Math.max(0, ref.shade ?? 0));
  if (shade > 0) {
    ctx.fillStyle = `rgba(0,0,0,${shade})`;
    ctx.fillRect(area.x, area.y, area.w, area.h);
  }
}

/** The circle a room's radial layout bends around, in cells. */
export interface RadialFrame {
  cx: number;
  cy: number;
  /** Radius where the first course starts. */
  r0: number;
  /** Angle (radians) where the courses start. */
  a0: number;
  /** Radius at which a tile keeps its true proportions along the ring. */
  rMid: number;
}

/** A ring slice bends around its ring's centre; any other room around its own centre. */
export function radialFrame(room: Room): RadialFrame {
  const s = room.sector;
  if (s) return { cx: s.cx, cy: s.cy, r0: s.innerRadius, a0: s.startAngle, rMid: (s.innerRadius + s.outerRadius) / 2 };
  const radius = Math.max(room.width, room.height) / 2;
  return { cx: room.centerX + 0.5, cy: room.centerY + 0.5, r0: 0, a0: -Math.PI / 2, rMid: radius / 2 };
}

/**
 * Texture coordinates (in tiles) of a point (cells) under a radial layout:
 * v counts courses outward from r0, u runs along the ring, measured as arc
 * length at rMid so stones keep their shape mid-room and taper toward the
 * centre like real radial paving.
 */
export function radialUV(frame: RadialFrame, cells: number, stagger: number, px: number, py: number): { u: number; v: number } {
  const dx = px - frame.cx, dy = py - frame.cy;
  const r = Math.hypot(dx, dy);
  let theta = Math.atan2(dy, dx) - frame.a0;
  theta -= Math.floor(theta / (2 * Math.PI)) * 2 * Math.PI;
  return { u: (theta * frame.rMid) / cells + stagger, v: (r - frame.r0) / cells };
}

const radialCache = new Map<string, OffscreenCanvas>();

/**
 * Paint a room's box with the texture bent around its circle. Canvas patterns
 * only tile in straight lines, so this resamples per pixel (bilinear) into an
 * offscreen canvas at the device resolution, cached until anything it depends
 * on changes.
 */
function fillRadial(ctx: CanvasRenderingContext2D, ref: TextureRef, img: Loaded, cellSize: number, cellBox: Box, frame: RadialFrame): void {
  // The drawn outline can bulge past the room's cells along a curve; cover a cell more.
  const box = { x: cellBox.x - cellSize, y: cellBox.y - cellSize, w: cellBox.w + 2 * cellSize, h: cellBox.h + 2 * cellSize };
  if (typeof OffscreenCanvas === "undefined") return;
  const t = ctx.getTransform();
  const scale = Math.hypot(t.a, t.b);
  const W = Math.max(1, Math.ceil(box.w * scale)), H = Math.max(1, Math.ceil(box.h * scale));
  const cells = Math.max(0.25, ref.cells ?? 4);
  const stagger = ref.stagger ?? 0;
  // Variants: only the ones loaded so far take part; a rebuild follows each load.
  const ids = (ref.variants && ref.variants.length > 1 ? ref.variants : [ref.asset]).filter((id) => textureImage(id));
  if (ids.length === 0) ids.push(ref.asset);
  const seed = ref.variantSeed ?? 0;
  const key = [ids.join(","), seed, cells, stagger, W, H, box.x, box.y, box.w, frame.cx, frame.cy, frame.r0, frame.a0, frame.rMid, cellSize].join("|");
  let canvas = radialCache.get(key);
  if (!canvas) {
    const tilePx = Math.max(8, Math.min(img.width, Math.round(cells * cellSize * scale)));
    const datas: Uint8ClampedArray[] = [];
    let sw = 0, sh = 0;
    for (const id of ids) {
      const src = resampled(id, textureImage(id) ?? img, tilePx);
      const sc = new OffscreenCanvas(src.width, src.height);
      const sctx = sc.getContext("2d");
      if (!sctx) return;
      sctx.drawImage(src, 0, 0);
      sw = src.width;
      sh = src.height;
      datas.push(sctx.getImageData(0, 0, sw, sh).data);
    }
    canvas = new OffscreenCanvas(W, H);
    const octx = canvas.getContext("2d");
    if (!octx) return;
    const out = octx.createImageData(W, H);
    const od = out.data;
    for (let j = 0; j < H; j++) {
      const py = (box.y + ((j + 0.5) * box.h) / H) / cellSize;
      for (let i = 0; i < W; i++) {
        const px = (box.x + ((i + 0.5) * box.w) / W) / cellSize;
        const { u, v } = radialUV(frame, cells, stagger, px, py);
        // Bilinear sample, wrapping in both directions (variants share edges, so
        // wrapping within one variant equals stepping into its neighbour).
        const sd = datas.length > 1 ? datas[variantIndex(Math.floor(u), Math.floor(v), seed, datas.length)]! : datas[0]!;
        const fx = (u - Math.floor(u)) * sw - 0.5, fy = (v - Math.floor(v)) * sh - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const ax = fx - x0, ay = fy - y0;
        const xa = ((x0 % sw) + sw) % sw, xb = (xa + 1) % sw;
        const ya = ((y0 % sh) + sh) % sh, yb = (ya + 1) % sh;
        const o = (j * W + i) * 4;
        for (let c = 0; c < 3; c++) {
          const top = sd[(ya * sw + xa) * 4 + c]! * (1 - ax) + sd[(ya * sw + xb) * 4 + c]! * ax;
          const bot = sd[(yb * sw + xa) * 4 + c]! * (1 - ax) + sd[(yb * sw + xb) * 4 + c]! * ax;
          od[o + c] = top * (1 - ay) + bot * ay;
        }
        od[o + 3] = 255;
      }
    }
    octx.putImageData(out, 0, 0);
    if (radialCache.size > 24) radialCache.clear();
    radialCache.set(key, canvas);
  }
  ctx.drawImage(canvas, box.x, box.y, box.w, box.h);
}

/** The room's bounds in world px: its drawn shape's box, or its cells' box. */
function roomBox(dungeon: Dungeon, roomId: number, cellSize: number): Box | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  dungeon.grid.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell.roomId !== roomId) return;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
    }),
  );
  if (!Number.isFinite(x0)) return undefined;
  return { x: x0 * cellSize, y: y0 * cellSize, w: (x1 - x0) * cellSize, h: (y1 - y0) * cellSize };
}

function roomClip(dungeon: Dungeon, roomId: number, cellSize: number): Path2D | null {
  const room = dungeon.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const path = new Path2D();
  if (room.footprint !== undefined) {
    for (const p of room.footprint) path.rect(p.x * cellSize, p.y * cellSize, cellSize, cellSize);
  } else if (!isCaveShape(room.shape)) {
    path.addPath(createRoomPath(getRoomGeometry(room, cellSize)));
  } else {
    dungeon.grid.forEach((row, y) =>
      row.forEach((cell, x) => {
        if (cell.roomId === roomId) path.rect(x * cellSize, y * cellSize, cellSize, cellSize);
      }),
    );
  }
  return path;
}

/**
 * Paint the style's floor textures inside the floor. Call after the parchment
 * fill and before anything drawn on the floor (wall shading, grid, symbols).
 */
export function drawFloorTextures(ctx: CanvasRenderingContext2D, dungeon: Dungeon, cellSize: number, floorPath: Path2D): void {
  const style = dungeon.style;
  if (!style) return;
  const area = { x: 0, y: 0, w: dungeon.width * cellSize, h: dungeon.height * cellSize };
  if (style.floor) {
    ctx.save();
    ctx.clip(floorPath, "nonzero");
    fillTexture(ctx, style.floor, cellSize, area);
    ctx.restore();
  }
  for (const [id, room] of Object.entries(style.rooms ?? {})) {
    if (!room.floor) continue;
    const clip = roomClip(dungeon, Number(id), cellSize);
    if (!clip) continue;
    ctx.save();
    ctx.clip(floorPath, "nonzero");
    ctx.clip(clip, "nonzero");
    const r = dungeon.rooms.find((x) => x.id === Number(id));
    fillTexture(ctx, room.floor, cellSize, area, roomBox(dungeon, Number(id), cellSize), r ? radialFrame(r) : undefined);
    ctx.restore();
  }
}

/**
 * Fill a world-px rectangle with the style's background texture. The pattern
 * is anchored at the world origin, so the static buffer and the live canvas
 * around it (which call this with different rectangles) line up seamlessly.
 * Returns false when there is nothing to draw (yet).
 */
export function drawBackgroundTexture(
  ctx: CanvasRenderingContext2D, dungeon: Dungeon, cellSize: number,
  x: number, y: number, w: number, h: number,
): boolean {
  const ref = dungeon.style?.background;
  if (!ref || !textureImage(ref.asset)) return false;
  fillTexture(ctx, { ...ref, fit: false }, cellSize, { x, y, w, h });
  return true;
}

/** True when any texture is painted, so text on the floor needs a halo. */
export function hasFloorTexture(dungeon: Dungeon): boolean {
  return styleTextures(dungeon).length > 0;
}
