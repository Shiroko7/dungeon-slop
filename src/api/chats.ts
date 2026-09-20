import { appDb } from "../db/context.ts";
import { campaignExists } from "../campaign/campaigns.ts";
import {
  appendMessage,
  createChat,
  deleteChat,
  getChat,
  listChats,
  replaceMessages,
  truncateMessagesFrom,
  updateChat,
} from "../campaign/chats.ts";
import type { MessageInput } from "../campaign/types.ts";
import { badRequest, json, notFound, readJson, serverError } from "./http.ts";

export function handleListChats(campaignId: number): Response {
  if (!campaignExists(appDb(), campaignId))
    return notFound(`No campaign ${campaignId}`);
  return json({ chats: listChats(appDb(), campaignId) });
}

export function handleGetChat(id: number): Response {
  const chat = getChat(appDb(), id);
  return chat === null ? notFound(`No chat ${id}`) : json({ chat });
}

export async function handleCreateChat(
  req: Request,
  campaignId: number,
): Promise<Response> {
  const db = appDb();
  if (!campaignExists(db, campaignId))
    return notFound(`No campaign ${campaignId}`);

  const body = await readJson<{ title?: string }>(req);
  if (!body || (body.title !== undefined && typeof body.title !== "string"))
    return badRequest("Expected a string title");
  try {
    return json(
      { chat: createChat(db, campaignId, { title: body.title }) },
      201,
    );
  } catch (err) {
    return serverError(err);
  }
}

export async function handleUpdateChat(
  req: Request,
  id: number,
): Promise<Response> {
  const body = await readJson<{ title?: string }>(req);
  if (body === null || typeof body.title !== "string") {
    return badRequest("Expected a JSON body with a title");
  }
  const chat = updateChat(appDb(), id, { title: body.title });
  return chat === null ? notFound(`No chat ${id}`) : json({ chat });
}

export function handleDeleteChat(id: number): Response {
  return deleteChat(appDb(), id)
    ? json({ deleted: id })
    : notFound(`No chat ${id}`);
}

function isRole(value: unknown): value is "user" | "assistant" {
  return value === "user" || value === "assistant";
}

/**
 * Append one message, or replace the whole thread when `messages` is sent.
 * Replacement is what the Architect uses: its transcript is rebuilt from the
 * client's working copy after an edit-and-resend, rather than diffed.
 */
export async function handleAppendMessage(
  req: Request,
  chatId: number,
): Promise<Response> {
  const db = appDb();
  if (getChat(db, chatId) === null) return notFound(`No chat ${chatId}`);

  const body = await readJson<
    { messages?: MessageInput[] } & Partial<MessageInput>
  >(req);
  if (body === null) return badRequest("Expected a JSON body");

  try {
    if (Array.isArray(body.messages)) {
      const clean = body.messages.filter(
        (m): m is MessageInput =>
          isRole(m?.role) && typeof m?.content === "string",
      );
      return json({ messages: replaceMessages(db, chatId, clean) });
    }

    if (!isRole(body.role) || typeof body.content !== "string") {
      return badRequest(
        "A message needs a role of user or assistant and a string content",
      );
    }
    return json(
      {
        message: appendMessage(db, chatId, {
          role: body.role,
          content: body.content,
          citations: body.citations ?? null,
        }),
      },
      201,
    );
  } catch (err) {
    return serverError(err);
  }
}

/** Drop the message at `index` and everything after it — edit-and-resend. */
export function handleTruncateMessages(
  chatId: number,
  index: number,
): Response {
  const db = appDb();
  if (getChat(db, chatId) === null) return notFound(`No chat ${chatId}`);
  return json({ messages: truncateMessagesFrom(db, chatId, index) });
}
