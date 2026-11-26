import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAssetPack } from "./import-pack.ts";
import { AssetLibrary } from "./library.ts";
import { decodePng, encodePng, raster, seamScore } from "./png.ts";

test("imports independent sprites and seamless materials, preserving review and IDs on retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "curated-atlas-"));
  const lib = new AssetLibrary(join(dir, "library"));
  try {
    const atlas = raster(4, 2, [10, 20, 30, 255]);
    atlas.data.set([0, 0, 0, 0], 0);
    atlas.data.set([200, 150, 99, 255], 3 * 4);
    writeFileSync(join(dir, "sheet.png"), encodePng(atlas));
    writeFileSync(join(dir, "prompts.json"), JSON.stringify({ generator: "Fixture", assets: [{ file: "sheet.png", prompt: "Painted swatches" }] }));
    const base = { version: 1, id: "frost", motif: "Frozen", style: "painted", prompts: "prompts.json" };
    const tree = { key: "pine", kind: "prop", subject: "Snowy pine", source: "sheet.png", crop: [0, 0, 2, 2], tags: ["canopy"] };
    const tile = { key: "snow", kind: "floor", subject: "Snow", source: "sheet.png", tileMode: "mirror", crop: [2, 0, 2, 2], tags: ["ground"] };
    const manifest = join(dir, "pack.json");
    writeFileSync(manifest, JSON.stringify({ ...base, assets: [tree, { ...tile, crop: [2, 0, 3, 3] }] }));
    expect(() => importAssetPack(lib, manifest)).toThrow("outside");
    expect(lib.list()).toHaveLength(0);
    writeFileSync(manifest, JSON.stringify({ ...base, assets: [tree, tile] }));
    const [pine, snow] = importAssetPack(lib, manifest);
    expect(pine).toMatchObject({ kind: "prop", width: 2, height: 2, alpha: true, tileable: false, status: "keep", prompt: "Painted swatches" });
    expect(snow).toMatchObject({ kind: "floor", width: 4, height: 4, alpha: false, tileable: true });
    expect(seamScore(decodePng(readFileSync(lib.path(snow!))))).toEqual({ x: 0, y: 0 });
    expect(lib.list({ tags: ["canopy", "frost"] })[0]?.id).toBe(pine!.id);
    lib.setStatus(pine!.id, "reject", "I prefer the spruce");
    lib.tag(pine!.id, ["private-tag"], ["canopy"]);
    unlinkSync(lib.path(pine!));
    const again = importAssetPack(lib, manifest);
    expect(again.map(a => a.id)).toEqual([pine!.id, snow!.id]);
    expect(again[0]).toMatchObject({ status: "reject", notes: "I prefer the spruce" });
    expect(again[0]!.tags).toContain("private-tag");
    expect(again[0]!.tags).not.toContain("canopy");
    expect(decodePng(readFileSync(lib.path(pine!))).width).toBe(2);
    expect(lib.list()).toHaveLength(2);
  } finally {
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
