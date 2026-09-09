import { usageReport } from "../db/usage.ts";
import { anyRatesConfigured } from "../ai/pricing.ts";
import { json } from "./http.ts";

/**
 * One endpoint for every scope. The query string picks the slice
 * (?campaignId= / ?dungeonId= / ?chatId=); no filter means lifetime totals.
 */
export function handleUsage(req: Request): Response {
  const url = new URL(req.url);

  const num = (key: string): number | undefined => {
    const raw = url.searchParams.get(key);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };

  const report = usageReport({
    campaignId: num("campaignId"),
    dungeonId: num("dungeonId"),
    chatId: num("chatId"),
  });

  return json({ ...report, ratesConfigured: anyRatesConfigured() });
}
