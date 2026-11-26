---
name: assets
description: Generate, review, tag and organise map art (transparent props, ground decals like vegetation/rubble/puddles, creature tokens, seamless floor and wall textures) with the user's local ComfyUI through `bun run assets`, into the tagged asset library. Use when the user asks for map assets, textures, tiles, sprites or to stylise a dungeon's look, or to find or clean up stored assets.
---

# Map art with ComfyUI

`scripts/assets.ts` (run as `bun run assets …`) drives a local ComfyUI over its
HTTP API and stores results in `assets/library/` (git-ignored): PNGs under
`<kind>/<motif>/<id>.png` plus `index.sqlite` with prompt, seed, the exact
workflow, quality metrics, review status and tags. `bun` lives at
`%USERPROFILE%\.bun\bin\bun.exe`; prepend it to PATH in non-interactive shells.

```sh
bun run assets doctor          # ComfyUI up? custom nodes and models present?
bun run assets serve           # start ComfyUI headless on :8188 (run in background)
bun run assets presets         # kinds, styles, motifs with example subjects
bun run assets generate <kind> "<subject>" [--style ink|painted|flat] [--motif M]
      [--count N] [--seed N] [--name short-label] [--tags a,b] [--extra "..."] [--size WxH] [--dry-run]
bun run assets noise <name> --colors "#dark,#mid,#light" [--scale 5 --octaves 6 --roughness 0.56 --contrast 0.12 --grain 2.6]
bun run assets list [--kind --motif --style --status new|keep|reject --tag a,b --text s]
bun run assets sheet <ids...|filters> --out sheet.png [--bg checker|parchment|white|black]
bun run assets keep|reject <ids...> [--note "..."];  bun run assets prune --yes
bun run assets show|path|delete <id>;  bun run assets tag <id> a,b [--remove c]
```

## Workflow

1. `doctor`. If ComfyUI is not reachable, run `serve` in the background (or ask
   the user to open ComfyUI Desktop and click the ComfyUI card; both use :8188,
   so never run both).
2. Generate 2-4 variants (`--count`) with a short `--name` for readable ids.
3. Build a `sheet` into a temporary folder and LOOK at it (open the PNG as an image). Check:
   truly overhead (not three-quarter), object complete and centred, clean
   alpha, tiles show no line through the middle of the 2×2 repeat. Read the
   `!` warnings the generator prints (opaque border = background not removed;
   touches edge = cut off; seam score > 2).
4. `keep` the good ones, `reject` the rest, `prune --yes` only rejected ones the
   user has seen or that you generated as tests. Never prune the user's keeps.
5. Report ids and show the sheet to the user when it is their call.

## Putting art on a map

Putting existing art on a map is a UI job: do it in the app through the browser
tools (`app-ui` skill, `.agents/skills/app-ui/SKILL.md`), not with `dungeon style`. Use the CLI below only when the
browser is unavailable or for bulk changes.

In the app, a tool rail on the left of the map: **V** select/pan, **T** Texture
tool (layers: rooms, floor, background; preview opens the catalog, F; tile size,
rotation, darken, tile/fit), **S** Stamp tool (click to place a prop/decal/token,
click to select, drag to move, Del to delete; size, rotation with random,
opacity, shadow, flip). Objects are stored in `style.objects` (cells, centre) and
belong to the room under their centre; the room inspector shows that room's
floor (inherited or its own) and its objects. `--clear --objects` removes all
placed objects from the CLI. From the CLI:

`bun run dungeon style <mapId> --floor <assetId> [--cells N] [--shade 0..1]` tiles a
floor texture over every room and corridor; `--room <roomId>` overrides one room;
`--room <id> --fit` draws one image (e.g. a round mosaic for a round room) over
that room instead of tiling; `--background <assetId>` tiles everything outside the
floor (around and between rooms, and the canvas beyond the map), e.g. water;
`--clear` removes all art, `--clear --background` / `--clear --room <id>` just that part. `--cells` is how many grid cells
one repeat spans (default 4: pick it so slabs/planks are 1-2 cells), `--shade`
darkens without regenerating. The app serves library PNGs at
`/api/assets/<id>.png` and redraws when they load; reload an open map after
styling it. `rebuild` keeps the style. Screenshot the map to check (see the
`verify` skill) - a medallion should meet the wall with no ring of floor showing.

For a fitted round image, generate a `decal` with `--prompt` asking for a
perfect circle filling the frame edge to edge (the "touches the frame edge"
warning is then expected) and pick the flattest one. For water, use motif
Default (Aquatic adds coral/barnacle specks) and describe the waves and foam
explicitly, or it comes out as flat murky blue; lighting words like
"underwater light" or "dim" make tiles blotchy - keep tiles evenly lit and use
`--shade` for darkness.

## Variant sets (break up repetition)

Every floor/wall tile should have a variant set: `generate floor|wall` makes 4
automatically (`--variants N`, 0 for none); for existing tiles run
`assets variants <id> [--count 4] [--prompt "<plain description>"]`. Members
share the base's edges exactly (checked: "edges match: true") and are tagged
`variant-of-<base>`. `dungeon style` and the app's texture picker attach the
set automatically (`--no-variants` to skip, `--shuffle N` / the Shuffle button
to re-roll placement); the renderer picks one per tile position by a stable hash,
in grid and radial layouts.
- AI tiles: interior inpainted (border 0.1, strength 0.88) and colour-matched.
  Do NOT show the original as a reference image - the model then copies it
  (no variation). If the tile's prompt mentions "image 1", pass `--prompt`
  with a plain description. A detail-ratio warning means a variant reads as a
  patch of other material: delete it.
- Procedural tiles: the new noise fades in over the whole tile (no band); a
  band of shared border would show as a square lattice in soft noise.
- Review with a random 4x4 grid of the set before using it.

## Mixing two looks ("like A, with some of B")

Use `generate --ref A,B --prompt "... image 1 ... image 2 ..."`: Qwen 2.1 sees the
library images and makes one coherent new tile (the user's "20 more prevalent
than 21" became "use image 1 as the floor ... weather it with the look of image
2 ... image 1 should dominate"). Pixel blending does not work well:
`assets blend` bakes B's stains into A's repeat (a regular lattice once tiled),
and B's joints survive blurring as a ghost grid (`assets stain` with `--lines`
removes thin dark joints, not stud rows). A texture can also carry a `blend`
layer at its own scale (`dungeon style --blend <id> --blend-cells 24
--blend-amount --blend-mode`), which avoids the lattice but still needs a
pattern-free source.

## Soft, featureless surfaces: use `noise`, not the model

Murky deep water, fog, smoke, void, plain cloudy ground: Qwen will not make
these plain. Asked for "soft, no waves", it still adds waves, coral specks or a
fine grain, and it comes out too dark. `noise` makes seamless cloud noise on a
colour ramp in about a second, with no ComfyUI needed. When the user shows a
reference, measure it (colours at the 2nd/50th/98th luminance percentile, grain,
blotch size), set `--colors` from those, compare side by side, and tune
`--contrast` and `--roughness`. The deep-water background on map 48 is
`--colors "#13273d,#213e55,#40657d" --scale 5 --octaves 6 --roughness 0.56
--contrast 0.12 --grain 2.6`. Use a large `--cells` repeat (about half the
map) so the repeat doesn't show as a lattice. For detail, use `--size 2048 --octaves 8`, a little `--warp` (0.15-0.35: current streaks; 0.6+ turns into marble) and `--specks` (drifting particles); the map 48 background is `deep-water-hd` (`--scale 5 --roughness 0.58 --contrast 0.14 --warp 0.25 --specks 90`). Qwen deep-water attempts at 2K came out near-black and featureless or with wave streaks.

## Writing subjects (this matters more than anything else)

- Concrete beats generic. Say what the units are and how many cross the image:
  `"six long weathered oak floorboards running horizontally, each about a sixth
  of the image tall"` gives planks; `"wooden floor planks"` gives tiny parquet.
  Same for stones ("about five across the image").
- Props: name the material and the visible top surface (a chest *open*, a table
  *with plates*). Things with a "front" (chests, doors, wardrobes) drift to
  three-quarter view; regenerate or add `--extra "only the top is visible"`.
- Creatures come out high-angle rather than strictly overhead. Fine for tokens.
- Decals: describe ground cover as a patch ("a patch of ferns", "scattered
  rubble"); dark water reads as a hole, so say "shallow, reflective".
- Motif (`--motif Infernal` etc.) adds the dungeon theme's materials/palette.

## Styles

- `ink`: black ink with hatching, matching the app's hand-drawn maps. Props and
  creatures get a solid white-paper interior so they hide the floor; decals get
  the paper knocked out so the floor shows between strokes.
- `painted`: full-colour VTT battle-map look. Best quality overall.
- `flat`: flat vector colours with outlines.

## How it works (for changing it)

- Model: Qwen Image 2.1 int8 (already installed) writes a real alpha channel when
  the prompt is wrapped in its RGBA sentences (`src/assets/presets.ts`); no
  background removal pass. Sprites use the turbo LoRA (8 steps, ~7 s); tiles use
  the full model (25 steps, ~18 s).
- Seamless tiles: `SeamlessTileModelDiT` (Universal Seamless Tiles pack) rolls
  the latent each step; our `DslopWrapDecode` node
  (`comfy/custom_nodes/dungeon_slop_nodes`, junctioned into ComfyUI's
  `custom_nodes`) decodes on a torus. Turbo + roll gives banding; the
  pack's circular VAE deep-copies the VAE and crashed the server;
  AdvancedTiling fails on Qwen 2.1 (rope shape). Details in `src/assets/workflows.ts`.
- Post-processing (`src/assets/generate.ts`, `png.ts`): trim to content, ink
  knockout, opaque tiles, metrics.
- Setup on a new machine: `doctor` prints the download URL of any missing model
  and the source of any missing node.

## Options researched (2026-10-15) and not installed

Civitai downloads need the user's API key or a logged-in browser; never ask for
the key in chat, let the user download or set `CIVITAI_API_TOKEN` themselves.
- **Top Down BattleMap Assets for Anima** (civitai 2636893, 88 MB, trigger
  `mapasset`): top-down props on the Anima model the user already has. Same
  author has an Illustrious version (2398156).
- **Mapcraft** (civitai 799901): whole battle maps; Anima, Flux.1 and Illustrious versions.
- **Krea 2 LoRAs** "Top-down Tokens" (2831033) and "Battlemaps" (2831782), Aug 2026;
  need the Krea 2 base model.
- **Stylized Textures (Game Asset) [ZIT]** (503877, most-liked texture LoRA):
  needs Z-Image Turbo. **Flux Hand-Painted Textures** (652904) and **Hand-Painted
  2d Seamless Textures** (SDXL, 483692): older bases.
- **Qwen-Image-2.1-Fix** LoRA (huggingface e-n-v-y/Qwen-Image-2.1-Fix): community
  fix for washed-out colour/fine texture; untested here.
- Qwen 2.1 also does subject extraction and layer decomposition (official
  templates) for cutting assets out of existing art.
