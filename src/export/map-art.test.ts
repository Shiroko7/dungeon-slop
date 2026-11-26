import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { decodePng, encodePng, raster } from "../assets/png.ts";
import { createCampaign } from "../campaign/campaigns.ts";
import { createDungeon } from "../campaign/dungeons.ts";
import { openAppDb } from "../db/open.ts";
import { geometry } from "../test-fixtures.ts";
import { artGuide, packArt, readArtMap } from "./map-art.ts";

const source = {
  format: 0.3,
  resolution: { map_origin: { x: 5, y: 8 }, map_size: { x: 4, y: 2 }, pixels_per_grid: 50, custom: true },
  line_of_sight: [[{ x: 6, y: 8, extra: 7 }, { x: 6, y: 10 }]],
  objects_line_of_sight: [[{ x: 8, y: 8 }, { x: 8, y: 9 }]],
  portals: [{ bounds: [{ x: 6, y: 9 }, { x: 7, y: 9 }], closed: true, x_kind: "locked" as const }],
  x_slop: { version: 1 as const, floor: ["#...", "...."], elevation: { "2,1": 1 }, name: "Original", seed: 22 },
  lights: [{ color: "ffffff" }], x_custom: { enabled: true }, image: "",
};
const png = encodePng(raster(30, 15, [11, 22, 33, 255]));

test("guide registers the mask, walls, objects, elevation and portals to the UVTT origin", () => {
  const guide = decodePng(artGuide(readArtMap(source), 8));
  const pixelAt = (x: number, y: number) => guide.data[(y * guide.width + x) * 4]!;
  expect([guide.width, guide.height]).toEqual([32, 16]);
  expect(pixelAt(4, 4)).toBe(25);           // solid
  expect(pixelAt(8, 4)).toBe(248);          // wall
  expect(pixelAt(12, 8)).toBe(255);         // portal
  expect(pixelAt(24, 4)).toBe(25);          // object
  expect(pixelAt(20, 12)).toBeGreaterThan(pixelAt(12, 12));
  expect(() => artGuide(readArtMap(source), 0)).toThrow();
  expect(() => readArtMap({ ...source, x_slop: { version: 1, floor: ["."] } })).toThrow("Floor mask");
});

test("rejects unsupported portal and extension data and counts the same geometry as the VTT", () => {
  expect(() => readArtMap({ ...source, x_slop: { version: 2 } })).toThrow("x_slop.version");
  expect(() => readArtMap({ ...source, portals: [{ ...source.portals[0], x_kind: "archway" }] })).toThrow("x_kind");
  expect(() => readArtMap({ ...source, portals: Array(801).fill(source.portals[0]) })).toThrow("portals");
  const atLimit = { ...source, line_of_sight: Array(6000).fill(source.line_of_sight[0]) };
  expect(() => readArtMap(atLimit)).toThrow("6001");
  const tiny = [{ x: 5, y: 8 }, { x: 5.00001, y: 8 }];
  expect(() => readArtMap({ ...atLimit, objects_line_of_sight: [tiny] })).not.toThrow();
  const elevation = Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [`${i % 200},${Math.floor(i / 200)}`, 1]));
  const terrain = { resolution: { map_size: { x: 200, y: 200 } }, x_slop: { version: 1, elevation } };
  expect(() => readArtMap(terrain)).toThrow("20001");
  elevation["0,0"] = 0.0001;
  expect(() => readArtMap(terrain)).not.toThrow();
});

test("pack embeds the unchanged image bytes and keeps all source extensions and geometry", async () => {
  const map = readArtMap(source);
  for (const art of [png, await new Bun.Image(png).webp().bytes(), await new Bun.Image(png).jpeg().bytes()]) {
    expect(await packArt(map, art, "New scene")).toEqual({
      ...source, resolution: { ...source.resolution, pixels_per_grid: 7.5 },
      x_slop: { ...source.x_slop, name: "New scene" }, image: Buffer.from(art).toString("base64"),
    });
  }
  expect(source.x_slop.name).toBe("Original");
  expect((await packArt(map, png)).x_slop).toEqual(source.x_slop);
  await expect(packArt(map, encodePng(raster(30, 16)))).rejects.toThrow("aspect ratio");
  await expect(packArt(map, png.subarray(0, 40))).rejects.toThrow();
});

test("file CLI extracts original artwork, refuses overwrites and exports saved dungeons read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "dungeon-slop-map-art-"));
  const dbPath = join(dir, "fixture.sqlite"), artPath = join(dir, "art.png");
  const guidePath = join(dir, "guide.png"), outPath = join(dir, "variant.uvtt"), sourcePath = join(dir, "original.uvtt");
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../scripts/map-art.ts"), ...args], {
    env: { ...process.env, NOTES_DB_PATH: dbPath },
  });
  try {
    writeFileSync(sourcePath, JSON.stringify({ ...source, image: Buffer.from(png).toString("base64") }));
    expect(cli("guide", sourcePath, "--out", guidePath, "--reference", artPath).exitCode).toBe(0);
    expect(readFileSync(artPath)).toEqual(Buffer.from(png));
    const anotherGuide = join(dir, "another.png");
    expect(cli("guide", sourcePath, "--out", anotherGuide, "--reference", artPath).exitCode).toBe(1);
    expect(existsSync(anotherGuide)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);

    const db = openAppDb(dbPath);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      const saved = createDungeon(db, createCampaign(db, { name: "Fixture" }).id, { name: "Painted dungeon", geometry: geometry() });
      const snapshot = readFileSync(dbPath), wal = readFileSync(`${dbPath}-wal`);
      expect(wal.length).toBeGreaterThan(0);
      expect(cli("guide", String(saved.id), "--out", anotherGuide, "--pixels-per-grid", "2").exitCode).toBe(0);
      const packed = cli("pack", String(saved.id), "--art", anotherGuide, "--out", outPath);
      expect(packed.exitCode).toBe(0);
      expect(packed.stdout.toString()).toContain(outPath);
      expect(JSON.parse(readFileSync(outPath, "utf8")).x_slop.name).toBe("Painted dungeon");
      expect(readFileSync(dbPath)).toEqual(snapshot);
      expect(readFileSync(`${dbPath}-wal`)).toEqual(wal);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
