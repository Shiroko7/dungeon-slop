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

  send: (content: string) => Promise<boolean>;
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
export function chatVersion() {
  return chatEpoch;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  chat: null,
  isLoading: false,
  isStreaming: false,
  streamingText: "",
  error: null,

  setStreaming: (isStreaming) => set({ isStreaming }),
  setStreamingText: (streamingText) => set({ streamingText }),
  setError: (error) => set({ error }),

  close: () => {
    ++chatEpoch;
    set({
      chat: null,
      isLoading: false,
      streamingText: "",
      isStreaming: false,
      error: null,
    });
  },

  openChat: async (id) => {
    const epoch = ++chatEpoch;
    const update: typeof set = (partial) => {
      if (epoch === chatEpoch) set(partial);
    };
    update({ isLoading: true, chat: null, streamingText: "" });
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
    update({ isLoading: true, chat: null, streamingText: "" });
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
