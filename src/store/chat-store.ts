import { create } from "zustand";
import { api } from "./api.ts";
import type { ChatMessage, ChatRecord, Citation } from "../campaign/types.ts";

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
  error: string | null;

  openChat: (id: number) => Promise<void>;
  openArchitect: (dungeonId: number) => Promise<ChatRecord | null>;
  close: () => void;

  send: (content: string) => Promise<void>;
  recordAssistant: (content: string, citations?: Citation[] | null) => Promise<void>;
  truncateFrom: (index: number) => Promise<void>;

  setStreaming: (value: boolean) => void;
  setStreamingText: (text: string) => void;
  setError: (error: string | null) => void;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Optimistic placeholder id — replaced when the server answers. */
let localId = -1;

export const useChatStore = create<ChatState>()((set, get) => ({
  chat: null,
  isLoading: false,
  isStreaming: false,
  streamingText: "",
  error: null,

  setStreaming: (isStreaming) => set({ isStreaming }),
  setStreamingText: (streamingText) => set({ streamingText }),
  setError: (error) => set({ error }),

  close: () => set({ chat: null, streamingText: "", isStreaming: false, error: null }),

  openChat: async (id) => {
    if (get().chat?.id === id) return;
    set({ isLoading: true, chat: null, streamingText: "" });
    try {
      set({ chat: await api.chats.get(id), error: null });
    } catch (err) {
      set({ error: message(err, "Could not open that thread") });
    } finally {
      set({ isLoading: false });
    }
  },

  openArchitect: async (dungeonId) => {
    set({ isLoading: true, streamingText: "" });
    try {
      const chat = await api.dungeons.architectChat(dungeonId);
      set({ chat, error: null });
      return chat;
    } catch (err) {
      set({ error: message(err, "Could not open the build log") });
      return null;
    } finally {
      set({ isLoading: false });
    }
  },

  /**
   * Shows the message immediately, then persists it. The optimistic entry is
   * swapped for the server's row rather than left in place, so its real id is
   * available for a later truncate.
   */
  send: async (content) => {
    const chat = get().chat;
    if (chat === null) return;

    const optimistic: ChatMessage = {
      id: localId--,
      role: "user",
      content,
      citations: null,
      createdAt: Date.now(),
    };
    set({ chat: { ...chat, messages: [...chat.messages, optimistic] } });

    try {
      const saved = await api.chats.append(chat.id, { role: "user", content });
      set((state) =>
        state.chat === null
          ? {}
          : {
              chat: {
                ...state.chat,
                messages: state.chat.messages.map((m) => (m.id === optimistic.id ? saved : m)),
              },
            },
      );
    } catch (err) {
      set({ error: message(err, "Could not save that message") });
    }
  },

  recordAssistant: async (content, citations = null) => {
    const chat = get().chat;
    if (chat === null) return;
    try {
      const saved = await api.chats.append(chat.id, { role: "assistant", content, citations });
      set((state) =>
        state.chat === null ? {} : { chat: { ...state.chat, messages: [...state.chat.messages, saved] } },
      );
    } catch (err) {
      set({ error: message(err, "Could not save the reply") });
    } finally {
      set({ streamingText: "" });
    }
  },

  /** Edit-and-resend: drop this message and everything after it. */
  truncateFrom: async (index) => {
    const chat = get().chat;
    if (chat === null) return;
    try {
      const messages = await api.chats.truncate(chat.id, index);
      set({ chat: { ...chat, messages }, error: null });
    } catch (err) {
      set({ error: message(err, "Could not edit that message") });
    }
  },
}));
