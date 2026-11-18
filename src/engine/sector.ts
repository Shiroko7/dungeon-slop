/**
 * A slice of a ring: the space between two concentric circles, cut off by two
 * straight walls.
 *
 * The walls are the radial lines at `startAngle` and `endAngle`, each moved
 * `inset` cells into the slice. Two neighbouring slices therefore sit
 * `2 * inset` apart along their whole shared edge - a wall of constant
 * thickness, the way a mason would build it, rather than a wedge of rock that
 * widens with the radius.
 *
 * Everything is in grid units. Angles are radians in screen space (y down), so
 * an increasing angle turns clockwise on the map and 0 points east. A slice is
 * at most half a turn: beyond that the two walls stop bounding a wedge.
 *
 * Carving and drawing both come from here, so the cells a slice owns and the
 * outline the map draws cannot disagree.
 */

export interface SectorGeometry {
  cx: number;
  cy: number;
  innerRadius: number;
  outerRadius: number;
  startAngle: number;
  endAngle: number;
  /** Distance each side wall is moved into the slice. */
  inset: number;
}

type Pt = { x: number; y: number };

export function pointInSector(s: SectorGeometry, px: number, py: number): boolean {
  const dx = px - s.cx;
  const dy = py - s.cy;
  const r2 = dx * dx + dy * dy;
  if (r2 < s.innerRadius * s.innerRadius || r2 > s.outerRadius * s.outerRadius) return false;
  // Inward normals of the two side walls.
  const fromStart = -Math.sin(s.startAngle) * dx + Math.cos(s.startAngle) * dy;
  const fromEnd = Math.sin(s.endAngle) * dx - Math.cos(s.endAngle) * dy;
  return fromStart >= s.inset && fromEnd >= s.inset;
}

/**
 * Where the side walls meet a circle of radius r, as angles on that circle.
 *
 * A wall offset by `inset` from the radial line meets the circle `asin(inset/r)`
 * further round than the line itself does.
 */
export function sectorArcAngles(s: SectorGeometry, r: number): { from: number; to: number } {
  const shift = Math.asin(Math.min(1, s.inset / r));
  return { from: s.startAngle + shift, to: s.endAngle - shift };
}

/** Points along an arc, both ends included, plus every axis extreme it passes. */
function arcPoints(s: SectorGeometry, r: number, from: number, to: number, step: number): Pt[] {
  const angles = new Set<number>([from, to]);
  const n = Math.max(1, Math.ceil(((to - from) * r) / step));
  for (let i = 1; i < n; i++) angles.add(from + ((to - from) * i) / n);
  for (let k = Math.ceil(from / (Math.PI / 2)); k * (Math.PI / 2) <= to; k++) angles.add(k * (Math.PI / 2));
  return [...angles]
    .sort((a, b) => a - b)
    .map((a) => ({ x: s.cx + r * Math.cos(a), y: s.cy + r * Math.sin(a) }));
}

/**
 * The slice's outline as a closed ring of points: outer arc clockwise, inner arc
 * back. `step` is the longest chord along an arc, in grid units.
 */
export function sectorOutline(s: SectorGeometry, step = 0.5): Pt[] {
  const outer = sectorArcAngles(s, s.outerRadius);
  const inner = sectorArcAngles(s, s.innerRadius);
  const pts = [
    ...arcPoints(s, s.outerRadius, outer.from, outer.to, step),
    ...arcPoints(s, s.innerRadius, inner.from, inner.to, step).reverse(),
  ];
  return [...pts, { ...pts[0]! }];
}

/** The smallest whole-cell rectangle that holds the slice. */
export function sectorBounds(s: SectorGeometry): { x: number; y: number; width: number; height: number } {
  const pts = sectorOutline(s);
  const minX = Math.floor(Math.min(...pts.map((p) => p.x)) + 1e-9);
  const minY = Math.floor(Math.min(...pts.map((p) => p.y)) + 1e-9);
  const maxX = Math.ceil(Math.max(...pts.map((p) => p.x)) - 1e-9);
  const maxY = Math.ceil(Math.max(...pts.map((p) => p.y)) - 1e-9);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Every cell whose centre lies inside the slice, as "x,y" keys. */
export function carveSector(s: SectorGeometry): Set<string> {
  const b = sectorBounds(s);
  const cells = new Set<string>();
  for (let y = b.y; y < b.y + b.height; y++) {
    for (let x = b.x; x < b.x + b.width; x++) {
      if (pointInSector(s, x + 0.5, y + 0.5)) cells.add(`${x},${y}`);
    }
  }
  return cells;
}

/**
 * The cell a label or a "centre" should use.
 *
 * Not the middle of the bounding box: for a slice of a ring that point is often
 * in the hole, or in the room next door. This is the cell the slice owns nearest
 * its mid-radius, mid-angle point.
 */
export function sectorAnchorCell(s: SectorGeometry, cells: Set<string>): Pt {
  const mid = (s.startAngle + s.endAngle) / 2;
  const r = (s.innerRadius + s.outerRadius) / 2;
  const tx = s.cx + r * Math.cos(mid);
  const ty = s.cy + r * Math.sin(mid);
  let best: Pt = { x: Math.floor(tx), y: Math.floor(ty) };
  let bestD = Infinity;
  for (const key of cells) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    const d = (x + 0.5 - tx) ** 2 + (y + 0.5 - ty) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { x, y };
    }
  }
  return best;
}
