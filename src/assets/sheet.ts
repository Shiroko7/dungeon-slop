/**
 * Review sheet: numbered thumbnails of several assets in one PNG. Transparent
 * assets sit on a checkerboard (or a flat colour) so their alpha is visible;
 * tiles are shown repeated 2×2 so a seam would show as a line through the middle.
 */
import { readFileSync } from "node:fs";
import type { AssetLibrary, AssetRecord } from "./library.ts";
import { checkerboard, decodePng, draw, drawNumber, encodePng, fit, raster, repeat, type Raster } from "./png.ts";

export type SheetBackground = "checker" | "parchment" | "white" | "black";

const FLAT: Record<Exclude<SheetBackground, "checker">, [number, number, number, number]> = {
  parchment: [236, 224, 196, 255],
  white: [255, 255, 255, 255],
  black: [24, 24, 24, 255],
};

export function contactSheet(library: AssetLibrary, assets: AssetRecord[], opts: { cell?: number; columns?: number; background?: SheetBackground } = {}): Uint8Array {
  const cell = opts.cell ?? 256;
  const gap = 8;
  const columns = Math.max(1, Math.min(opts.columns ?? 4, assets.length));
  const rows = Math.ceil(assets.length / columns);
  const sheet = raster(columns * (cell + gap) + gap, rows * (cell + gap) + gap, [60, 60, 60, 255]);
  const bg = opts.background ?? "checker";
  assets.forEach((a, i) => {
    const x = gap + (i % columns) * (cell + gap);
    const y = gap + Math.floor(i / columns) * (cell + gap);
    const back: Raster = bg === "checker" ? checkerboard(cell, cell, cell / 16) : raster(cell, cell, FLAT[bg]);
    draw(sheet, back, x, y);
    const img = decodePng(readFileSync(library.path(a)));
    const thumb = a.tileable ? fit(repeat(fit(img, cell), 2), cell) : fit(img, Math.round(cell * 0.92));
    draw(sheet, thumb, x + Math.floor((cell - thumb.width) / 2), y + Math.floor((cell - thumb.height) / 2));
    drawNumber(sheet, i + 1, x + 4, y + 4, 3);
  });
  return encodePng(sheet);
}
