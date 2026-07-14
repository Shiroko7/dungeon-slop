import type { DungeonConfig } from "../ai/schema.ts";
import type { Room } from "./types.ts";
import type { SeededRandom } from "../lib/random.ts";

export interface BSPNode {
  x: number;
  y: number;
  width: number;
  height: number;
  left: BSPNode | null;
  right: BSPNode | null;
  room: Room | null;
}

const SHAPE_MINIMUMS: Record<string, { w: number; h: number }> = {
  Circular:   { w: 7, h: 7 },
  Diamond:    { w: 5, h: 5 },
  Hexagonal:  { w: 7, h: 7 },
  Pentagonal: { w: 7, h: 7 },
  Cross:      { w: 9, h: 9 },
  Cave:       { w: 5, h: 5 },
};

// Room size expressed as fractions of the grid's smaller dimension.
// Calibrated so that at the default 50×50 grid the absolute cell counts
// match the previous fixed values (Tiny→3-5, Small→4-7, Medium→5-10,
// Large→8-15, Huge→12-20).
const ROOM_SIZE_FRACTIONS: Record<string, { min: number; max: number }> = {
  Tiny:   { min: 0.06, max: 0.10 },
  Small:  { min: 0.08, max: 0.14 },
  Medium: { min: 0.10, max: 0.20 },
  Large:  { min: 0.16, max: 0.30 },
  Huge:   { min: 0.24, max: 0.40 },
};

function getRoomSizeRange(sizeConfig: string, gridScale: number): { min: number; max: number } {
  const f = ROOM_SIZE_FRACTIONS[sizeConfig] ?? ROOM_SIZE_FRACTIONS["Medium"]!;
  return {
    min: Math.max(3, Math.round(f.min * gridScale)),
    max: Math.round(f.max * gridScale),
  };
}

function getDensityMargin(densityConfig: string): number {
  switch (densityConfig) {
    case "Sparse":
      return 0.4;
    case "Moderate":
      return 0.25;
    case "Dense":
      return 0.1;
    case "Exact":
      return 0.25; // Exact uses Moderate margin; user controls count separately
    default:
      return 0.25;
  }
}

function getRoomCountFromDensity(density: string, gridW: number, gridH: number): number {
  const area = gridW * gridH;
  const factor = density === "Sparse" ? 2000 : density === "Moderate" ? 1000 : 500;
  return Math.max(3, Math.min(50, Math.round(area / factor)));
}

function splitNode(
  node: BSPNode,
  minLeafSize: number,
  rng: SeededRandom,
): boolean {
  if (node.left !== null || node.right !== null) {
    return false;
  }

  const splitHorizontal =
    node.width > node.height
      ? false
      : node.height > node.width
        ? true
        : rng.chance(0.5);

  const maxSize = (splitHorizontal ? node.height : node.width) - minLeafSize;
  if (maxSize < minLeafSize) {
    return false;
  }

  const split = rng.nextInt(minLeafSize, maxSize);

  if (splitHorizontal) {
    node.left = {
      x: node.x,
      y: node.y,
      width: node.width,
      height: split,
      left: null,
      right: null,
      room: null,
    };
    node.right = {
      x: node.x,
      y: node.y + split,
      width: node.width,
      height: node.height - split,
      left: null,
      right: null,
      room: null,
    };
  } else {
    node.left = {
      x: node.x,
      y: node.y,
      width: split,
      height: node.height,
      left: null,
      right: null,
      room: null,
    };
    node.right = {
      x: node.x + split,
      y: node.y,
      width: node.width - split,
      height: node.height,
      left: null,
      right: null,
      room: null,
    };
  }

  return true;
}

function collectLeaves(node: BSPNode): BSPNode[] {
  if (node.left === null && node.right === null) {
    return [node];
  }
  const leaves: BSPNode[] = [];
  if (node.left !== null) {
    leaves.push(...collectLeaves(node.left));
  }
  if (node.right !== null) {
    leaves.push(...collectLeaves(node.right));
  }
  return leaves;
}

function applySymmetry(rooms: Room[], symmetry: string, gridW: number, gridH: number): void {
  const origCount = rooms.length;

  const makeRoom = (r: Room, x: number, y: number): Room => ({
    id: rooms.length,
    x,
    y,
    width: r.width,
    height: r.height,
    centerX: Math.floor(x + r.width / 2),
    centerY: Math.floor(y + r.height / 2),
    shape: r.shape,
    connections: [],
    features: [],
  });

  for (let i = 0; i < origCount; i++) {
    const r = rooms[i]!;
    const mx = gridW - r.x - r.width;
    const my = gridH - r.y - r.height;

    if (symmetry === "Horizontal") {
      rooms.push(makeRoom(r, mx, r.y));
    } else if (symmetry === "Vertical") {
      rooms.push(makeRoom(r, r.x, my));
    } else if (symmetry === "Radial") {
      rooms.push(makeRoom(r, mx, my));
    } else if (symmetry === "Four-Way") {
      rooms.push(makeRoom(r, mx, r.y));      // H-mirror
      rooms.push(makeRoom(r, r.x, my));      // V-mirror
      rooms.push(makeRoom(r, mx, my));       // HV-mirror
    }
  }
}

export function generateBSP(
  width: number,
  height: number,
  config: DungeonConfig,
  rng: SeededRandom,
): Room[] {
  const gridScale = Math.min(width, height);
  const sizeRange = getRoomSizeRange(config.room_size, gridScale);
  const targetCount = config.room_density === "Exact"
    ? (config.room_count ?? 10)
    : getRoomCountFromDensity(config.room_density, width, height);
  const densityMargin = getDensityMargin(config.room_density);
  const minLeafSize = sizeRange.min + 2;

  // Restrict root bounds to half the space for symmetric layouts so mirrored
  // rooms don't overlap the originals.
  let rootW = width - 2;
  let rootH = height - 2;
  if (config.symmetry === "Horizontal" || config.symmetry === "Four-Way") {
    rootW = Math.floor((width - 2) / 2);
  }
  if (config.symmetry === "Vertical" || config.symmetry === "Four-Way" || config.symmetry === "Radial") {
    rootH = Math.floor((height - 2) / 2);
  }

  const root: BSPNode = {
    x: 1,
    y: 1,
    width: rootW,
    height: rootH,
    left: null,
    right: null,
    room: null,
  };

  const nodesToSplit: BSPNode[] = [root];
  let splitAttempts = 0;
  const maxAttempts = 100;

  while (nodesToSplit.length > 0 && splitAttempts < maxAttempts) {
    const leaves = collectLeaves(root);
    if (leaves.length >= targetCount) {
      break;
    }

    const node = nodesToSplit.shift();
    if (node === undefined) break;

    splitAttempts++;
    if (splitNode(node, minLeafSize, rng)) {
      if (node.left !== null) nodesToSplit.push(node.left);
      if (node.right !== null) nodesToSplit.push(node.right);
    }
  }

  const leaves = collectLeaves(root);
  const rooms: Room[] = [];
  const eccentricity = config.room_eccentricity ?? 0.5;

  // Eccentricity range is computed from the GLOBAL sizeRange, not per-leaf.
  // eccentricity=0  → all rooms target the midpoint (uniform size)
  // eccentricity=1  → range extends from ABS_MIN up to sizeRange.max (dramatic variation)
  const ABS_MIN = 3;
  const globalMid = Math.floor((sizeRange.min + sizeRange.max) / 2);
  const eccentricLo = Math.max(ABS_MIN, Math.round(globalMid - (globalMid - ABS_MIN) * eccentricity));
  const eccentricHi = Math.round(globalMid + (sizeRange.max - globalMid) * eccentricity);

  for (let i = 0; i < leaves.length && i < targetCount; i++) {
    const leaf = leaves[i]!;

    // Room size: sampled from the eccentricity range, then clamped to what
    // physically fits in the leaf. Density margin does NOT restrict size here —
    // it only controls how the room is positioned within the leaf.
    const maxFitW = leaf.width - 2;
    const maxFitH = leaf.height - 2;
    if (maxFitW < 2 || maxFitH < 2) continue;

    const roomW = Math.max(2, Math.min(rng.nextInt(eccentricLo, Math.max(eccentricLo, eccentricHi)), maxFitW));
    const roomH = Math.max(2, Math.min(rng.nextInt(eccentricLo, Math.max(eccentricLo, eccentricHi)), maxFitH));

    // Density margin is positioning-only: how far from the leaf edge the room
    // can sit. If the room is large relative to the leaf, the margin shrinks
    // (room size wins, density only determines leftover spacing).
    const desiredMarginX = Math.max(1, Math.floor(leaf.width * densityMargin));
    const desiredMarginY = Math.max(1, Math.floor(leaf.height * densityMargin));
    const marginX = Math.min(desiredMarginX, Math.floor((leaf.width - roomW) / 2));
    const marginY = Math.min(desiredMarginY, Math.floor((leaf.height - roomH) / 2));

    const shapes = config.room_shapes ?? ["Rectangular"];
    const eligible = shapes.filter((s) => {
      const min = SHAPE_MINIMUMS[s];
      return min === undefined || (roomW >= min.w && roomH >= min.h);
    });
    const pool = eligible.length > 0 ? eligible : ["Rectangular"];
    const shape = pool[rng.nextInt(0, pool.length - 1)] ?? "Rectangular";

    // Cross and Square rooms must have equal width/height so their geometry
    // (cross arms, carved square) matches their stored bounding box exactly.
    // Re-center within the originally allocated space so placement stays valid.
    let finalW = roomW, finalH = roomH;
    if (shape === "Cross" || shape === "Square") {
      const s = Math.min(roomW, roomH);
      finalW = s;
      finalH = s;
    }

    // Placement uses the original bounding box (roomW × roomH) so the
    // squarification offset never pushes the room outside the leaf.
    const squarified = shape === "Cross" || shape === "Square";
    const maxX = leaf.x + leaf.width - roomW - marginX;
    const maxY = leaf.y + leaf.height - roomH - marginY;
    const baseX = rng.nextInt(leaf.x + marginX, Math.max(leaf.x + marginX, maxX));
    const baseY = rng.nextInt(leaf.y + marginY, Math.max(leaf.y + marginY, maxY));
    const finalX = squarified ? Math.floor(baseX + (roomW - finalW) / 2) : baseX;
    const finalY = squarified ? Math.floor(baseY + (roomH - finalH) / 2) : baseY;

    const room: Room = {
      id: rooms.length,
      x: finalX,
      y: finalY,
      width: finalW,
      height: finalH,
      centerX: Math.floor(finalX + finalW / 2),
      centerY: Math.floor(finalY + finalH / 2),
      shape,
      connections: [],
      features: [],
    };

    leaf.room = room;
    rooms.push(room);
  }

  if (config.symmetry !== "None") {
    applySymmetry(rooms, config.symmetry, width, height);
  }

  return rooms;
}
