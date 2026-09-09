import { appDb } from "./context.ts";
import { costOf, type TokenCounts } from "../ai/pricing.ts";
import type {
  UsageGroup,
  UsageOperation,
  UsageReport,
  UsageRow,
  UsageTotals,
} from "../usage/types.ts";

export type {
  UsageGroup,
  UsageOperation,
  UsageReport,
  UsageRow,
  UsageTotals,
} from "../usage/types.ts";


export interface UsageOwner {
  campaignId?: number | null;
  dungeonId?: number | null;
  chatId?: number | null;
}

export interface RecordUsageInput extends UsageOwner {
  operation: UsageOperation;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  reasoning?: string | null;
  /** A call that threw partway still burned input tokens; record it as failed. */
  failed?: boolean;
}

/**
 * Append one row to the ledger.
 *
 * Never throws: a bookkeeping failure must not take down the generation that
 * succeeded. A dropped row costs a line in a report; a thrown one costs the
 * user the dungeon they just paid for.
 */
export function recordUsage(input: RecordUsageInput): void {
  const insert = (campaignId: number | null, dungeonId: number | null, chatId: number | null) => {
    appDb().run(
      `INSERT INTO usage_events
         (campaign_id, dungeon_id, chat_id, operation, provider, model,
          input_tokens, output_tokens, thinking_tokens, reasoning, failed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campaignId,
        dungeonId,
        chatId,
        input.operation,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.thinkingTokens ?? 0,
        input.reasoning ?? null,
        input.failed === true ? 1 : 0,
        Date.now(),
      ],
    );
  };

  try {
    insert(input.campaignId ?? null, input.dungeonId ?? null, input.chatId ?? null);
  } catch (err) {
    // A stale or unsaved owner id fails the foreign key. The spend still
    // happened, so retry unattributed rather than dropping it: a row missing
    // from "by dungeon" is a smaller lie than a lifetime total that is short.
    try {
      insert(null, null, null);
      console.warn("usage ledger: owner ids rejected, recorded unattributed:", err);
    } catch (fatal) {
      console.error("usage ledger write failed:", fatal);
    }
  }
}


interface RawRow {
  id: number;
  campaign_id: number | null;
  dungeon_id: number | null;
  chat_id: number | null;
  operation: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  reasoning: string | null;
  failed: number;
  created_at: number;
}

function priceRow(r: RawRow): UsageRow {
  const tokens: TokenCounts = {
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    thinkingTokens: r.thinking_tokens,
  };
  const { usd, rateMissing } = costOf(r.model, tokens);
  return {
    id: r.id,
    campaignId: r.campaign_id,
    dungeonId: r.dungeon_id,
    chatId: r.chat_id,
    operation: r.operation,
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    thinkingTokens: r.thinking_tokens,
    reasoning: r.reasoning,
    failed: r.failed === 1,
    createdAt: r.created_at,
    usd,
    rateMissing,
  };
}


function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    usd: 0,
    unpricedCalls: 0,
  };
}

/**
 * `usd` sums only the rows that could be priced, and `unpricedCalls` counts the
 * rest, so a partially-filled rate table reads as "$X across N of M calls"
 * instead of silently understating the bill.
 */
function totalsOf(rows: UsageRow[]): UsageTotals {
  const t = emptyTotals();
  for (const r of rows) {
    t.calls += 1;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.thinkingTokens += r.thinkingTokens;
    if (r.usd === null) t.unpricedCalls += 1;
    else t.usd += r.usd;
  }
  t.totalTokens = t.inputTokens + t.outputTokens + t.thinkingTokens;
  return t;
}



function groupBy(
  rows: UsageRow[],
  key: (r: UsageRow) => number | string | null,
  label: (r: UsageRow) => string,
): UsageGroup[] {
  const groups = new Map<string, { key: number | string | null; label: string; rows: UsageRow[] }>();
  for (const r of rows) {
    const k = key(r);
    const id = String(k);
    let g = groups.get(id);
    if (g === undefined) {
      g = { key: k, label: label(r), rows: [] };
      groups.set(id, g);
    }
    g.rows.push(r);
  }
  return [...groups.values()]
    .map((g) => ({ key: g.key, label: g.label, totals: totalsOf(g.rows) }))
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);
}

function allRows(where: string, params: unknown[]): UsageRow[] {
  const raw = appDb()
    .query(`SELECT * FROM usage_events ${where} ORDER BY created_at DESC`)
    .all(...(params as never[])) as RawRow[];
  return raw.map(priceRow);
}

/** Names for the group labels, resolved in one pass rather than per row. */
function nameMaps(): { dungeons: Map<number, string>; chats: Map<number, string> } {
  const db = appDb();
  const dungeons = new Map<number, string>();
  for (const d of db.query("SELECT id, name FROM dungeons").all() as Array<{
    id: number;
    name: string;
  }>) {
    dungeons.set(d.id, d.name);
  }
  const chats = new Map<number, string>();
  for (const c of db.query("SELECT id, title FROM chats").all() as Array<{
    id: number;
    title: string;
  }>) {
    chats.set(c.id, c.title.length > 0 ? c.title : `Chat ${c.id}`);
  }
  return { dungeons, chats };
}

export function usageReport(scope?: {
  campaignId?: number;
  dungeonId?: number;
  chatId?: number;
}): UsageReport {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope?.campaignId !== undefined) {
    clauses.push("campaign_id = ?");
    params.push(scope.campaignId);
  }
  if (scope?.dungeonId !== undefined) {
    clauses.push("dungeon_id = ?");
    params.push(scope.dungeonId);
  }
  if (scope?.chatId !== undefined) {
    clauses.push("chat_id = ?");
    params.push(scope.chatId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = allRows(where, params);
  const { dungeons, chats } = nameMaps();

  return {
    overall: totalsOf(rows),
    byModel: groupBy(rows, (r) => r.model, (r) => r.model),
    byOperation: groupBy(rows, (r) => r.operation, (r) => r.operation),
    byDungeon: groupBy(
      rows.filter((r) => r.dungeonId !== null),
      (r) => r.dungeonId,
      (r) => dungeons.get(r.dungeonId as number) ?? `Deleted dungeon ${r.dungeonId}`,
    ),
    byChat: groupBy(
      rows.filter((r) => r.chatId !== null),
      (r) => r.chatId,
      (r) => chats.get(r.chatId as number) ?? `Deleted chat ${r.chatId}`,
    ),
    recent: rows.slice(0, 50),
  };
}
