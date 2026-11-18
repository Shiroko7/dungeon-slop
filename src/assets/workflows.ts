/**
 * ComfyUI workflows for asset generation, built as API-format graphs.
 *
 * Both run on Qwen Image 2.1 (int8), which writes its own alpha channel when the
 * prompt asks for it - no background-removal pass, so edges stay clean.
 *
 * - `sprite`: transparent RGBA with the turbo LoRA, 8 steps (~10-15 s at 1 MP).
 * - `tile`:   seamless texture. Full model, 25 steps, with the latent rolled by a
 *             shrinking offset every step (Universal Seamless Tiles'
 *             SeamlessTileModelDiT) and decoded on a torus (our DslopWrapDecode).
 *             Turbo is not used here: with 8 steps the roll leaves horizontal
 *             banding; at 25 the tile is clean (~18 s at 1 MP).
 *
 * Tested 2026-10-15 on ComfyUI 0.38, RTX 5080 Laptop 16 GB. AdvancedTiling's
 * toroidal attention fails on Qwen 2.1 ("apply_rope freqs shape"), and Universal
 * Seamless Tiles' MakeCircularVAEDiT deep-copies the VAE, which crashed the
 * server on the second run - hence our own decode node.
 */
import type { Workflow } from "./comfy.ts";

export const MODELS = {
  diffusion: { folder: "diffusion_models", file: "qwen_image_2.1_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors" },
  textEncoder: { folder: "text_encoders", file: "qwen3vl_8b_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors" },
  vae: { folder: "vae", file: "qwen_image_2.1_vae_bf16.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors" },
  turboLora: { folder: "loras", file: "qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/loras/qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors" },
} as const;

/** Custom node classes the workflows need, and where each comes from. */
export const NODES = {
  DslopWrapDecode: "this repo: comfy/custom_nodes/dungeon_slop_nodes (link it into ComfyUI/custom_nodes)",
  SeamlessTileModelDiT: "https://github.com/OliverCrosby/ComfyUI-Universal-Seamless-Tiles",
  TextEncodeQwenImage21: "ComfyUI core 0.37+",
} as const;

/** The turbo LoRA's distilled schedule (from the official turbo template); euler/simple does not work with it. */
const TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0";

export type WorkflowKind = "sprite" | "tile";

export interface WorkflowParams {
  prompt: string;
  negative?: string;
  seed: number;
  width: number;
  height: number;
  /** Output file prefix inside ComfyUI's output folder. */
  prefix: string;
  /** tile only: which axes wrap. */
  tiling?: "enable" | "x_only" | "y_only";
  /** tile only: sampling steps (default 25). */
  steps?: number;
  /**
   * Reference images already uploaded to ComfyUI's input folder. Qwen 2.1 sees
   * them alongside the prompt, which can name them "image 1", "image 2"...
   */
  references?: string[];
}

/** Models a workflow kind loads, for `doctor` to check. */
export function modelsFor(kind: WorkflowKind): (typeof MODELS)[keyof typeof MODELS][] {
  return kind === "sprite" ? [MODELS.diffusion, MODELS.textEncoder, MODELS.vae, MODELS.turboLora] : [MODELS.diffusion, MODELS.textEncoder, MODELS.vae];
}

export function nodesFor(kind: WorkflowKind): (keyof typeof NODES)[] {
  return kind === "sprite" ? ["TextEncodeQwenImage21"] : ["TextEncodeQwenImage21", "SeamlessTileModelDiT", "DslopWrapDecode"];
}

function snap(n: number): number {
  return Math.max(256, Math.round(n / 32) * 32);
}

export function buildWorkflow(kind: WorkflowKind, p: WorkflowParams): Workflow {
  const wf: Workflow = {
    unet: { class_type: "UNETLoader", inputs: { unet_name: MODELS.diffusion.file, weight_dtype: "default" } },
    clip: { class_type: "CLIPLoader", inputs: { clip_name: MODELS.textEncoder.file, type: "qwen_image", device: "default" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: MODELS.vae.file } },
    text: {
      class_type: "TextEncodeQwenImage21",
      inputs: { clip: ["clip", 0], prompt: p.prompt, negative_prompt: p.negative ?? "", resolution: 1024 },
    },
    latent: { class_type: "EmptyLatentImage", inputs: { width: snap(p.width), height: snap(p.height), batch_size: 1 } },
    noise: { class_type: "RandomNoise", inputs: { noise_seed: p.seed } },
    sampler: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  };
  (p.references ?? []).slice(0, 4).forEach((name, i) => {
    wf[`ref${i + 1}`] = { class_type: "LoadImage", inputs: { image: name } };
    wf.text!.inputs[`images.image_${i + 1}`] = [`ref${i + 1}`, 0];
    wf.text!.inputs.vae = ["vae", 0];
    wf.text!.inputs.resolution = 768;
  });
  let model: [string, number] = ["unet", 0];
  if (kind === "sprite") {
    wf.turbo = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: MODELS.turboLora.file, strength_model: 1.0 } };
    model = ["turbo", 0];
    wf.sigmas = { class_type: "ManualSigmas", inputs: { sigmas: TURBO_SIGMAS } };
  } else {
    wf.roll = { class_type: "SeamlessTileModelDiT", inputs: { model, tiling: p.tiling ?? "enable", seed: p.seed } };
    model = ["roll", 0];
    wf.sigmas = { class_type: "BasicScheduler", inputs: { model, scheduler: "simple", steps: p.steps ?? 25, denoise: 1 } };
  }
  wf.guider = { class_type: "BasicGuider", inputs: { model, conditioning: ["text", 0] } };
  wf.sample = {
    class_type: "SamplerCustomAdvanced",
    inputs: { noise: ["noise", 0], guider: ["guider", 0], sampler: ["sampler", 0], sigmas: ["sigmas", 0], latent_image: ["latent", 0] },
  };
  wf.decode =
    kind === "sprite"
      ? { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["vae", 0] } }
      : { class_type: "DslopWrapDecode", inputs: { samples: ["sample", 0], vae: ["vae", 0], tiling: p.tiling ?? "enable", pad: 8 } };
  wf.save = { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: p.prefix } };
  return wf;
}

export interface InpaintParams {
  prompt: string;
  seed: number;
  /** Uploaded input image names (ComfyUI input folder). */
  image: string;
  /** Greyscale: white = regenerate, black = keep. */
  mask: string;
  prefix: string;
  steps?: number;
  /** 0..1: how far from the original the repaint may go (1 = from scratch). */
  denoise?: number;
  /** Show the original to the model as "image 1" too, so the repaint keeps its look. */
  reference?: boolean;
}

/**
 * Repaint the white part of `mask` in `image`, keeping the rest: the latent is
 * noised only under the mask, so every step sees the kept pixels as context.
 * Full model, no tiling roll (the kept border already wraps).
 */
export function buildInpaintWorkflow(p: InpaintParams): Workflow {
  const wf = inpaintGraph(p);
  if (p.reference) {
    wf.text!.inputs["images.image_1"] = ["image", 0];
    wf.text!.inputs.vae = ["vae", 0];
    wf.text!.inputs.resolution = 768;
  }
  return wf;
}

function inpaintGraph(p: InpaintParams): Workflow {
  return {
    unet: { class_type: "UNETLoader", inputs: { unet_name: MODELS.diffusion.file, weight_dtype: "default" } },
    clip: { class_type: "CLIPLoader", inputs: { clip_name: MODELS.textEncoder.file, type: "qwen_image", device: "default" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: MODELS.vae.file } },
    text: { class_type: "TextEncodeQwenImage21", inputs: { clip: ["clip", 0], prompt: p.prompt, negative_prompt: "", resolution: 1024 } },
    image: { class_type: "LoadImage", inputs: { image: p.image } },
    maskImage: { class_type: "LoadImage", inputs: { image: p.mask } },
    mask: { class_type: "ImageToMask", inputs: { image: ["maskImage", 0], channel: "red" } },
    encode: { class_type: "VAEEncode", inputs: { pixels: ["image", 0], vae: ["vae", 0] } },
    masked: { class_type: "SetLatentNoiseMask", inputs: { samples: ["encode", 0], mask: ["mask", 0] } },
    noise: { class_type: "RandomNoise", inputs: { noise_seed: p.seed } },
    sampler: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    sigmas: { class_type: "BasicScheduler", inputs: { model: ["unet", 0], scheduler: "simple", steps: p.steps ?? 25, denoise: p.denoise ?? 1 } },
    guider: { class_type: "BasicGuider", inputs: { model: ["unet", 0], conditioning: ["text", 0] } },
    sample: {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["noise", 0], guider: ["guider", 0], sampler: ["sampler", 0], sigmas: ["sigmas", 0], latent_image: ["masked", 0] },
    },
    decode: { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["vae", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: p.prefix } },
  };
}
