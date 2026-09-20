import { appDb } from "../db/context.ts";
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from "../campaign/campaigns.ts";
import type { CampaignInput } from "../campaign/types.ts";
import { badRequest, json, notFound, readJson, serverError } from "./http.ts";

export function handleListCampaigns(): Response {
  return json({ campaigns: listCampaigns(appDb()) });
}

export function handleGetCampaign(id: number): Response {
  const campaign = getCampaign(appDb(), id);
  return campaign === null ? notFound(`No campaign ${id}`) : json({ campaign });
}

export async function handleCreateCampaign(req: Request): Promise<Response> {
  const body = await readJson<Partial<CampaignInput>>(req);
  if (body === null || typeof body.name !== "string") {
    return badRequest("Expected a JSON body with a name");
  }
  if (body.blurb !== undefined && typeof body.blurb !== "string")
    return badRequest("blurb must be a string");
  try {
    return json(
      {
        campaign: createCampaign(appDb(), {
          name: body.name,
          blurb: body.blurb,
        }),
      },
      201,
    );
  } catch (err) {
    return err instanceof Error && /needs a name/i.test(err.message)
      ? badRequest(err.message)
      : serverError(err);
  }
}

export async function handleUpdateCampaign(
  req: Request,
  id: number,
): Promise<Response> {
  const body = await readJson<Partial<CampaignInput>>(req);
  if (body === null) return badRequest("Expected a JSON body");
  if (
    (body.name !== undefined && typeof body.name !== "string") ||
    (body.blurb !== undefined && typeof body.blurb !== "string")
  )
    return badRequest("Campaign fields must be strings");

  try {
    const campaign = updateCampaign(appDb(), id, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.blurb === "string" ? { blurb: body.blurb } : {}),
    });
    return campaign === null
      ? notFound(`No campaign ${id}`)
      : json({ campaign });
  } catch (err) {
    return err instanceof Error && /needs a name/i.test(err.message)
      ? badRequest(err.message)
      : serverError(err);
  }
}

/**
 * Deletes the campaign and everything inside it — notes, chunks, embeddings,
 * dungeons, room notes, chats, messages — in one cascade. There is no soft
 * delete and no undo, so the client confirms first.
 */
export function handleDeleteCampaign(id: number): Response {
  return deleteCampaign(appDb(), id)
    ? json({ deleted: id })
    : notFound(`No campaign ${id}`);
}
