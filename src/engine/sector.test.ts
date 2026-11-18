import { describe, test, expect } from "bun:test";
import {
  carveSector,
  pointInSector,
  sectorAnchorCell,
  sectorBounds,
  sectorOutline,
  type SectorGeometry,
} from "./sector.ts";

const quarter = (slot: number, inset = 0.625): SectorGeometry => ({
  cx: 20.5,
  cy: 20.5,
  innerRadius: 5.75,
  outerRadius: 14.75,
  startAngle: -Math.PI / 2 + (slot * Math.PI) / 2,
  endAngle: -Math.PI / 2 + ((slot + 1) * Math.PI) / 2,
  inset,
});

describe("ring slices", () => {
  test("the outline is the boundary the containment test uses", () => {
    // Nudged toward the slice's middle, every outline point is inside; nudged
    // away from it, outside.
    const s = quarter(1);
    const mid = (s.startAngle + s.endAngle) / 2;
    const r = (s.innerRadius + s.outerRadius) / 2;
    const m = { x: s.cx + r * Math.cos(mid), y: s.cy + r * Math.sin(mid) };
    for (const p of sectorOutline(s)) {
      const dx = m.x - p.x;
      const dy = m.y - p.y;
      const len = Math.hypot(dx, dy);
      expect(pointInSector(s, p.x + (dx / len) * 0.01, p.y + (dy / len) * 0.01)).toBe(true);
      expect(pointInSector(s, p.x - (dx / len) * 0.05, p.y - (dy / len) * 0.05)).toBe(false);
    }
  });

  test("every carved cell and the whole outline lie inside the bounds", () => {
    for (let slot = 0; slot < 4; slot++) {
      const s = quarter(slot);
      const b = sectorBounds(s);
      for (const key of carveSector(s)) {
        const [x, y] = key.split(",").map(Number) as [number, number];
        expect(x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height).toBe(true);
      }
      for (const p of sectorOutline(s)) {
        expect(p.x >= b.x - 1e-9 && p.x <= b.x + b.width + 1e-9).toBe(true);
        expect(p.y >= b.y - 1e-9 && p.y <= b.y + b.height + 1e-9).toBe(true);
      }
    }
  });

  test("neighbouring slices never share a cell edge", () => {
    const cells = [0, 1, 2, 3].map((slot) => carveSector(quarter(slot)));
    const touching: string[] = [];
    cells.forEach((own, i) => {
      for (const key of own) {
        const [x, y] = key.split(",").map(Number) as [number, number];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const n = `${x + dx},${y + dy}`;
          cells.forEach((other, j) => {
            if (j !== i && other.has(n)) touching.push(`${key} / ${n}`);
          });
        }
      }
    });
    expect(touching).toEqual([]);
  });

  test("the anchor is a cell the slice owns", () => {
    for (let slot = 0; slot < 4; slot++) {
      const s = quarter(slot);
      const cells = carveSector(s);
      const a = sectorAnchorCell(s, cells);
      expect(cells.has(`${a.x},${a.y}`)).toBe(true);
    }
  });

  test("a half-turn slice is still bounded by its two walls", () => {
    const half: SectorGeometry = { ...quarter(0), startAngle: -Math.PI / 2, endAngle: Math.PI / 2 };
    expect(pointInSector(half, half.cx + 10, half.cy)).toBe(true);
    expect(pointInSector(half, half.cx - 10, half.cy)).toBe(false);
  });
});
