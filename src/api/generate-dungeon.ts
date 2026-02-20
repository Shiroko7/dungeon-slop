import { DungeonConfigSchema } from "../ai/schema.ts";
import type { DungeonConfig } from "../ai/schema.ts";
import { generateDungeon } from "../engine/generate.ts";

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

  const validation = DungeonConfigSchema.safeParse(body);
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
    const dungeon = generateDungeon(config);
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
