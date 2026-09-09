/**
 * Shapes shared by the ledger and the views that read it.
 *
 * These live outside src/db so the browser can import them. Anything under
 * src/db reaches bun:sqlite, which Vite stubs silently - a value import from
 * there blanks the app at runtime with no build error.
 */

/** What produced the call. Kept coarse - it is a spend label, not a trace. */
export type UsageOperation =
  | "config"
  | "blueprint"
  | "refine"
  | "rooms"
  | "room"
  | "overview"
  | "chat";

export interface UsageRow {
  id: number;
  campaignId: number | null;
  dungeonId: number | null;
  chatId: number | null;
  operation: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  reasoning: string | null;
  failed: boolean;
  createdAt: number;
  /** Null when the model has no rate on file - show tokens only. */
  usd: number | null;
  rateMissing: boolean;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  usd: number;
  /** Calls whose model has no rate on file, so `usd` excludes them. */
  unpricedCalls: number;
}

export interface UsageGroup {
  key: number | string | null;
  label: string;
  totals: UsageTotals;
}

export interface UsageReport {
  overall: UsageTotals;
  byModel: UsageGroup[];
  byOperation: UsageGroup[];
  byDungeon: UsageGroup[];
  byChat: UsageGroup[];
  recent: UsageRow[];
}
