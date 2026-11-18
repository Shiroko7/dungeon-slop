import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alphaStats, decodePng, encodePng, knockOutPaper, raster, resize, seamScore, trimToContent, fillRect, type Raster } from "./png.ts";
import { KINDS, composePrompt, type Kind } from "./presets.ts";
import { buildWorkflow, modelsFor, nodesFor } from "./workflows.ts";
import { AssetLibrary } from "./library.ts";
import { checkImage } from "./generate.ts";
import { cloudTexture } from "./procedural.ts";
import { blendLook, closeDarkLines, stainMap } from "./blend.ts";
import { compositeVariant, edgesMatch, matchColour, variantMask } from "./variants.ts";
import { cloudVariant } from "./procedural.ts";
import { variantIndex } from "../renderer/floor-textures.ts";
import { contactSheet } from "./sheet.ts";

function pixel(r: Raster, x: number, y: number): number[] {
  const i = (y * r.width + x) * 4;
  return [...r.data.subarray(i, i + 4)];
}

/** Horizontal gradient: wraps badly in x (dark left edge meets bright right edge). */
function gradient(w: number, h: number): Raster {
  const r = raster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) r.data.set([Math.round((x / (w - 1)) * 255), 0, 0, 255], (y * w + x) * 4);
  return r;
}

/** A pattern that wraps perfectly: one sine period across each axis. */
function periodic(w: number, h: number): Raster {
  const r = raster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 128 + 100 * Math.sin((2 * Math.PI * x) / w) * Math.cos((2 * Math.PI * y) / h);
      r.data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return r;
}

describe("png", () => {
  test("encode/decode round-trips RGBA", () => {
    const r = raster(5, 3, [10, 20, 30, 40]);
    r.data.set([1, 2, 3, 255], 0);
    const back = decodePng(encodePng(r));
    expect(back.width).toBe(5);
    expect(back.height).toBe(3);
    expect([...back.data]).toEqual([...r.data]);
  });

  test("alphaStats finds the content box, edge contact and an opaque border", () => {
    const r = raster(100, 100);
    fillRect(r, 30, 40, 20, 10, [0, 0, 0, 255]);
    const s = alphaStats(r);
    expect(s.bbox).toEqual({ x: 30, y: 40, width: 20, height: 10 });
    expect(s.touchesEdge).toBe(false);
    expect(s.borderOpaque).toBe(0);
    expect(s.opaque).toBeCloseTo(0.02);

    const full = raster(10, 10, [255, 255, 255, 255]);
    expect(alphaStats(full).touchesEdge).toBe(true);
    expect(alphaStats(full).borderOpaque).toBe(1);
    expect(alphaStats(raster(4, 4)).bbox).toBeNull();
  });

  test("trimToContent crops to the content plus a margin", () => {
    const r = raster(100, 100);
    fillRect(r, 30, 40, 20, 10, [0, 0, 0, 255]);
    const t = trimToContent(r, 0.1);
    expect(t.width).toBe(24);
    expect(t.height).toBe(14);
    expect(pixel(t, 2, 2)[3]).toBe(255);
    expect(pixel(t, 0, 0)[3]).toBe(0);
  });

  test("seamScore tells a wrapping pattern from one that does not wrap", () => {
    // The sine seam sits where its slope is steepest, so it scores about pi/2:
    // still under the warning threshold of 2.
    const good = seamScore(periodic(64, 64));
    expect(good.x).toBeLessThan(2);
    expect(good.y).toBeLessThan(2);
    expect(seamScore(gradient(64, 64)).x).toBeGreaterThan(10);
  });

  test("resize averages with premultiplied alpha (no dark fringe)", () => {
    const r = raster(2, 1);
    r.data.set([255, 255, 255, 255], 0); // white, opaque
    r.data.set([0, 0, 0, 0], 4); // black, transparent: must not darken
    const out = resize(r, 1, 1);
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255, 128]);
  });

  test("knockOutPaper makes white transparent and keeps black ink", () => {
    const r = raster(3, 1);
    r.data.set([255, 255, 255, 255], 0);
    r.data.set([0, 0, 0, 255], 4);
    r.data.set([138, 138, 138, 255], 8);
    const k = knockOutPaper(r);
    expect(pixel(k, 0, 0)[3]).toBe(0);
    expect(pixel(k, 1, 0)[3]).toBe(255);
    expect(pixel(k, 2, 0)[3]).toBeGreaterThan(60);
    expect(pixel(k, 2, 0)[3]).toBeLessThan(200);
  });
});

describe("prompts", () => {
  test("transparent kinds carry Qwen's RGBA framing; tiles do not", () => {
    for (const kind of Object.keys(KINDS) as Kind[]) {
      const p = composePrompt({ kind, subject: "a barrel.", style: "painted", motif: "Default" });
      const rgba = p.startsWith("This is an RGBA format image with transparency.") && p.endsWith("The image has an alpha channel and a transparent background.");
      expect(rgba).toBe(KINDS[kind].alpha);
      expect(p).toContain("a barrel");
      expect(p).not.toContain("..");
    }
  });

  test("ink paper fill is for solid things only, motif text is added", () => {
    const prop = composePrompt({ kind: "prop", subject: "a chest", style: "ink", motif: "Frozen" });
    const decal = composePrompt({ kind: "decal", subject: "moss", style: "ink", motif: "Default" });
    expect(prop).toContain("opaque");
    expect(prop).toContain("Frozen theme");
    expect(decal).not.toContain("inside the object's outline is opaque");
    expect(composePrompt({ kind: "prop", subject: "a chest", style: "painted", motif: "Default" })).not.toContain("white paper");
  });
});

describe("workflows", () => {
  for (const kind of ["sprite", "tile"] as const) {
    test(`${kind}: every link points at a node that exists`, () => {
      const wf = buildWorkflow(kind, { prompt: "x", seed: 5, width: 1000, height: 700, prefix: "p" });
      for (const node of Object.values(wf)) {
        for (const v of Object.values(node.inputs)) {
          if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "number") expect(wf[v[0]]).toBeDefined();
        }
      }
      expect(wf.latent!.inputs).toMatchObject({ width: 992, height: 704 });
      expect(wf.noise!.inputs.noise_seed).toBe(5);
      const classes = Object.values(wf).map((n) => n.class_type);
      for (const n of nodesFor(kind)) expect(classes).toContain(n);
      for (const m of modelsFor(kind)) expect(JSON.stringify(wf)).toContain(m.file);
    });
  }

  test("tiles roll the latent and decode on a torus; sprites use the turbo LoRA", () => {
    const tile = buildWorkflow("tile", { prompt: "x", seed: 1, width: 1024, height: 1024, prefix: "p", tiling: "x_only" });
    expect(tile.roll!.inputs.tiling).toBe("x_only");
    expect(tile.decode!.class_type).toBe("DslopWrapDecode");
    expect(tile.decode!.inputs.tiling).toBe("x_only");
    expect(tile.turbo).toBeUndefined();
    const sprite = buildWorkflow("sprite", { prompt: "x", seed: 1, width: 1024, height: 1024, prefix: "p" });
    expect(sprite.turbo!.class_type).toBe("LoraLoaderModelOnly");
    expect(sprite.roll).toBeUndefined();
  });
});

describe("checkImage", () => {
  test("flags an unremoved background, cut-off content and a visible seam", () => {
    expect(checkImage(KINDS.prop, { borderOpaque: 0.9, touchesEdge: true, empty: false })[0]).toContain("background");
    expect(checkImage(KINDS.prop, { borderOpaque: 0.1, touchesEdge: true, empty: false })[0]).toContain("cut off");
    expect(checkImage(KINDS.prop, { borderOpaque: 0, touchesEdge: false, empty: false })).toEqual([]);
    expect(checkImage(KINDS.floor, { seam: { x: 3, y: 1 } })[0]).toContain("seam");
    expect(checkImage(KINDS.floor, { seam: { x: 1.1, y: 0.9 } })).toEqual([]);
  });
});

describe("library", () => {
  function withLibrary(fn: (lib: AssetLibrary, dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "assets-test-"));
    const lib = new AssetLibrary(dir);
    try {
      fn(lib, dir);
    } finally {
      lib.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const png = (shade: number) => encodePng(raster(4, 4, [shade, shade, shade, 255]));
  const base = {
    kind: "prop", subject: "A Wooden Barrel!", style: "ink", motif: "Infernal", width: 4, height: 4, alpha: true,
    tileable: false, prompt: "p", model: "m", seed: 1, workflow: { a: 1 }, metrics: { x: 1 },
  };

  test("stores the file under kind/motif and indexes it with tags", () => {
    withLibrary((lib, dir) => {
      const a = lib.add({ ...base, png: png(10), tags: ["Container", "wood", "wood"] });
      expect(a.id).toMatch(/^prop-a-wooden-barrel-[0-9a-f]{6}$/);
      expect(a.file).toBe(`prop/infernal/${a.id}.png`);
      expect(existsSync(join(dir, a.file))).toBe(true);
      expect(readFileSync(join(dir, a.file)).length).toBeGreaterThan(0);
      expect(a.tags).toEqual(["container", "wood"]);
      expect(a.workflow).toEqual({ a: 1 });
      expect(a.status).toBe("new");
    });
  });

  test("the same image twice is stored once", () => {
    withLibrary((lib) => {
      const a = lib.add({ ...base, png: png(10) });
      const b = lib.add({ ...base, png: png(10) });
      expect(b.id).toBe(a.id);
      expect(lib.list()).toHaveLength(1);
    });
  });

  test("filters by kind, motif, tags, text and status; resolves prefixes", () => {
    withLibrary((lib) => {
      const a = lib.add({ ...base, png: png(1), tags: ["wood"] });
      const b = lib.add({ ...base, png: png(2), kind: "floor", subject: "oak planks", name: "oak", motif: "Default", tags: ["wood", "planks"] });
      expect(b.id).toStartWith("floor-oak-");
      expect(lib.list({ tags: ["wood"] }).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
      expect(lib.list({ tags: ["wood", "planks"] }).map((x) => x.id)).toEqual([b.id]);
      expect(lib.list({ kind: "prop" }).map((x) => x.id)).toEqual([a.id]);
      expect(lib.list({ motif: "Default" }).map((x) => x.id)).toEqual([b.id]);
      expect(lib.list({ text: "planks" }).map((x) => x.id)).toEqual([b.id]);
      lib.setStatus(a.id, "keep", "good");
      expect(lib.list({ status: "keep" }).map((x) => x.notes)).toEqual(["good"]);
      expect(lib.resolve("floor-oak").id).toBe(b.id);
      expect(() => lib.resolve("zzz")).toThrow("no asset");
      expect(lib.tag(a.id, ["Big Barrel"], ["wood"]).tags).toEqual(["big-barrel"]);
    });
  });

  test("remove deletes the record, its tags and its file", () => {
    withLibrary((lib, dir) => {
      const a = lib.add({ ...base, png: png(3), tags: ["x"] });
      lib.remove(a.id);
      expect(lib.get(a.id)).toBeUndefined();
      expect(existsSync(join(dir, a.file))).toBe(false);
      expect(lib.tagCounts()).toEqual([]);
    });
  });

  test("contact sheet renders one numbered cell per asset", () => {
    withLibrary((lib) => {
      const a = lib.add({ ...base, png: png(4) });
      const b = lib.add({ ...base, png: png(5), tileable: true });
      const sheet = decodePng(contactSheet(lib, [a, b], { cell: 64, columns: 2 }));
      expect(sheet.width).toBe(2 * 64 + 3 * 8);
      expect(sheet.height).toBe(64 + 2 * 8);
    });
  });
});

describe("procedural cloud texture", () => {
  const opts = { size: 64, colors: ["#102030", "#405060"], scale: 2, octaves: 3, roughness: 0.5, contrast: 0, grain: 0, seed: 7 };

  test("tiles without a seam and stays inside the colour ramp", () => {
    const img = cloudTexture(opts);
    const seam = seamScore(img);
    expect(seam.x).toBeLessThan(2);
    expect(seam.y).toBeLessThan(2);
    for (let i = 0; i < img.data.length; i += 4) {
      expect(img.data[i]).toBeGreaterThanOrEqual(0x10);
      expect(img.data[i]).toBeLessThanOrEqual(0x40);
      expect(img.data[i + 3]).toBe(255);
    }
  });

  test("is deterministic per seed", () => {
    expect([...cloudTexture(opts).data]).toEqual([...cloudTexture(opts).data]);
    expect([...cloudTexture({ ...opts, seed: 8 }).data]).not.toEqual([...cloudTexture(opts).data]);
  });

  test("rejects bad colours", () => {
    expect(() => cloudTexture({ ...opts, colors: ["#102030"] })).toThrow();
    expect(() => cloudTexture({ ...opts, colors: ["#102030", "blue"] })).toThrow("#rrggbb");
  });
});

describe("blending looks", () => {
  // A periodic "stone" base and a striped overlay with thin dark joints.
  const base = cloudTexture({ size: 64, colors: ["#205060", "#60a0b0"], scale: 2, octaves: 3, roughness: 0.5, contrast: 0, grain: 0, seed: 3 });
  const joints = raster(64, 64, [180, 180, 180, 255]);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x += 16) joints.data.set([20, 20, 20, 255], (y * 64 + x) * 4);

  test("blendLook keeps the result seamless and leaves amount 0 unchanged", () => {
    const b = blendLook(base, joints, { amount: 0.5, softness: 0.05 });
    expect(Math.max(seamScore(b).x, seamScore(b).y)).toBeLessThan(2);
    expect([...blendLook(base, joints, { amount: 0, softness: 0.05 }).data]).toEqual([...base.data]);
  });

  test("closeDarkLines removes thin dark joints", () => {
    const closed = closeDarkLines(joints, 2);
    expect(closed.data[(10 * 64 + 16) * 4]).toBe(180);
  });

  test("stainMap is seamless", () => {
    const s = stainMap(base, 0.05, 1.5, 0.02);
    expect(Math.max(seamScore(s).x, seamScore(s).y)).toBeLessThan(2);
  });
});

test("reference images are wired into the text encoder", () => {
  const wf = buildWorkflow("tile", { prompt: "x", seed: 1, width: 1024, height: 1024, prefix: "p", references: ["a.png", "b.png"] });
  expect(wf.ref1!.inputs.image).toBe("a.png");
  expect(wf.text!.inputs["images.image_2"]).toEqual(["ref2", 0]);
  expect(wf.text!.inputs.vae).toEqual(["vae", 0]);
});

describe("tile variants", () => {
  const opts = { size: 64, colors: ["#102030", "#405060"], scale: 2, octaves: 3, roughness: 0.5, contrast: 0, grain: 0, seed: 9 };

  test("composited variants keep the base's edges exactly", () => {
    const base = cloudTexture(opts);
    const other = cloudTexture({ ...opts, seed: 10 });
    const mask = variantMask(64, 0.1, 0.06);
    const v = compositeVariant(base, other, mask);
    expect(edgesMatch(v, base, 3)).toBe(true);
    expect([...v.data]).not.toEqual([...base.data]);
    expect(edgesMatch(other, base, 3)).toBe(false);
  });

  test("procedural variants share the base's edges and differ inside", () => {
    const base = cloudTexture(opts);
    const v = cloudVariant(opts, 77);
    expect(edgesMatch(v, base, 1)).toBe(true);
    let changed = 0;
    for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) if (v.data[(y * 64 + x) * 4] !== base.data[(y * 64 + x) * 4]) changed++;
    expect(changed).toBeGreaterThan(32 * 32 * 0.5);
  });

  test("matchColour moves the variant's tone to the base's", () => {
    const base = raster(8, 8, [100, 120, 140, 255]);
    const bright = raster(8, 8, [200, 210, 220, 255]);
    const m = matchColour(base, bright, raster(8, 8, [255, 255, 255, 255]));
    expect([...m.data.slice(0, 3)]).toEqual([100, 120, 140]);
  });
});

test("variantIndex is stable, in range and varied", () => {
  const seen = new Set<number>();
  for (let i = -5; i < 5; i++) for (let j = -5; j < 5; j++) {
    const k = variantIndex(i, j, 3, 5);
    expect(k).toBe(variantIndex(i, j, 3, 5));
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThan(5);
    seen.add(k);
  }
  expect(seen.size).toBe(5);
});

test("warped, speckled cloud textures stay seamless and their variants keep the edges", () => {
  const o = { size: 96, colors: ["#102030", "#405060"], scale: 3, octaves: 4, roughness: 0.55, contrast: 0.1, grain: 0, seed: 5, warp: 0.3, specks: 40 };
  const img = cloudTexture(o);
  expect(Math.max(seamScore(img).x, seamScore(img).y)).toBeLessThan(2);
  expect(edgesMatch(cloudVariant(o, 99), img, 1)).toBe(true);
});

test("caustics: seamless web, variants keep the edges", () => {
  const o = { size: 96, colors: ["#0b5e6e", "#b9f2e6"], scale: 3, octaves: 4, roughness: 0.5, contrast: 0, grain: 0, seed: 2, pattern: "caustics" as const, warp: 0.3 };
  const img = cloudTexture(o);
  expect(Math.max(seamScore(img).x, seamScore(img).y)).toBeLessThan(2);
  expect(edgesMatch(cloudVariant(o, 7), img, 1)).toBe(true);
});
