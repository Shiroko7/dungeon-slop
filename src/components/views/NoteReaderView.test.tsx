import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NoteReaderContent } from "./NoteReaderView.tsx";
import { SearchResults } from "./NoteSearch.tsx";
import type { NoteReader, NoteSearchResult } from "../../notes/retrieval-types.ts";

const note: NoteReader = { campaignId: 1, documentId: 4, filename: "session.md", revision: 2, activeRevision: 2,
  contentHash: "fixture", indexStatus: "indexed", source: "# Mira\r\n\r\n<script>alert('untrusted')</script>", notice: null,
  chunks: [{ id: 9, ordinal: 0, headingPath: "Mira", startOffset: 0, endOffset: 7, text: "# Mira\n" }] };

test("reader renders selected revision, heading navigation and inert source markup", () => {
  const html = renderToStaticMarkup(<NoteReaderContent note={note} chunkId={9} />);
  expect(html).toContain("revision 2");
  expect(html).toContain("Jump to heading / passage");
  expect(html).toContain("/c/1/notes/4/r/2/chunk/9");
  expect(html).toContain("<mark>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("never silently points at new text");
});

test("legacy reader shows retained chunks with explicit missing-source notice", () => {
  const html = renderToStaticMarkup(<NoteReaderContent note={{ ...note, source: null, notice: "Original source unavailable" }} chunkId={null} />);
  expect(html).toContain("Original source unavailable");
  expect(html).toContain("Legacy stored chunks");
  expect(html).toContain("# Mira");
});

test("large source is paged instead of rendering the entire stored document", () => {
  const html = renderToStaticMarkup(<NoteReaderContent note={{ ...note, source: "x".repeat(60_000) + "TAIL_MARKER" }} chunkId={null} />);
  expect(html).toContain("Next page");
  expect(html).not.toContain("TAIL_MARKER");
  expect(html.length).toBeLessThan(25_000);
});

test("search results expose source revision, fallback, budget and non-answer disclaimer", () => {
  const result: NoteSearchResult = { query: "Mira", mode: "hybrid", usedMode: "lexical", status: "ready",
    tokenBudget: 128, tokensUsed: 2, warnings: ["Embedding credentials missing"],
    diagnostics: { lexicalCandidates: 1, semanticCandidates: 0, indexedChunks: 1, embeddingModel: null },
    results: [{ citation: { campaignId: 1, documentId: 4, revision: 2, chunkId: 9, filename: "session.md", headingPath: "Mira", startOffset: 0, endOffset: 7 },
      text: "# Mira", score: 1 / 61, lexicalRank: 1, semanticRank: null, tokens: 2, truncated: true }] };
  const html = renderToStaticMarkup(<SearchResults result={result} />);
  expect(html).toContain("Embedding credentials missing");
  expect(html).toContain("2 / 128 estimated context tokens");
  expect(html).toContain("/c/1/notes/4/r/2/chunk/9");
  expect(html).toContain("not answers or proof");
  expect(html).toContain("shortened to fit context budget");
});
