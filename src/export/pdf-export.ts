import { jsPDF } from "jspdf";
import type { Dungeon } from "../engine/types.ts";
import { FeatureType } from "../engine/types.ts";
import { renderDungeon } from "../renderer/canvas-renderer.ts";
import { getTheme } from "../renderer/themes/theme-engine.ts";
import { useUIStore } from "../store/ui-store.ts";

export async function exportPDF(dungeon: Dungeon): Promise<void> {
  const cellSize = 20;
  // Room labels use a webfont — ensure it's loaded before rasterizing
  await document.fonts.ready;

  const hidden = new Set(useUIStore.getState().hiddenFeatureTypes) as ReadonlySet<FeatureType>;

  // Render map to offscreen canvas
  const canvas = document.createElement("canvas");
  canvas.width = dungeon.width * cellSize;
  canvas.height = dungeon.height * cellSize;
  const ctx = canvas.getContext("2d")!;
  renderDungeon(ctx, dungeon, {
    cellSize,
    showGrid: true,
    theme: getTheme(dungeon.config.motif),
    selectedRoomId: null,
    hoveredRoomId: null,
    hiddenFeatureTypes: hidden,
  });

  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  // Page 1: Map
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 10;
  const availWidth = pageWidth - 2 * margin;
  const availHeight = pageHeight - 2 * margin;
  const scale = Math.min(availWidth / canvas.width, availHeight / canvas.height);
  const imgW = canvas.width * scale;
  const imgH = canvas.height * scale;

  pdf.addImage(imgData, "PNG", margin, margin, imgW, imgH);

  // Page 2+: Room Key
  pdf.addPage("a4", "portrait");
  const textPageWidth = pdf.internal.pageSize.getWidth();
  let yPos = 20;

  pdf.setFontSize(18);
  pdf.text("Room Key", 15, yPos);
  yPos += 12;

  for (const room of dungeon.rooms) {
    if (yPos > 270) {
      pdf.addPage();
      yPos = 20;
    }

    pdf.setFontSize(12);
    pdf.setFont("helvetica", "bold");
    const name = room.description?.name ?? `Room ${room.id}`;
    pdf.text(name, 15, yPos);
    yPos += 6;

    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    const desc = room.description?.description ?? "No description";
    const lines: string[] = pdf.splitTextToSize(desc, textPageWidth - 30);
    pdf.text(lines, 15, yPos);
    yPos += lines.length * 5 + 4;

    if (room.description?.monsters?.length) {
      pdf.setFont("helvetica", "italic");
      pdf.text(`Monsters: ${room.description.monsters.join(", ")}`, 15, yPos);
      yPos += 6;
    }

    if (room.description?.treasure?.length) {
      pdf.setFont("helvetica", "italic");
      pdf.text(`Treasure: ${room.description.treasure.join(", ")}`, 15, yPos);
      yPos += 6;
    }

    yPos += 4;
  }

  pdf.save(`dungeon-${dungeon.seed}.pdf`);
}
