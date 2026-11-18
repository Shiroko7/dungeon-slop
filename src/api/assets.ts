/**
 * The generated-art library (`bun run assets`) for the app: list assets, serve
 * an asset's PNG or a cached thumbnail of it, and mark favourites.
 *
 * Asset ids end in a content hash, so a served file never changes under its
 * URL and can be cached for good.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AssetLibrary, type AssetRecord } from "../assets/library.ts";
import { crop, decodePng, encodePng, fit, raster, draw } from "../assets/png.ts";
import { badRequest, json, readJson } from "./http.ts";

let library: AssetLibrary | null = null;
function lib(): AssetLibrary {
  library ??= new AssetLibrary();
  return library;
}

export const ASSET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const THUMB_SIZES = [96, 192, 384] as const;
const FAVORITE = "favorite";

function find(id: string): AssetRecord | Response {
  if (!ASSET_ID.test(id)) return json({ error: "Invalid asset id" }, 400);
  const asset = lib().get(id);
  if (!asset || !existsSync(lib().path(asset))) return json({ error: `No asset ${id}` }, 404);
  return asset;
}

const IMMUTABLE = { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" };

export function handleAssetImage(id: string): Response {
  const asset = find(id);
  if (asset instanceof Response) return asset;
  return new Response(Bun.file(lib().path(asset)), { headers: IMMUTABLE });
}

/**
 * A square thumbnail: tiles show their top-left square, everything else is
 * fitted whole on transparency. Built once, then served from disk.
 */
export function handleAssetThumb(id: string, url: URL): Response {
  const asset = find(id);
  if (asset instanceof Response) return asset;
  const wanted = Number(url.searchParams.get("size") ?? 192);
  const size: number = THUMB_SIZES.find((s) => s >= wanted) ?? 384;
  const dir = join(lib().root, ".thumbs");
  const file = join(dir, `${asset.id}-${size}.png`);
  if (!existsSync(file)) {
    const img = decodePng(readFileSync(lib().path(asset)));
    let thumb;
    if (asset.tileable) {
      const side = Math.min(img.width, img.height);
      thumb = fit(crop(img, 0, 0, side, side), size);
    } else {
      thumb = raster(size, size);
      const f = fit(img, size);
      draw(thumb, f, Math.floor((size - f.width) / 2), Math.floor((size - f.height) / 2));
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, encodePng(thumb));
  }
  return new Response(Bun.file(file), { headers: IMMUTABLE });
}

export interface AssetSummary {
  id: string;
  kind: string;
  subject: string;
  style: string;
  motif: string;
  width: number;
  height: number;
  tileable: boolean;
  alpha: boolean;
  tags: string[];
  status: string;
  favorite: boolean;
  createdAt: string;
}

function summary(a: AssetRecord): AssetSummary {
  return {
    id: a.id, kind: a.kind, subject: a.subject, style: a.style, motif: a.motif, width: a.width, height: a.height,
    tileable: a.tileable, alpha: a.alpha, tags: a.tags, status: a.status, favorite: a.tags.includes(FAVORITE), createdAt: a.createdAt,
  };
}

export function handleListAssets(url: URL): Response {
  const kind = url.searchParams.get("kind") ?? undefined;
  const motif = url.searchParams.get("motif") ?? undefined;
  const assets = lib().list({ kind, motif }).filter((a) => a.status !== "reject").map(summary);
  return json({ assets });
}

export async function handleFavoriteAsset(id: string, req: Request): Promise<Response> {
  const asset = find(id);
  if (asset instanceof Response) return asset;
  const body = await readJson<{ favorite?: unknown }>(req);
  if (!body || typeof body.favorite !== "boolean") return badRequest("Expected { favorite: boolean }");
  const next = body.favorite ? lib().tag(asset.id, [FAVORITE]) : lib().tag(asset.id, [], [FAVORITE]);
  return json({ asset: summary(next) });
}
