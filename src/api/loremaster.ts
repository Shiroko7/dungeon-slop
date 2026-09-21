import { appDb } from "../db/context.ts";
import { appendMessage, getChat } from "../campaign/chats.ts";
import { campaignExists } from "../campaign/campaigns.ts";
import { getApiKey, getProvider, resolveModel } from "../ai/provider-registry.ts";
import type { ThinkingLevel } from "../ai/types.ts";
import { notesEmbedder } from "../notes/context.ts";
import { answerLoremaster } from "../loremaster/agent.ts";
import { badRequest, json, notFound, readJson } from "./http.ts";
import { operationStream } from "./stream.ts";

interface AskBody { question?: unknown; provider?: unknown; model?: unknown; temperature?: unknown; thinkingLevel?: unknown }
const PROVIDERS = ["gemini", "claude", "ollama"] as const;
const THINKING = ["minimal", "low", "medium", "high"] as const;

function sendEvent(controller: Pick<ReadableStreamDefaultController<Uint8Array>, "enqueue">, event: string, data: unknown): void {
  controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

export async function handleAskLoremaster(req: Request, campaignId: number, chatId: number): Promise<Response> {
  const db = appDb();
  if (!campaignExists(db, campaignId)) return notFound(`No campaign ${campaignId}`);
  const chat = getChat(db, chatId);
  if (!chat || chat.campaignId !== campaignId || chat.dungeonId !== null) return notFound("That is not a Loremaster thread in this campaign");
  const body = await readJson<AskBody>(req);
  if (!body || typeof body.question !== "string" || body.question.trim() === "" || body.question.length > 4_000) return badRequest("Question must be between 1 and 4,000 characters");
  const question = (body.question as string).trim();
  if (body.provider !== undefined && (typeof body.provider !== "string" || !PROVIDERS.includes(body.provider as (typeof PROVIDERS)[number]))) return badRequest("Unknown generation provider");
  if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 200)) return badRequest("Invalid generation model");
  if (body.temperature !== undefined && (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 2)) return badRequest("Temperature must be between 0 and 2");
  if (body.thinkingLevel !== undefined && (typeof body.thinkingLevel !== "string" || !THINKING.includes(body.thinkingLevel as (typeof THINKING)[number]))) return badRequest("Invalid thinking level");
  const providerName = typeof body.provider === "string" ? body.provider : "gemini";
  const provider = getProvider(providerName);
  const model = resolveModel(providerName, typeof body.model === "string" ? body.model : undefined);
  const apiKey = getApiKey(providerName);
  const stream = operationStream(req, async (controller, signal) => {
    try {
      await answerLoremaster({ db, campaignId, chatId, question, provider, apiKey, model,
        temperature: typeof body.temperature === "number" ? body.temperature : 0.3,
        thinkingLevel: typeof body.thinkingLevel === "string" ? body.thinkingLevel as ThinkingLevel : undefined,
        signal, getEmbedder: notesEmbedder,
        onEvent: (event) => sendEvent(controller, event.type, event) });
    } catch (error) {
      if (!signal.aborted) sendEvent(controller, "error", { error: error instanceof Error ? error.message : "Loremaster turn failed" });
    }
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
