import type { Dungeon } from "../engine/types.ts";
import { renderDungeon } from "../renderer/canvas-renderer.ts";
import { getTheme } from "../renderer/themes/theme-engine.ts";
import { dungeonToUVTT } from "./uvtt.ts";

/**
 * Download the map as a Universal VTT file (`.dd2vtt`): the rendered map image
 * plus walls and doors from `dungeonToUVTT`. The image needs a canvas, so this
 * runs in the browser; the server serves the same geometry without art.
 */
export async function exportVTT(dungeon: Dungeon): Promise<void> {
  const pxPerGrid = 140;
  // Room labels use a webfont — ensure it's loaded before rasterizing
  await document.fonts.ready;

  const canvas = document.createElement("canvas");
  canvas.width = dungeon.width * pxPerGrid;
  canvas.height = dungeon.height * pxPerGrid;
  const ctx = canvas.getContext("2d")!;
  renderDungeon(ctx, dungeon, {
    cellSize: pxPerGrid,
    showGrid: false,
    theme: getTheme(dungeon.config.motif),
    selectedRoomId: null,
    hoveredRoomId: null,
  });

  const image = canvas.toDataURL("image/png").split(",")[1] ?? "";
  const vtt = dungeonToUVTT(dungeon, { image, pixelsPerGrid: pxPerGrid });

  const blob = new Blob([JSON.stringify(vtt)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dungeon-${dungeon.seed}.dd2vtt`;
  a.click();
  URL.revokeObjectURL(url);
}
