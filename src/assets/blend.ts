/**
 * Blend the look of one seamless tile into another without mixing their
 * patterns: the base keeps its stones and joints, and takes on the overlay's
 * large-scale staining and colour. Overlaying the images directly would print
 * the overlay's joints over the base's as a ghost grid.
 *
 * The overlay is blurred with wrap-around edges, so the result stays seamless
 * when both inputs are.
 */
import { raster, resize, type Raster } from "./png.ts";

export interface BlendOptions {
  /** 0..1: how much of the overlay's look comes through. */
  amount: number;
  /** Blur radius as a fraction of the tile width: bigger keeps only broad stains. */
  softness: number;
}

/** Separable box blur, wrapping at the edges (one channel per call over RGB). */
function wrapBlur(src: Raster, radius: number): Float32Array {
  const { width: w, height: h, data } = src;
  const tmp = new Float32Array(w * h * 3);
  const out = new Float32Array(w * h * 3);
  const r = Math.max(1, Math.round(radius));
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += data[(y * w + ((k % w) + w) % w) * 4 + c]!;
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = sum / n;
        const add = (x + r + 1) % w, drop = ((x - r) % w + w) % w;
        sum += data[(y * w + add) * 4 + c]! - data[(y * w + drop) * 4 + c]!;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[(((k % h) + h) % h * w + x) * 3 + c]!;
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + c] = sum / n;
        const add = (y + r + 1) % h, drop = ((y - r) % h + h) % h;
        sum += tmp[(add * w + x) * 3 + c]! - tmp[(drop * w + x) * 3 + c]!;
      }
    }
  }
  return out;
}

export function blendLook(base: Raster, overlay: Raster, o: BlendOptions): Raster {
  const ov = overlay.width === base.width && overlay.height === base.height ? overlay : resize(overlay, base.width, base.height);
  const radius = Math.max(1, o.softness * base.width);
  // Two box passes ≈ a Gaussian; enough to drop the overlay's joints.
  const once = wrapBlur(ov, radius);
  const asRaster = raster(base.width, base.height);
  for (let i = 0; i < base.width * base.height; i++) {
    for (let c = 0; c < 3; c++) asRaster.data[i * 4 + c] = Math.round(once[i * 3 + c]!);
    asRaster.data[i * 4 + 3] = 255;
  }
  const soft = wrapBlur(asRaster, radius);

  // Mean of base and of the blurred overlay, per channel.
  const n = base.width * base.height;
  const meanB = [0, 0, 0], meanO = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      meanB[c]! += base.data[i * 4 + c]!;
      meanO[c]! += soft[i * 3 + c]!;
    }
  }
  for (let c = 0; c < 3; c++) {
    meanB[c]! /= n;
    meanO[c]! /= n;
  }

  const out = raster(base.width, base.height);
  const a = Math.min(1, Math.max(0, o.amount));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const b = base.data[i * 4 + c]!;
      // Staining: the overlay's local light/dark relative to its average.
      const stain = soft[i * 3 + c]! / Math.max(1, meanO[c]!);
      // Tint: shift the base's average colour toward the overlay's.
      const tinted = b * (1 + a * (meanO[c]! / Math.max(1, meanB[c]!) - 1));
      out.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(tinted * Math.pow(stain, a * 1.6))));
    }
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Separable max (grow = true) or min filter over RGB with wrap-around edges. */
function rankFilter(src: Raster, r: number, grow: boolean): Raster {
  const { width: w, height: h } = src;
  const pick = grow ? Math.max : Math.min;
  const tmp = raster(w, h), out = raster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let v = src.data[(y * w + x) * 4 + c]!;
        for (let k = 1; k <= r; k++) {
          v = pick(v, src.data[(y * w + ((x + k) % w)) * 4 + c]!, src.data[(y * w + ((x - k + w * 4) % w)) * 4 + c]!);
        }
        tmp.data[(y * w + x) * 4 + c] = v;
      }
      tmp.data[(y * w + x) * 4 + 3] = 255;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let v = tmp.data[(y * w + x) * 4 + c]!;
        for (let k = 1; k <= r; k++) {
          v = pick(v, tmp.data[(((y + k) % h) * w + x) * 4 + c]!, tmp.data[(((y - k + h * 4) % h) * w + x) * 4 + c]!);
        }
        out.data[(y * w + x) * 4 + c] = v;
      }
      out.data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return out;
}

/** Morphological closing: removes dark features narrower than about 2r pixels. */
export function closeDarkLines(src: Raster, r: number): Raster {
  return rankFilter(rankFilter(src, r, true), r, false);
}

/**
 * A seamless "stain map" from a tile: blurred until its joints and pattern are
 * gone, leaving only its broad light/dark patches and colour, then stretched
 * so those patches carry weight. Meant as a blend layer over another texture.
 */
export function stainMap(src: Raster, softness: number, contrast = 1.8, lines = 0.012): Raster {
  const radius = Math.max(1, softness * src.width);
  // Joints and grout are thin dark lines; a closing erases them while big dark
  // patches (seaweed, silt) survive. Otherwise they blur into a soft grid.
  const cleaned = lines > 0 ? closeDarkLines(src, Math.max(1, Math.round(lines * src.width))) : src;
  const once = wrapBlur(cleaned, radius);
  const mid = raster(src.width, src.height);
  for (let i = 0; i < src.width * src.height; i++) {
    for (let c = 0; c < 3; c++) mid.data[i * 4 + c] = Math.round(once[i * 3 + c]!);
    mid.data[i * 4 + 3] = 255;
  }
  const soft = wrapBlur(mid, radius);
  const n = src.width * src.height;
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c]! += soft[i * 3 + c]!;
  for (let c = 0; c < 3; c++) mean[c]! /= n;
  const out = raster(src.width, src.height);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = mean[c]! + (soft[i * 3 + c]! - mean[c]!) * contrast;
      out.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
    out.data[i * 4 + 3] = 255;
  }
  return out;
}
