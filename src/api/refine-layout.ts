import { operationStream } from "./stream.ts";
import {
  getProvider,
  getApiKey,
  resolveModel,
} from "../ai/provider-registry.ts";
import { BlueprintSchema, normalizeBlueprint } from "../ai/blueprint.ts";
import { buildRefineMessages } from "../ai/prompts/refine.ts";
import {
  RefineResponseSchema,
  applyRefineOps,
  describeOp,
} from "../engine/refine-ops.ts";
import type { AIImage, ThinkingLevel } from "../ai/types.ts";
import type { Dungeon } from "../engine/types.ts";
import { recordUsage } from "../db/usage.ts";

interface RefineBody {
  blueprint: unknown;
  dungeon?: Dungeon | null;
  /** A rendered PNG as a data: URL, straight from the canvas exporter. */
  image?: string | null;
  sourcePrompt?: string;
  instruction?: string;
  temperature?: number;
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  includeThoughts?: boolean;
  campaignId?: number;
  dungeonId?: number;
  chatId?: number;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Roughly 8 MB of base64, past which the request is not worth attempting. */
const MAX_IMAGE_CHARS = 8_000_000;

/**
 * Split a data: URL into the parts an inline image part needs.
 *
 * Returns null for anything that is not a plain base64 data URL - the map
 * renderer is the only intended source, and a URL pointing anywhere else is a
 * request for this server to go fetch it, which it will not do.
 */
function parseDataUrl(input: string): AIImage | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
    input.trim(),
  );
  if (match === null) return null;
  const [, mimeType, data] = match;
  if (mimeType === undefined || data === undefined) return null;
  if (data.length > MAX_IMAGE_CHARS) return null;
  return { mimeType, data };
}

/**
 * Critique a floor plan and return validated edits.
 *
 * The ops are applied here rather than on the client so the caller receives a
 * plan that is already known to be buildable, along with a per-op record of what
 * was refused. Nothing is persisted: the user reviews the diff and decides.
 */
export async function handleRefineLayout(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const {
    blueprint: rawBlueprint,
    dungeon,
    image,
    sourcePrompt,
    instruction,
    temperature,
    provider,
    model,
    thinkingLevel,
    includeThoughts,
    campaignId,
    dungeonId,
    chatId,
  } = body as RefineBody;

  const parsedBlueprint = BlueprintSchema.safeParse(rawBlueprint);
  if (!parsedBlueprint.success) {
    return new Response(
      JSON.stringify({ error: "Missing or invalid blueprint to refine" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const blueprint = normalizeBlueprint(parsedBlueprint.data).blueprint;

  const providerName = provider ?? "gemini";
  const aiProvider = getProvider(providerName);
  const modelName = resolveModel(providerName, model);
  const apiKey = getApiKey(providerName);

  // A provider that cannot take images gets the graph alone rather than a
  // request it would reject outright.
  const parsedImage =
    aiProvider.supportsImages === true && typeof image === "string"
      ? parseDataUrl(image)
      : null;

  const messages = buildRefineMessages({
    blueprint,
    dungeon: dungeon ?? null,
    image: parsedImage,
    sourcePrompt,
    instruction,
  });

  const stream = operationStream(req, async (controller, signal) => {
    const encoder = new TextEncoder();
    let fullText = "";

    try {
      const generator = aiProvider.streamComplete(apiKey, {
        signal,
        messages,
        temperature: temperature ?? 0.4,
        responseFormat: "json",
        model: modelName,
        thinkingLevel,
        includeThoughts,
      });

      let result;
      while (true) {
        signal.throwIfAborted();
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        fullText += next.value;
        controller.enqueue(
          encoder.encode(sseEvent("token", { text: next.value })),
        );
      }

      recordUsage({
        operation: "refine",
        provider: providerName,
        model: result?.model ?? modelName,
        inputTokens: result?.usage.inputTokens ?? 0,
        outputTokens: result?.usage.outputTokens ?? 0,
        thinkingTokens: result?.usage.thinkingTokens ?? 0,
        reasoning: result?.thoughts ?? null,
        campaignId,
        dungeonId,
        chatId,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(fullText);
      } catch {
        controller.enqueue(
          encoder.encode(
            sseEvent("error", { error: "Failed to parse AI response as JSON" }),
          ),
        );
        controller.close();
        return;
      }

      const validation = RefineResponseSchema.safeParse(parsed);
      if (!validation.success) {
        const errors = validation.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`,
        );
        controller.enqueue(
          encoder.encode(
            sseEvent("error", {
              error: `Refinement failed validation: ${errors.join("; ")}`,
            }),
          ),
        );
        controller.close();
        return;
      }

      const { blueprint: refined, results } = applyRefineOps(
        blueprint,
        validation.data.ops,
      );
      const settled = normalizeBlueprint(refined);

      controller.enqueue(
        encoder.encode(
          sseEvent("complete", {
            critique: validation.data.critique ?? "",
            blueprint: settled.blueprint,
            problems: settled.problems,
            changes: results.map((r) => ({
              summary: describeOp(r.op),
              applied: r.applied,
              note: r.note ?? null,
              reason: "reason" in r.op ? (r.op.reason ?? null) : null,
            })),
            imageUsed: parsedImage !== null,
            usage: result?.usage,
            model: result?.model ?? modelName,
          }),
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stream failed";
      controller.enqueue(encoder.encode(sseEvent("error", { error: message })));
    } finally {
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
