/**
 * Minimal client for a local ComfyUI server's HTTP API: queue an API-format
 * workflow, wait for it, download the images it saved.
 *
 * ComfyUI runs one prompt at a time from a queue; polling /history is enough
 * for a CLI and avoids holding a websocket open.
 */

export const DEFAULT_COMFY_URL = process.env.COMFY_URL ?? "http://127.0.0.1:8188";

/** API-format workflow: node id → { class_type, inputs }. Links are [nodeId, outputIndex]. */
export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface ComfyImage {
  filename: string;
  subfolder: string;
  type: string;
}

export class ComfyError extends Error {}

export class ComfyClient {
  constructor(readonly url: string = DEFAULT_COMFY_URL) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url + path, init);
    } catch {
      throw new ComfyError(`ComfyUI is not reachable at ${this.url}. Start it (\`bun run assets serve\`, or open ComfyUI Desktop).`);
    }
    const body = await res.text();
    if (!res.ok) throw new ComfyError(`ComfyUI ${path} answered ${res.status}: ${describeError(body)}`);
    return JSON.parse(body) as T;
  }

  async ping(): Promise<{ version: string; device: string; vramFree: number } | null> {
    try {
      const s = await this.json<{ system: { comfyui_version: string }; devices: { name: string; vram_free: number }[] }>("/system_stats");
      return { version: s.system.comfyui_version, device: s.devices[0]?.name ?? "?", vramFree: s.devices[0]?.vram_free ?? 0 };
    } catch {
      return null;
    }
  }

  /** Node classes the server knows, mapped to their input specs. */
  async nodeTypes(): Promise<Record<string, { input: { required?: Record<string, unknown[]> } }>> {
    return this.json("/object_info");
  }

  /** File names ComfyUI can see in a model folder ("loras", "diffusion_models", ...). */
  async models(folder: string): Promise<string[]> {
    return this.json(`/models/${folder}`);
  }

  /** Put an image in ComfyUI's input folder (overwriting), for LoadImage. Returns its name. */
  async upload(bytes: Uint8Array, name: string): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(bytes)], { type: "image/png" }), name);
    form.append("overwrite", "true");
    const r = await this.json<{ name: string }>("/upload/image", { method: "POST", body: form });
    return r.name;
  }

  async queue(workflow: Workflow): Promise<string> {
    const r = await this.json<{ prompt_id?: string }>("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
    });
    if (!r.prompt_id) throw new ComfyError(`ComfyUI did not queue the workflow: ${JSON.stringify(r)}`);
    return r.prompt_id;
  }

  /** Wait for a queued prompt; resolves with every image its output nodes saved. */
  async wait(promptId: string, timeoutMs = 15 * 60_000): Promise<ComfyImage[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const h = await this.json<Record<string, HistoryEntry>>(`/history/${promptId}`);
      const entry = h[promptId];
      if (entry?.status?.status_str === "error") {
        const err = entry.status.messages?.find((m) => m[0] === "execution_error")?.[1] as
          | { node_type?: string; exception_message?: string }
          | undefined;
        throw new ComfyError(`ComfyUI failed in ${err?.node_type ?? "a node"}: ${(err?.exception_message ?? "unknown error").trim()}`);
      }
      if (entry?.status?.completed) {
        return Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
      }
      await Bun.sleep(1000);
    }
    throw new ComfyError(`ComfyUI prompt ${promptId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
  }

  async image(img: ComfyImage): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    const res = await fetch(`${this.url}/view?${q}`);
    if (!res.ok) throw new ComfyError(`could not download ${img.filename}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Queue, wait, download: the bytes of every image the workflow produced. */
  async run(workflow: Workflow): Promise<Uint8Array[]> {
    const images = await this.wait(await this.queue(workflow));
    return Promise.all(images.map((i) => this.image(i)));
  }
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: [string, unknown][] };
  outputs?: Record<string, { images?: ComfyImage[] }>;
}

/** Turn ComfyUI's validation error JSON into one readable line. */
function describeError(body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string };
      node_errors?: Record<string, { class_type: string; errors: { message: string; details: string }[] }>;
    };
    const nodes = Object.values(j.node_errors ?? {}).map(
      (n) => `${n.class_type}: ${n.errors.map((e) => `${e.message} (${e.details})`).join("; ")}`,
    );
    return [j.error?.message, ...nodes].filter(Boolean).join(" | ");
  } catch {
    return body.slice(0, 300);
  }
}
