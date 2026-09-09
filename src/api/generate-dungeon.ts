import { DungeonConfigSchema } from "../ai/schema.ts";
import type { DungeonConfig } from "../ai/schema.ts";
import { generateDungeon, generateFromBlueprint } from "../engine/generate.ts";
import { BlueprintSchema, normalizeBlueprint } from "../ai/blueprint.ts";

export async function handleGenerateDungeon(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Two body shapes: a bare config (the original contract, still used by the
  // reroll path) or { config, blueprint } when a floor plan drives the layout.
  const envelope = body as { config?: unknown; blueprint?: unknown };
  const hasEnvelope =
    typeof envelope === "object" && envelope !== null && envelope.config !== undefined;
  const rawConfig = hasEnvelope ? envelope.config : body;

  const validation = DungeonConfigSchema.safeParse(rawConfig);
  if (!validation.success) {
    const errors = validation.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    return new Response(
      JSON.stringify({ error: "Invalid dungeon config", details: errors }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const config: DungeonConfig = validation.data;
  const startTime = performance.now();

  try {
    let dungeon;
    if (hasEnvelope && envelope.blueprint !== undefined && envelope.blueprint !== null) {
      const parsed = BlueprintSchema.safeParse(envelope.blueprint);
      if (!parsed.success) {
        const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        return new Response(JSON.stringify({ error: "Invalid blueprint", details }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      dungeon = generateFromBlueprint(normalizeBlueprint(parsed.data).blueprint, config);
    } else {
      dungeon = generateDungeon(config);
    }
    const elapsed = performance.now() - startTime;

    return new Response(
      JSON.stringify({
        dungeon,
        timing: {
          generationMs: Math.round(elapsed * 100) / 100,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dungeon generation failed";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
