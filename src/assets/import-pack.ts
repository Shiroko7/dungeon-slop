import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AssetLibrary } from "./library.ts";
import { alphaStats, crop, decodePng, encodePng, type Raster } from "./png.ts";
import { isKind, isStyle, MOTIFS } from "./presets.ts";

const label = z.string().trim().min(1);
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const coordinate = z.number().int().nonnegative();
const size = z.number().int().positive();
const packSchema = z.object({
  version: z.literal(1), id: key, style: label.refine(isStyle), motif: z.enum(MOTIFS), prompts: label,
  assets: z.array(z.object({
    key, subject: label, kind: label.refine(isKind), source: label, tags: z.array(label),
    crop: z.tuple([coordinate, coordinate, size, size]).optional(),
    tileMode: z.literal("mirror").optional(),
  })).min(1),
});
const promptsSchema = z.object({
  generator: label, assets: z.array(z.object({ file: label, prompt: label })),
});

/** Reflect both axes, including the edge pixels, for a repeatable material swatch. */
function mirroredTile(image: Raster): Raster {
  const width = image.width * 2, height = image.height * 2;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < image.height; y++) {
    const row = data.subarray(y * width * 4, (y + 1) * width * 4);
    const left = image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4);
    row.set(left);
    for (let x = 0; x < image.width; x++) row.set(left.subarray(x * 4, x * 4 + 4), (width - x - 1) * 4);
    data.set(row, (height - y - 1) * width * 4);
  }
  return { width, height, data };
}

/** Extract reviewed PNGs into the same database and catalog as generated assets. */
export function importAssetPack(lib: AssetLibrary, manifest: string) {
  const root = dirname(resolve(manifest));
  function sourcePath(file: string) {
    const full = resolve(root, file);
    const part = relative(root, full);
    if (isAbsolute(file) || isAbsolute(part) || part === ".." || part.startsWith(".." + sep)) {
      throw new Error(`Pack reference must be a relative path inside the pack: ${file}`);
    }
    return full;
  }
  const pack = packSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
  const prompts = promptsSchema.parse(JSON.parse(readFileSync(sourcePath(pack.prompts), "utf8")));
  const sheets = new Map<string, Raster>();
  const seen = new Set<string>();
  const prepared = pack.assets.map(asset => {
    if (seen.has(asset.key)) throw new Error(`Duplicate asset key: ${asset.key}`);
    seen.add(asset.key);
    const prompt = prompts.assets.find(a => a.file === asset.source)?.prompt;
    if (!prompt) throw new Error(`${asset.key}: missing source prompt for ${asset.source}`);
    let sheet = sheets.get(asset.source);
    if (!sheet) {
      sheet = decodePng(readFileSync(sourcePath(asset.source)));
      sheets.set(asset.source, sheet);
    }
    let image = sheet;
    if (asset.crop) {
      const [x, y, w, h] = asset.crop;
      if (x + w > sheet.width || y + h > sheet.height) throw new Error(`${asset.key}: crop extends outside ${asset.source}`);
      image = crop(sheet, x, y, w, h);
    }
    const stats = alphaStats(image);
    if (!stats.bbox) throw new Error(`${asset.key}: crop is empty`);
    const alpha = image.data.some((value, i) => i % 4 === 3 && value < 255);
    if (asset.tileMode) {
      if (alpha || (asset.kind !== "floor" && asset.kind !== "wall")) throw new Error(`${asset.key}: mirror tiling requires an opaque floor or wall material`);
      image = mirroredTile(image);
    }
    return {
      kind: asset.kind, name: asset.key, subject: asset.subject, style: pack.style, motif: pack.motif,
      width: image.width, height: image.height, alpha, tileable: asset.tileMode === "mirror",
      prompt, model: prompts.generator, seed: 0,
      workflow: { pack: pack.id, key: asset.key, source: asset.source, crop: asset.crop, tileMode: asset.tileMode, originalSeed: null },
      metrics: { transparent: stats.transparent }, png: encodePng(image), initialStatus: "keep" as const,
      tags: [pack.id, asset.key, asset.kind, pack.style, pack.motif, ...asset.tags],
    };
  });
  // File and crop errors were checked before storing anything. Serialize pack
  // imports and reuse existing IDs, leaving the owner's review and tags intact.
  return lib.db.transaction(() => prepared.map(asset => lib.add(asset))).immediate();
}
