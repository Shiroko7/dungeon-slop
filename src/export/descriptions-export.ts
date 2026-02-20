import { jsPDF } from "jspdf";
import type { Dungeon, RoomDescription, DungeonDescription } from "../engine/types.ts";

function getDescriptions(
  dungeon: Dungeon,
  overrides: Map<number, RoomDescription>,
): Array<{ id: number; desc: RoomDescription }> {
  return dungeon.rooms
    .map((room) => {
      const desc = overrides.get(room.id) ?? room.description;
      return desc ? { id: room.id, desc } : null;
    })
    .filter((r): r is { id: number; desc: RoomDescription } => r !== null);
}

function descProse(desc: RoomDescription): string {
  return desc.features ?? desc.description ?? "";
}

function download(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Text ──────────────────────────────────────────────────────────────────────

export function exportDescriptionsText(
  dungeon: Dungeon,
  overrides: Map<number, RoomDescription>,
  dungeonDesc?: DungeonDescription | null,
): void {
  const rooms = getDescriptions(dungeon, overrides);
  if (rooms.length === 0 && !dungeonDesc) return;

  const lines: string[] = [`DUNGEON — Seed ${dungeon.seed} — ${dungeon.config.motif}`, ""];

  if (dungeonDesc) {
    lines.push("═══ GENERAL ═══", "");
    if (dungeonDesc.history) lines.push(`History: ${dungeonDesc.history}`, "");
    if (dungeonDesc.size) lines.push(`Size: ${dungeonDesc.size}`);
    if (dungeonDesc.walls) lines.push(`Walls: ${dungeonDesc.walls}`);
    if (dungeonDesc.floor) lines.push(`Floor: ${dungeonDesc.floor}`);
    if (dungeonDesc.temperature) lines.push(`Temperature: ${dungeonDesc.temperature}`);
    if (dungeonDesc.illumination) lines.push(`Illumination: ${dungeonDesc.illumination}`);
    if (dungeonDesc.corridorFeatures?.length) {
      lines.push("", "Corridor Features");
      for (const cf of dungeonDesc.corridorFeatures) {
        lines.push(`  ${cf.label}. ${cf.description}`);
      }
    }
    if (dungeonDesc.wanderingMonsters?.length) {
      lines.push("", "Wandering Monsters");
      for (const m of dungeonDesc.wanderingMonsters) lines.push(`  - ${m}`);
    }
    lines.push("");
  }

  for (const { desc } of rooms) {
    lines.push(`═══ ${desc.name} ═══`, "");
    if (desc.entries?.length) {
      lines.push("Entries");
      for (const e of desc.entries) {
        let entry = `  ${e.direction}: ${e.doorType} → ${e.leadsTo}`;
        if (e.trap) entry += ` [TRAP: ${e.trap}]`;
        lines.push(entry);
      }
      lines.push("");
    }
    const prose = descProse(desc);
    if (prose) { lines.push(prose, ""); }
    if (desc.empty) { lines.push("Empty room.", ""); }
    if (desc.monsters?.length) lines.push(`Monsters: ${desc.monsters.join("; ")}`);
    if (desc.treasure?.length) lines.push(`Treasure: ${desc.treasure.join("; ")}`);
    if (desc.hiddenTreasure) lines.push(`Hidden: ${desc.hiddenTreasure}`);
    if (desc.traps?.length) lines.push(`Traps: ${desc.traps.join("; ")}`);
    if (desc.tricks?.length) lines.push(`Tricks: ${desc.tricks.join("; ")}`);
    if (desc.notes) lines.push(`Notes: ${desc.notes}`);
    lines.push("");
  }

  download(lines.join("\n"), `dungeon-${dungeon.seed}-descriptions.txt`, "text/plain");
}

// ── JSON ──────────────────────────────────────────────────────────────────────

export function exportDescriptionsJSON(
  dungeon: Dungeon,
  overrides: Map<number, RoomDescription>,
  dungeonDesc?: DungeonDescription | null,
): void {
  const rooms = getDescriptions(dungeon, overrides);
  if (rooms.length === 0 && !dungeonDesc) return;

  const payload = {
    seed: dungeon.seed,
    motif: dungeon.config.motif,
    general: dungeonDesc ?? undefined,
    rooms: rooms.map(({ id, desc }) => ({ id, ...desc })),
  };

  download(
    JSON.stringify(payload, null, 2),
    `dungeon-${dungeon.seed}-descriptions.json`,
    "application/json",
  );
}

// ── Markdown ──────────────────────────────────────────────────────────────────

export function exportDescriptionsMarkdown(
  dungeon: Dungeon,
  overrides: Map<number, RoomDescription>,
  dungeonDesc?: DungeonDescription | null,
): void {
  const rooms = getDescriptions(dungeon, overrides);
  if (rooms.length === 0 && !dungeonDesc) return;

  const lines: string[] = [
    `# Dungeon Descriptions`,
    ``,
    `*Seed: ${dungeon.seed} · Motif: ${dungeon.config.motif}*`,
    ``,
  ];

  if (dungeonDesc) {
    lines.push(`## General`, ``);
    if (dungeonDesc.history) lines.push(`**History:** ${dungeonDesc.history}`, ``);
    const stats = [
      dungeonDesc.size && `**Size:** ${dungeonDesc.size}`,
      dungeonDesc.walls && `**Walls:** ${dungeonDesc.walls}`,
      dungeonDesc.floor && `**Floor:** ${dungeonDesc.floor}`,
      dungeonDesc.temperature && `**Temperature:** ${dungeonDesc.temperature}`,
      dungeonDesc.illumination && `**Illumination:** ${dungeonDesc.illumination}`,
    ].filter(Boolean) as string[];
    if (stats.length) { lines.push(...stats, ``); }
    if (dungeonDesc.corridorFeatures?.length) {
      lines.push(`**Corridor Features**`, ``);
      for (const cf of dungeonDesc.corridorFeatures) {
        lines.push(`- **${cf.label}.** ${cf.description}`);
      }
      lines.push(``);
    }
    if (dungeonDesc.wanderingMonsters?.length) {
      lines.push(`**Wandering Monsters**`, ``);
      for (const m of dungeonDesc.wanderingMonsters) lines.push(`- ${m}`);
      lines.push(``);
    }
    lines.push(`---`, ``);
  }

  for (const { desc } of rooms) {
    lines.push(`## ${desc.name}`, ``);
    if (desc.entries?.length) {
      lines.push(`**Entries**`, ``);
      for (const e of desc.entries) {
        let entry = `- **${e.direction}:** ${e.doorType} → ${e.leadsTo}`;
        if (e.trap) entry += ` *(Trap: ${e.trap})*`;
        lines.push(entry);
      }
      lines.push(``);
    }
    const prose = descProse(desc);
    if (prose) lines.push(prose, ``);
    if (desc.empty) lines.push(`*Empty room.*`, ``);
    if (desc.monsters?.length) {
      lines.push(`**Monsters**`, ``);
      for (const m of desc.monsters) lines.push(`- ${m}`);
      lines.push(``);
    }
    if (desc.treasure?.length) {
      lines.push(`**Treasure**`, ``);
      for (const t of desc.treasure) lines.push(`- ${t}`);
      lines.push(``);
    }
    if (desc.hiddenTreasure) lines.push(`**Hidden:** ${desc.hiddenTreasure}`, ``);
    if (desc.traps?.length) {
      lines.push(`**Traps**`, ``);
      for (const t of desc.traps) lines.push(`- ${t}`);
      lines.push(``);
    }
    if (desc.tricks?.length) {
      lines.push(`**Tricks**`, ``);
      for (const t of desc.tricks) lines.push(`- ${t}`);
      lines.push(``);
    }
    if (desc.notes) lines.push(`*Notes: ${desc.notes}*`, ``);
    lines.push(`---`, ``);
  }

  download(
    lines.join("\n"),
    `dungeon-${dungeon.seed}-descriptions.md`,
    "text/markdown",
  );
}

// ── PDF ───────────────────────────────────────────────────────────────────────

export function exportDescriptionsPDF(
  dungeon: Dungeon,
  overrides: Map<number, RoomDescription>,
  dungeonDesc?: DungeonDescription | null,
): void {
  const rooms = getDescriptions(dungeon, overrides);
  if (rooms.length === 0 && !dungeonDesc) return;

  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 15;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  function ensureSpace(needed: number): void {
    if (y + needed > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
  }

  function printLabel(label: string, value: string): void {
    ensureSpace(6);
    pdf.setFont("helvetica", "bold");
    const lw = pdf.getTextWidth(label + " ");
    pdf.text(label, margin, y);
    pdf.setFont("helvetica", "normal");
    const wrapped = pdf.splitTextToSize(value, maxWidth - lw) as string[];
    pdf.text(wrapped[0] ?? "", margin + lw, y);
    y += 5;
    for (let i = 1; i < wrapped.length; i++) {
      ensureSpace(5);
      pdf.text(wrapped[i]!, margin + lw, y);
      y += 5;
    }
  }

  function printBullets(items: string[], indent = 5): void {
    for (const item of items) {
      const wrapped = pdf.splitTextToSize(`• ${item}`, maxWidth - indent) as string[];
      ensureSpace(wrapped.length * 5 + 1);
      pdf.text(wrapped, margin + indent, y);
      y += wrapped.length * 5 + 1;
    }
  }

  // Title
  pdf.setFontSize(18);
  pdf.setFont("helvetica", "bold");
  pdf.text("Dungeon Descriptions", margin, y);
  y += 7;
  pdf.setFontSize(10);
  pdf.setFont("helvetica", "normal");
  pdf.setTextColor(120);
  pdf.text(`Seed: ${dungeon.seed}  ·  Motif: ${dungeon.config.motif}`, margin, y);
  pdf.setTextColor(0);
  y += 10;

  // General section
  if (dungeonDesc) {
    ensureSpace(10);
    pdf.setFontSize(14);
    pdf.setFont("helvetica", "bold");
    pdf.text("General", margin, y);
    y += 7;
    pdf.setFontSize(10);

    if (dungeonDesc.history) {
      const hl = pdf.splitTextToSize(dungeonDesc.history, maxWidth) as string[];
      ensureSpace(hl.length * 5 + 4);
      pdf.setFont("helvetica", "italic");
      pdf.text(hl, margin, y);
      pdf.setFont("helvetica", "normal");
      y += hl.length * 5 + 3;
    }
    if (dungeonDesc.size) { printLabel("Size:", dungeonDesc.size); }
    if (dungeonDesc.walls) { printLabel("Walls:", dungeonDesc.walls); }
    if (dungeonDesc.floor) { printLabel("Floor:", dungeonDesc.floor); }
    if (dungeonDesc.temperature) { printLabel("Temperature:", dungeonDesc.temperature); }
    if (dungeonDesc.illumination) { printLabel("Illumination:", dungeonDesc.illumination); }

    if (dungeonDesc.corridorFeatures?.length) {
      y += 3;
      ensureSpace(8);
      pdf.setFont("helvetica", "bold");
      pdf.text("Corridor Features", margin, y);
      y += 5;
      pdf.setFont("helvetica", "normal");
      for (const cf of dungeonDesc.corridorFeatures) {
        const cfLine = `${cf.label}. ${cf.description}`;
        const cfWrapped = pdf.splitTextToSize(cfLine, maxWidth - 2) as string[];
        ensureSpace(cfWrapped.length * 5 + 1);
        pdf.text(cfWrapped, margin + 2, y);
        y += cfWrapped.length * 5 + 1;
      }
    }

    if (dungeonDesc.wanderingMonsters?.length) {
      y += 3;
      ensureSpace(8);
      pdf.setFont("helvetica", "bold");
      pdf.text("Wandering Monsters", margin, y);
      y += 5;
      pdf.setFont("helvetica", "normal");
      printBullets(dungeonDesc.wanderingMonsters);
    }

    y += 6;
  }

  // Room sections
  for (const { desc } of rooms) {
    ensureSpace(20);

    pdf.setFontSize(13);
    pdf.setFont("helvetica", "bold");
    pdf.text(desc.name, margin, y);
    y += 6;
    pdf.setFontSize(10);

    if (desc.entries?.length) {
      pdf.setFont("helvetica", "bold");
      pdf.text("Entries", margin, y);
      y += 5;
      pdf.setFont("helvetica", "normal");
      for (const e of desc.entries) {
        let text = `${e.direction}: ${e.doorType} → ${e.leadsTo}`;
        if (e.trap) text += ` [Trap: ${e.trap}]`;
        const eLines = pdf.splitTextToSize(text, maxWidth - 5) as string[];
        ensureSpace(eLines.length * 5 + 1);
        pdf.text(eLines, margin + 5, y);
        y += eLines.length * 5 + 1;
      }
      y += 2;
    }

    const prose = descProse(desc);
    if (prose) {
      const dl = pdf.splitTextToSize(prose, maxWidth) as string[];
      ensureSpace(dl.length * 5 + 4);
      pdf.setFont("helvetica", "normal");
      pdf.text(dl, margin, y);
      y += dl.length * 5 + 2;
    }

    if (desc.monsters?.length) {
      ensureSpace(8);
      pdf.setFont("helvetica", "bold");
      pdf.text("Monsters", margin, y);
      y += 5;
      pdf.setFont("helvetica", "normal");
      printBullets(desc.monsters);
    }

    if (desc.treasure?.length) {
      ensureSpace(8);
      pdf.setFont("helvetica", "bold");
      pdf.text("Treasure", margin, y);
      y += 5;
      pdf.setFont("helvetica", "normal");
      printBullets(desc.treasure);
    }

    if (desc.hiddenTreasure) {
      ensureSpace(7);
      printLabel("Hidden:", desc.hiddenTreasure);
    }

    if (desc.traps?.length) {
      ensureSpace(8);
      pdf.setFont("helvetica", "bold");
      pdf.text("Traps", margin, y);
      y += 5;
      pdf.setFont("helvetica", "normal");
      printBullets(desc.traps);
    }

    if (desc.tricks?.length) {
      ensureSpace(8);
      pdf.setFont("helvetica", "bold");
      pdf.text("Tricks", margin, y);
      y += 5;
      pdf.setFont("helvetica", "normal");
      printBullets(desc.tricks);
    }

    if (desc.notes) {
      ensureSpace(8);
      pdf.setFont("helvetica", "normal");
      pdf.setTextColor(100);
      const nl = pdf.splitTextToSize(`Notes: ${desc.notes}`, maxWidth) as string[];
      ensureSpace(nl.length * 5);
      pdf.text(nl, margin, y);
      pdf.setTextColor(0);
      y += nl.length * 5;
    }

    y += 6;
  }

  pdf.save(`dungeon-${dungeon.seed}-descriptions.pdf`);
}
