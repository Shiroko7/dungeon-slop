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

function getDensityMargin(layoutConfig: string): number {
  switch (layoutConfig) {
    case "Sparse":
      return 0.4;
    case "Moderate":
      return 0.25;
    case "Dense":
      return 0.1;
    default:
      return 0.25;
  }
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

export function generateBSP(
  width: number,
  height: number,
  config: DungeonConfig,
  rng: SeededRandom,
): Room[] {
  const gridScale = Math.min(width, height);
  const sizeRange = getRoomSizeRange(config.room_size, gridScale);
  const targetCount = config.room_count;
  const densityMargin = getDensityMargin(config.room_layout);
  const minLeafSize = sizeRange.min + 2;

  const root: BSPNode = {
    x: 1,
    y: 1,
    width: width - 2,
    height: height - 2,
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

  for (let i = 0; i < leaves.length && i < targetCount; i++) {
    const leaf = leaves[i]!;

    const marginX = Math.max(1, Math.floor(leaf.width * densityMargin));
    const marginY = Math.max(1, Math.floor(leaf.height * densityMargin));

    const maxRoomW = Math.min(sizeRange.max, leaf.width - marginX * 2);
    const maxRoomH = Math.min(sizeRange.max, leaf.height - marginY * 2);
    const minRoomW = Math.min(sizeRange.min, maxRoomW);
    const minRoomH = Math.min(sizeRange.min, maxRoomH);

    if (minRoomW < 2 || minRoomH < 2) continue;

    const roomW = rng.nextInt(minRoomW, maxRoomW);
    const roomH = rng.nextInt(minRoomH, maxRoomH);

    const maxX = leaf.x + leaf.width - roomW - marginX;
    const maxY = leaf.y + leaf.height - roomH - marginY;
    const roomX = rng.nextInt(leaf.x + marginX, Math.max(leaf.x + marginX, maxX));
    const roomY = rng.nextInt(leaf.y + marginY, Math.max(leaf.y + marginY, maxY));

    const shapes = config.room_shapes ?? ["Rectangular"];
    const eligible = shapes.filter((s) => {
      const min = SHAPE_MINIMUMS[s];
      return min === undefined || (roomW >= min.w && roomH >= min.h);
    });
    const pool = eligible.length > 0 ? eligible : ["Rectangular"];
    const shape = pool[rng.nextInt(0, pool.length - 1)] ?? "Rectangular";

    const room: Room = {
      id: rooms.length,
      x: roomX,
      y: roomY,
      width: roomW,
      height: roomH,
      centerX: Math.floor(roomX + roomW / 2),
      centerY: Math.floor(roomY + roomH / 2),
      shape,
      connections: [],
      features: [],
    };

    leaf.room = room;
    rooms.push(room);
  }

  return rooms;
}
