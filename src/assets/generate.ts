/**
 * One generation request → N stored, checked assets.
 *
 * After ComfyUI returns an image it is checked and cleaned before it is indexed:
 * transparent kinds are trimmed to their content and flagged when the
 * background was not removed or the object runs off the frame; tiles are made
 * fully opaque and get a seam score.
 */
import { readFileSync } from "node:fs";
import type { ComfyClient } from "./comfy.ts";
import type { AssetLibrary, AssetRecord } from "./library.ts";
import { alphaStats, decodePng, encodePng, knockOutPaper, makeOpaque, resize, seamScore, trimToContent, type Raster } from "./png.ts";
import { DEFAULT_BORDER, compositeVariant, detailLevel, edgesMatch, matchColour, variantMask } from "./variants.ts";
import { cloudVariant, type CloudOptions } from "./procedural.ts";
import { KINDS, composePrompt, type Kind, type KindPreset, type Motif, type Style } from "./presets.ts";
import { MODELS, buildInpaintWorkflow, buildWorkflow } from "./workflows.ts";

export interface GenerateRequest {
  kind: Kind;
  subject: string;
  /** Short label used in the id (`floor-oak-planks-1a2b3c`); defaults to the subject. */
  name?: string;
  style: Style;
  motif: Motif;
  extra?: string;
  tags?: string[];
  count: number;
  /** First seed; variant i uses seed + i. Random when absent. */
  seed?: number;
  width?: number;
  height?: number;
  /** Override the composed prompt entirely. */
  prompt?: string;
  /** Library asset ids shown to the model as reference images ("image 1", "image 2"...). */
  references?: string[];
}

export interface GeneratedAsset {
  record: AssetRecord;
  warnings: string[];
  seconds: number;
}

/** Content checks; empty when the image looks usable. */
export function checkImage(kind: KindPreset, metrics: Record<string, unknown>): string[] {
  const w: string[] = [];
  if (kind.alpha) {
    const borderOpaque = metrics.borderOpaque as number;
    if (metrics.empty) w.push("image is empty");
    else if (borderOpaque > 0.5) w.push(`${(borderOpaque * 100).toFixed(0)}% of the frame edge is opaque: background probably not removed`);
    else if (metrics.touchesEdge) w.push("content touches the frame edge: probably cut off");
  }
  if (kind.tileable) {
    const seam = metrics.seam as { x: number; y: number };
    if (Math.max(seam.x, seam.y) > 2) w.push(`visible seam (seam/interior x ${seam.x.toFixed(2)}, y ${seam.y.toFixed(2)})`);
  }
  return w;
}

export async function generateAssets(
  client: ComfyClient,
  library: AssetLibrary,
  req: GenerateRequest,
  onProgress?: (done: GeneratedAsset, index: number) => void,
): Promise<GeneratedAsset[]> {
  const kind: KindPreset = KINDS[req.kind];
  const prompt = req.prompt ?? composePrompt(req);
  const firstSeed = req.seed ?? Math.floor(Math.random() * 2 ** 31);
  const refNames: string[] = [];
  for (const id of req.references ?? []) {
    const ref = library.get(id);
    if (!ref) throw new Error(`no asset ${id} to use as a reference`);
    refNames.push(await client.upload(new Uint8Array(readFileSync(library.path(ref))), `dungeon-slop-ref-${ref.id}.png`));
  }
  const out: GeneratedAsset[] = [];
  for (let i = 0; i < req.count; i++) {
    const seed = firstSeed + i;
    const workflow = buildWorkflow(kind.workflow, {
      prompt,
      seed,
      width: req.width ?? kind.width,
      height: req.height ?? kind.height,
      prefix: `dungeon-slop/${req.kind}`,
      references: refNames,
    });
    const t0 = Date.now();
    const [bytes] = await client.run(workflow);
    if (!bytes) throw new Error("ComfyUI finished without saving an image");
    let image = decodePng(bytes);
    const metrics: Record<string, unknown> = { sourceWidth: image.width, sourceHeight: image.height };
    if (kind.alpha) {
      const s = alphaStats(image);
      Object.assign(metrics, {
        transparent: round(s.transparent), partial: round(s.partial), borderOpaque: round(s.borderOpaque),
        touchesEdge: s.touchesEdge, empty: s.bbox === null,
      });
      // Ink ground cover: drop the paper so the floor shows between the strokes.
      if (req.style === "ink" && !kind.solid) image = knockOutPaper(image);
      image = trimToContent(image);
    } else {
      image = makeOpaque(image);
    }
    if (kind.tileable) {
      const seam = seamScore(image);
      metrics.seam = { x: round(seam.x), y: round(seam.y) };
    }
    const record = library.add({
      kind: req.kind,
      subject: req.subject,
      name: req.name,
      style: req.style,
      motif: req.motif,
      width: image.width,
      height: image.height,
      alpha: kind.alpha,
      tileable: kind.tileable,
      prompt,
      model: kind.workflow === "sprite" ? `${MODELS.diffusion.file} + ${MODELS.turboLora.file}` : MODELS.diffusion.file,
      seed,
      workflow,
      metrics,
      png: encodePng(image),
      tags: [req.kind, req.style, req.motif, ...(req.tags ?? []), ...(req.references?.length ? ["from-references"] : [])],
    });
    const done = { record, warnings: checkImage(kind, metrics), seconds: (Date.now() - t0) / 1000 };
    out.push(done);
    onProgress?.(done, i);
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface VariantRequest {
  /** The tile to make variants of. */
  baseId: string;
  count: number;
  seed?: number;
  /** Edge band kept identical, fraction of the tile (default DEFAULT_BORDER). */
  border?: number;
  /** Width of the soft transition from kept band to new interior, fraction of the tile (default 0.06). */
  feather?: number;
  /** Describe the texture (default: the tile's own prompt, or its subject). */
  prompt?: string;
  /** 0..1, how far a variant may drift from the original (default 0.88). */
  strength?: number;
}

/**
 * What a variant is asked to be. Showing the model the original as a reference
 * made it copy the tile almost exactly (no variation); describing it in words
 * and repainting at ~0.85-0.9 strength keeps the material and rearranges the
 * stones. A prompt that refers to reference images ("image 1") is meaningless
 * here, so such tiles fall back to their subject.
 */
export function variantPrompt(base: { prompt: string; subject: string }): string {
  const own = base.prompt && !/\bimage \d\b/i.test(base.prompt) ? base.prompt : "";
  return own || `Seamless top-down texture of ${base.subject}, filling the whole image edge to edge, even flat lighting, no vignette, no shadows.`;
}

/** Tag every member of a variant set carries (the base included). */
export const variantTag = (baseId: string) => `variant-of-${baseId}`;

/**
 * Make `count` variants of a seamless tile that share its edges exactly.
 * AI tiles are inpainted with their own prompt; procedural tiles are redrawn
 * with new seeds. Both are composited onto the base's border band.
 */
export async function generateVariants(
  client: ComfyClient | null,
  library: AssetLibrary,
  req: VariantRequest,
  onProgress?: (done: GeneratedAsset, index: number) => void,
): Promise<GeneratedAsset[]> {
  const base = library.get(req.baseId);
  if (!base) throw new Error(`no asset ${req.baseId}`);
  if (!base.tileable) throw new Error(`${base.id} is not a seamless tile`);
  const baseImg = makeOpaque(decodePng(new Uint8Array(readFileSync(library.path(base)))));
  const mask = variantMask(baseImg.width, req.border ?? DEFAULT_BORDER, req.feather ?? 0.06);
  const procedural = base.model === "procedural:cloud";
  let names: { image: string; mask: string } | null = null;
  if (!procedural) {
    if (!client) throw new Error("ComfyUI is needed to make variants of an AI tile");
    names = {
      image: await client.upload(encodePng(baseImg), `dungeon-slop-variant-base-${base.id}.png`),
      mask: await client.upload(encodePng(mask), `dungeon-slop-variant-mask-${baseImg.width}-${Math.round((req.border ?? DEFAULT_BORDER) * 1000)}-${Math.round((req.feather ?? 0.06) * 1000)}.png`),
    };
  }
  library.tag(base.id, [variantTag(base.id)]);
  const firstSeed = req.seed ?? Math.floor(Math.random() * 2 ** 31);
  const out: GeneratedAsset[] = [];
  for (let i = 0; i < req.count; i++) {
    const seed = firstSeed + i;
    const t0 = Date.now();
    let inner: Raster;
    let workflow: unknown;
    if (procedural) {
      const params = base.workflow as CloudOptions;
      inner = cloudVariant(params, seed);
      workflow = { generator: "cloud-variant", base: base.id, variantSeed: seed, ...params };
    } else {
      const wf = buildInpaintWorkflow({
        prompt: req.prompt ?? variantPrompt(base), seed, image: names!.image, mask: names!.mask,
        prefix: "dungeon-slop/variant", denoise: req.strength ?? 0.88,
      });
      const [bytes] = await client!.run(wf);
      if (!bytes) throw new Error("ComfyUI finished without saving an image");
      inner = makeOpaque(decodePng(bytes));
      if (inner.width !== baseImg.width || inner.height !== baseImg.height) inner = resize(inner, baseImg.width, baseImg.height);
      workflow = { generator: "inpaint-variant", base: base.id, border: req.border ?? DEFAULT_BORDER, strength: req.strength ?? 0.88, workflow: wf };
    }
    // Procedural variants already blend into the edges over the whole tile; only
    // the outermost pixels (grain) are restored. AI variants keep a band.
    const img = procedural
      ? compositeVariant(baseImg, inner, variantMask(baseImg.width, 2 / baseImg.width, 2 / baseImg.width))
      : compositeVariant(baseImg, matchColour(baseImg, inner, mask), mask);
    const seam = seamScore(img);
    const record = library.add({
      kind: base.kind, subject: base.subject, name: `${base.id.replace(/^[a-z]+-/, "").replace(/-[0-9a-f]{6}$/, "").slice(0, 24)}-v`,
      style: base.style, motif: base.motif, width: img.width, height: img.height, alpha: false, tileable: true,
      prompt: base.prompt, model: procedural ? base.model : MODELS.diffusion.file, seed, workflow,
      metrics: { seam: { x: round(seam.x), y: round(seam.y) }, edgesMatchBase: edgesMatch(img, baseImg) },
      png: encodePng(img),
      tags: [...base.tags.filter((t) => t !== "favorite" && !t.startsWith("variant-of-")), "variant", variantTag(base.id)],
    });
    const warnings: string[] = edgesMatch(img, baseImg) ? [] : ["edges differ from the base"];
    const detail = detailLevel(img, mask) / Math.max(1e-6, detailLevel(baseImg, mask));
    if (detail > 1.3 || detail < 0.75) warnings.push(`detail ${detail.toFixed(2)}x the original's: may read as a patch of another material`);
    const done = { record, warnings, seconds: (Date.now() - t0) / 1000 };
    out.push(done);
    onProgress?.(done, i);
  }
  return out;
}
