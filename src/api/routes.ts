import { handleGenerateConfig } from "./generate-config.ts";
import { handleGenerateDungeon } from "./generate-dungeon.ts";
import { handleDescribeRooms, handleDescribeRoom } from "./describe-rooms.ts";
import { handleGenerateBlueprint } from "./generate-blueprint.ts";
import { handleRefineLayout } from "./refine-layout.ts";
import { handleDescribeDungeon } from "./describe-dungeon.ts";
import {
  handleDeleteNote,
  handleListNotes,
  handleUploadNotes,
  handleRetryNotes,
  handleNotesProviders,
} from "./upload-notes.ts";
import {
  handleCreateCampaign,
  handleDeleteCampaign,
  handleGetCampaign,
  handleListCampaigns,
  handleUpdateCampaign,
} from "./campaigns.ts";
import {
  handleArchitectChat,
  handleCreateDungeon,
  handleDeleteDungeon,
  handleDeleteRoomNote,
  handleForkDungeon,
  handleGetDungeon,
  handleListDungeons,
  handleListDungeonRevisions,
  handleRestoreDungeonRevision,
  handlePutRoomNote,
  handleUpdateDungeon,
} from "./dungeons.ts";
import {
  handleAppendMessage,
  handleCreateChat,
  handleDeleteChat,
  handleGetChat,
  handleListChats,
  handleTruncateMessages,
  handleUpdateChat,
} from "./chats.ts";
import {
  handleLegacyImport,
  handleLegacyImportStatus,
} from "./legacy-import.ts";
import { handleUsage } from "./usage.ts";
import { handleAskLoremaster } from "./loremaster.ts";
import { handleReadNote, handleSearchNotes } from "./search-notes.ts";
import { json, readJson, badRequest, serverError } from "./http.ts";
import { checkOrigin } from "./origin.ts";
import { validateAIRequest } from "./ownership.ts";

/**
 * Routes are matched against a small table rather than a chain of `if`s, so the
 * URL space stays readable as one thing — it mirrors the client's routes, and
 * the ownership tree is visible in the paths themselves.
 *
 * Every `(\d+)` capture is handed to a handler as a number; a non-numeric id
 * simply fails to match and falls through to a 404.
 */
type Handler = (req: Request, ids: number[]) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  handle: Handler;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/notes\/providers$/,
    handle: () => handleNotesProviders(),
  },
  {
    method: "POST",
    pattern: /^\/api\/campaigns\/(\d+)\/notes\/retry$/,
    handle: (req, [id]) => handleRetryNotes(req, id!),
  },
  // ─── campaigns ────────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: /^\/api\/campaigns$/,
    handle: () => handleListCampaigns(),
  },
  {
    method: "POST",
    pattern: /^\/api\/campaigns$/,
    handle: (req) => handleCreateCampaign(req),
  },
  {
    method: "GET",
    pattern: /^\/api\/campaigns\/(\d+)$/,
    handle: (_r, [id]) => handleGetCampaign(id!),
  },
  {
    method: "PATCH",
    pattern: /^\/api\/campaigns\/(\d+)$/,
    handle: (req, [id]) => handleUpdateCampaign(req, id!),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/campaigns\/(\d+)$/,
    handle: (_r, [id]) => handleDeleteCampaign(id!),
  },

  // ─── notes, owned by a campaign ───────────────────────────────────────────
  {
    method: "POST",
    pattern: /^\/api\/campaigns\/(\d+)\/notes\/search$/,
    handle: (req, [id]) => handleSearchNotes(req, id!),
  },
  {
    method: "GET",
    pattern: /^\/api\/campaigns\/(\d+)\/notes\/(\d+)\/revisions\/(\d+)$/,
    handle: (req, [campaign, doc, revision]) => handleReadNote(req, campaign!, doc!, revision!),
  },
  {
    method: "GET",
    pattern: /^\/api\/campaigns\/(\d+)\/notes$/,
    handle: (_r, [id]) => handleListNotes(id!),
  },
  {
    method: "POST",
    pattern: /^\/api\/campaigns\/(\d+)\/notes$/,
    handle: (req, [id]) => handleUploadNotes(req, id!),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/notes\/(\d+)$/,
    handle: (_r, [id]) => handleDeleteNote(id!),
  },

  // ─── dungeons, owned by a campaign ────────────────────────────────────────
  {
    method: "GET",
    pattern: /^\/api\/campaigns\/(\d+)\/dungeons$/,
    handle: (_r, [id]) => handleListDungeons(id!),
  },
  {
    method: "POST",
    pattern: /^\/api\/campaigns\/(\d+)\/dungeons$/,
    handle: (req, [id]) => handleCreateDungeon(req, id!),
  },
  {
    method: "GET",
    pattern: /^\/api\/dungeons\/(\d+)$/,
    handle: (_r, [id]) => handleGetDungeon(id!),
  },
  {
    method: "PATCH",
    pattern: /^\/api\/dungeons\/(\d+)$/,
    handle: (req, [id]) => handleUpdateDungeon(req, id!),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/dungeons\/(\d+)$/,
    handle: (_r, [id]) => handleDeleteDungeon(id!),
  },
  {
    method: "POST",
    pattern: /^\/api\/dungeons\/(\d+)\/fork$/,
    handle: (req, [id]) => handleForkDungeon(req, id!),
  },
  {
    method: "GET",
    pattern: /^\/api\/dungeons\/(\d+)\/revisions$/,
    handle: (req, [id]) =>
      handleListDungeonRevisions(id!, new URL(req.url).searchParams),
  },
  {
    method: "POST",
    pattern: /^\/api\/dungeons\/(\d+)\/revisions\/(\d+)\/restore$/,
    handle: (req, [id, revision]) =>
      handleRestoreDungeonRevision(req, id!, revision!),
  },
  {
    method: "POST",
    pattern: /^\/api\/dungeons\/(\d+)\/chat$/,
    handle: (_r, [id]) => handleArchitectChat(id!),
  },
  {
    method: "PUT",
    pattern: /^\/api\/dungeons\/(\d+)\/rooms\/(\d+)$/,
    handle: (req, [id, room]) => handlePutRoomNote(req, id!, room!),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/dungeons\/(\d+)\/rooms\/(\d+)$/,
    handle: (req, [id, room]) => handleDeleteRoomNote(req, id!, room!),
  },

  // ─── chats, owned by a campaign ───────────────────────────────────────────
  {
    method: "POST",
    pattern: /^\/api\/campaigns\/(\d+)\/chats\/(\d+)\/ask$/,
    handle: (req, [campaign, chat]) => handleAskLoremaster(req, campaign!, chat!),
  },
  {
    method: "GET",
    pattern: /^\/api\/campaigns\/(\d+)\/chats$/,
    handle: (_r, [id]) => handleListChats(id!),
  },
  {
    method: "POST",
    pattern: /^\/api\/campaigns\/(\d+)\/chats$/,
    handle: (req, [id]) => handleCreateChat(req, id!),
  },
  {
    method: "GET",
    pattern: /^\/api\/chats\/(\d+)$/,
    handle: (_r, [id]) => handleGetChat(id!),
  },
  {
    method: "PATCH",
    pattern: /^\/api\/chats\/(\d+)$/,
    handle: (req, [id]) => handleUpdateChat(req, id!),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/chats\/(\d+)$/,
    handle: (_r, [id]) => handleDeleteChat(id!),
  },
  {
    method: "POST",
    pattern: /^\/api\/chats\/(\d+)\/messages$/,
    handle: (req, [id]) => handleAppendMessage(req, id!),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/chats\/(\d+)\/messages\/(\d+)$/,
    handle: (_r, [id, index]) => handleTruncateMessages(id!, index!),
  },

  // ─── generation (stateless; the client owns what comes back) ──────────────
  {
    method: "POST",
    pattern: /^\/api\/generate-config$/,
    handle: (req) => handleGenerateConfig(req),
  },
  {
    method: "POST",
    pattern: /^\/api\/generate-dungeon$/,
    handle: (req) => handleGenerateDungeon(req),
  },
  {
    method: "POST",
    pattern: /^\/api\/generate-blueprint$/,
    handle: (req) => handleGenerateBlueprint(req),
  },
  {
    method: "POST",
    pattern: /^\/api\/refine-layout$/,
    handle: (req) => handleRefineLayout(req),
  },
  {
    method: "POST",
    pattern: /^\/api\/describe-rooms$/,
    handle: (req) => handleDescribeRooms(req),
  },
  {
    method: "POST",
    pattern: /^\/api\/describe-dungeon$/,
    handle: (req) => handleDescribeDungeon(req),
  },
  {
    method: "POST",
    pattern: /^\/api\/describe-room\/(\d+)$/,
    handle: (req, [id]) => handleDescribeRoom(req, String(id)),
  },

  // ─── one-shot localStorage migration ──────────────────────────────────────
  // ─── spend ledger ─────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: /^\/api\/usage$/,
    handle: (req) => handleUsage(req),
  },

  {
    method: "GET",
    pattern: /^\/api\/legacy-import$/,
    handle: () => handleLegacyImportStatus(),
  },
  {
    method: "POST",
    pattern: /^\/api\/legacy-import$/,
    handle: (req) => handleLegacyImport(req),
  },
];

export async function handleApiRoute(
  req: Request,
  pathname: string,
): Promise<Response | null> {
  if (pathname.startsWith("/api/")) {
    const rejected = checkOrigin(req);
    if (rejected) return rejected;
  }
  if (pathname === "/api/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let pathMatched = false;

  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (match === null) continue;
    pathMatched = true;
    if (route.method !== req.method) continue;

    const ids = match.slice(1).map(Number);
    if (ids.some((id) => !Number.isSafeInteger(id)))
      return badRequest("Invalid route ID");
    if (
      ["POST", "PUT", "PATCH"].includes(req.method) &&
      !pathname.endsWith("/notes")
    ) {
      const body = await readJson<Record<string, unknown>>(req.clone());
      if (!body) return badRequest("Expected a JSON object");
      if (/^\/api\/(generate-|describe-|refine-)/.test(pathname)) {
        const rejected = validateAIRequest(body);
        if (rejected) return rejected;
      }
    }
    try {
      return await route.handle(req, ids);
    } catch (err) {
      return serverError(err);
    }
  }

  // A path that exists under a different verb gets a 405, not a 404 — answering
  // "not found" would send a client hunting for a typo in a correct URL.
  if (pathMatched)
    return json({ error: `${req.method} is not allowed on ${pathname}` }, 405);

  return null;
}
