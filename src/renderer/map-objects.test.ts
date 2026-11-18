import { describe, expect, test } from "bun:test";
import { containsPoint, objectAt, objectBox, objectRoomId } from "./map-objects.ts";
import type { Dungeon, MapObject } from "../engine/types.ts";

const obj = (id: string, x: number, y: number, size = 2, rotation = 0): MapObject => ({ id, asset: id, x, y, size, rotation });
const square = () => 1;

describe("map objects", () => {
  test("a box is centred on the object, sized in cells, height from the aspect", () => {
    expect(objectBox(obj("a", 5, 6, 4), 0.5)).toEqual({ cx: 5, cy: 6, w: 4, h: 2, angle: 0 });
  });

  test("hit-testing respects rotation", () => {
    const thin = objectBox(obj("a", 0, 0, 4), 0.25); // 4 wide, 1 tall
    expect(containsPoint(thin, 1.8, 0)).toBe(true);
    expect(containsPoint(thin, 0, 1.8)).toBe(false);
    const turned = objectBox(obj("a", 0, 0, 4, 90), 0.25); // now 1 wide, 4 tall
    expect(containsPoint(turned, 1.8, 0)).toBe(false);
    expect(containsPoint(turned, 0, 1.8)).toBe(true);
  });

  test("objectAt returns the topmost (last drawn) object", () => {
    const list = [obj("under", 5, 5, 4), obj("over", 6, 5, 4)];
    expect(objectAt(list, 5.5, 5, square)?.id).toBe("over");
    expect(objectAt(list, 3.5, 5, square)?.id).toBe("under");
    expect(objectAt(list, 20, 20, square)).toBeUndefined();
  });

  test("an object belongs to the room under its centre", () => {
    const grid = [[{ roomId: 3 }, { roomId: null }]];
    const d = { grid } as unknown as Dungeon;
    expect(objectRoomId(d, { x: 0.5, y: 0.5 })).toBe(3);
    expect(objectRoomId(d, { x: 1.5, y: 0.5 })).toBeNull();
    expect(objectRoomId(d, { x: 9, y: 9 })).toBeNull();
  });
});
