import { describe, test, expect } from "bun:test";
import { chunkDocument, estimateTokens } from "./chunker.ts";
import type { Chunk } from "./types.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Body text of roughly `tokens` tokens, as whole words. */
function prose(tokens: number, word = "torchlight"): string {
  const per = Math.ceil((word.length + 1) / 4);
  return Array.from({ length: Math.ceil(tokens / per) }, () => word).join(" ");
}

/**
 * Every non-whitespace character outside a heading line must land in at least
 * one chunk. Headings are boundaries, carried in `headingPath` rather than body
 * text, so they are excluded.
 */
function uncoveredOffsets(source: string, chunks: Chunk[]): number[] {
  const covered = new Uint8Array(source.length);
  for (const c of chunks) {
    for (let i = c.startOffset; i < c.endOffset; i++) covered[i] = 1;
  }

  const headingLine = new Uint8Array(source.length);
  let at = 0;
  for (const line of source.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      for (let i = at; i < at + line.length; i++) headingLine[i] = 1;
    }
    at += line.length + 1;
  }

  const missed: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch.trim() === "") continue;
    if (headingLine[i] === 1) continue;
    if (covered[i] !== 1) missed.push(i);
  }
  return missed;
}

const SESSION_NOTES = `# Session 12

The party regrouped at the Gilded Hart before dawn.

## The Sewers

Vashti led them through the grate behind the tannery.

### Ambush

Three goblins waited at the第 junction. Kael took a bolt to the shoulder.

## Aftermath

They surfaced near the temple district, short one guide.
`;

// ─── invariants ───────────────────────────────────────────────────────────────

describe("chunkDocument invariants", () => {
  const corpora: Array<[string, string]> = [
    ["session notes", SESSION_NOTES],
    ["plain text, no headings", `${prose(300)}\n\n${prose(300)}\n\n${prose(300)}`],
    ["one long paragraph", prose(5000)],
    ["heading-only", "# A\n\n## B\n\n### C\n"],
    ["mixed with code", `# Loot\n\n\`\`\`json\n{"gp": 250}\n\`\`\`\n\nSplit four ways.\n`],
    ["crlf line endings", "# Title\r\n\r\nA line of prose.\r\n\r\nAnother line.\r\n"],
  ];

  for (const [name, source] of corpora) {
    test(`${name}: text always equals its own offset slice`, () => {
      for (const chunk of chunkDocument(source)) {
        expect(source.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
      }
    });

    test(`${name}: ordinals are sequential from zero`, () => {
      const chunks = chunkDocument(source);
      expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    });

    test(`${name}: no body content is dropped`, () => {
      const chunks = chunkDocument(source);
      expect(uncoveredOffsets(source, chunks)).toEqual([]);
    });

    test(`${name}: offsets are ordered and in range`, () => {
      for (const chunk of chunkDocument(source)) {
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.endOffset).toBeLessThanOrEqual(source.length);
        expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
      }
    });
  }

  test("empty and whitespace-only input produce no chunks", () => {
    expect(chunkDocument("")).toEqual([]);
    expect(chunkDocument("   \n\n  \t \n")).toEqual([]);
  });
});

// ─── size discipline ──────────────────────────────────────────────────────────

describe("chunk sizing", () => {
  test("respects the hard ceiling even on a single huge paragraph", () => {
    const chunks = chunkDocument(prose(9000), { targetTokens: 400, maxTokens: 600 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(600);
    }
  });

  test("accumulates small paragraphs instead of emitting one chunk each", () => {
    const source = Array.from({ length: 20 }, () => prose(50)).join("\n\n");
    const chunks = chunkDocument(source, { targetTokens: 800, overlapTokens: 0 });
    expect(chunks.length).toBeLessThan(8);
  });

  test("overlap repeats prior content but does not duplicate the whole chunk", () => {
    const source = Array.from({ length: 12 }, (_, i) => prose(120, `w${i}`)).join("\n\n");
    const withOverlap = chunkDocument(source, { targetTokens: 300, overlapTokens: 100 });
    const without = chunkDocument(source, { targetTokens: 300, overlapTokens: 0 });

    const sum = (cs: Chunk[]): number => cs.reduce((n, c) => n + c.tokens, 0);
    expect(sum(withOverlap)).toBeGreaterThan(sum(without));
    expect(sum(withOverlap)).toBeLessThan(sum(without) * 2);
  });

  test("overlap never runs backwards past the start of the document", () => {
    for (const chunk of chunkDocument(SESSION_NOTES, { targetTokens: 40, overlapTokens: 30 })) {
      expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── structure ────────────────────────────────────────────────────────────────

describe("heading structure", () => {
  test("builds a breadcrumb from the heading stack", () => {
    const paths = chunkDocument(SESSION_NOTES).map((c) => c.headingPath);
    expect(paths).toContain("Session 12 › The Sewers › Ambush");
    expect(paths).toContain("Session 12 › Aftermath");
  });

  test("a sibling heading pops its predecessor rather than nesting", () => {
    const paths = chunkDocument(SESSION_NOTES).map((c) => c.headingPath);
    expect(paths.some((p) => p.includes("Ambush › Aftermath"))).toBe(false);
  });

  test("a chunk never spans two sections", () => {
    // Tiny sections that would otherwise merge under an 800-token target.
    const source = "# One\n\nalpha\n\n# Two\n\nbeta\n\n# Three\n\ngamma\n";
    const chunks = chunkDocument(source);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.headingPath)).toEqual(["One", "Two", "Three"]);
  });

  test("documents with no headings get an empty path", () => {
    for (const chunk of chunkDocument(prose(400))) {
      expect(chunk.headingPath).toBe("");
    }
  });
});

// ─── code fences ──────────────────────────────────────────────────────────────

describe("fenced code", () => {
  test("a fence is never split across chunks", () => {
    const body = Array.from({ length: 40 }, (_, i) => `  "line${i}": ${i},`).join("\n");
    const source = `# Ledger\n\n\`\`\`json\n{\n${body}\n}\n\`\`\`\n`;
    const chunks = chunkDocument(source, { targetTokens: 100, maxTokens: 100000 });

    const holder = chunks.filter((c) => c.text.includes("```"));
    expect(holder).toHaveLength(1);
    expect(holder[0]!.text.match(/```/g)).toHaveLength(2);
  });

  test("blank lines inside a fence do not break it up", () => {
    const source = "```\nfirst\n\n\nsecond\n```\n";
    const chunks = chunkDocument(source);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("first");
    expect(chunks[0]!.text).toContain("second");
  });

  test("an unterminated fence still emits its content", () => {
    const source = "# Notes\n\n```\ndangling content here\n";
    const chunks = chunkDocument(source);
    expect(chunks.some((c) => c.text.includes("dangling content here"))).toBe(true);
  });

  test("a heading inside a fence is not treated as a heading", () => {
    const source = "# Real\n\n```md\n# Not A Heading\n```\n\ntrailing prose\n";
    const paths = chunkDocument(source).map((c) => c.headingPath);
    expect(paths.every((p) => p === "Real")).toBe(true);
  });
});

// ─── token estimate ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  test("is monotonic in length", () => {
    expect(estimateTokens("abcd")).toBeLessThanOrEqual(estimateTokens("abcdefgh"));
  });

  test("is zero only for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBeGreaterThan(0);
  });
});
