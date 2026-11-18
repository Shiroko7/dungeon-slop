/**
 * What can be generated (kinds), how it should look (styles) and how a dungeon
 * motif tints it - composed into one Qwen Image 2.1 prompt.
 *
 * Qwen follows plain descriptive English well; it needs the camera spelled out
 * ("directly above", "orthographic") or it drifts to three-quarter views, and it
 * needs the exact RGBA framing sentences to write an alpha channel.
 */
import type { WorkflowKind } from "./workflows.ts";

export const MOTIFS = ["Default", "Infernal", "Aquatic", "Natural", "Arcane", "Undead", "Mechanical", "Frozen"] as const;
export type Motif = (typeof MOTIFS)[number];

export interface KindPreset {
  workflow: WorkflowKind;
  /** One line for `presets`. */
  summary: string;
  /** Subject framing; `{subject}` is replaced. */
  frame: string;
  width: number;
  height: number;
  /** Transparent output, trimmed to its content. */
  alpha: boolean;
  /** A solid object that should hide what is under it (props, creatures), not ground cover. */
  solid: boolean;
  tileable: boolean;
  examples: string[];
}

export const KINDS = {
  prop: {
    workflow: "sprite",
    summary: "a single object for a room: furniture, statue, chest, barrel, altar (transparent)",
    frame:
      "{subject}, seen from directly above: a bird's-eye view looking straight down, so only its top surface is visible and none of its front or sides, " +
      "as it would appear on a tabletop battle map. " +
      "One object only, centred, completely inside the frame with empty space around it. No floor, no ground, no cast shadow, no scenery",
    width: 1024,
    height: 1024,
    alpha: true,
    solid: true,
    tileable: false,
    examples: ["a wooden barrel with iron hoops", "a stone altar with candles", "an open treasure chest full of coins", "a long feast table with benches"],
  },
  decal: {
    workflow: "sprite",
    summary: "ground detail laid flat on the floor: vegetation, rubble, puddles, moss, bones, cracks (transparent)",
    frame:
      "a flat patch of {subject} lying on the ground, seen from directly above in a strict top-down orthographic view. " +
      "Irregular natural outline that fades out softly at the edges, centred, completely inside the frame with empty space around it. No floor surface, no scenery",
    width: 1024,
    height: 1024,
    alpha: true,
    solid: false,
    tileable: false,
    examples: ["ferns and low weeds", "scattered rubble and broken stones", "a shallow water puddle", "green moss", "scattered bones"],
  },
  creature: {
    workflow: "sprite",
    summary: "a creature or character token seen from above (transparent)",
    frame:
      "{subject}, seen from directly overhead as a tabletop battle map token: a bird's-eye view looking straight down at the top of its head and shoulders, " +
      "body and limbs foreshortened below. One figure only, centred, completely inside the frame with empty space around it. No ground, no cast shadow, no border ring",
    width: 1024,
    height: 1024,
    alpha: true,
    solid: true,
    tileable: false,
    examples: ["a goblin with a spear", "a giant spider", "a skeleton warrior"],
  },
  floor: {
    workflow: "tile",
    summary: "seamless floor texture that repeats in both directions (opaque)",
    frame:
      "Top-down view of {subject}, seen from directly above, filling the whole image edge to edge. " +
      "Seamless tileable texture with even, flat lighting: no vignette, no light patches, no shadows",
    width: 1024,
    height: 1024,
    alpha: false,
    solid: false,
    tileable: true,
    // Say what the units are and how many cross the image: "a texture of planks" gives parquet.
    examples: [
      "six long weathered oak floorboards running horizontally, each about a sixth of the image tall, with knots and nail heads",
      "large irregular grey flagstones, about five across the image, with dark mortar gaps",
      "packed brown dirt with scattered small pebbles",
      "short green grass with a few clover patches",
    ],
  },
  wall: {
    workflow: "tile",
    summary: "seamless texture for the solid rock/wall mass around rooms (opaque)",
    frame:
      "Top-down view of {subject}, seen from directly above, filling the whole image edge to edge. " +
      "Seamless tileable texture with even, flat lighting: no vignette, no light patches, no shadows",
    width: 1024,
    height: 1024,
    alpha: false,
    solid: false,
    tileable: true,
    examples: ["rough dark bedrock with large cracks and fissures", "packed earth threaded with thick roots"],
  },
} satisfies Record<string, KindPreset>;
export type Kind = keyof typeof KINDS;

export interface StylePreset {
  summary: string;
  /** Appended to every prompt. */
  text: string;
}

export const STYLES = {
  ink: {
    summary: "black ink line art with hatching, matching the app's hand-drawn maps",
    text:
      "Drawn in bold black ink on white paper, strong confident outlines with cross-hatching for shading, like an illustration in an old-school dungeon map. " +
      "High contrast monochrome, no colour, no grey wash",
  },
  painted: {
    summary: "full-colour painted battle-map art (VTT style)",
    text:
      "Semi-realistic hand-painted digital art in full colour, crisp edges, rich material detail, soft light from above, " +
      "in the style of premium virtual tabletop battle map assets",
  },
  flat: {
    summary: "clean flat-colour vector look with dark outlines",
    text: "Clean flat-colour vector illustration with bold dark outlines and simple cel shading, limited palette",
  },
} satisfies Record<string, StylePreset>;
export type Style = keyof typeof STYLES;

/** How each motif shifts materials and palette. Default adds nothing. */
export const MOTIF_TEXT: Record<Motif, string> = {
  Default: "",
  Infernal: "Infernal theme: scorched blackened surfaces, volcanic basalt, glowing embers and brimstone, red and orange accents",
  Aquatic: "Aquatic theme: wet surfaces, barnacles, seaweed and coral, damp green-blue tones",
  Natural: "Natural theme: overgrown with roots, moss and leaves, earthy greens and browns",
  Arcane: "Arcane theme: carved runes, faintly glowing violet and blue sigils, polished crystal accents",
  Undead: "Undead theme: grave dust, cobwebs, old bone and decay, cold desaturated tones",
  Mechanical: "Mechanical theme: brass and iron fittings, gears, rivets and pipes",
  Frozen: "Frozen theme: frost, ice crust and snow, pale blue-white tones",
};

const RGBA_HEAD = "This is an RGBA format image with transparency.";
const RGBA_TAIL = "The image has an alpha channel and a transparent background.";

export interface PromptRequest {
  kind: Kind;
  subject: string;
  style: Style;
  motif: Motif;
  /** Free text appended last (extra detail, overrides). */
  extra?: string;
}

export function composePrompt(r: PromptRequest): string {
  const kind: KindPreset = KINDS[r.kind];
  const ink = r.style === "ink";
  const parts = [
    kind.frame.replace("{subject}", r.subject.trim().replace(/\.$/, "")),
    STYLES[r.style].text,
    // Ink line art keeps its interior as solid paper so a prop hides the grid
    // and floor under it instead of showing through between the lines. Not for
    // decals: ground cover should let the floor show between its parts.
    ink && kind.solid ? "Everything inside the object's outline is opaque, with the inked details drawn on white paper; only the area outside the object is transparent" : "",
    MOTIF_TEXT[r.motif],
    r.extra?.trim() ?? "",
  ].filter(Boolean);
  const body = parts.map((p) => p.replace(/[.\s]+$/, "")).join(". ") + ".";
  return kind.alpha ? `${RGBA_HEAD} ${body} ${RGBA_TAIL}` : body;
}

export function isKind(s: string): s is Kind {
  return Object.hasOwn(KINDS, s);
}
export function isStyle(s: string): s is Style {
  return Object.hasOwn(STYLES, s);
}
export function asMotif(s: string): Motif | undefined {
  return MOTIFS.find((m) => m.toLowerCase() === s.toLowerCase());
}
