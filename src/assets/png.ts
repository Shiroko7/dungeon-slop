/**
 * Small RGBA raster toolkit for generated assets: decode/encode PNG, measure
 * transparency and tile seams, trim to content, scale, and compose review
 * sheets. Pure TypeScript on top of pngjs, so it runs anywhere bun does.
 */
import { PNG } from "pngjs";

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

export function raster(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
}

export function decodePng(bytes: Uint8Array): Raster {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

export function encodePng(r: Raster): Uint8Array {
  const png = new PNG({ width: r.width, height: r.height });
  png.data = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.length);
  return new Uint8Array(PNG.sync.write(png, { colorType: 6 }));
}

// ─── measurements ─────────────────────────────────────────────────────────────

export interface AlphaStats {
  /** Fractions of all pixels, 0..1. */
  transparent: number;
  opaque: number;
  partial: number;
  /** Bounding box of pixels with alpha > threshold, or null when empty. */
  bbox: { x: number; y: number; width: number; height: number } | null;
  /** True when content reaches the image border (likely cut off). */
  touchesEdge: boolean;
  /** Fraction of the outermost ring of pixels that is mostly opaque: high means the background was not removed. */
  borderOpaque: number;
}

export function alphaStats(r: Raster, threshold = 8): AlphaStats {
  let transparent = 0, opaque = 0, partial = 0;
  let x0 = r.width, y0 = r.height, x1 = -1, y1 = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const a = r.data[(y * r.width + x) * 4 + 3]!;
      if (a === 0) transparent++;
      else if (a === 255) opaque++;
      else partial++;
      if (a > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const n = r.width * r.height;
  const bbox = x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const touchesEdge = bbox !== null && (x0 === 0 || y0 === 0 || x1 === r.width - 1 || y1 === r.height - 1);
  let border = 0, borderSolid = 0;
  const visit = (x: number, y: number) => {
    border++;
    if (r.data[(y * r.width + x) * 4 + 3]! > 128) borderSolid++;
  };
  for (let x = 0; x < r.width; x++) { visit(x, 0); if (r.height > 1) visit(x, r.height - 1); }
  for (let y = 1; y < r.height - 1; y++) { visit(0, y); if (r.width > 1) visit(r.width - 1, y); }
  return { transparent: transparent / n, opaque: opaque / n, partial: partial / n, bbox, touchesEdge, borderOpaque: borderSolid / border };
}

/**
 * How visible the wrap-around seam is: the mean colour step across the
 * right→left (x) and bottom→top (y) borders, divided by the mean step between
 * neighbouring pixels inside the image. About 1 means the border is no
 * different from any other line of pixels; a plain non-tiling image scores
 * well above 3.
 */
export function seamScore(r: Raster): { x: number; y: number } {
  const { width: w, height: h, data } = r;
  const px = (x: number, y: number) => (y * w + x) * 4;
  const diff = (a: number, b: number) =>
    Math.abs(data[a]! - data[b]!) + Math.abs(data[a + 1]! - data[b + 1]!) + Math.abs(data[a + 2]! - data[b + 2]!);
  let inX = 0, inY = 0, seamX = 0, seamY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) inX += diff(px(x, y), px(x + 1, y));
    seamX += diff(px(w - 1, y), px(0, y));
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h - 1; y++) inY += diff(px(x, y), px(x, y + 1));
    seamY += diff(px(x, h - 1), px(x, 0));
  }
  const meanInX = inX / (h * (w - 1)), meanInY = inY / (w * (h - 1));
  return { x: seamX / h / Math.max(meanInX, 1e-6), y: seamY / w / Math.max(meanInY, 1e-6) };
}

// ─── transforms ───────────────────────────────────────────────────────────────

export function crop(r: Raster, x: number, y: number, width: number, height: number): Raster {
  const out = raster(width, height);
  for (let row = 0; row < height; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= r.height) continue;
    for (let col = 0; col < width; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= r.width) continue;
      const s = (sy * r.width + sx) * 4;
      out.data.set(r.data.subarray(s, s + 4), (row * width + col) * 4);
    }
  }
  return out;
}

/** Crop to the visible content plus a margin (a fraction of the larger side). */
export function trimToContent(r: Raster, margin = 0.04, threshold = 8): Raster {
  const { bbox } = alphaStats(r, threshold);
  if (!bbox) return r;
  const pad = Math.round(Math.max(bbox.width, bbox.height) * margin);
  return crop(r, bbox.x - pad, bbox.y - pad, bbox.width + 2 * pad, bbox.height + 2 * pad);
}

export function makeOpaque(r: Raster): Raster {
  const data = new Uint8Array(r.data);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: r.width, height: r.height, data };
}

/**
 * Ink on paper → ink on nothing: white becomes transparent, dark lines stay
 * opaque, grey hatching becomes partly transparent. For line art meant to be
 * laid over a floor (ground cover), where the paper behind the lines would
 * otherwise show as a white blob.
 */
export function knockOutPaper(r: Raster, black = 40, white = 235): Raster {
  const data = new Uint8Array(r.data);
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const ink = Math.min(1, Math.max(0, (white - lum) / (white - black)));
    data[i + 3] = Math.round(data[i + 3]! * ink);
  }
  return { width: r.width, height: r.height, data };
}

/** Area-average resize with premultiplied alpha (no dark fringes). */
export function resize(r: Raster, width: number, height: number): Raster {
  const out = raster(width, height);
  const sx = r.width / width, sy = r.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy, y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx, x1 = x0 + sx;
      let R = 0, G = 0, B = 0, A = 0, W = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          const wgt = wx * wy;
          const i = (Math.min(yy, r.height - 1) * r.width + Math.min(xx, r.width - 1)) * 4;
          const a = r.data[i + 3]! / 255;
          R += r.data[i]! * a * wgt;
          G += r.data[i + 1]! * a * wgt;
          B += r.data[i + 2]! * a * wgt;
          A += a * wgt;
          W += wgt;
        }
      }
      const o = (y * width + x) * 4;
      if (A > 0) {
        out.data[o] = Math.round(R / A);
        out.data[o + 1] = Math.round(G / A);
        out.data[o + 2] = Math.round(B / A);
      }
      out.data[o + 3] = Math.round((A / W) * 255);
    }
  }
  return out;
}

/** Fit inside a box, keeping aspect ratio. */
export function fit(r: Raster, box: number): Raster {
  const s = box / Math.max(r.width, r.height);
  return resize(r, Math.max(1, Math.round(r.width * s)), Math.max(1, Math.round(r.height * s)));
}

/** Alpha-composite `src` onto `dst` at (x, y), in place. */
export function draw(dst: Raster, src: Raster, x: number, y: number): void {
  for (let row = 0; row < src.height; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dst.height) continue;
    for (let col = 0; col < src.width; col++) {
      const dx = x + col;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (row * src.width + col) * 4, d = (dy * dst.width + dx) * 4;
      const a = src.data[s + 3]! / 255;
      if (a === 0) continue;
      const da = dst.data[d + 3]! / 255;
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = Math.round((src.data[s + c]! * a + dst.data[d + c]! * da * (1 - a)) / oa);
      }
      dst.data[d + 3] = Math.round(oa * 255);
    }
  }
}

export function fillRect(dst: Raster, x: number, y: number, w: number, h: number, rgba: [number, number, number, number]): void {
  for (let yy = Math.max(0, y); yy < Math.min(dst.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(dst.width, x + w); xx++) dst.data.set(rgba, (yy * dst.width + xx) * 4);
  }
}

export function checkerboard(width: number, height: number, cell = 16): Raster {
  const r = raster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 205 : 160;
      r.data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return r;
}

/** The image repeated n×n, to judge a tile. */
export function repeat(r: Raster, n: number): Raster {
  const out = raster(r.width * n, r.height * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) draw(out, r, i * r.width, j * r.height);
  return out;
}

// ─── labels ───────────────────────────────────────────────────────────────────

// 3×5 digits, enough to number the cells of a review sheet.
const DIGITS = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001",
  "111100111001111", "111100111101111", "111001010010010", "111101111101111", "111101111001111"];

export function drawNumber(dst: Raster, n: number, x: number, y: number, scale = 4): void {
  const text = String(n);
  fillRect(dst, x, y, text.length * 4 * scale + scale, 7 * scale, [20, 20, 20, 255]);
  [...text].forEach((ch, k) => {
    const glyph = DIGITS[Number(ch)]!;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy * 3 + gx] === "1") fillRect(dst, x + scale + (k * 4 + gx) * scale, y + scale + gy * scale, scale, scale, [255, 255, 255, 255]);
      }
    }
  });
}
