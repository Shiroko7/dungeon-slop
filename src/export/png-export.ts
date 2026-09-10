import type { Dungeon } from "../engine/types.ts";
import { FeatureType } from "../engine/types.ts";
import { renderDungeon } from "../renderer/canvas-renderer.ts";
import { getTheme } from "../renderer/themes/theme-engine.ts";
import { useUIStore } from "../store/ui-store.ts";

async function renderToCanvas(dungeon: Dungeon, cellSize: number): Promise<HTMLCanvasElement> {
  // Room labels use a webfont — ensure it's loaded before rasterizing
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = dungeon.width * cellSize;
  canvas.height = dungeon.height * cellSize;
  const ctx = canvas.getContext("2d")!;

  const hidden = new Set(useUIStore.getState().hiddenFeatureTypes) as ReadonlySet<FeatureType>;

  renderDungeon(ctx, dungeon, {
    cellSize,
    showGrid: true,
    theme: getTheme(dungeon.config.motif),
    selectedRoomId: null,
    hoveredRoomId: null,
    hiddenFeatureTypes: hidden,
  });

  return canvas;
}

/**
 * The same render, as a data URL, for sending to a model rather than to disk.
 *
 * Deliberately coarse: the critic is judging the SHAPE of the map — long empty
 * runs, clustering, rooms sitting oddly alone — and a print-resolution raster
 * of a 180-cell map is megabytes of tokens to say the same thing. The cell size
 * is scaled down so the longest edge lands near `maxPixels`.
 */
export async function renderDungeonDataUrl(dungeon: Dungeon, maxPixels = 1400): Promise<string> {
  const longest = Math.max(dungeon.width, dungeon.height);
  const cellSize = Math.max(3, Math.min(14, Math.floor(maxPixels / longest)));
  const canvas = await renderToCanvas(dungeon, cellSize);
  return canvas.toDataURL("image/png");
}

export async function exportPNG(dungeon: Dungeon, cellSize = 30): Promise<void> {
  const canvas = await renderToCanvas(dungeon, cellSize);

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dungeon-${dungeon.seed}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}
