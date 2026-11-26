import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getDungeon } from "../src/campaign/dungeons.ts";
import { dungeonToUVTT } from "../src/export/uvtt.ts";
import { artGuide, inspectArt, packArt, readArtMap } from "../src/export/map-art.ts";

const HELP = `Prepare image-generation guides and package registered artwork for the VTT.

  bun run map-art guide <map.uvtt|dungeon-id> --out guide.png [--reference original.png] [--pixels-per-grid 16]
  bun run map-art pack  <map.uvtt|dungeon-id> --art painting.webp --out painted.uvtt [--name "Scene name"]

Saved dungeon IDs read NOTES_DB_PATH (default: this project's notes.sqlite).
Guide colors: gray floor, dark solid cells, lighter raised ground, white walls,
teal object outlines, amber portals. The guide spans the exact source bounds.
--reference extracts the original embedded bytes; use the matching PNG, JPEG
or WebP extension. Saved dungeons export geometry and have no embedded image.
Pack accepts PNG, JPEG and WebP with the same aspect ratio as the map. It
computes pixels per grid from the image width. All outputs must be new files.`;

function loadSource(source: string) {
  if (!/^\d+$/.test(source)) return readArtMap(JSON.parse(readFileSync(source, "utf8").replace(/^\uFEFF/, "")));
  const dbPath = process.env.NOTES_DB_PATH ?? resolve(import.meta.dir, "../notes.sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const dungeon = getDungeon(db, Number(source));
    if (!dungeon?.geometry) throw new Error(`No saved geometry for dungeon ${source}.`);
    const doc = dungeonToUVTT(dungeon.geometry);
    return readArtMap({ ...doc, x_slop: { ...doc.x_slop, name: dungeon.name } });
  } finally {
    db.close();
  }
}

/** Claim every destination before writing. Keep existing files on retries. */
function saveNew(outputs: Array<{ path: string; data: string | Uint8Array }>) {
  const claimed: Array<{ path: string; fd: number }> = [];
  try {
    for (const output of outputs) {
      const path = resolve(output.path);
      mkdirSync(dirname(path), { recursive: true });
      claimed.push({ path, fd: openSync(path, "wx") });
    }
    outputs.forEach(({ data }, i) => writeFileSync(claimed[i]!.fd, data));
  } catch (err) {
    for (const { fd, path } of claimed.splice(0)) {
      closeSync(fd);
      unlinkSync(path);
    }
    throw err;
  } finally {
    for (const { fd } of claimed) closeSync(fd);
  }
}

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return console.log(HELP);
  if (command !== "guide" && command !== "pack") throw new Error("Use map-art guide or map-art pack; see map-art help.");
  const value = { type: "string" } as const;
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: command === "guide"
      ? { out: value, reference: value, "pixels-per-grid": value }
      : { out: value, art: value, name: value },
  });
  const [source] = positionals;
  if (!source || positionals.length !== 1 || typeof values.out !== "string" || !values.out) {
    throw new Error(`${command} requires one source and --out <new file>.`);
  }
  const map = loadSource(source);
  const { x: cols, y: rows } = map.resolution.map_size;
  if (command === "pack") {
    if (typeof values.art !== "string" || !values.art) throw new Error("pack requires --art <registered artwork>.");
    const packed = await packArt(map, readFileSync(values.art), values.name as string | undefined);
    const data = JSON.stringify(packed);
    if (Buffer.byteLength(data) > 40 * 1024 * 1024) throw new Error("Packed map exceeds the VTT's 40 MiB upload limit. Use a smaller image or WebP.");
    saveNew([{ path: values.out, data }]);
    console.log(`${resolve(values.out)} — ${cols}×${rows} cells, ${packed.resolution.pixels_per_grid} pixels per grid.`);
    return;
  }
  if (extname(values.out).toLowerCase() !== ".png") throw new Error("The guide output needs a .png extension.");
  const ppg = Number(values["pixels-per-grid"] ?? 16);
  const outputs = [{ path: values.out, data: artGuide(map, ppg) }];
  const reference = values.reference;
  if (typeof reference === "string") {
    if (!map.image?.trim()) throw new Error("This map has no embedded image to extract. Omit --reference to write its guide.");
    const bytes = Buffer.from(map.image.replace(/^data:[^,]*,/, ""), "base64");
    const { format } = await inspectArt(bytes);
    const extensions = format === "jpeg" ? [".jpeg", ".jpg"] : [`.${format}`];
    if (!extensions.includes(extname(reference).toLowerCase())) throw new Error(`The embedded artwork is ${format}; use ${extensions.join(" or ")} for --reference.`);
    outputs.push({ path: reference, data: bytes });
  }
  saveNew(outputs);
  for (const { path } of outputs) console.log(resolve(path));
  console.log(`Guide: ${cols}×${rows} cells, ${ppg} pixels per grid. ${cols * ppg}×${rows * ppg} pixels.`);
}

run().catch(err => { console.error(`map-art: ${err.message}`); process.exitCode = 1; });
