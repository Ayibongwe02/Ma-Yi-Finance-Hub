/**
 * Dedicated Live Monitor page — open trades with expanded monitor-layer
 * status (conviction, MTM, noise, prob sparkline) + backend ML health.
 * Fed by GET /api/monitor/open (logger-backed live_status snapshots).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronRight,
  Gauge,
  Loader2,
  Minus,
  RefreshCw,
  Target,
  Waves,
} from "lucide-react";
import type { LiveStatus, MlStatus, Signal } from "./types";
import {
  cn,
  confidenceLabel,
  directionLabel,
  displayPair,
  formatAge,
  formatPrice,
  formatTs,
  patternPretty,
  scoreColor,
} from "./utils";
import { fetchMonitorOpen, fetchMonitorIdeas, refreshOpenMonitors } from "./api";

interface Props {
  ml?: MlStatus;
  /** Fallback open signals from the desk store when API is offline. */
  fallbackSignals?: Signal[];
  onSelectTrade?: (s: Signal) => void;
}

export default function MonitorPage({ ml: mlProp, fallbackSignals = [], onSelectTrade }: Props) {
  const [trades, setTrades] = useState<Signal[]>([]);
  const [ml, setMl] = useState<MlStatus | undefined>(mlProp);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [lastTs, setLastTs] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "adverse" | "rising" | "falling">("all");
  const [ideas, setIdeas] = useState<
    Array<{
      kind: string;
      title: string;
      detail: string;
      priority?: number;
      pattern?: string;
      pair?: string;
      side?: string;
      win_rate?: number;
      n?: number;
      wins?: number;
      losses?: number;
    }>
  >([]);
  const [closedCount, setClosedCount] = useState(0);
  const [closedWins, setClosedWins] = useState(0);
  const [closedLosses, setClosedLosses] = useState(0);

  const load = useCallback(async (forceRefresh = false) => {
    try {
      setError(null);
      if (forceRefresh) setRefreshing(true);
      else if (trades.length === 0) setLoading(true);
      const [data, ideaData] = await Promise.all([
        fetchMonitorOpen({ refresh: forceRefresh, limit: 40 }),
        fetchMonitorIdeas({ hours: 4, limit: 40 }).catch(() => null),
      ]);
      setTrades(data.trades ?? []);
      if (data.ml) setMl(normalizeMl(data.ml));
      else if (ideaData?.ml) setMl(normalizeMl(ideaData.ml));
      setLastTs(data.ts ?? new Date().toISOString());
      if (ideaData) {
        setIdeas(ideaData.ideas ?? []);
        setClosedCount(ideaData.closed_count ?? 0);
        setClosedWins(ideaData.wins ?? 0);
        setClosedLosses(ideaData.losses ?? 0);
        if (ideaData.ml && !data.ml) setMl(normalizeMl(ideaData.ml));
      }
      // Auto-expand first few so the page feels alive on first visit
      if (expanded.size === 0 && (data.trades?.length ?? 0) > 0) {
        setExpanded(new Set((data.trades ?? []).slice(0, 3).map((t) => t.id)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load monitor feed");
      if (fallbackSignals.length) {
        const open = fallbackSignals.filter(
          (s) => !s.outcome || s.outcome === "pending"
        );
        setTrades(open);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fallbackSignals, trades.length, expanded.size]);

  useEffect(() => {
    void load(false);
    const id = window.setInterval(() => void load(false), 20_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mlProp) setMl(mlProp);
  }, [mlProp]);

  const filtered = useMemo(() => {
    return trades.filter((t) => {
      const ls = t.live_status;
      const conv = t.live_conviction ?? ls?.conviction;
      const noise = t.live_noise ?? ls?.noise?.state;
      if (filter === "adverse") return noise === "adverse";
      if (filter === "rising") return conv === "rising";
      if (filter === "falling") return conv === "falling";
      return true;
    });
  }, [trades, filter]);

  const summary = useMemo(() => {
    let rising = 0,
      falling = 0,
      adverse = 0,
      favorable = 0;
    for (const t of trades) {
      const c = t.live_conviction ?? t.live_status?.conviction;
      const n = t.live_noise ?? t.live_status?.noise?.state;
      if (c === "rising") rising++;
      if (c === "falling") falling++;
      if (n === "adverse") adverse++;
      if (n === "favorable") favorable++;
    }
    return { rising, falling, adverse, favorable, open: trades.length };
  }, [trades]);

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleForceRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshOpenMonitors(40);
    } catch {
      /* ignore — load() will still try */
    }
    await load(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-tv-bg">
      {/* Header strip */}
      <div className="shrink-0 border-b border-tv-border bg-tv-panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-[color-mix(in_oklab,var(--tv-blue)_25%,transparent)]">
              <Gauge className="h-4 w-4 text-tv-blue" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">Live Monitor</div>
              <div className="text-micro text-tv-muted">
                Open trades · monitor layer · ML-backed conviction
                {lastTs && <> · updated {formatAge(lastTs)}</>}
              </div>
            </div>
          </div>

          <div className="flex-1" />

          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ["all", "All"],
                ["rising", "Rising"],
                ["falling", "Falling"],
                ["adverse", "Adverse"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-caption font-medium transition-colors",
                  filter === id
                    ? "bg-tv-blue text-white"
                    : "bg-tv-panel-2 text-tv-muted hover:text-tv-text"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => void handleForceRefresh()}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-sm border border-tv-border bg-tv-panel-2 px-2.5 py-1.5 text-caption font-medium text-tv-text hover:bg-tv-hover disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Re-score
          </button>
        </div>

        {/* Summary chips */}
        <div className="mt-3 flex flex-wrap gap-2">
          <SummaryChip label="Open" value={summary.open} />
          <SummaryChip label="Rising" value={summary.rising} tone="green" />
          <SummaryChip label="Falling" value={summary.falling} tone="red" />
          <SummaryChip label="Favorable" value={summary.favorable} tone="green" />
          <SummaryChip label="Adverse" value={summary.adverse} tone="red" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl gap-4 p-4 lg:grid-cols-[1fr_280px]">
          {/* Trade list */}
          <div className="space-y-3">
            {loading && trades.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-16 text-tv-muted">
                <Loader2 className="h-5 w-5 animate-spin" />
                Loading open trades…
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-md border border-tv-border bg-tv-panel px-6 py-12 text-center">
                <Waves className="mx-auto mb-3 h-8 w-8 text-tv-dim" />
                <div className="text-sm font-medium text-tv-text">No open trades to monitor</div>
                <div className="mt-1 text-xs text-tv-muted">
                  {error
                    ? error
                    : filter !== "all"
                      ? "Nothing matches this filter — try All."
                      : "Fired + pending signals will appear here after a scan."}
                </div>
              </div>
            ) : (
              filtered.map((t) => (
                <TradeCard
                  key={t.id}
                  signal={t}
                  expanded={expanded.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onSelect={() => onSelectTrade?.(t)}
                />
              ))
            )}
          </div>

          {/* Sidebar: ideas from closed + ML */}
          <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
            <IdeasFromClosed
              ideas={ideas}
              closedCount={closedCount}
              wins={closedWins}
              losses={closedLosses}
              hours={4}
            />
            <MlHealthCard ml={ml} />
            <div className="rounded-md border border-tv-border bg-tv-panel p-4 text-xs leading-relaxed text-tv-muted">
              <div className="mb-2 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wider text-tv-text">
                <Activity className="h-3.5 w-3.5" />
                How this works
              </div>
              <p>
                This is the dedicated Live Monitor page (not Deep Dive). Open trades
                are re-scored against the latest bar. Direction stays fixed — only{" "}
                <span className="text-tv-text">conviction</span>,{" "}
                <span className="text-tv-text">MTM</span>, and{" "}
                <span className="text-tv-text">noise</span> update. Ideas refresh from
                closed trades in the last 4 hours on every poll.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}


function IdeasFromClosed({
  ideas,
  closedCount,
  wins,
  losses,
  hours,
}: {
  ideas: Array<{
    kind: string;
    title: string;
    detail: string;
    priority?: number;
    pattern?: string;
    pair?: string;
    side?: string;
    win_rate?: number;
    n?: number;
  }>;
  closedCount: number;
  wins: number;
  losses: number;
  hours: number;
}) {
  const toneFor = (kind: string) => {
    if (kind === "pattern_hot" || kind === "pair_bias" || kind === "summary") return "text-tv-green";
    if (kind === "pattern_cold" || kind === "pair_avoid") return "text-tv-red";
    return "text-tv-muted";
  };

  return (
    <div className="rounded-md border border-tv-border bg-tv-panel p-4">
      <div className="mb-3 flex items-center gap-2 text-caption font-semibold uppercase tracking-wider text-tv-muted">
        <Target className="h-3.5 w-3.5" />
        Ideas · last {hours}h closed
      </div>
      <div className="mb-3 flex flex-wrap gap-2 text-micro">
        <span className="rounded-sm bg-tv-panel-2 px-2 py-0.5 tv-mono">
          {closedCount} closed
        </span>
        <span className="rounded-sm bg-tv-panel-2 px-2 py-0.5 tv-mono text-tv-green">
          {wins}W
        </span>
        <span className="rounded-sm bg-tv-panel-2 px-2 py-0.5 tv-mono text-tv-red">
          {losses}L
        </span>
      </div>
      {ideas.length === 0 ? (
        <p className="text-xs text-tv-muted">
          No closed trades in the last {hours}h yet. Ideas appear as outcomes are logged.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {ideas.slice(0, 8).map((idea, i) => (
            <li key={`${idea.kind}-${idea.title}-${i}`} className="border-t border-tv-border pt-2 first:border-0 first:pt-0">
              <div className={cn("text-xs font-semibold", toneFor(idea.kind))}>
                {idea.title}
              </div>
              <p className="mt-0.5 text-micro leading-relaxed text-tv-muted">{idea.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SummaryChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "green" | "red";
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-sm border border-tv-border bg-tv-panel-2 px-2.5 py-1">
      <span className="text-micro uppercase tracking-wider text-tv-muted">{label}</span>
      <span
        className={cn(
          "tv-mono text-sm font-bold",
          tone === "green" && "text-tv-green",
          tone === "red" && "text-tv-red",
          !tone && "text-tv-text"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function normalizeMl(raw: Record<string, unknown>): MlStatus {
  const health =
    typeof raw.health === "object" && raw.health
      ? String((raw.health as any).state ?? "unknown")
      : String(raw.health ?? raw.state ?? "unknown");
  return {
    health,
    health_detail: (raw.health as any) ?? null,
    n_samples: (raw.n_samples as number) ?? (raw.labeled as number) ?? undefined,
    train_acc: (raw.train_accuracy as number) ?? (raw.train_acc as number),
    walk_forward:
      typeof raw.walk_forward === "object"
        ? (raw.walk_forward as any)?.accuracy
        : (raw.walk_forward as number),
    walk_forward_detail:
      typeof raw.walk_forward === "object" ? (raw.walk_forward as any) : null,
    last_train: (raw.last_train as string) ?? (raw.trained_at as string),
    paused: Boolean(raw.learning_paused ?? raw.paused),
    explore: Boolean(raw.explore_mode ?? raw.explore),
    message: (raw.message as string) ?? (raw.recommendation as string),
  };
}

function TradeCard({
  signal,
  expanded,
  onToggle,
  onSelect,
}: {
  signal: Signal;
  expanded: boolean;
  onToggle: () => void;
  onSelect?: () => void;
}) {
  const [live, setLive] = useState<LiveStatus | null>(signal.live_status ?? null);
  const [busy, setBusy] = useState(false);
  const isBuy = signal.direction > 0;
  const ls = live ?? signal.live_status;
  const conv = signal.live_conviction ?? ls?.conviction ?? "unknown";
  const noise = signal.live_noise ?? ls?.noise?.state ?? "unknown";
  const prob = signal.live_prob_win ?? ls?.prob_win;
  const rMult = signal.live_r_multiple ?? ls?.mtm?.r_multiple;
  const hours = signal.live_time_in_trade_hours ?? ls?.time_in_trade_hours;

  useEffect(() => {
    setLive(signal.live_status ?? null);
  }, [signal.live_status, signal.id]);

  const refreshOne = async () => {
    setBusy(true);
    try {
      const st = await fetchLiveStatus(signal.id, true);
      setLive(st);
    } catch {
      /* keep cached */
    } finally {
      setBusy(false);
    }
  };

  const ConvIcon =
    conv === "rising" ? ArrowUp : conv === "falling" ? ArrowDown : Minus;
  const convColor =
    conv === "rising" ? "var(--tv-green)" : conv === "falling" ? "var(--tv-red)" : "var(--tv-muted)";
  const noiseColor =
    noise === "favorable"
      ? "var(--tv-green)"
      : noise === "adverse"
        ? "var(--tv-red)"
        : noise === "noise"
          ? "var(--tv-amber)"
          : "var(--tv-muted)";

  // Progress bar: SL ← entry → TP mapped from progress_sl / progress_tp
  const progTp = Math.min(1, Math.max(0, ls?.mtm?.progress_tp ?? 0));
  const progSl = Math.min(1, Math.max(0, ls?.mtm?.progress_sl ?? 0));
  // Position of current mark on a 0..100 scale where 50 is entry
  const markPct = 50 + (rMult != null ? Math.max(-45, Math.min(45, rMult * 30)) : 0);

  return (
    <article
      className={cn(
        "overflow-hidden rounded-md border border-tv-border bg-tv-panel transition-shadow",
        expanded && "shadow-[0_0_0_1px_color-mix(in_oklab,var(--tv-blue)_35%,transparent)]"
      )}
    >
      {/* Collapsed header — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-tv-hover"
      >
        <div className="mt-0.5 text-tv-muted">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{displayPair(signal.pair)}</span>
            <span
              className={cn(
                "tv-mono rounded-sm px-1.5 py-0.5 text-micro font-bold",
                isBuy
                  ? "bg-[color-mix(in_oklab,var(--tv-green)_20%,transparent)] text-tv-green"
                  : "bg-[color-mix(in_oklab,var(--tv-red)_20%,transparent)] text-tv-red"
              )}
            >
              {directionLabel(signal.direction)}
            </span>
            <span className="text-caption text-tv-muted">{signal.timeframe}</span>
            <span className="text-caption text-tv-dim">· {patternPretty(signal.pattern)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-micro text-tv-dim">
            <span>Entry {formatPrice(signal.entry, signal.pair)}</span>
            <span>SL {formatPrice(signal.sl, signal.pair)}</span>
            <span>TP {formatPrice(signal.tp, signal.pair)}</span>
            <span className="ml-auto">{formatAge(signal.bar_time)}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <div
            className="tv-mono text-lg font-bold leading-none"
            style={{ color: scoreColor(signal.final_score) }}
          >
            {signal.final_score > 0 ? "+" : ""}
            {Number(signal.final_score).toFixed(0)}
          </div>
          <div className="text-micro text-tv-muted">{confidenceLabel(signal.final_score)}</div>
        </div>
      </button>

      {/* Live status strip (visible even when collapsed) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-tv-border bg-tv-panel-2 px-4 py-2 text-caption">
        <span className="tv-mono font-semibold">
          {prob != null ? `${(prob * 100).toFixed(0)}%` : "—"}{" "}
          <span className="font-normal text-tv-muted">win</span>
        </span>
        <span className="inline-flex items-center gap-1 capitalize" style={{ color: convColor }}>
          <ConvIcon className="h-3.5 w-3.5" />
          {conv}
        </span>
        <span className="capitalize" style={{ color: noiseColor }}>
          {noise}
        </span>
        <span className="tv-mono text-tv-text">
          {rMult != null ? `${rMult >= 0 ? "+" : ""}${rMult.toFixed(2)}R` : "—"}
        </span>
        {hours != null && <span className="text-tv-dim">{hours.toFixed(1)}h in trade</span>}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="space-y-4 border-t border-tv-border px-4 py-4">
          {/* MTM track */}
          <div>
            <div className="mb-1.5 flex justify-between text-micro uppercase tracking-wider text-tv-muted">
              <span>SL</span>
              <span>Entry</span>
              <span>TP</span>
            </div>
            <div className="relative h-2 overflow-hidden rounded-full bg-tv-panel-2">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-[color-mix(in_oklab,var(--tv-red)_35%,transparent)]"
                style={{ width: `${50 * progSl}%` }}
              />
              <div
                className="absolute inset-y-0 right-0 rounded-full bg-[color-mix(in_oklab,var(--tv-green)_35%,transparent)]"
                style={{ width: `${50 * progTp}%` }}
              />
              <div
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-tv-bg bg-tv-blue shadow"
                style={{ left: `${markPct}%` }}
                title={ls?.current_price != null ? formatPrice(ls.current_price, signal.pair) : "mark"}
              />
            </div>
            <div className="mt-1.5 flex justify-between tv-mono text-micro text-tv-dim">
              <span>{formatPrice(signal.sl, signal.pair)}</span>
              <span>
                {ls?.current_price != null
                  ? `Mark ${formatPrice(ls.current_price, signal.pair)}`
                  : formatPrice(signal.entry, signal.pair)}
              </span>
              <span>{formatPrice(signal.tp, signal.pair)}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              label="Prob win"
              value={prob != null ? `${(prob * 100).toFixed(1)}%` : "—"}
            />
            <Metric
              label="Adj. score"
              value={
                ls?.adjusted_score != null
                  ? `${ls.adjusted_score > 0 ? "+" : ""}${Number(ls.adjusted_score).toFixed(0)}`
                  : "—"
              }
            />
            <Metric
              label="Noise (ATR)"
              value={
                ls?.noise?.adverse_atr != null
                  ? `${ls.noise.adverse_atr.toFixed(2)}× / ${ls.noise.band_atr ?? 0.75}×`
                  : noise
              }
            />
            <Metric
              label="Trend / S/R"
              value={`${ls?.trend != null ? (ls.trend > 0 ? "↑" : ls.trend < 0 ? "↓" : "·") : "—"} · ${
                ls?.sr_score != null ? `${(ls.sr_score * 100).toFixed(0)}%` : "—"
              }`}
            />
          </div>

          {(ls?.prob_history?.length ?? 0) >= 2 && (
            <div>
              <div className="mb-1 text-micro uppercase tracking-wider text-tv-muted">
                Conviction trend (prob win)
              </div>
              <ProbSparkline history={ls!.prob_history!} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-caption text-tv-dim">
            {ls?.ml_note && <span className="text-tv-muted">{ls.ml_note}</span>}
            {ls?.ts && <span>Snapshot {formatTs(ls.ts, "HH:mm:ss")}</span>}
            {ls?.anomaly && (
              <span className="rounded-sm bg-[color-mix(in_oklab,var(--tv-amber)_20%,transparent)] px-1.5 py-0.5 text-tv-amber">
                anomaly
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void refreshOne();
                }}
                disabled={busy}
                className="flex items-center gap-1 rounded-sm border border-tv-border px-2 py-1 text-micro hover:bg-tv-hover disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </button>
              {onSelect && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect();
                  }}
                  className="flex items-center gap-1 rounded-sm border border-tv-border px-2 py-1 text-micro hover:bg-tv-hover"
                >
                  <Target className="h-3 w-3" />
                  Deep dive
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm bg-tv-panel-2 px-3 py-2">
      <div className="text-micro uppercase tracking-wider text-tv-muted">{label}</div>
      <div className="tv-mono mt-0.5 text-sm font-semibold text-tv-text">{value}</div>
    </div>
  );
}

function ProbSparkline({ history }: { history: Array<{ ts: string; prob_win: number }> }) {
  const w = 320;
  const h = 48;
  const vals = history.map((p) => p.prob_win);
  const min = Math.min(...vals, 0.25);
  const max = Math.max(...vals, 0.75);
  const span = max - min || 0.1;
  const pts = vals
    .map((v, i) => {
      const x = (i / Math.max(1, vals.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = vals[vals.length - 1] >= vals[0];
  return (
    <div className="rounded-sm bg-tv-panel-2 p-2">
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block">
        <polyline
          fill="none"
          stroke={rising ? "var(--tv-green)" : "var(--tv-red)"}
          strokeWidth="2"
          strokeLinejoin="round"
          points={pts}
        />
      </svg>
      <div className="mt-1 flex justify-between tv-mono text-micro text-tv-dim">
        <span>{(vals[0] * 100).toFixed(0)}%</span>
        <span>{history.length} samples</span>
        <span>{(vals[vals.length - 1] * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

function MlHealthCard({ ml }: { ml?: MlStatus }) {
  const health = String((ml?.health_detail as any)?.state ?? ml?.health ?? "unknown").toLowerCase();
  const healthColor =
    health === "healthy"
      ? "text-tv-green"
      : health.includes("overfit") || health === "stale"
        ? "text-tv-amber"
        : health.includes("under") || health.includes("insufficient")
          ? "text-tv-red"
          : "text-tv-muted";

  return (
    <div className="rounded-md border border-tv-border bg-tv-panel p-4">
      <div className="mb-3 flex items-center gap-2 text-caption font-semibold uppercase tracking-wider text-tv-muted">
        <Brain className="h-3.5 w-3.5" />
        ML status
      </div>
      {!ml || (ml.health === "unknown" && ml.n_samples == null) ? (
        <div className="space-y-2 text-xs text-tv-muted">
          <p>Waiting for backend ML status…</p>
          <p className="text-micro text-tv-dim">
            Endpoint: <span className="tv-mono">/api/ml/status</span> and the monitor
            feed. If this persists in Docker, check that the model files loaded and
            the learner started without errors in the engine log.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-tv-muted">Health</span>
            <span className={cn("text-sm font-semibold capitalize", healthColor)}>{health}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Samples" value={ml.n_samples != null ? String(ml.n_samples) : "—"} />
            <Metric
              label="Train acc"
              value={ml.train_acc != null ? `${(ml.train_acc * 100).toFixed(0)}%` : "—"}
            />
            <Metric
              label="Walk-fwd"
              value={
                ml.walk_forward != null
                  ? `${(Number(ml.walk_forward) <= 1 ? Number(ml.walk_forward) * 100 : Number(ml.walk_forward)).toFixed(0)}%`
                  : "—"
              }
            />
            <Metric
              label="Mode"
              value={ml.paused ? "paused" : ml.explore ? "explore" : "active"}
            />
          </div>
          {ml.message && (
            <p className="text-xs leading-relaxed text-tv-muted">{ml.message}</p>
          )}
          {ml.last_train && (
            <div className="text-micro text-tv-dim">Last train {formatAge(ml.last_train)}</div>
          )}
        </div>
      )}
    </div>
  );
}
