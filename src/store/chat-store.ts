import { create } from "zustand";
import { api } from "./api.ts";
import type { ChatMessage, ChatRecord, Citation, ToolCallRecord } from "../campaign/types.ts";

/**
 * Whichever thread is open — a campaign's Loremaster thread or a dungeon's
 * Architect log. They are the same object with a different owner, so they share
 * one store and one thread component; only the prompt and the tool set differ.
 */
interface ChatState {
  chat: ChatRecord | null;
  isLoading: boolean;
  /** True while an assistant turn is in flight. */
  isStreaming: boolean;
  /** Partial assistant text as it arrives, before it becomes a message. */
  streamingText: string;
  turnTools: ToolCallRecord[];
  activeTool: string | null;
  turnStatus: "idle" | "working" | "cancelled" | "failed";
  error: string | null;

  openChat: (id: number) => Promise<void>;
  openArchitect: (dungeonId: number) => Promise<ChatRecord | null>;
  close: () => void;

  send: (content: string) => Promise<boolean>;
  askLoremaster: (content: string, options: { provider?: string; model?: string | null; temperature?: number; thinkingLevel?: string | null }) => Promise<boolean>;
  cancelAnswer: () => void;
  recordAssistant: (
    content: string,
    citations?: Citation[] | null,
  ) => Promise<void>;
  truncateFrom: (index: number) => Promise<void>;
  /** Replace an edited user turn atomically; the local transcript changes only after ACK. */
  submitEdit: (index: number, content: string) => Promise<boolean>;

  setStreaming: (value: boolean) => void;
  setStreamingText: (text: string) => void;
  setError: (error: string | null) => void;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Optimistic placeholder id — replaced when the server answers. */
let localId = -1;
let chatEpoch = 0;
let answerAbort: AbortController | null = null;
export function chatVersion() {
  return chatEpoch;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  chat: null,
  isLoading: false,
  isStreaming: false,
  streamingText: "",
  turnTools: [],
  activeTool: null,
  turnStatus: "idle",
  error: null,

  setStreaming: (isStreaming) => set({ isStreaming }),
  setStreamingText: (streamingText) => set({ streamingText }),
  setError: (error) => set({ error }),

  close: () => {
    answerAbort?.abort(); answerAbort = null;
    ++chatEpoch;
    set({
      chat: null,
      isLoading: false,
      streamingText: "",
      isStreaming: false,
      turnTools: [], activeTool: null, turnStatus: "idle",
      error: null,
    });
  },

  openChat: async (id) => {
    const epoch = ++chatEpoch;
    const update: typeof set = (partial) => {
      if (epoch === chatEpoch) set(partial);
    };
    answerAbort?.abort(); answerAbort = null;
    update({ isLoading: true, chat: null, streamingText: "", turnTools: [], activeTool: null, turnStatus: "idle" });
    try {
      update({ chat: await api.chats.get(id), error: null });
    } catch (err) {
      update({ error: message(err, "Could not open that thread") });
    } finally {
      update({ isLoading: false });
    }
  },

  openArchitect: async (dungeonId) => {
    const epoch = ++chatEpoch;
    const update: typeof set = (partial) => {
      if (epoch === chatEpoch) set(partial);
    };
    answerAbort?.abort(); answerAbort = null;
    update({ isLoading: true, chat: null, streamingText: "", turnTools: [], activeTool: null, turnStatus: "idle" });
    try {
      const chat = await api.dungeons.architectChat(dungeonId);
      update({ chat, error: null });
      return epoch === chatEpoch ? chat : null;
    } catch (err) {
      update({ error: message(err, "Could not open the build log") });
      return null;
    } finally {
      update({ isLoading: false });
    }
  },

  /**
   * Shows the message immediately, then persists it. The optimistic entry is
   * swapped for the server's row rather than left in place, so its real id is
   * available for a later truncate.
   */
  send: async (content) => {
    const epoch = chatEpoch;
    const update: typeof set = (partial) => {
      if (epoch === chatEpoch) set(partial);
    };
    const chat = get().chat;
    if (chat === null) return false;

    const optimistic: ChatMessage = {
      id: localId--,
      role: "user",
      content,
      citations: null,
      toolCalls: null,
      createdAt: Date.now(),
    };
    update({ chat: { ...chat, messages: [...chat.messages, optimistic] } });

    try {
      const saved = await api.chats.append(chat.id, { role: "user", content });
      update((state) =>
        state.chat === null
          ? {}
          : {
              chat: {
                ...state.chat,
                messages: state.chat.messages.map((m) =>
                  m.id === optimistic.id ? saved : m,
                ),
              },
            },
      );
    } catch (err) {
      update({ error: message(err, "Could not save that message") });
      return false;
    }
    return epoch === chatEpoch;
  },

  recordAssistant: async (content, citations = null) => {
    const epoch = chatEpoch;
    const update: typeof set = (partial) => {
      if (epoch === chatEpoch) set(partial);
    };
    const chat = get().chat;
    if (chat === null) return;
    try {
      const saved = await api.chats.append(chat.id, {
        role: "assistant",
        content,
        citations,
      });
      update((state) =>
        state.chat === null
          ? {}
          : {
              chat: {
                ...state.chat,
                messages: [...state.chat.messages, saved],
              },
            },
      );
    } catch (err) {
      update({ error: message(err, "Could not save the reply") });
    } finally {
      update({ streamingText: "" });
    }
  },

  /** Edit-and-resend: drop this message and everything after it. */
  truncateFrom: async (index) => {
    const epoch = ++chatEpoch;
    const update: typeof set = (partial) => {
      if (epoch === chatEpoch) set(partial);
    };
    const chat = get().chat;
    if (chat === null) return;
    try {
      const messages = await api.chats.truncate(chat.id, index);
      update({ chat: { ...chat, messages }, error: null });
    } catch (err) {
      update({ error: message(err, "Could not edit that message") });
    }
  },

  askLoremaster: async (content, options) => {
    const epoch = chatEpoch;
    const chat = get().chat;
    if (chat === null || chat.dungeonId !== null || get().isStreaming) return false;
    const optimistic: ChatMessage = { id: localId--, role: "user", content, citations: null, toolCalls: null, createdAt: Date.now() };
    set({ chat: { ...chat, messages: [...chat.messages, optimistic] }, isStreaming: true, streamingText: "",
      turnTools: [], activeTool: null, turnStatus: "working", error: null });
    const abort = new AbortController(); answerAbort = abort;
    try {
      for await (const event of api.chats.ask(chat.campaignId, chat.id, { question: content, ...options }, abort.signal)) {
        if (epoch !== chatEpoch) return false;
        if (event.type === "user" && event.message) {
          const saved = event.message as ChatMessage;
          set((state) => state.chat ? { chat: { ...state.chat, messages: state.chat.messages.map((m) => m.id === optimistic.id ? saved : m) } } : {});
        } else if (event.type === "tool_start") {
          set({ activeTool: String(event.name ?? "tool") });
        } else if (event.type === "tool_result" && event.record) {
          set((state) => ({ turnTools: [...state.turnTools, event.record as ToolCallRecord], activeTool: null }));
        } else if (event.type === "token") {
          set((state) => ({ streamingText: state.streamingText + String(event.text ?? "") }));
        } else if (event.type === "complete" && event.message) {
          const saved = event.message as ChatMessage;
          set((state) => state.chat ? { chat: { ...state.chat, messages: [...state.chat.messages, saved] }, isStreaming: false,
            streamingText: "", activeTool: null, turnStatus: "idle", turnTools: [] } : {});
        }
      }
      if (epoch === chatEpoch && get().isStreaming) set({ isStreaming: false, activeTool: null, turnStatus: "failed", error: "The stream ended before the answer was saved. The draft is retained below." });
      return epoch === chatEpoch;
    } catch (err) {
      if (epoch !== chatEpoch) return false;
      const cancelled = abort.signal.aborted;
      set({ isStreaming: false, activeTool: null, turnStatus: cancelled ? "cancelled" : "failed",
        error: cancelled ? "Answer cancelled. The partial draft is retained below; you can retry the question." : message(err, "Could not answer that question. The partial draft is retained below.") });
      return false;
    } finally { if (answerAbort === abort) answerAbort = null; }
  },

  cancelAnswer: () => {
    answerAbort?.abort();
    set({ isStreaming: false, activeTool: null, turnStatus: "cancelled" });
  },

  submitEdit: async (index, content) => {
    const epoch = ++chatEpoch;
    const chat = get().chat;
    if (chat === null || index < 0 || index >= chat.messages.length) return false;
    const inputs = [
      ...chat.messages.slice(0, index),
      { role: "user" as const, content, citations: null },
    ];
    try {
      const messages = await api.chats.replace(chat.id, inputs);
      if (epoch !== chatEpoch) return false;
      set({ chat: { ...chat, messages }, error: null });
      return true;
    } catch (err) {
      if (epoch === chatEpoch)
        set({ error: message(err, "Could not save that edit") });
      return false;
    }
  },
}));
