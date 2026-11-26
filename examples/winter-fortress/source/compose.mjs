import sharp from "sharp";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [output, option, ...rest] = process.argv.slice(2);
if (!output || !output.toLowerCase().endsWith(".webp") || (option && option !== "--ground-only") || rest.length) {
  throw new Error("Usage: node compose.mjs <new-output.webp> [--ground-only]");
}
if (existsSync(output)) throw new Error("Output already exists: " + output);

const folder = dirname(fileURLToPath(import.meta.url));
const source = (file) => join(folder, file);
const layout = JSON.parse(readFileSync(source("layout.json"), "utf8"));
const pack = JSON.parse(readFileSync(source("asset-pack.json"), "utf8"));
const assets = new Map(pack.assets.map(asset => [asset.key, asset]));

function assetImage(key) {
  const asset = assets.get(key);
  if (!asset) throw new Error("Missing art pack entry: " + key);
  const image = sharp(source(asset.source));
  if (!asset.crop) return image;
  const [left, top, width, height] = asset.crop;
  return image.extract({ left, top, width, height });
}

const pixelsPerSquare = 40;
const width = 72 * pixelsPerSquare;
const height = 128 * pixelsPerSquare;
const pixels = new Uint8ClampedArray(width * height * 3);
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const mix = (a, b, amount) => a + (b - a) * amount;

function smooth(start, end, value) {
  const t = clamp((value - start) / (end - start));
  return t * t * (3 - 2 * t);
}

function random(x, y, seed) {
  let bits = Math.imul(x + 13, 0x7feb352d) ^ Math.imul(y + 73, 0x846ca68b) ^ Math.imul(seed + 31, 0x27d4eb2d);
  bits = Math.imul(bits ^ (bits >>> 16), 0x45d9f3b);
  return ((bits ^ (bits >>> 15)) >>> 0) / 4294967296;
}

// Vary the wind and exposure continuously over several physical scales.
function noiseAt(spacing, seed) {
  const columns = Math.ceil(width / spacing) + 2;
  const rows = Math.ceil(height / spacing) + 2;
  const field = Float32Array.from({ length: columns * rows }, (_, index) =>
    random(index % columns, Math.floor(index / columns), seed) - 0.5);
  const column = Int32Array.from({ length: width }, (_, x) => Math.floor(x / spacing));
  const fraction = Float32Array.from({ length: width }, (_, x) => smooth(0, 1, (x / spacing) % 1));
  return (x, y) => {
    const origin = Math.floor(y / spacing) * columns + column[x];
    const north = mix(field[origin], field[origin + 1], fraction[x]);
    const south = mix(field[origin + columns], field[origin + columns + 1], fraction[x]);
    return mix(north, south, smooth(0, 1, (y / spacing) % 1));
  };
}

// Bake small radial influences once. This records meltwater near fires and exposed
// litter below trees without testing every object for every output pixel.
function influenceField(marks) {
  const samples = 8;
  const columns = 72 * samples + 1;
  const rows = 128 * samples + 1;
  const field = new Float32Array(columns * rows);
  for (const { x, y, radius, weight, stretch = 1 } of marks) {
    const left = Math.max(0, Math.floor((x - radius) * samples));
    const right = Math.min(columns - 1, Math.ceil((x + radius) * samples));
    const top = Math.max(0, Math.floor((y - radius * stretch) * samples));
    const bottom = Math.min(rows - 1, Math.ceil((y + radius * stretch) * samples));
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const distance = Math.hypot(column / samples - x, (row / samples - y) / stretch);
        const intensity = (1 - smooth(radius * 0.21, radius, distance)) * weight;
        const index = row * columns + column;
        field[index] = Math.max(field[index], intensity);
      }
    }
  }
  return (x, y) => {
    const column = x * samples;
    const row = y * samples;
    const index = Math.floor(row) * columns + Math.floor(column);
    const north = mix(field[index], field[index + 1], column % 1);
    const south = mix(field[index + columns], field[index + columns + 1], column % 1);
    return mix(north, south, row % 1);
  };
}

// Look up the original sampled spline at a pixel column or row.
function lineCoordinates(points, axis, length) {
  const ordered = [...points].sort((a, b) => a[axis] - b[axis]);
  const coordinates = new Float32Array(length);
  let segment = 1;
  for (let pixel = 0; pixel < length; pixel++) {
    const position = (pixel + 0.5) / pixelsPerSquare;
    while (segment < ordered.length - 1 && position > ordered[segment][axis]) segment++;
    const start = ordered[segment - 1];
    const end = ordered[segment];
    const progress = clamp((position - start[axis]) / (end[axis] - start[axis] || 1));
    coordinates[pixel] = mix(start[1 - axis], end[1 - axis], progress);
  }
  return coordinates;
}
const roadX = lineCoordinates(layout.road, 1, height);
const streamY = lineCoordinates(layout.stream, 0, width);
const spurY = lineCoordinates(layout.spur, 0, width);
const broadNoise = noiseAt(380, 1);
const driftNoise = noiseAt(117, 3);
const patchNoise = noiseAt(31, 4);
const grainNoise = noiseAt(11, 5);

async function materialTile(key, scale, seed) {
  const textureSize = 512;
  const texture = await assetImage(key).resize(textureSize, textureSize, { fit: "fill" }).removeAlpha().raw().toBuffer();

  // Each patch samples a different contiguous window in the source. Adjacent
  // patches crossfade before any window reaches the edge of the image.
  const spacing = 236;
  const columns = Math.ceil(width / spacing) + 2;
  const rows = Math.ceil(height / spacing) + 2;
  const patches = Array.from({ length: columns * rows }, (_, index) => {
    const x = index % columns;
    const y = Math.floor(index / columns);
    const margin = Math.ceil(spacing * 0.74 * scale) + 2;
    const available = textureSize - margin * 2;
    const sign = random(x, y, seed + 3) > 0.5 ? 1 : -1;
    return {
      left: x * spacing, top: y * spacing, sign,
      u: margin + random(x, y, seed + 1) * available,
      v: margin + random(x, y, seed + 2) * available,
    };
  });
  function texel(patch, x, y) {
    const u = clamp(Math.floor(patch.u + (x - patch.left) * scale * patch.sign), 0, textureSize - 1);
    const v = clamp(Math.floor(patch.v + (y - patch.top) * scale * patch.sign), 0, textureSize - 1);
    return (v * textureSize + u) * 3;
  }
  const color = new Float32Array(3);
  return (x, y) => {
    const gridX = x / spacing;
    const gridY = y / spacing;
    const origin = Math.floor(gridY) * columns + Math.floor(gridX);
    const tx = smooth(0.28, 0.72, gridX % 1);
    const ty = smooth(0.28, 0.72, gridY % 1);
    const nw = texel(patches[origin], x, y);
    const ne = texel(patches[origin + 1], x, y);
    const sw = texel(patches[origin + columns], x, y);
    const se = texel(patches[origin + columns + 1], x, y);
    for (let channel = 0; channel < 3; channel++) {
      const north = mix(texture[nw + channel], texture[ne + channel], tx);
      const south = mix(texture[sw + channel], texture[se + channel], tx);
      color[channel] = mix(north, south, ty);
    }
    return color;
  };
}

async function paintGround() {
  const [snow, trail, forest, ice] = await Promise.all([
    materialTile("drift-snow", 0.79, 0), materialTile("packed-trail", 0.92, 7),
    materialTile("woodland-floor", 0.91, 14), materialTile("frozen-water", 1.05, 21),
  ]);
  const litterAt = influenceField(layout.trees.map(tree => ({
    x: tree.x + tree.r * 0.15, y: tree.y + tree.r * 0.14,
    radius: tree.r * 1.73, weight: tree.kind === "pine" ? 1 : 0.50, stretch: 0.94,
  })));
  const warmthAt = influenceField(layout.braziers.map(([x,y]) => ({ x, y, radius: 2.4, weight: 1 })));
  const doorWearAt = influenceField([
    { x: 29.8, y: 103.55, radius: 1.15, stretch: 1.65, weight: 0.83 },
    { x: 30.1, y: 102.25, radius: 0.90, stretch: 1.55, weight: 0.65 },
    { x: 30.7, y: 101.12, radius: 0.76, stretch: 1.53, weight: 0.41 },
  ]);
  const pineLitter = [126, 115, 97];
  const fireLight = [255, 179, 81];
  for (let y = 0; y < height; y++) {
    const gy = (y + 0.5) / pixelsPerSquare;
    for (let x = 0; x < width; x++) {
      const gx = (x + 0.5) / pixelsPerSquare;
      const wind = broadNoise(x,y), drift = driftNoise(x,y), patch = patchNoise(x,y), grain = grainNoise(x,y);
      const edge = wind * 1.4 + drift * 0.65 + patch * 0.29 + grain * 0.11;
      const roadDistance = Math.abs(gx - roadX[y]);
      const spurDistance = Math.hypot(Math.max(23.5 - gx, gx - 43.5, 0), gy - spurY[x]);
      const arenaDistance = Math.hypot(gx - layout.arena.x, gy - layout.arena.y);
      const shedDistance = Math.hypot(Math.max(26 - gx, gx - 33, 0), Math.max(103 - gy, gy - 110, 0));
      const clearing = smooth(7, 12, arenaDistance + edge) * smooth(1, 5, shedDistance);
      const litter = clamp(litterAt(gx, gy) * (0.95 + patch * 0.32 + drift * 0.23));
      const woods = clamp(smooth(45, 64, gy + wind * 11 + drift * 4) * clearing * (0.57 + wind * 0.5 + drift * 0.45) + litter * 0.78);
      const creekDistance = Math.abs(gy - streamY[x]);
      const water = 1 - smooth(1.21 + edge * 0.28, 1.53 + edge * 0.28, creekDistance);
      const roadEdge = Math.min(roadDistance - 2.15, spurDistance - 1.03) + edge * 0.55;
      const doorstep = doorWearAt(gx, gy) * clamp(0.83 + patch * 0.75 + grain * 0.33);
      const track = Math.max(doorstep, (1 - smooth(-0.45, 0.68, roadEdge)) * clamp(0.78 + drift * 0.38 + patch * 0.18));
      const wheelDistance = Math.abs(roadDistance - 0.83 - drift * 0.10 - patch * 0.06);
      const wheel = (1 - smooth(0.015, 0.21, wheelDistance)) * (0.24 + clamp(0.35 + drift + patch * 0.45) * 0.6) * (1 - water);
      const bank = (1 - smooth(0.13, 0.68, Math.abs(creekDistance - 1.52 - edge * 0.28))) * 0.20;
      const shade = 1 + (wind * 0.05 + drift * 0.047 + patch * 0.025) * (1 - 0.5 * water);
      const heat = warmthAt(gx, gy) * (0.43 + drift * 0.08);
      const snowColor = snow(x, y);
      const forestColor = woods > 0.005 ? forest(x, y) : snowColor;
      const pathColor = track > 0.005 ? trail(x, y) : snowColor;
      const iceColor = water > 0.005 ? ice(x, y) : snowColor;
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        let value = mix(snowColor[channel], forestColor[channel], woods);
        value = mix(value, pineLitter[channel], litter * 0.30);
        value = mix(value, pathColor[channel], track);
        value = mix(value, iceColor[channel], water);
        value = value * shade * (1 - bank * (channel === 2 ? 0.45 : 0.70)) - wheel * 18;
        pixels[offset + channel] = mix(value, fireLight[channel], heat);
      }
    }
  }
}

async function paintFortress() {
  const stripHeight = 24 * pixelsPerSquare;
  const strip = await assetImage("gatehouse").resize(width, stripHeight, { fit: "fill" }).removeAlpha().raw().toBuffer();
  for (let y = 0; y < stripHeight; y++) {
    for (let x = 0; x < width; x++) {
      const gy = (y + 0.5) / pixelsPerSquare;
      const bank = gy + driftNoise(x, y) * 0.8 + patchNoise(x, y) * 0.23;
      const opacity = 1 - smooth(22.18, 23.96, bank);
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = mix(pixels[offset + channel], strip[offset + channel], opacity);
      }
    }
  }
}

function readSprites(keys) {
  return Promise.all(keys.map(key => assetImage(key).png().toBuffer()));
}

async function seatingPlank(shed) {
  // Reuse the shed's snow-dusted north timber for the two curved wooden benches.
  const { width, height } = await sharp(shed).metadata();
  return await sharp(shed).extract({
    left: Math.round(width * 0.10), top: Math.round(height * 0.01),
    width: Math.round(width * 0.26), height: Math.round(height * 0.058),
  }).png().toBuffer();
}

async function scenery() {
  const evergreenKeys = ["spruce", "pine", "spruce-broad", "spruce-open", "spruce-dense", "pine-old", "pine-windswept", "pine-spreading"];
  const deciduousKeys = ["bare-tree", "oak-frosted"];
  const [props, landmarks, dressing, evergreenArt, deciduousArt] = await Promise.all([
    readSprites(["boulder", "stone-lantern", "ox-cart"]),
    readSprites(["arena", "equipment-shed", "footbridge", "torii"]),
    readSprites(["brazier", "training-rack", "practice-post", "frosted-reeds"]),
    readSprites(evergreenKeys),
    readSprites(deciduousKeys),
  ]);
  const [boulder, lantern, cart] = props;
  const [arena, shed, bridge, torii] = landmarks;
  const [brazier, rack, pell, reed] = dressing;
  const plank = await seatingPlank(shed);
  const objects = [];
  const place = (art, x, y, w, h, options = {}) => objects.push({ art, x, y, w, h, ...options });

  for (let i = 0; i < 93; i++) {
    const x = random(i, 0, 43) * 72;
    if (Math.abs(x - layout.bridgeX) < 3.1) continue;
    const bank = streamY[Math.floor(x * pixelsPerSquare)];
    const side = random(i, 1, 65) > 0.48 ? 1 : -1;
    const size = 0.28 + random(i, 2, 74) * 0.53;
    const y = bank + side * (1.67 + random(i, 3, 44) * 0.42);
    place(reed, x, y, size, size * 0.85, { angle: random(i, 4, 53) * 170 - 85, shadow: 0, opacity: 0.72 });
  }
  for (const [index, rock] of layout.rocks.entries()) {
    const xs = rock.pts.map(point => point[0]);
    const ys = rock.pts.map(point => point[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    place(boulder, rock.x, rock.y, w, h, { angle: random(index, 2, 9) * 34 - 17, shadow: 0.09, dx: 0.15, dy: 0.18 });
  }
  for (const [x, y] of layout.lanterns) place(lantern, x, y, 1.05, 1.05, { dx: 0.16, dy: 0.24 });
  place(cart, layout.cart.x, layout.cart.y + 0.3, 2.9, 4.3, { angle: layout.cart.angle, shadow: 0.15, dx: 0.18, dy: 0.23 });
  place(arena, layout.arena.x, layout.arena.y, 13.35, 14.55, { fill: true, shadow: 0.16, dx: 0.18, dy: 0.22 });
  for (const side of [-1, 1]) {
    for (const degrees of [26, 39.5, 53, 66.5]) {
      const angle = side * degrees * Math.PI / 180;
      const x = layout.arena.x + 8.9 * Math.cos(angle);
      const y = layout.arena.y + 8.9 * Math.sin(angle);
      place(plank, x, y, 2.14, 0.54, { fill: true, angle: side * degrees + 90, shadow: 0.065 });
    }
  }
  for (const [x,y] of layout.braziers) place(brazier, x, y, 1.05, 1.05, { shadow: 0.07, dy: 0.10 });
  for (const {x,y} of layout.racks) place(rack, x, y, 1.34, 2.05, { fill: true, shadow: 0.075, dy: 0.12 });
  for (const [x,y] of layout.pells) place(pell, x, y, 0.96, 0.91, { fill: true, shadow: 0.08, dy: 0.15 });
  place(shed, 29.5, 107, 7.35, 6.4, { fill: true, shadow: 0.15, dx: 0.15, dy: 0.22 });
  place(bridge, layout.bridgeX, layout.streamBridgeY, 4.6, 6.85, { fill: true, shadow: 0.13, dx: 0.17, dy: 0.19 });
  // The beam spans the road. Its roughly inset pillars align to the two LOS rings.
  place(torii, layout.toriiX, layout.toriiY - 0.21, 9.45, 1.48, { fill: true, shadow: 0.17, dx: 0.34, dy: 0.58 });

  const planted = [];
  for (const [i, tree] of (option === "--ground-only" ? [] : layout.trees).entries()) {
    const pine = tree.kind === "pine";
    const choices = pine ? evergreenArt : deciduousArt;
    // These canopies have directional light painted into them. Choose a different
    // drawing near recent neighbors and keep every sprite's authored orientation.
    const nearby = planted.filter(other => Math.hypot(tree.x - other.x, tree.y - other.y) < 6);
    const distinct = choices.filter(art => !nearby.some(other => other.art === art));
    const available = distinct.length ? distinct : choices;
    const art = available[Math.floor(random(i, 0, 92) * available.length)];
    planted.push({ x: tree.x, y: tree.y, art });
    // Open stands and dense groves alternate. Scale around the trunk so the
    // painted cover never moves away from its sight blocker.
    const grove = 0.5 + 0.5 * Math.sin(tree.x * 0.26 + Math.sin(tree.y * 0.31)) * Math.cos(tree.y * 0.23);
    const age = random(i, 3, 117) ** 1.35;
    const diameter = tree.r * 2.06 * (0.60 + grove * 0.27 + age * 0.51);
    place(art, tree.x, tree.y, diameter, diameter, {
      dx: tree.r * 0.29, dy: tree.r * 0.39, shadow: 0.17,
      shadowOpacity: pine ? 0.51 : 0.42, tone: 0.94 + random(i, 2, 31) * 0.10, canopy: true,
    });
  }
  return objects;
}

async function renderSprite(object) {
  const w = Math.max(1, Math.round(object.w * pixelsPerSquare));
  const h = Math.max(1, Math.round(object.h * pixelsPerSquare));
  const resized = await sharp(object.art).resize(w, h, { fit: object.fill ? "fill" : "inside" }).png().toBuffer();
  const rotated = object.angle
    ? await sharp(resized).rotate(object.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
    : resized;
  const image = await sharp(rotated).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const blur = object.shadow ?? 0.11;
  const shade = blur === 0 ? null : await sharp(rotated).blur(Math.max(0.3, blur * pixelsPerSquare)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { ...object, image, shade };
}

const shadowTint = [0.38, 0.43, 0.57];
function stamp(texture, cx, cy, shadow, opacity, tone) {
  const { data, info } = texture;
  const left = Math.round(cx * pixelsPerSquare - info.width / 2);
  const top = Math.round(cy * pixelsPerSquare - info.height / 2);
  const x1 = Math.max(0, -left), x2 = Math.min(info.width, width - left);
  const y1 = Math.max(0, -top), y2 = Math.min(info.height, height - top);
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const src = (y * info.width + x) * 4;
      const alpha = data[src + 3] / 255 * opacity;
      if (alpha < 0.008) continue;
      const dest = ((top + y) * width + left + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const current = pixels[dest + channel];
        const value = shadow ? current * shadowTint[channel] : data[src + channel] * tone;
        pixels[dest + channel] = mix(current, value, alpha);
      }
    }
  }
}

async function paintScenery() {
  const objects = await scenery();
  // Blurred shadows and rotated sprites each need temporary image buffers.
  // Limit simultaneous Sharp jobs while keeping the output layer order stable.
  const rendered = [];
  for (let i = 0; i < objects.length; i += 8) {
    rendered.push(...await Promise.all(objects.slice(i, i + 8).map(renderSprite)));
  }
  for (const canopy of [false, true]) {
    const layer = rendered.filter(object => Boolean(object.canopy) === canopy).sort((a,b) => a.y - b.y);
    for (const object of layer) {
      if (object.shade) stamp(object.shade, object.x + (object.dx ?? 0.12), object.y + (object.dy ?? 0.15), true, object.shadowOpacity ?? 0.47, 1);
    }
    for (const object of layer) {
      stamp(object.image, object.x, object.y, false, object.opacity ?? 1, object.tone ?? 1);
    }
  }
}

await paintGround();
await paintFortress();
await paintScenery();
const image = await sharp(Buffer.from(pixels.buffer), { raw: { width, height, channels: 3 } })
  .webp({ quality: 91, effort: 5, smartSubsample: true }).toBuffer();
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, image, { flag: "wx" });
console.log("Wrote " + resolve(output) + " (2880 × 5120, " + layout.trees.length + " registered trees).");

