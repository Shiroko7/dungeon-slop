import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { api } from "./api.ts";
import { useChatStore } from "./chat-store.ts";
import { deferred } from "../test-fixtures.ts";
import type { ChatMessage, ChatRecord } from "../campaign/types.ts";

function chat(): ChatRecord { return { id: 1, campaignId: 1, dungeonId: null, title: "", messageCount: 0, createdAt: 0, updatedAt: 0, messages: [] }; }
function message(role: "user" | "assistant", content: string): ChatMessage { return { id: role === "user" ? 2 : 3, role, content, citations: null, toolCalls: null, createdAt: 0 }; }
afterEach(() => { useChatStore.getState().close(); mock.restore(); });

test("Loremaster store streams tool activity and commits the assistant without losing citations", async () => {
  spyOn(api.chats, "ask").mockImplementation(async function* () {
    yield { type: "user", message: message("user", "Where?") };
    yield { type: "tool_start", name: "search_notes", args: {} };
    yield { type: "tool_result", record: { name: "search_notes", args: {}, status: "completed", result: "[S1] crypt.md" } };
    yield { type: "token", text: "The answer" };
    yield { type: "complete", message: { ...message("assistant", "The answer"), citations: [{ chunkId: 1, docId: 1, filename: "crypt.md", headingPath: "", snippet: "The answer", campaignId: 1, revision: 1 }], toolCalls: [{ name: "search_notes", args: {}, status: "completed" }] } };
  });
  useChatStore.setState({ chat: chat() });
  expect(await useChatStore.getState().askLoremaster("Where?", { provider: "ollama" })).toBe(true);
  expect(useChatStore.getState().chat?.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
  expect(useChatStore.getState().chat?.messages[1]?.citations?.[0]?.revision).toBe(1);
  expect(useChatStore.getState().turnTools).toEqual([]);
});

test("cancellation keeps a partial draft visible and prevents late assistant commits", async () => {
  const gate = deferred<Record<string, unknown>>();
  let signal: AbortSignal | undefined;
  spyOn(api.chats, "ask").mockImplementation(async function* (_campaign, _chat, _body, supplied) {
    signal = supplied;
    yield { type: "user", message: message("user", "Slow question") };
    yield { type: "token", text: "Partial evidence" };
    await gate.promise;
  });
  useChatStore.setState({ chat: chat() });
  const pending = useChatStore.getState().askLoremaster("Slow question", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  useChatStore.getState().cancelAnswer();
  expect(signal?.aborted).toBe(true);
  gate.resolve({}); await pending;
  expect(useChatStore.getState().turnStatus).toBe("cancelled");
  expect(useChatStore.getState().streamingText).toBe("Partial evidence");
  expect(useChatStore.getState().chat?.messages).toHaveLength(1);
});

test("navigation closes the owned answer and late events cannot enter another thread", async () => {
  const gate = deferred<Record<string, unknown>>();
  spyOn(api.chats, "ask").mockImplementation(async function* () { yield { type: "token", text: "old" }; await gate.promise; });
  useChatStore.setState({ chat: chat() });
  const pending = useChatStore.getState().askLoremaster("old", {});
  useChatStore.getState().close();
  gate.resolve({}); await pending;
  expect(useChatStore.getState().chat).toBeNull();
  expect(useChatStore.getState().streamingText).toBe("");
});
