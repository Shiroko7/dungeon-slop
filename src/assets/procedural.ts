/**
 * Procedural seamless textures: soft cloud noise mapped onto a colour ramp,
 * with film grain. For the surfaces diffusion models refuse to make plain
 * (murky deep water, fog, smoke, void): asked for "soft and featureless" they
 * add waves, specks and detail, and drift to a fine grain.
 *
 * Seamless by construction: every octave is gradient noise on a lattice that
 * wraps at the image edge.
 */
import { raster, type Raster } from "./png.ts";

export interface CloudOptions {
  size: number;
  /** Colour stops from darkest to lightest, "#rrggbb". */
  colors: string[];
  /** Blotches across the image at the coarsest octave (integer, wraps). */
  scale: number;
  octaves: number;
  /** Amplitude kept per octave, 0..1: higher is rougher. */
  roughness: number;
  /** 0..1: push values away from the middle, for crisper-edged blotches. */
  contrast: number;
  /** Grain standard deviation in 0..255 levels. */
  grain: number;
  seed: number;
  /**
   * Domain warp strength, in coarse blotches (0 = off, ~0.5 = currents): the
   * coordinates are pushed around by another noise field, turning round
   * blotches into swirls and streaks. Seamless, the warp field wraps too.
   */
  warp?: number;
  /** Bright drifting particles per tile (0 = off). */
  specks?: number;
  /**
   * "clouds" (default): soft blotches. "caustics": the bright web sunlight
   * casts through a rippling surface - cellular noise, brightest along cell
   * borders, two scales layered and warped so the web wobbles.
   */
  pattern?: "clouds" | "caustics";
}

export const CLOUD_DEFAULTS: Omit<CloudOptions, "colors" | "seed"> = {
  size: 1024, scale: 4, octaves: 5, roughness: 0.5, contrast: 0, grain: 3,
};

/** Small seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gradient noise on a period×period lattice that wraps, sampled at u,v in [0, period). */
function periodicNoise(period: number, random: () => number): (u: number, v: number) => number {
  const gx = new Float32Array(period * period), gy = new Float32Array(period * period);
  for (let i = 0; i < period * period; i++) {
    const a = random() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (u, v) => {
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const fx = u - x0, fy = v - y0;
    const dot = (ix: number, iy: number, dx: number, dy: number) => {
      const k = (((iy % period) + period) % period) * period + (((ix % period) + period) % period);
      return gx[k]! * dx + gy[k]! * dy;
    };
    const n00 = dot(x0, y0, fx, fy), n10 = dot(x0 + 1, y0, fx - 1, fy);
    const n01 = dot(x0, y0 + 1, fx, fy - 1), n11 = dot(x0 + 1, y0 + 1, fx - 1, fy - 1);
    const sx = fade(fx), sy = fade(fy);
    return (n00 + (n10 - n00) * sx) + ((n01 + (n11 - n01) * sx) - (n00 + (n10 - n00) * sx)) * sy;
  };
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Periodic cellular noise: one random point per cell of a period×period grid
 * (wrapping), returning the distance to the second-nearest point minus the
 * nearest one. Zero on the border between two cells.
 */
function periodicCells(period: number, random: () => number): (u: number, v: number) => number {
  const px = new Float32Array(period * period), py = new Float32Array(period * period);
  for (let i = 0; i < period * period; i++) {
    px[i] = random();
    py[i] = random();
  }
  return (u, v) => {
    const cx = Math.floor(u), cy = Math.floor(v);
    let f1 = Infinity, f2 = Infinity;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j;
        const k = (((gy % period) + period) % period) * period + (((gx % period) + period) % period);
        const dx = gx + px[k]! - u, dy = gy + py[k]! - v;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
    }
    return f2 - f1;
  };
}

function causticsField(o: CloudOptions, random: () => number): Float32Array {
  const base = Math.max(1, Math.round(o.scale));
  const coarse = periodicCells(base, random), fine = periodicCells(base * 2, random);
  const warp = o.warp ?? 0.3;
  const wx = [periodicNoise(base, random), periodicNoise(base * 2, random)];
  const wy = [periodicNoise(base, random), periodicNoise(base * 2, random)];
  // Soft glow over the web, so the light is not just thin lines.
  const glow = Array.from({ length: Math.max(1, o.octaves - 3) }, (_, i) => periodicNoise(base * 2 ** i, random));
  const n = o.size;
  const field = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let u = x / n, v = y / n;
      const dx = wx[0]!(u * base, v * base) + 0.5 * wx[1]!(u * base * 2, v * base * 2);
      const dy = wy[0]!(u * base, v * base) + 0.5 * wy[1]!(u * base * 2, v * base * 2);
      u += (dx * warp) / base;
      v += (dy * warp) / base;
      // Bright where the cell-border distance is small; the fine web is fainter.
      const line = (d: number, width: number) => Math.exp(-(d * d) / (width * width));
      let s = line(coarse(u * base, v * base), 0.12) + 0.55 * line(fine(u * base * 2, v * base * 2), 0.1);
      let g = 0, amp = 1;
      for (let i = 0; i < glow.length; i++) {
        g += amp * glow[i]!(u * base * 2 ** i, v * base * 2 ** i);
        amp *= o.roughness;
      }
      field[y * n + x] = s + 0.35 * g;
    }
  }
  return field;
}

function cloudField(o: CloudOptions, random: () => number): Float32Array {
  if (o.pattern === "caustics") return causticsField(o, random);
  const base = Math.max(1, Math.round(o.scale));
  const layers = Array.from({ length: o.octaves }, (_, i) => periodicNoise(base * 2 ** i, random));
  const warp = o.warp ?? 0;
  // Two low-frequency fields for the x and y displacement (only drawn when warping,
  // so unwarped textures keep the random sequence, and look, they always had).
  const wx = warp > 0 ? [periodicNoise(base, random), periodicNoise(base * 2, random)] : [];
  const wy = warp > 0 ? [periodicNoise(base, random), periodicNoise(base * 2, random)] : [];
  const n = o.size;
  const field = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Position in "tiles" (0..1); displacement keeps it periodic because the
      // warp fields wrap at whole multiples of the tile.
      let u = x / n, v = y / n;
      if (warp > 0) {
        const dx = wx[0]!(u * base, v * base) + 0.5 * wx[1]!(u * base * 2, v * base * 2);
        const dy = wy[0]!(u * base, v * base) + 0.5 * wy[1]!(u * base * 2, v * base * 2);
        u += (dx * warp) / base;
        v += (dy * warp) / base;
      }
      let sum = 0, amp = 1;
      for (let i = 0; i < layers.length; i++) {
        const period = base * 2 ** i;
        sum += amp * layers[i]!(u * period, v * period);
        amp *= o.roughness;
      }
      field[y * n + x] = sum;
    }
  }
  return field;
}

/** Soft bright dots, wrapped at the edges, added on top of a coloured texture. */
function addSpecks(out: Raster, count: number, random: () => number, keep: (x: number, y: number) => boolean = () => true): void {
  const n = out.width;
  for (let s = 0; s < count; s++) {
    const cx = random() * n, cy = random() * n;
    const r = n * (0.0015 + random() * 0.003);
    const strength = 25 + random() * 55;
    if (!keep(cx, cy)) continue;
    const R = Math.ceil(r * 3);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = (dx * dx + dy * dy) / (r * r);
        if (d2 > 9) continue;
        const a = strength * Math.exp(-d2);
        const x = ((Math.floor(cx) + dx) % n + n) % n, y = ((Math.floor(cy) + dy) % n + n) % n;
        const i = (y * n + x) * 4;
        // Cool, slightly cyan particles.
        out.data[i] = Math.min(255, out.data[i]! + a * 0.7);
        out.data[i + 1] = Math.min(255, out.data[i + 1]! + a * 0.9);
        out.data[i + 2] = Math.min(255, out.data[i + 2]! + a);
      }
    }
  }
}

/** The 2nd and 98th percentile of a field: the range the colour ramp is stretched over. */
function fieldRange(field: Float32Array): [number, number] {
  const sorted = Float32Array.from(field).sort();
  return [sorted[Math.floor(sorted.length * 0.02)]!, sorted[Math.floor(sorted.length * 0.98)]!];
}

export function cloudTexture(o: CloudOptions): Raster {
  if (o.colors.length < 2) throw new Error("need at least two colours");
  const random = rng(o.seed);
  const field = cloudField(o, random);
  const out = colourise(o, field, fieldRange(field), random);
  if (o.specks) addSpecks(out, o.specks, rng(o.seed ^ 0x5eed));
  return out;
}

/**
 * A variant of the cloud texture made with `o` that has exactly its edges:
 * a second field (seed `variantSeed`) fades in from the edges toward the
 * middle over the whole tile, so there is no band and no straight seam, and
 * the mix is rescaled to keep the original's contrast. Both share the base's
 * colour range, so variants match in tone. Grain is per pixel; callers that
 * need identical edge pixels composite the original's outermost rows back.
 */
export function cloudVariant(o: CloudOptions, variantSeed: number): Raster {
  if (o.colors.length < 2) throw new Error("need at least two colours");
  const base = cloudField(o, rng(o.seed));
  const random = rng(variantSeed);
  const other = cloudField(o, random);
  const n = o.size;
  const mixed = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // 1 at the edge, fading to 0 by 40% of the way to the centre: enough to blend
      // smoothly, while most of the tile (and so most blotches) is new.
      const d = Math.min(x, y, n - 1 - x, n - 1 - y) / (n / 2);
      const t = Math.min(1, d / 0.4);
      const w = 1 - t * t * (3 - 2 * t);
      const i = y * n + x;
      mixed[i] = (w * base[i]! + (1 - w) * other[i]!) / Math.max(1e-6, Math.hypot(w, 1 - w));
    }
  }
  const out = colourise(o, mixed, fieldRange(base), random);
  if (o.specks) {
    // The original's particles near the edges (so edges still match), new ones inside.
    const nearEdge = (x: number, y: number) => Math.min(x, y, n - 1 - x, n - 1 - y) < n * 0.12;
    addSpecks(out, o.specks, rng(o.seed ^ 0x5eed), nearEdge);
    addSpecks(out, o.specks, rng(variantSeed ^ 0x5eed), (x, y) => !nearEdge(x, y));
  }
  return out;
}

function colourise(o: CloudOptions, field: Float32Array, [lo, hi]: [number, number], random: () => number): Raster {
  const stops = o.colors.map(parseHex);
  const n = o.size;
  const out = raster(n, n);
  for (let i = 0; i < field.length; i++) {
    const u = Math.min(1, Math.max(0, (field[i]! - lo) / (hi - lo || 1)));
    const t = Math.min(1, Math.max(0, 0.5 + (u - 0.5) * (1 + 2 * o.contrast))) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    // Box-Muller grain; independent per pixel, so it tiles trivially.
    const g = o.grain * Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
    const a = stops[k]!, b = stops[k + 1]!;
    out.data[i * 4] = Math.max(0, Math.min(255, Math.round(a[0] + (b[0] - a[0]) * f + g)));
    out.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(a[1] + (b[1] - a[1]) * f + g)));
    out.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(a[2] + (b[2] - a[2]) * f + g)));
    out.data[i * 4 + 3] = 255;
  }
  return out;
}
