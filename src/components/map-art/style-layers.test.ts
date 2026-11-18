import { expect, test } from "bun:test";
import { withLayer } from "./style-layers.ts";

test("withLayer sets, replaces and removes one layer without touching the others", () => {
  const base = { floor: { asset: "f", cells: 8 }, rooms: { "0": { floor: { asset: "m", fit: true } } } };
  expect(withLayer(base, "background", { asset: "w", cells: 20 })).toEqual({ ...base, background: { asset: "w", cells: 20 } });
  expect(withLayer(base, "floor", { asset: "f", cells: 4 }).floor).toEqual({ asset: "f", cells: 4 });
  expect(withLayer(base, "room:0", undefined)).toEqual({ floor: { asset: "f", cells: 8 } });
  expect(withLayer(base, "floor", undefined)).toEqual({ rooms: base.rooms });
  expect(base.floor.cells).toBe(8);
});
