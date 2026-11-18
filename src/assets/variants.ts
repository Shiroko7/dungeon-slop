/**
 * Tile variant sets: several versions of one seamless tile that share its
 * border exactly and differ inside, so any variant can sit next to any other
 * (or the original) without a seam, and a renderer can scatter them at random
 * to hide repetition.
 *
 * A variant is made by keeping a band along the tile's edges and regenerating
 * only the inside (latent inpainting with the tile's own prompt). The band is
 * then restored pixel-exactly with a feathered seam inside the tile, so edge
 * matching is guaranteed rather than hoped for.
 */
import { raster, type Raster } from "./png.ts";

/** Default width of the kept edge band, as a fraction of the tile. */
export const DEFAULT_BORDER = 0.1;

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Inpainting weight per pixel: 0 on the kept border, rising to 1 inside over
 * `feather` (fraction of the tile). White = regenerate.
 */
export function variantMask(size: number, border = DEFAULT_BORDER, feather = 0.06): Raster {
  const m = raster(size, size);
  const b = border * size, f = Math.max(1, feather * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(x, y, size - 1 - x, size - 1 - y); // distance to the nearest edge
      const v = Math.round(255 * smoothstep((d - b) / f));
      m.data.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  return m;
}

/**
 * Keep the base where the mask is black, the variant where white, blended in
 * between. Pixels on the border band come out identical to the base.
 */
export function compositeVariant(base: Raster, variant: Raster, mask: Raster): Raster {
  const out = raster(base.width, base.height);
  for (let i = 0; i < base.width * base.height; i++) {
    const w = mask.data[i * 4]! / 255;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.round(base.data[i * 4 + c]! * (1 - w) + variant.data[i * 4 + c]! * w);
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** True when two tiles share every pixel of their outermost `px` rows and columns. */
export function edgesMatch(a: Raster, b: Raster, px = 2): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const { width: w, height: h } = a;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.min(x, y, w - 1 - x, h - 1 - y) >= px) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) if (a.data[i + c] !== b.data[i + c]) return false;
    }
  }
  return true;
}

/**
 * Match the variant's colour to the base where it will be used (under the
 * mask): per channel, shift and scale so its mean and spread equal the base's.
 * Repaints tend to come out a little lighter or tinted, and once tiles are
 * scattered that shows as squares; structure is left alone.
 */
export function matchColour(base: Raster, variant: Raster, mask: Raster): Raster {
  const n = base.width * base.height;
  const out = raster(variant.width, variant.height);
  for (let c = 0; c < 3; c++) {
    let wSum = 0, mb = 0, mv = 0;
    for (let i = 0; i < n; i++) {
      const w = mask.data[i * 4]! / 255;
      wSum += w;
      mb += w * base.data[i * 4 + c]!;
      mv += w * variant.data[i * 4 + c]!;
    }
    if (wSum === 0) return variant;
    mb /= wSum;
    mv /= wSum;
    let sb = 0, sv = 0;
    for (let i = 0; i < n; i++) {
      const w = mask.data[i * 4]! / 255;
      sb += w * (base.data[i * 4 + c]! - mb) ** 2;
      sv += w * (variant.data[i * 4 + c]! - mv) ** 2;
    }
    const k = Math.sqrt(sb / wSum) / Math.max(1e-6, Math.sqrt(sv / wSum));
    for (let i = 0; i < n; i++) {
      out.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round((variant.data[i * 4 + c]! - mv) * k + mb)));
    }
  }
  for (let i = 0; i < n; i++) out.data[i * 4 + 3] = 255;
  return out;
}

/**
 * Detail level inside the mask: mean colour step between neighbouring pixels.
 * A variant whose detail differs a lot from its base (much busier or much
 * smoother) reads as a patch of another material once tiles are scattered.
 */
export function detailLevel(r: Raster, mask: Raster): number {
  const { width: w, height: h, data } = r;
  let sum = 0, wsum = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const m = mask.data[i]! / 255;
      if (m < 0.5) continue;
      let d = 0;
      for (let c = 0; c < 3; c++) d += Math.abs(data[i + c]! - data[i + 4 + c]!) + Math.abs(data[i + c]! - data[i + w * 4 + c]!);
      sum += d * m;
      wsum += m;
    }
  }
  return wsum ? sum / wsum : 0;
}
