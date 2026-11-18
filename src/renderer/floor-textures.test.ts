import { describe, expect, test } from "bun:test";
import { hasFloorTexture, radialFrame, radialUV, styleTextures, textureImage, textureUrl } from "./floor-textures.ts";
import { ASSET_ID } from "../api/assets.ts";
import type { Dungeon, Room } from "../engine/types.ts";

const bare = { rooms: [], grid: [], width: 0, height: 0 } as unknown as Dungeon;

describe("floor textures", () => {
  test("styleTextures lists the map floor, the background and every room override", () => {
    expect(styleTextures(bare)).toEqual([]);
    expect(hasFloorTexture(bare)).toBe(false);
    const styled: Dungeon = {
      ...bare,
      style: { floor: { asset: "floor-a-1" }, background: { asset: "floor-water-3" }, rooms: { "0": { floor: { asset: "decal-b-2", fit: true } }, "1": {} } },
    };
    expect(styleTextures(styled).map((t) => t.asset)).toEqual(["floor-a-1", "floor-water-3", "decal-b-2"]);
    expect(hasFloorTexture(styled)).toBe(true);
  });

  test("outside a browser nothing loads, so floors stay parchment", () => {
    expect(textureImage("floor-a-1")).toBeUndefined();
  });

  test("asset URLs only ever carry a slug id", () => {
    expect(textureUrl("floor-sunken-temple-24e8db")).toBe("/api/assets/floor-sunken-temple-24e8db.png");
    expect(ASSET_ID.test("floor-sunken-temple-24e8db")).toBe(true);
    for (const bad of ["../x", "a/b", "A-B", "-a", "a--b", "a.png", ""]) expect(ASSET_ID.test(bad)).toBe(false);
  });
});

describe("radial layout", () => {
  const frame = { cx: 10, cy: 10, r0: 4, a0: 0, rMid: 6 };

  test("courses count outward from the inner radius", () => {
    expect(radialUV(frame, 2, 0, 14, 10).v).toBeCloseTo(0);
    expect(radialUV(frame, 2, 0, 18, 10).v).toBeCloseTo(2);
  });

  test("u runs along the ring as arc length at the middle radius, plus stagger", () => {
    // A quarter turn at rMid 6 is 3π cells = 3π/2 tiles of 2 cells.
    expect(radialUV(frame, 2, 0, 10, 16).u).toBeCloseTo((Math.PI / 2) * 6 / 2);
    expect(radialUV(frame, 2, 0.25, 16, 10).u).toBeCloseTo(0.25);
    // Same angle, different radius: same u (joints run out from the centre).
    expect(radialUV(frame, 2, 0, 10, 13).u).toBeCloseTo(radialUV(frame, 2, 0, 10, 19).u);
  });

  test("a ring slice bends around its ring's centre", () => {
    const room = { sector: { cx: 36.5, cy: 36.5, innerRadius: 13.75, outerRadius: 29.75, startAngle: 0, endAngle: 1.57, inset: 0.6 } } as unknown as Room;
    expect(radialFrame(room)).toEqual({ cx: 36.5, cy: 36.5, r0: 13.75, a0: 0, rMid: 21.75 });
  });
});
