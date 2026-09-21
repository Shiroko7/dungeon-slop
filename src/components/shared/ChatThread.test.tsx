import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatThread } from "./ChatThread.tsx";
import type { ChatMessage } from "../../campaign/types.ts";

const assistant: ChatMessage = { id: 2, role: "assistant", content: "Vess has a flooded gate.", createdAt: 0,
  citations: [{ chunkId: 3, docId: 1, filename: "crypt.md", headingPath: "Vess", snippet: "flooded gate", campaignId: 1, revision: 2 }],
  toolCalls: [{ name: "search_notes", args: { query: "gate" }, status: "completed", result: "[S1] crypt.md" }] };

test("chat renders deep-link citations and persisted tool provenance", () => {
  const html = renderToStaticMarkup(<ChatThread messages={[assistant]} isBusy={false} emptyTitle="" emptyHint="" placeholder="Ask" onSend={() => {}} />);
  expect(html).toContain("/c/1/notes/1/r/2/chunk/3");
  expect(html).toContain("Research used (1 read-only tool calls)");
  expect(html).toContain("search notes");
});

test("chat keeps a cancelled partial answer visibly separate from saved messages", () => {
  const html = renderToStaticMarkup(<ChatThread messages={[]} isBusy={false} streamingText="Some evidence" turnStatus="cancelled" onCancel={() => {}}
    emptyTitle="Ask" emptyHint="" placeholder="Ask" onSend={() => {}} />);
  expect(html).toContain("Cancelled draft");
  expect(html).toContain("Some evidence");
});
