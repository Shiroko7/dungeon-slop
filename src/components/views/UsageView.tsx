import { useCallback, useEffect, useState } from "react";
import { api } from "../../store/api.ts";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";
import type { UsageGroup, UsageReport, UsageRow, UsageTotals } from "../../usage/types.ts";

type Report = UsageReport & { ratesConfigured: boolean };

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Sub-cent amounts are the normal case for a single call, so a flat 2dp would
 * render most of this dashboard as "$0.00" and make the whole thing look broken.
 */
function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const OPERATION_LABELS: Record<string, string> = {
  config: "Architect (config)",
  blueprint: "Architect (floor plan)",
  refine: "Layout refine",
  rooms: "Room descriptions",
  room: "Single room",
  overview: "Dungeon overview",
  chat: "Chat",
};

function opLabel(op: string): string {
  return OPERATION_LABELS[op] ?? op;
}

/**
 * The one place a dollar figure is allowed to be absent. `unpricedCalls` is
 * surfaced rather than folded into the total, because a table with half its
 * rates missing must not read as though the spend were genuinely that low.
 */
function Cost({ totals, ratesConfigured }: { totals: UsageTotals; ratesConfigured: boolean }) {
  if (!ratesConfigured) return <span className="usage-cost usage-cost--none">—</span>;
  if (totals.unpricedCalls === totals.calls) {
    return <span className="usage-cost usage-cost--none">rate not set</span>;
  }
  return (
    <span className="usage-cost">
      {formatUsd(totals.usd)}
      {totals.unpricedCalls > 0 && (
        <small className="usage-cost-partial">
          {" "}
          +{totals.unpricedCalls} unpriced
        </small>
      )}
    </span>
  );
}

function GroupTable({
  title,
  groups,
  ratesConfigured,
  labelHeading,
  transformLabel,
}: {
  title: string;
  groups: UsageGroup[];
  ratesConfigured: boolean;
  labelHeading: string;
  transformLabel?: (label: string) => string;
}) {
  if (groups.length === 0) return null;

  return (
    <section className="usage-section">
      <h3 className="usage-section-heading">{title}</h3>
      <div className="usage-table-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th>{labelHeading}</th>
              <th className="usage-num">Calls</th>
              <th className="usage-num">In</th>
              <th className="usage-num">Out</th>
              <th className="usage-num">Thinking</th>
              <th className="usage-num">Total</th>
              <th className="usage-num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={String(g.key)}>
                <td className="usage-label">
                  {transformLabel ? transformLabel(g.label) : g.label}
                </td>
                <td className="usage-num">{g.totals.calls}</td>
                <td className="usage-num">{formatTokens(g.totals.inputTokens)}</td>
                <td className="usage-num">{formatTokens(g.totals.outputTokens)}</td>
                <td className="usage-num">{formatTokens(g.totals.thinkingTokens)}</td>
                <td className="usage-num usage-num--strong">
                  {formatTokens(g.totals.totalTokens)}
                </td>
                <td className="usage-num">
                  <Cost totals={g.totals} ratesConfigured={ratesConfigured} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** One call, expandable to the reasoning that produced it. */
function CallRow({ row }: { row: UsageRow }) {
  const [open, setOpen] = useState(false);
  const hasReasoning = row.reasoning !== null && row.reasoning.trim().length > 0;

  return (
    <>
      <tr className={row.failed ? "usage-row--failed" : undefined}>
        <td className="usage-label">{formatWhen(row.createdAt)}</td>
        <td className="usage-label">{opLabel(row.operation)}</td>
        <td className="usage-label usage-model">{row.model}</td>
        <td className="usage-num">{formatTokens(row.inputTokens)}</td>
        <td className="usage-num">{formatTokens(row.outputTokens)}</td>
        <td className="usage-num">{formatTokens(row.thinkingTokens)}</td>
        <td className="usage-num">
          {row.usd === null ? (
            <span className="usage-cost usage-cost--none">—</span>
          ) : (
            formatUsd(row.usd)
          )}
        </td>
        <td>
          {hasReasoning && (
            <button className="usage-why" onClick={() => setOpen((v) => !v)}>
              {open ? "hide" : "why?"}
            </button>
          )}
        </td>
      </tr>
      {open && hasReasoning && (
        <tr>
          <td colSpan={8}>
            <pre className="usage-reasoning">{row.reasoning}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Spend, for a campaign and for everything.
 *
 * Token counts are recorded per call and priced at read time, so filling in a
 * rate in src/ai/pricing.ts reprices history rather than only new rows.
 */
export function UsageView({ campaignId }: { campaignId: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [scopeAll, setScopeAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const r = await api.usage.report(scopeAll ? undefined : { campaignId });
      setReport(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load usage");
    } finally {
      setIsLoading(false);
    }
  }, [campaignId, scopeAll]);

  useEffect(() => {
    void load();
  }, [load]);

  if (isLoading && report === null) {
    return (
      <div className="usage-view usage-view--empty">
        <LoadingSpinner />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="usage-view usage-view--empty">
        <p className="usage-error">{error}</p>
      </div>
    );
  }

  if (report === null) return null;

  const { overall, ratesConfigured } = report;

  return (
    <div className="usage-view">
      <header className="usage-header">
        <h2 className="usage-title">Spend</h2>
        <div className="usage-scope">
          <button
            className={`usage-scope-btn${!scopeAll ? " usage-scope-btn--active" : ""}`}
            onClick={() => setScopeAll(false)}
          >
            This campaign
          </button>
          <button
            className={`usage-scope-btn${scopeAll ? " usage-scope-btn--active" : ""}`}
            onClick={() => setScopeAll(true)}
          >
            Everything
          </button>
        </div>
      </header>

      {overall.unpricedCalls > 0 && (
        <p className="usage-notice">
          {overall.unpricedCalls} of {overall.calls} calls have no price on file, so they
          count tokens but not dollars. Fill in the per-million rates in{" "}
          <code>src/ai/pricing.ts</code> and every figure below, including past calls, will
          price itself.
        </p>
      )}

      {overall.calls === 0 ? (
        <p className="usage-notice">
          Nothing recorded yet. Generating a config or describing rooms will show up here.
        </p>
      ) : (
        <>
          <div className="usage-cards">
            <div className="usage-card">
              <span className="usage-card-value">{overall.calls}</span>
              <span className="usage-card-label">model calls</span>
            </div>
            <div className="usage-card">
              <span className="usage-card-value">{formatTokens(overall.totalTokens)}</span>
              <span className="usage-card-label">tokens total</span>
            </div>
            <div className="usage-card">
              <span className="usage-card-value">{formatTokens(overall.thinkingTokens)}</span>
              <span className="usage-card-label">thinking tokens</span>
            </div>
            <div className="usage-card usage-card--cost">
              <span className="usage-card-value">
                <Cost totals={overall} ratesConfigured={ratesConfigured} />
              </span>
              <span className="usage-card-label">estimated cost</span>
            </div>
          </div>

          <GroupTable
            title="By dungeon"
            labelHeading="Dungeon"
            groups={report.byDungeon}
            ratesConfigured={ratesConfigured}
          />
          <GroupTable
            title="By chat"
            labelHeading="Chat"
            groups={report.byChat}
            ratesConfigured={ratesConfigured}
          />
          <GroupTable
            title="By step"
            labelHeading="Step"
            groups={report.byOperation}
            ratesConfigured={ratesConfigured}
            transformLabel={opLabel}
          />
          <GroupTable
            title="By model"
            labelHeading="Model"
            groups={report.byModel}
            ratesConfigured={ratesConfigured}
          />

          <section className="usage-section">
            <h3 className="usage-section-heading">Recent calls</h3>
            <div className="usage-table-scroll">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Step</th>
                    <th>Model</th>
                    <th className="usage-num">In</th>
                    <th className="usage-num">Out</th>
                    <th className="usage-num">Thinking</th>
                    <th className="usage-num">Cost</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {report.recent.map((row) => (
                    <CallRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
