import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NotesView } from "./NotesView.tsx";
import { useNotesStore } from "../../store/notes-store.ts";
import type { NoteDocument } from "../../notes/types.ts";

const original = { ...useNotesStore.getInitialState() };
afterEach(() => {
  Object.assign(useNotesStore.getInitialState(), original);
  useNotesStore.setState(original);
});

test("Notes discloses providers, readable partial failure and retry controls", () => {
  useNotesStore.setState({
    providers: {
      embeddings: { provider: "gemini", model: "embedding-model", configured: true },
      summaries: { provider: "openrouter", model: "summary-model", configured: true },
    },
    documents: [{ id: 1, filename: "session.md", campaignId: 1, uploadedAt: 0, summary: "", entities: [], tokens: 3,
      chunkCount: 1, activeRevision: 1, latestRevision: 1, sourceAvailable: true, retrySourceAvailable: true,
      activeIndexStatus: "indexed", indexStatus: "indexed", indexError: null, summaryStatus: "failed", summaryError: "Summary provider unavailable", embeddingModel: "embedding-model",
    } satisfies NoteDocument],
  });
  // React's server renderer uses Zustand's initial snapshot, not the live one.
  Object.assign(useNotesStore.getInitialState(), useNotesStore.getState());
  const html = renderToStaticMarkup(<NotesView campaignId={1} />);
  expect(html).toContain("gemini / embedding-model");
  expect(html).toContain("openrouter / summary-model");
  expect(html).toContain("Ollama");
  expect(html).toContain("Summary provider unavailable");
  expect(html).toContain("Retry summary");
  expect(html).toContain("Reindex this note");
});
