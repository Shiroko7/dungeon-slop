import { describe, test, expect } from "bun:test";
import {
  PRESETS,
  createOpenAICompatEmbedder,
  createOpenAICompatSummarizer,
  resolvePreset,
} from "./providers.ts";
import { SUMMARY_JSON_SCHEMA, buildSummaryPrompt, parseSummary } from "./summary-spec.ts";

// ─── response parsing ─────────────────────────────────────────────────────────

const VALID = { summary: "The party enters the sewers.", entities: ["Vashti", "Kael"] };

describe("parseSummary", () => {
  test("accepts clean JSON", () => {
    expect(parseSummary(JSON.stringify(VALID))).toEqual(VALID);
  });

  test("recovers JSON from a markdown fence", () => {
    expect(parseSummary("```json\n" + JSON.stringify(VALID) + "\n```")).toEqual(VALID);
  });

  test("recovers JSON from an unlabelled fence", () => {
    expect(parseSummary("```\n" + JSON.stringify(VALID) + "\n```")).toEqual(VALID);
  });

  test("recovers JSON buried under preamble", () => {
    const raw = `Sure! Here is the summary you asked for:\n\n${JSON.stringify(VALID)}\n\nHope that helps.`;
    expect(parseSummary(raw)).toEqual(VALID);
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseSummary(`\n\n  ${JSON.stringify(VALID)}  \n`)).toEqual(VALID);
  });

  test("rejects JSON of the wrong shape", () => {
    expect(() => parseSummary(JSON.stringify({ summary: 42, entities: [] }))).toThrow();
    expect(() => parseSummary(JSON.stringify({ summary: "ok" }))).toThrow();
  });

  test("rejects a response with no JSON at all", () => {
    expect(() => parseSummary("I'm sorry, I can't help with that.")).toThrow(/Could not parse/);
  });

  test("the error quotes the response so a failure is diagnosable", () => {
    expect(() => parseSummary("total nonsense here")).toThrow(/total nonsense here/);
  });
});

// ─── prompt shaping ───────────────────────────────────────────────────────────

describe("buildSummaryPrompt", () => {
  test("includes the filename and the body", () => {
    const prompt = buildSummaryPrompt("session-12.md", "The party regrouped.");
    expect(prompt).toContain("session-12.md");
    expect(prompt).toContain("The party regrouped.");
  });

  test("samples head and tail of an oversized document", () => {
    const body = `HEAD_MARKER${"x".repeat(500_000)}TAIL_MARKER`;
    const prompt = buildSummaryPrompt("big.md", body);

    expect(prompt).toContain("HEAD_MARKER");
    expect(prompt).toContain("TAIL_MARKER");
    expect(prompt).toContain("characters omitted");
    expect(prompt.length).toBeLessThan(body.length);
  });
});

describe("SUMMARY_JSON_SCHEMA", () => {
  test("is strict enough for a json_schema response format", () => {
    const schema = SUMMARY_JSON_SCHEMA as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["required"]).toEqual(["summary", "entities"]);
  });
});

// ─── presets ──────────────────────────────────────────────────────────────────

describe("presets", () => {
  test("every base URL ends in a slash", () => {
    // Compatibility layers 404 when the path is joined onto a slashless base.
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(`${name}:${preset.baseUrl.endsWith("/")}`).toBe(`${name}:true`);
    }
  });

  test("relative paths resolve onto the base without eating a segment", () => {
    for (const preset of Object.values(PRESETS)) {
      const url = new URL("chat/completions", preset.baseUrl).toString();
      expect(url).toBe(`${preset.baseUrl}chat/completions`);
    }
  });

  test("resolvePreset returns known providers", () => {
    expect(resolvePreset("gemini").defaultModel).toBe("gemini-flash-latest");
    expect(resolvePreset("openrouter").baseUrl).toContain("openrouter.ai");
  });

  test("resolvePreset lists the alternatives when given a bad name", () => {
    expect(() => resolvePreset("claude")).toThrow(/gemini/);
    expect(() => resolvePreset("claude")).toThrow(/Unknown provider/);
  });

  test("only providers that actually serve embeddings advertise a model", () => {
    // OpenRouter, DeepSeek and Groq are chat-only; claiming otherwise would
    // fail deep inside an ingest run instead of at startup.
    expect(PRESETS["gemini"]?.defaultEmbeddingModel).toBeDefined();
    expect(PRESETS["openai"]?.defaultEmbeddingModel).toBeDefined();
    expect(PRESETS["openrouter"]?.defaultEmbeddingModel).toBeUndefined();
    expect(PRESETS["deepseek"]?.defaultEmbeddingModel).toBeUndefined();
    expect(PRESETS["groq"]?.defaultEmbeddingModel).toBeUndefined();
  });
});

// ─── wire format, against a stub server ───────────────────────────────────────

async function withStubServer(
  handler: (req: Request, body: Record<string, unknown>) => Response,
  run: (baseUrl: string, seen: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const seen: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push(body);
      return handler(req, body);
    },
  });

  try {
    await run(`http://localhost:${server.port}/v1/`, seen);
  } finally {
    server.stop(true);
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI-compatible summarizer", () => {
  test("sends the expected request and parses the reply", async () => {
    await withStubServer(
      () =>
        jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
      async (baseUrl, seen) => {
        const summarizer = createOpenAICompatSummarizer({
          baseUrl,
          apiKey: "test-key",
          model: "test-model",
          structuredMode: "json_schema",
        });

        expect(await summarizer.summarize("s12.md", "body text")).toEqual(VALID);

        const body = seen[0]!;
        expect(body["model"]).toBe("test-model");
        expect(body["response_format"]).toMatchObject({ type: "json_schema" });

        const messages = body["messages"] as Array<{ role: string; content: string }>;
        expect(messages[0]?.role).toBe("system");
        expect(messages[1]?.content).toContain("s12.md");
      },
    );
  });

  test("json_object mode omits the schema", async () => {
    await withStubServer(
      () => jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
      async (baseUrl, seen) => {
        const summarizer = createOpenAICompatSummarizer({
          baseUrl,
          apiKey: "k",
          model: "m",
          structuredMode: "json_object",
        });
        await summarizer.summarize("a.md", "b");
        expect(seen[0]!["response_format"]).toEqual({ type: "json_object" });
      },
    );
  });

  test("prompt mode sends no response_format at all", async () => {
    await withStubServer(
      () => jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
      async (baseUrl, seen) => {
        const summarizer = createOpenAICompatSummarizer({
          baseUrl,
          apiKey: "k",
          model: "m",
          structuredMode: "prompt",
        });
        await summarizer.summarize("a.md", "b");
        expect(seen[0]!["response_format"]).toBeUndefined();
      },
    );
  });

  test("an empty completion is an error, not an empty summary", async () => {
    await withStubServer(
      () => jsonResponse({ choices: [{ message: { content: "" } }] }),
      async (baseUrl) => {
        const summarizer = createOpenAICompatSummarizer({
          baseUrl,
          apiKey: "k",
          model: "m",
        });
        await expect(summarizer.summarize("a.md", "b")).rejects.toThrow(/no content/);
      },
    );
  });

  test("a non-retryable error fails immediately with the status in the message", async () => {
    await withStubServer(
      () => new Response("bad model", { status: 400 }),
      async (baseUrl, seen) => {
        const summarizer = createOpenAICompatSummarizer({
          baseUrl,
          apiKey: "k",
          model: "m",
        });
        await expect(summarizer.summarize("a.md", "b")).rejects.toThrow(/400/);
        expect(seen).toHaveLength(1);
      },
    );
  });
});

describe("OpenAI-compatible embedder", () => {
  test("returns vectors in input order even when the reply is shuffled", async () => {
    await withStubServer(
      (_req, body) => {
        const input = body["input"] as string[];
        // Deliberately reversed: the client must sort by index, not trust order.
        const rows = input
          .map((_, i) => ({ index: i, embedding: [i, i + 1] }))
          .reverse();
        return jsonResponse({ data: rows });
      },
      async (baseUrl) => {
        const embedder = createOpenAICompatEmbedder({
          baseUrl,
          apiKey: "k",
          model: "embed-model",
        });

        const vectors = await embedder.embed(["a", "b", "c"], "document");
        expect(vectors).toHaveLength(3);
        expect(Array.from(vectors[0]!)).toEqual([0, 1]);
        expect(Array.from(vectors[2]!)).toEqual([2, 3]);
      },
    );
  });

  test("a short reply is an error rather than a silent misalignment", async () => {
    await withStubServer(
      () => jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] }),
      async (baseUrl) => {
        const embedder = createOpenAICompatEmbedder({ baseUrl, apiKey: "k", model: "m" });
        await expect(embedder.embed(["a", "b"], "document")).rejects.toThrow(/2 inputs/);
      },
    );
  });

  test("no inputs means no request", async () => {
    await withStubServer(
      () => jsonResponse({ data: [] }),
      async (baseUrl, seen) => {
        const embedder = createOpenAICompatEmbedder({ baseUrl, apiKey: "k", model: "m" });
        expect(await embedder.embed([], "document")).toEqual([]);
        expect(seen).toHaveLength(0);
      },
    );
  });

  test("large input sets are split across multiple requests", async () => {
    await withStubServer(
      (_req, body) => {
        const input = body["input"] as string[];
        return jsonResponse({
          data: input.map((_, i) => ({ index: i, embedding: [i] })),
        });
      },
      async (baseUrl, seen) => {
        const embedder = createOpenAICompatEmbedder({ baseUrl, apiKey: "k", model: "m" });
        const vectors = await embedder.embed(Array.from({ length: 150 }, (_, i) => `t${i}`), "document");

        expect(vectors).toHaveLength(150);
        expect(seen.length).toBeGreaterThan(1);
        for (const body of seen) {
          expect((body["input"] as string[]).length).toBeLessThanOrEqual(64);
        }
      },
    );
  });
});
