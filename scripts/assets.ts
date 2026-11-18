/**
 * assets — generate, review and organise map art (props, ground decals, creature
 * tokens, seamless floor and wall textures) with a local ComfyUI, into a
 * tagged, searchable library.
 *
 *   bun run assets help
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ComfyClient, ComfyError } from "../src/assets/comfy.ts";
import { generateAssets, generateVariants } from "../src/assets/generate.ts";
import { AssetLibrary, type AssetQuery, type AssetRecord, type AssetStatus } from "../src/assets/library.ts";
import { KINDS, MOTIFS, STYLES, asMotif, composePrompt, isKind, isStyle, type KindPreset } from "../src/assets/presets.ts";
import { contactSheet, type SheetBackground } from "../src/assets/sheet.ts";
import { CLOUD_DEFAULTS, cloudTexture } from "../src/assets/procedural.ts";
import { decodePng, encodePng, seamScore } from "../src/assets/png.ts";
import { blendLook, stainMap } from "../src/assets/blend.ts";
import { NODES, buildWorkflow, modelsFor, nodesFor } from "../src/assets/workflows.ts";

const HELP = `assets — generate and organise map art with a local ComfyUI

  doctor                                   check ComfyUI, its custom nodes and models, and the library
  serve                                    start ComfyUI headless on :8188 (Ctrl+C to stop)
  presets                                  list kinds, styles and motifs

  generate <kind> <subject> [options]      generate and store assets
      --style <ink|painted|flat>           default ink
      --motif <Default|Infernal|...>       default Default
      --count <n>                          variants, default 1 (seeds seed, seed+1, ...)
      --seed <n>                           first seed (random by default)
      --tags <a,b,c>                       extra tags (kind, style and motif are always tags)
      --extra <text>                       extra prompt detail, appended
      --name <label>                       short label for the ids (default: the subject)
      --size <WxH>                         output size, default 1024x1024
      --prompt <text>                      replace the composed prompt entirely
      --ref <id,id>                        library images shown to the model; refer to them in the
                                           prompt as "image 1", "image 2" (best with --prompt)
      --variants <n>                       floor/wall tiles: also make n edge-matched variants (default 4, 0 for none)
      --dry-run                            print the prompt and workflow, generate nothing
  noise <name> --colors <#dark,#mid,#light> [--scale 4] [--octaves 5] [--roughness 0.5] [--contrast 0]
        [--grain 3] [--size 1024] [--warp 0] [--specks 0] [--pattern clouds|caustics] [--seed N] [--count N] [--tags a,b] [--motif M]
                                           procedural seamless cloud texture (murk, fog, smoke, void)
                                           - no ComfyUI needed; stored as a floor tile
  blend <baseId> <overlayId> [--amount 0.35] [--softness 0.03] [--name <label>] [--tags a,b] [--count N]
                                           new tile: the base's stones with the overlay's staining and
                                           colour (--count makes amount variants around --amount)
  stain <assetId> [--softness 0.02] [--contrast 1.8] [--lines 0.012] [--name <label>]
                                           seamless stain map (pattern blurred away, patches kept) for
                                           use as a texture's blend layer
  variants <tileId> [--count 4] [--seed N] [--border 0.1] [--strength 0.88] [--feather 0.06] [--prompt <description>]
                                           variants of a seamless tile with identical edges, for random
                                           placement (maps pick them up automatically)
  list [filters]                           --kind --motif --style --status --tag a,b --text <s> --limit <n>
  show <id>                                everything recorded about an asset
  path <id>                                absolute path of the PNG
  tag <id> <a,b> [--remove <c,d>]          add / remove tags
  keep <id...> | reject <id...>            mark review status (--note <text>)
  prune --yes                              delete every rejected asset and its file
  delete <id>                              delete one asset and its file
  sheet [id...] [filters] --out <file.png> numbered review sheet (--bg checker|parchment|white|black)

Ids may be shortened to any unambiguous prefix. Library: $ASSET_LIBRARY_DIR or assets/library.
ComfyUI: $COMFY_URL (default http://127.0.0.1:8188).`;

// ─── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(arg.slice(2), true);
    else {
      flags.set(arg.slice(2), next);
      i++;
    }
  } else positional.push(arg);
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function list(value: string | undefined): string[] {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function intFlag(name: string): number | undefined {
  const v = flag(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a whole number`);
  return n;
}

function query(): AssetQuery {
  const status = flag("status");
  if (status && !["new", "keep", "reject"].includes(status)) fail("--status is new, keep or reject");
  const motif = flag("motif");
  return {
    kind: flag("kind"),
    motif: motif ? (asMotif(motif) ?? fail(`unknown motif ${motif}`)) : undefined,
    style: flag("style"),
    status: status as AssetStatus | undefined,
    tags: list(flag("tag")),
    text: flag("text"),
    limit: intFlag("limit"),
  };
}

function line(a: AssetRecord): string {
  const status = a.status === "new" ? "   " : a.status === "keep" ? " ✓ " : " ✗ ";
  return `${status}${a.id.padEnd(48)} ${`${a.width}x${a.height}`.padEnd(10)} ${a.style.padEnd(8)} ${a.motif.padEnd(10)} ${a.subject}`;
}

// ─── commands ─────────────────────────────────────────────────────────────────

const client = new ComfyClient();
const [command, ...rest] = positional;

async function doctor(): Promise<void> {
  const lib = new AssetLibrary();
  console.log(`library   ${lib.root}  (${lib.list().length} assets)`);
  const ping = await client.ping();
  if (!ping) {
    console.log(`comfyui   NOT reachable at ${client.url}. Run \`bun run assets serve\` or open ComfyUI Desktop.`);
    process.exitCode = 1;
    return;
  }
  console.log(`comfyui   ${client.url}  v${ping.version}  ${ping.device}  ${(ping.vramFree / 2 ** 30).toFixed(1)} GB VRAM free`);
  const types = await client.nodeTypes();
  let ok = true;
  for (const [node, source] of Object.entries(NODES)) {
    const has = node in types;
    ok &&= has;
    console.log(`node      ${has ? "ok     " : "MISSING"} ${node}${has ? "" : `  ← ${source}`}`);
  }
  const seen = new Set<string>();
  for (const m of [...modelsFor("sprite"), ...modelsFor("tile")]) {
    if (seen.has(m.file)) continue;
    seen.add(m.file);
    const has = (await client.models(m.folder)).includes(m.file);
    ok &&= has;
    console.log(`model     ${has ? "ok     " : "MISSING"} ${m.folder}/${m.file}${has ? "" : `  ← ${m.url}`}`);
  }
  console.log(ok ? "ready" : "not ready: fix the MISSING lines above");
  if (!ok) process.exitCode = 1;
}

function serve(): void {
  const local = process.env.LOCALAPPDATA ?? "";
  const comfyDir = process.env.COMFY_DIR ?? join(local, "Comfy-Desktop", "ComfyUI-Installs", "ComfyUI", "ComfyUI");
  const shared = process.env.COMFY_MODELS ?? join(local, "Comfy-Desktop", "ComfyUI-Shared");
  const python = process.env.COMFY_PYTHON ?? join(comfyDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(join(comfyDir, "main.py"))) fail(`no ComfyUI at ${comfyDir}; set COMFY_DIR to the folder holding main.py`);
  if (!existsSync(python)) fail(`no python at ${python}; set COMFY_PYTHON`);
  // ComfyUI Desktop passes its shared model folders on the command line; do the same.
  const folders = ["checkpoints", "clip", "clip_vision", "configs", "controlnet", "diffusers", "diffusion_models", "embeddings",
    "loras", "text_encoders", "unet", "upscale_models", "vae", "vae_approx", "model_patches", "background_removal"];
  const yaml = join(new AssetLibrary().root, ".comfy-extra-models.yaml");
  writeFileSync(yaml, `shared:\n  base_path: ${shared.replace(/\\/g, "/")}/\n  is_default: true\n${folders.map((f) => `  ${f}: models/${f}/`).join("\n")}\n`);
  const port = new URL(client.url).port || "8188";
  console.log(`starting ComfyUI from ${comfyDir} on :${port} (models: ${shared})`);
  const child = spawn(python, ["main.py", "--listen", "127.0.0.1", "--port", port, "--extra-model-paths-config", yaml,
    "--output-directory", join(shared, "output"), "--disable-auto-launch"], { cwd: comfyDir, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function presets(): void {
  console.log("kinds:");
  for (const [name, k] of Object.entries(KINDS) as [string, KindPreset][]) {
    console.log(`  ${name.padEnd(9)} ${k.summary}\n            e.g. ${k.examples.map((e) => `"${e}"`).join(", ")}`);
  }
  console.log("styles:");
  for (const [name, s] of Object.entries(STYLES)) console.log(`  ${name.padEnd(9)} ${s.summary}`);
  console.log(`motifs: ${MOTIFS.join(", ")}`);
}

async function generate(): Promise<void> {
  const [kind, ...subjectWords] = rest;
  if (!kind || !isKind(kind)) fail(`kind must be one of ${Object.keys(KINDS).join(", ")}`);
  const subject = subjectWords.join(" ").trim();
  if (!subject) fail("say what to generate, e.g. generate prop \"a wooden barrel\"");
  const style = flag("style") ?? "ink";
  if (!isStyle(style)) fail(`style must be one of ${Object.keys(STYLES).join(", ")}`);
  const motif = asMotif(flag("motif") ?? "Default") ?? fail(`motif must be one of ${MOTIFS.join(", ")}`);
  let width: number | undefined, height: number | undefined;
  const size = flag("size");
  if (size) {
    const m = /^(\d+)x(\d+)$/.exec(size);
    if (!m) fail("--size is WIDTHxHEIGHT, e.g. 1024x1024");
    [width, height] = [Number(m[1]), Number(m[2])];
    if (width < 256 || height < 256 || width * height > 2048 * 2048) fail("--size must be between 256x256 and about 4 MP");
  }
  const req = {
    kind, subject, style, motif, width, height, name: flag("name"),
    extra: flag("extra"), prompt: flag("prompt"), tags: list(flag("tags")),
    count: intFlag("count") ?? 1, seed: intFlag("seed"),
    references: ids(new AssetLibrary(), list(flag("ref"))).map((a) => a.id),
  };
  if (req.count < 1 || req.count > 32) fail("--count is 1 to 32");
  const prompt = req.prompt ?? composePrompt(req);
  if (flags.has("dry-run")) {
    console.log(prompt);
    console.log(JSON.stringify(buildWorkflow(KINDS[kind].workflow, { prompt, seed: req.seed ?? 0, width: width ?? 1024, height: height ?? 1024, prefix: "dry-run" }), null, 2));
    return;
  }
  const lib = new AssetLibrary();
  console.log(`generating ${req.count} × ${kind} "${subject}" (${style}, ${motif})`);
  const results = await generateAssets(client, lib, req, (r, i) => {
    console.log(`${String(i + 1).padStart(3)}. ${r.record.id}  ${r.record.width}x${r.record.height}  seed ${r.record.seed}  ${r.seconds.toFixed(1)}s`);
    for (const w of r.warnings) console.log(`     ! ${w}`);
  });
  const variantCount = KINDS[kind].tileable ? (intFlag("variants") ?? 4) : 0;
  for (const r of results) {
    if (variantCount === 0) break;
    console.log(`  variants of ${r.record.id}:`);
    await generateVariants(client, lib, { baseId: r.record.id, count: variantCount }, (v, i) =>
      console.log(`    ${i + 1}. ${v.record.id}  ${v.seconds.toFixed(1)}s${v.warnings.length ? "  ! " + v.warnings.join("; ") : ""}`));
  }
  console.log(`saved under ${lib.root}`);
  if (results.length > 1) console.log(`review: bun run assets sheet ${results.map((r) => r.record.id).join(" ")} --out sheet.png`);
}

async function variants(): Promise<void> {
  const lib = new AssetLibrary();
  const [id] = rest;
  if (!id) fail("variants <tileId>");
  const [base] = ids(lib, [id]);
  const border = flag("border") === undefined ? undefined : Number(flag("border"));
  if (border !== undefined && !(border > 0.02 && border < 0.4)) fail("--border is 0.02 to 0.4");
  const count = intFlag("count") ?? 4;
  console.log(`making ${count} variant(s) of ${base!.id}`);
  const procedural = base!.model === "procedural:cloud";
  const strength = flag("strength") === undefined ? undefined : Number(flag("strength"));
  if (strength !== undefined && !(strength > 0 && strength <= 1)) fail("--strength is above 0, up to 1");
  await generateVariants(procedural ? null : client, lib, { baseId: base!.id, count, seed: intFlag("seed"), border, strength, prompt: flag("prompt"), feather: flag("feather") === undefined ? undefined : Number(flag("feather")) }, (v, i) =>
    console.log(`${String(i + 1).padStart(3)}. ${v.record.id}  ${v.seconds.toFixed(1)}s  edges match: ${v.record.metrics.edgesMatchBase}${v.warnings.length ? "  ! " + v.warnings.join("; ") : ""}`));
}

function noise(): void {
  const name = rest.join(" ").trim() || fail("noise <name> --colors <#dark,#light>");
  const colors = list(flag("colors"));
  if (colors.length < 2) fail("--colors needs at least two #rrggbb colours, darkest first");
  const num = (k: string, d: number) => {
    const v = flag(k);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`--${k} must be a number`);
    return n;
  };
  const motif = asMotif(flag("motif") ?? "Default") ?? fail(`motif must be one of ${MOTIFS.join(", ")}`);
  const count = intFlag("count") ?? 1;
  const firstSeed = intFlag("seed") ?? Math.floor(Math.random() * 2 ** 31);
  const lib = new AssetLibrary();
  for (let i = 0; i < count; i++) {
    const params = {
      ...CLOUD_DEFAULTS,
      size: num("size", CLOUD_DEFAULTS.size), scale: num("scale", CLOUD_DEFAULTS.scale),
      octaves: num("octaves", CLOUD_DEFAULTS.octaves), roughness: num("roughness", CLOUD_DEFAULTS.roughness), contrast: num("contrast", CLOUD_DEFAULTS.contrast),
      grain: num("grain", CLOUD_DEFAULTS.grain), colors, seed: firstSeed + i,
      warp: num("warp", flag("pattern") === "caustics" ? 0.3 : 0), specks: num("specks", 0),
      pattern: (flag("pattern") ?? "clouds") as "clouds" | "caustics",
    };
    if (params.size < 64 || params.size > 4096) fail("--size is 64 to 4096");
    if (params.octaves < 1 || params.octaves > 8) fail("--octaves is 1 to 8");
    let img;
    try {
      img = cloudTexture(params);
    } catch (e) {
      fail((e as Error).message);
    }
    const seam = seamScore(img);
    const a = lib.add({
      kind: "floor", subject: name, name, style: "procedural", motif, width: img.width, height: img.height,
      alpha: false, tileable: true, prompt: "", model: "procedural:cloud", seed: params.seed,
      workflow: { generator: "cloud", ...params }, metrics: { seam: { x: Math.round(seam.x * 1000) / 1000, y: Math.round(seam.y * 1000) / 1000 } },
      png: encodePng(img), tags: ["floor", "procedural", motif, ...list(flag("tags"))],
    });
    console.log(`${String(i + 1).padStart(3)}. ${a.id}  ${a.width}x${a.height}  seed ${a.seed}  seam x ${seam.x.toFixed(2)} y ${seam.y.toFixed(2)}`);
  }
}

function blend(): void {
  const lib = new AssetLibrary();
  const [baseId, overlayId] = rest;
  if (!baseId || !overlayId) fail("blend <baseId> <overlayId>");
  const [base, overlay] = ids(lib, [baseId, overlayId]);
  if (!base!.tileable || !overlay!.tileable) console.log("warning: blending is meant for seamless tiles");
  const amount = Number(flag("amount") ?? 0.35);
  const softness = Number(flag("softness") ?? 0.03);
  if (!(amount >= 0 && amount <= 1)) fail("--amount is 0 to 1");
  if (!(softness > 0 && softness <= 0.5)) fail("--softness is above 0, up to 0.5");
  const count = intFlag("count") ?? 1;
  const baseImg = decodePng(readFileSync(lib.path(base!)));
  const overImg = decodePng(readFileSync(lib.path(overlay!)));
  for (let i = 0; i < count; i++) {
    // Several: spread the amount around the one asked for.
    const a = count === 1 ? amount : Math.min(1, Math.max(0, amount * (0.6 + (0.8 * i) / (count - 1))));
    const img = blendLook(baseImg, overImg, { amount: a, softness });
    const seam = seamScore(img);
    const name = flag("name") ?? `${base!.id.replace(/-[0-9a-f]{6}$/, "")}-blend`;
    const rec = lib.add({
      kind: base!.kind, subject: `${base!.subject} (blended with ${overlay!.id}, ${Math.round(a * 100)}%)`, name,
      style: base!.style, motif: base!.motif, width: img.width, height: img.height, alpha: false, tileable: base!.tileable,
      prompt: "", model: "blend", seed: 0,
      workflow: { generator: "blend", base: base!.id, overlay: overlay!.id, amount: a, softness },
      metrics: { seam: { x: Math.round(seam.x * 1000) / 1000, y: Math.round(seam.y * 1000) / 1000 } },
      png: encodePng(img), tags: [...new Set([...base!.tags.filter((t) => t !== "favorite"), "blend", ...list(flag("tags"))])],
    });
    console.log(`${String(i + 1).padStart(3)}. ${rec.id}  amount ${Math.round(a * 100)}%  seam x ${seam.x.toFixed(2)} y ${seam.y.toFixed(2)}`);
  }
}

function stain(): void {
  const lib = new AssetLibrary();
  const [srcId] = rest;
  if (!srcId) fail("stain <assetId>");
  const [src] = ids(lib, [srcId]);
  const softness = Number(flag("softness") ?? 0.02);
  const contrast = Number(flag("contrast") ?? 1.8);
  if (!(softness > 0 && softness <= 0.5)) fail("--softness is above 0, up to 0.5");
  const lines = Number(flag("lines") ?? 0.012);
  const img = stainMap(decodePng(readFileSync(lib.path(src!))), softness, contrast, lines);
  const seam = seamScore(img);
  const rec = lib.add({
    kind: src!.kind, subject: `stains of ${src!.subject}`, name: flag("name") ?? `${src!.id.replace(/-[0-9a-f]{6}$/, "")}-stain`,
    style: src!.style, motif: src!.motif, width: img.width, height: img.height, alpha: false, tileable: true,
    prompt: "", model: "stain", seed: 0, workflow: { generator: "stain", source: src!.id, softness, contrast, lines },
    metrics: { seam: { x: Math.round(seam.x * 1000) / 1000, y: Math.round(seam.y * 1000) / 1000 } },
    png: encodePng(img), tags: ["stain", "blend-layer", src!.motif.toLowerCase(), ...list(flag("tags"))],
  });
  console.log(`${rec.id}  seam x ${seam.x.toFixed(2)} y ${seam.y.toFixed(2)}`);
}

function ids(lib: AssetLibrary, args: string[]): AssetRecord[] {
  return args.map((a) => {
    try {
      return lib.resolve(a);
    } catch (e) {
      fail((e as Error).message);
    }
  });
}

async function main(): Promise<void> {
  switch (command) {
    case undefined:
    case "help":
      console.log(HELP);
      return;
    case "doctor":
      return doctor();
    case "serve":
      return serve();
    case "presets":
      return presets();
    case "generate":
      return generate();
    case "noise":
      return noise();
    case "variants":
      return variants();
    case "blend":
      return blend();
    case "stain":
      return stain();
  }
  const lib = new AssetLibrary();
  switch (command) {
    case "list": {
      const found = lib.list(query());
      for (const a of found) console.log(line(a));
      console.log(`${found.length} asset${found.length === 1 ? "" : "s"}`);
      break;
    }
    case "show": {
      const [a] = ids(lib, rest.slice(0, 1));
      if (!a) fail("show <id>");
      const { workflow: _w, ...shown } = a;
      console.log(JSON.stringify({ ...shown, path: lib.path(a) }, null, 2));
      break;
    }
    case "path": {
      const [a] = ids(lib, rest.slice(0, 1));
      if (!a) fail("path <id>");
      console.log(lib.path(a));
      break;
    }
    case "tag": {
      const [a] = ids(lib, rest.slice(0, 1));
      if (!a) fail("tag <id> <a,b>");
      console.log(line(lib.tag(a.id, list(rest[1]), list(flag("remove")))), "\n   tags:", lib.get(a.id)!.tags.join(", "));
      break;
    }
    case "keep":
    case "reject": {
      const targets = ids(lib, rest);
      if (targets.length === 0) fail(`${command} <id...>`);
      for (const a of targets) console.log(line(lib.setStatus(a.id, command, flag("note"))));
      break;
    }
    case "prune": {
      const rejected = lib.list({ status: "reject" });
      if (!flags.has("yes")) fail(`would delete ${rejected.length} rejected asset(s); add --yes`);
      for (const a of rejected) lib.remove(a.id);
      console.log(`deleted ${rejected.length} rejected asset(s)`);
      break;
    }
    case "delete": {
      const [a] = ids(lib, rest.slice(0, 1));
      if (!a) fail("delete <id>");
      lib.remove(a.id);
      console.log(`deleted ${a.id}`);
      break;
    }
    case "sheet": {
      const out = flag("out");
      if (!out) fail("sheet needs --out <file.png>");
      const chosen = rest.length ? ids(lib, rest) : lib.list({ ...query(), limit: intFlag("limit") ?? 48 });
      if (chosen.length === 0) fail("no assets match");
      const bg = (flag("bg") ?? "checker") as SheetBackground;
      if (!["checker", "parchment", "white", "black"].includes(bg)) fail("--bg is checker, parchment, white or black");
      writeFileSync(resolve(out), contactSheet(lib, chosen, { background: bg, columns: intFlag("columns") }));
      chosen.forEach((a, i) => console.log(`${String(i + 1).padStart(3)}. ${line(a).trimStart()}`));
      console.log(`wrote ${resolve(out)}`);
      break;
    }
    default:
      fail(`unknown command ${command}; try \`bun run assets help\``);
  }
  lib.close();
}

main().catch((e) => {
  if (e instanceof ComfyError) fail(e.message);
  throw e;
});

