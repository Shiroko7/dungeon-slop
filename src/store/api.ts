import type { Blueprint } from "../ai/blueprint.ts";
import type {
  Campaign,
  CampaignInput,
  ChatMessage,
  ChatRecord,
  ChatSummary,
  DungeonInput,
  DungeonMutation,
  DungeonRecord,
  DungeonSummary,
  MessageInput,
} from "../campaign/types.ts";
import type { Dungeon } from "../engine/types.ts";
import type { DungeonConfig } from "../ai/schema.ts";
import type { NoteDocument } from "../notes/types.ts";
import type { UsageReport } from "../usage/types.ts";

/**
 * One typed door to the server.
 *
 * Errors carry the server's own message rather than a bare status code —
 * "A campaign needs a name" is something a user can act on, and it is already
 * written on the other side of the wire.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  const text = await response.text();

  let payload: unknown = null;
  if (text !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Server responded with ${response.status}`;
    const data = payload as { code?: string; revision?: number } | null;
    throw new ApiError(message, response.status, data?.code, data?.revision);
  }

  return payload as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public revision?: number,
  ) {
    super(message);
  }
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function patchJson(body: unknown): RequestInit {
  return { ...postJson(body), method: "PATCH" };
}

export const api = {
  campaigns: {
    list: () =>
      request<{ campaigns: Campaign[] }>("/api/campaigns").then(
        (r) => r.campaigns,
      ),
    get: (id: number) =>
      request<{ campaign: Campaign }>(`/api/campaigns/${id}`).then(
        (r) => r.campaign,
      ),
    create: (input: CampaignInput) =>
      request<{ campaign: Campaign }>("/api/campaigns", postJson(input)).then(
        (r) => r.campaign,
      ),
    update: (id: number, patch: Partial<CampaignInput>) =>
      request<{ campaign: Campaign }>(
        `/api/campaigns/${id}`,
        patchJson(patch),
      ).then((r) => r.campaign),
    remove: (id: number) =>
      request<{ deleted: number }>(`/api/campaigns/${id}`, {
        method: "DELETE",
      }),
  },

  dungeons: {
    list: (campaignId: number) =>
      request<{ dungeons: DungeonSummary[] }>(
        `/api/campaigns/${campaignId}/dungeons`,
      ).then((r) => r.dungeons),
    get: (id: number) =>
      request<{ dungeon: DungeonRecord }>(`/api/dungeons/${id}`).then(
        (r) => r.dungeon,
      ),
    create: (
      campaignId: number,
      input: Partial<DungeonInput> & { name: string },
    ) =>
      request<{ dungeon: DungeonRecord }>(
        `/api/campaigns/${campaignId}/dungeons`,
        postJson(input),
      ).then((r) => r.dungeon),
    update: (id: number, mutation: DungeonMutation) =>
      request<{ revision: number }>(`/api/dungeons/${id}`, patchJson(mutation)),
    remove: (id: number) =>
      request<{ deleted: number }>(`/api/dungeons/${id}`, { method: "DELETE" }),
    fork: (
      id: number,
      input: {
        expectedRevision: number;
        seed: number | null;
        config: DungeonConfig | null;
        geometry: Dungeon | null;
        blueprint?: Blueprint | null;
      },
    ) =>
      request<{ dungeon: DungeonRecord }>(
        `/api/dungeons/${id}/fork`,
        postJson(input),
      ).then((r) => r.dungeon),
    architectChat: (dungeonId: number) =>
      request<{ chat: ChatRecord }>(
        `/api/dungeons/${dungeonId}/chat`,
        postJson({}),
      ).then((r) => r.chat),
  },

  chats: {
    list: (campaignId: number) =>
      request<{ chats: ChatSummary[] }>(
        `/api/campaigns/${campaignId}/chats`,
      ).then((r) => r.chats),
    get: (id: number) =>
      request<{ chat: ChatRecord }>(`/api/chats/${id}`).then((r) => r.chat),
    create: (campaignId: number, title?: string) =>
      request<{ chat: ChatRecord }>(
        `/api/campaigns/${campaignId}/chats`,
        postJson({ title }),
      ).then((r) => r.chat),
    rename: (id: number, title: string) =>
      request<{ chat: ChatRecord }>(
        `/api/chats/${id}`,
        patchJson({ title }),
      ).then((r) => r.chat),
    remove: (id: number) =>
      request<{ deleted: number }>(`/api/chats/${id}`, { method: "DELETE" }),
    append: (chatId: number, message: MessageInput) =>
      request<{ message: ChatMessage }>(
        `/api/chats/${chatId}/messages`,
        postJson(message),
      ).then((r) => r.message),
    replace: (chatId: number, messages: MessageInput[]) =>
      request<{ messages: ChatMessage[] }>(
        `/api/chats/${chatId}/messages`,
        postJson({ messages }),
      ).then((r) => r.messages),
    truncate: (chatId: number, index: number) =>
      request<{ messages: ChatMessage[] }>(
        `/api/chats/${chatId}/messages/${index}`,
        {
          method: "DELETE",
        },
      ).then((r) => r.messages),
  },

  notes: {
    list: (campaignId: number) =>
      request<{ documents: NoteDocument[] }>(
        `/api/campaigns/${campaignId}/notes`,
      ).then((r) => r.documents),
    remove: (docId: number) =>
      request<{ deleted: number }>(`/api/notes/${docId}`, { method: "DELETE" }),
  },

  usage: {
    /** Omit every field for lifetime totals; pass one to scope the report. */
    report: (scope?: {
      campaignId?: number;
      dungeonId?: number;
      chatId?: number;
    }) => {
      const q = new URLSearchParams();
      if (scope?.campaignId !== undefined)
        q.set("campaignId", String(scope.campaignId));
      if (scope?.dungeonId !== undefined)
        q.set("dungeonId", String(scope.dungeonId));
      if (scope?.chatId !== undefined) q.set("chatId", String(scope.chatId));
      const qs = q.toString();
      return request<UsageReport & { ratesConfigured: boolean }>(
        `/api/usage${qs === "" ? "" : `?${qs}`}`,
      );
    },
  },

  legacy: {
    status: () =>
      request<{ done: boolean; campaigns: number }>("/api/legacy-import"),
    run: (payload: unknown) =>
      request<{
        imported: number;
        campaignId?: number;
        currentDungeonId?: number | null;
        skipped?: boolean;
      }>("/api/legacy-import", postJson(payload)),
  },
};
