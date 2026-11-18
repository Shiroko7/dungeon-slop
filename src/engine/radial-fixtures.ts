import type { Blueprint, BlueprintNode } from "../ai/blueprint.ts";

/**
 * Radial plans shared by the engine and renderer tests.
 *
 * The moon cycle is the plan the radial layout was built for: a round room at
 * the centre, four slices around it walked as a loop, and the last slice sealed
 * from the centre until the loop is done.
 */
export function moonCycle(): Blueprint {
  return {
    name: "Moon Cycle",
    layout: "radial",
    nodes: [
      { key: "vigil", name: "The Vigil", role: "entrance", tier: 0, size: "Medium", ring: 0 },
      { key: "unveiling", name: "The Unveiling", role: "gauntlet", tier: 1, size: "Large", ring: 1, sector: 0 },
      { key: "shards", name: "Hall of Shards", role: "gauntlet", tier: 2, size: "Large", ring: 1, sector: 1 },
      { key: "table", name: "The Table", role: "chokepoint", tier: 3, size: "Large", ring: 1, sector: 2 },
      { key: "cradle", name: "The Cradle", role: "boss", tier: 4, size: "Large", ring: 1, sector: 3 },
    ],
    edges: [
      { from: "vigil", to: "unveiling", door: "Portcullis" },
      { from: "unveiling", to: "shards" },
      { from: "shards", to: "table" },
      { from: "table", to: "vigil" },
      { from: "vigil", to: "cradle", gating: "all four phases of the moon" },
    ],
  };
}

/** A ring of `n` slices around a centre, each joined to the centre and its neighbour. */
export function ringOf(n: number, size: BlueprintNode["size"] = "Medium"): Blueprint {
  const nodes: BlueprintNode[] = [
    { key: "centre", name: "Centre", role: "entrance", tier: 0, size: "Medium", ring: 0 },
  ];
  const edges: Blueprint["edges"] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ key: `s${i}`, name: `Slice ${i}`, role: i === n - 1 ? "boss" : "chamber", tier: 1 + i, size, ring: 1 });
    edges.push({ from: "centre", to: `s${i}` });
    if (i > 0) edges.push({ from: `s${i - 1}`, to: `s${i}` });
  }
  return { name: `Ring of ${n}`, layout: "radial", nodes, edges };
}

/** Two rings: four inner slices, each opening onto the two outer slices it borders. */
export function twoRings(): Blueprint {
  const nodes: BlueprintNode[] = [
    { key: "core", name: "Core", role: "entrance", tier: 0, size: "Small", ring: 0 },
  ];
  const edges: Blueprint["edges"] = [];
  for (let i = 0; i < 4; i++) {
    nodes.push({ key: `in${i}`, name: `Inner ${i}`, role: "chamber", tier: 1, size: "Small", ring: 1, sector: i });
    edges.push({ from: "core", to: `in${i}` });
  }
  for (let i = 0; i < 8; i++) {
    nodes.push({ key: `out${i}`, name: `Outer ${i}`, role: i === 7 ? "boss" : "chamber", tier: 2, size: "Medium", ring: 2, sector: i });
    edges.push({ from: `in${Math.floor(i / 2)}`, to: `out${i}` });
  }
  return { name: "Two Rings", layout: "radial", nodes, edges };
}

/** Every radial fixture, labelled. */
export function radialPlans(): Array<[string, Blueprint]> {
  return [
    ["moon cycle", moonCycle()],
    ["ring of 2", ringOf(2)],
    ["ring of 3", ringOf(3)],
    ["ring of 6", ringOf(6, "Small")],
    ["ring of 8", ringOf(8, "Tiny")],
    ["two rings", twoRings()],
    ["lone slice", ringOf(1)],
  ];
}
