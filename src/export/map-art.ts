import { z } from "zod";
import { encodePng, fillRect, raster } from "../assets/png.ts";

// Parse only the fields we need. Return the original document so unknown
// extensions at any depth survive a round trip through this tool.
const point = z.object({ x: z.number(), y: z.number() });
const side = z.number().int().min(1).max(200);
const uvtt = z.object({
  format: z.number().optional(),
  resolution: z.object({
    map_size: z.object({ x: side, y: side }),
    map_origin: point.optional(),
    pixels_per_grid: z.number().positive().optional(),
  }),
  line_of_sight: z.array(z.array(point)).optional(),
  objects_line_of_sight: z.array(z.array(point)).optional(),
  portals: z.array(z.object({
    bounds: z.array(point).min(2),
    closed: z.boolean().optional(),
    x_kind: z.enum(["door", "locked", "secret", "trapped", "portcullis"]).optional(),
  })).max(800).optional(),
  x_slop: z.object({
    version: z.literal(1),
    floor: z.array(z.string().regex(/^[.#]+$/)).optional(),
    elevation: z.record(z.string(), z.number()).optional(),
    name: z.string().max(200).optional(),
    seed: z.number().int().optional(),
    wallHeight: z.number().positive().optional(),
  }).optional(),
  image: z.string().optional(),
});
type ArtMap = z.infer<typeof uvtt>;
type Point = z.infer<typeof point>;
type Ink = [number, number, number, number];

export function readArtMap(raw: unknown): ArtMap {
  const result = uvtt.safeParse(raw);
  if (!result.success) throw new Error(`Invalid UVTT: ${result.error.issues[0]?.path.join(".")} — ${result.error.issues[0]?.message}`);
  const map = raw as ArtMap;
  const { x, y } = map.resolution.map_size;
  const floor = map.x_slop?.floor;
  if (floor && (floor.length !== y || floor.some(row => row.length !== x))) {
    throw new Error(`Floor mask must contain ${y} rows of ${x} cells.`);
  }
  const origin = map.resolution.map_origin ?? { x: 0, y: 0 };
  const walls = [...(map.line_of_sight ?? []), ...(map.objects_line_of_sight ?? [])];
  const paths = [...walls, ...(map.portals ?? []).map(p => p.bounds)];
  for (const path of paths) {
    for (const p of path) {
      // The VTT allows wall endpoints up to one cell beyond the map.
      if (p.x < origin.x - 1 || p.y < origin.y - 1 || p.x > origin.x + x + 1 || p.y > origin.y + y + 1) {
        throw new Error("Geometry lies outside the map bounds.");
      }
    }
  }
  // The VTT drops zero-length segments after rounding to 1/1000 of a cell.
  let count = 0;
  for (const path of walls) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      if (Math.round((a.x - origin.x) * 1000) !== Math.round((b.x - origin.x) * 1000) ||
          Math.round((a.y - origin.y) * 1000) !== Math.round((b.y - origin.y) * 1000)) count++;
    }
  }
  if (count > 6000) throw new Error(`The VTT holds 6000 wall segments; this map has ${count}.`);
  let raised = 0;
  for (const [key, height] of Object.entries(map.x_slop?.elevation ?? {})) {
    const cell = /^(\d+),(\d+)$/.exec(key);
    if (cell && Number(cell[1]) < x && Number(cell[2]) < y && Math.round(height * 1000) !== 0) raised++;
  }
  if (raised > 20000) throw new Error(`The VTT holds 20000 elevation cells; this map has ${raised}.`);
  return map;
}

/** No grid, labels, padding or perspective. Pixel (0,0) is the map origin. */
export function artGuide(map: ArtMap, ppg: number): Uint8Array {
  const { x: cols, y: rows } = map.resolution.map_size;
  if (!Number.isSafeInteger(ppg) || ppg < 1 || cols * rows * ppg ** 2 > 16_777_216) {
    throw new Error("Guide density must be a positive integer that produces at most 16 megapixels.");
  }
  const paper = raster(cols * ppg, rows * ppg, [138, 150, 151, 255]);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (map.x_slop?.floor?.[y]?.[x] === "#") {
        fillRect(paper, x * ppg, y * ppg, ppg, ppg, [25, 31, 40, 255]);
      } else {
        const h = map.x_slop?.elevation?.[`${x},${y}`] ?? 0;
        if (h === 0) continue;
        const delta = Math.round(62 * Math.tanh(h / 4));
        fillRect(paper, x * ppg, y * ppg, ppg, ppg, [138 + delta, 150 + delta, 151 + delta, 255]);
      }
    }
  }
  const origin = map.resolution.map_origin ?? { x: 0, y: 0 };
  const stroke = Math.max(1, Math.round(ppg / 6));
  function line(a: Point, b: Point, color: Ink) {
    const x = (a.x - origin.x) * ppg, y = (a.y - origin.y) * ppg;
    const dx = (b.x - a.x) * ppg, dy = (b.y - a.y) * ppg;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
    for (let i = 0; i <= steps; i++) {
      const px = x + dx * i / steps, py = y + dy * i / steps;
      const left = px === paper.width ? paper.width - stroke : Math.round(px - stroke / 2);
      const top = py === paper.height ? paper.height - stroke : Math.round(py - stroke / 2);
      fillRect(paper, left, top, stroke, stroke, color);
    }
  }
  function paths(lines: Point[][], color: Ink) {
    for (const path of lines) for (let i = 1; i < path.length; i++) line(path[i - 1]!, path[i]!, color);
  }
  paths(map.objects_line_of_sight ?? [], [25, 112, 122, 255]);
  paths(map.line_of_sight ?? [], [248, 246, 231, 255]);
  paths((map.portals ?? []).map(portal => portal.bounds), [255, 164, 48, 255]);
  return encodePng(paper);
}

export async function inspectArt(bytes: Uint8Array) {
  if (!bytes.length) throw new Error("Empty artwork.");
  const image = new Bun.Image(bytes);
  const info = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(info.format)) throw new Error("Artwork must be PNG, JPEG or WebP.");
  // Metadata alone accepts truncated containers. Decode before embedding.
  await image.resize(1, 1).png().bytes();
  return info;
}

export async function packArt(map: ArtMap, bytes: Uint8Array, name?: string) {
  const { width, height } = await inspectArt(bytes);
  const { x: cols, y: rows } = map.resolution.map_size;
  if (width * rows !== height * cols) {
    throw new Error(`Art is ${width}×${height}; the map requires a ${cols}:${rows} aspect ratio. Register the image to the map edges before packing.`);
  }
  const title = name?.trim();
  if (name !== undefined && (!title || title.length > 60)) throw new Error("Scene name must contain 1–60 characters.");
  return {
    ...map,
    resolution: { ...map.resolution, pixels_per_grid: width / cols },
    ...(title ? { x_slop: { ...map.x_slop, version: 1, name: title } } : {}),
    image: Buffer.from(bytes).toString("base64"),
  };
}
