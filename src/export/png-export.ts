import type { Dungeon } from "../engine/types.ts";
import { FeatureType } from "../engine/types.ts";
import { renderDungeon } from "../renderer/canvas-renderer.ts";
import { getTheme } from "../renderer/themes/theme-engine.ts";
import { useUIStore } from "../store/ui-store.ts";

export function exportPNG(dungeon: Dungeon, cellSize = 30): void {
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
