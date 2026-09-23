import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Minus,
  Target,
  Shield,
  TrendingUp,
  Activity,
  Layers,
  Brain,
  Gauge,
} from "lucide-react";
import type { LiveStatus, MlStatus, PairBias, Signal } from "./types";
import {
  biasColor,
  cn,
  confidenceLabel,
  directionLabel,
  displayPair,
  formatAge,
  formatPips,
  formatPrice,
  formatTs,
  patternPretty,
  scoreColor,
} from "./utils";
import { PATTERN_HIT_RATES } from "./ml";
import { fetchLiveStatus } from "./api";

interface Props {
  signal: Signal | null;
  onBack: () => void;
  pairBias: PairBias[];
  ml?: MlStatus;
}

export default function SignalDeepDive({ signal, onBack, pairBias, ml }: Props) {
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);

  useEffect(() => {
    if (!signal?.id) {
      setLive(null);
      return;
    }

    // Seed from snapshot on the signal so the strip never blanks on open.
    const seed = signal.live_status;
    if (seed && (seed.ok || seed.prob_win != null || seed.conviction)) {
      setLive(seed);
    }

    let cancelled = false;
    const isOpen = !signal.outcome || signal.outcome === "pending";

    const pull = (force: boolean, showSpinner: boolean) => {
      if (showSpinner) setLiveLoading(true);
      fetchLiveStatus(signal.id, force)
        .then((st) => {
          if (cancelled) return;
          // Never replace a good snapshot with a failed/empty one.
          setLive((prev) => {
            if (st && (st.ok || st.prob_win != null || st.conviction)) return st;
            if (st?.error && !prev) return st;
            return prev; // keep last good
          });
        })
        .catch(() => {
          // Keep whatever we already have; do not clear.
        })
        .finally(() => {
          if (!cancelled) setLiveLoading(false);
        });
    };

    pull(true, true);

    // Continuous refresh while the trade is still open.
    // Primary continuous monitor lives on the dedicated Monitor page.
    let intervalId: number | undefined;
    if (isOpen) {
      intervalId = window.setInterval(() => pull(true, false), 25_000);
    }

    return () => {
      cancelled = true;
      if (intervalId != null) window.clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal?.id, signal?.outcome]);

  if (!signal) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-tv-bg text-tv-muted">
        <Target className="h-10 w-10 opacity-40" />
        <p className="text-sm">Select a signal from the triage panel to deep-dive</p>
        <button onClick={onBack} className="text-xs text-tv-blue hover:underline">
          Back to desk
        </button>
      </div>
    );
  }

  const bias = pairBias.find((b) => b.pair === signal.pair);
  const isBuy = signal.direction > 0;
  const meta = signal.meta || {};
  const conf = confidenceLabel(signal.final_score);
  const hit = PATTERN_HIT_RATES[signal.pattern];
  const isOpen = !signal.outcome || signal.outcome === "pending";

  return (
    <div className="h-full overflow-y-auto bg-tv-bg">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-tv-border bg-tv-panel px-4 py-3">
        <button onClick={onBack} className="rounded-sm p-1.5 text-tv-muted hover:bg-tv-hover" aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">{displayPair(signal.pair)}</span>
            <span
              className={cn(
                "tv-mono rounded-sm px-2 py-0.5 text-caption font-bold",
                isBuy
                  ? "bg-tv-green text-white"
                  : "bg-tv-red text-white"
              )}
            >
              {directionLabel(signal.direction)}
            </span>
            <span className="text-caption text-tv-muted">{signal.timeframe}</span>
          </div>
          <div className="text-xs text-tv-muted">
            {patternPretty(signal.pattern)} · {formatAge(signal.bar_time)}
          </div>
        </div>
        <div className="text-right">
          <div className="tv-mono text-[22px] font-bold leading-none" style={{ color: scoreColor(signal.final_score) }}>
            {signal.final_score > 0 ? "+" : ""}
            {Number(signal.final_score).toFixed(0)}
          </div>
          <div className="text-caption text-tv-muted">{conf}</div>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <section className="tv-panel overflow-hidden rounded-md">
          <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2 text-caption font-semibold uppercase tracking-wider text-tv-muted">
            <Target className="h-3.5 w-3.5" />
            Trade levels
          </div>
          <div className="grid grid-cols-3 divide-x divide-tv-border">
            <LevelBlock label="Entry" value={formatPrice(signal.entry, signal.pair)} color="var(--tv-blue)" />
            <LevelBlock
              label="Stop Loss"
              value={formatPrice(signal.sl, signal.pair)}
              color="var(--tv-red)"
              sub={formatPips(signal.risk, signal.pair)}
            />
            <LevelBlock
              label="Take Profit"
              value={formatPrice(signal.tp, signal.pair)}
              color="var(--tv-green)"
              sub={`R:R ${signal.rr?.toFixed(2) ?? "—"}`}
            />
          </div>
        </section>

        {isOpen && (
          <LiveConvictionStrip live={live} loading={liveLoading} pair={signal.pair} />
        )}

        <section className="tv-panel overflow-hidden rounded-md">
          <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2 text-caption font-semibold uppercase tracking-wider text-tv-muted">
            <Activity className="h-3.5 w-3.5" />
            Score breakdown
          </div>
          <div className="space-y-3 p-4">
            <ScoreRow label="Raw pattern" value={signal.raw_score} max={100} />
            <ScoreRow label="Final (context)" value={signal.final_score} max={100} signed />
            <div className="grid grid-cols-2 gap-3 pt-2">
              <MetaPill label="Trend" value={trendLabel(signal.trend)} />
              <MetaPill label="S/R score" value={`${(signal.sr_score * 100).toFixed(0)}%`} />
              <MetaPill label="Volatility" value={signal.volatility || "—"} />
              <MetaPill label="Outcome" value={signal.outcome || "pending"} />
            </div>
          </div>
        </section>

        <section className="tv-panel overflow-hidden rounded-md">
          <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2 text-caption font-semibold uppercase tracking-wider text-tv-muted">
            <Layers className="h-3.5 w-3.5" />
            Context filters
          </div>
          <div className="grid grid-cols-2 gap-2 p-4">
            {Object.entries(meta).length === 0 && (
              <div className="col-span-2 py-2 text-center text-xs text-tv-dim">No extended meta on this signal</div>
            )}
            {Object.entries(meta)
              .slice(0, 8)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between rounded-sm bg-tv-panel-2 px-3 py-2 text-xs">
                  <span className="text-tv-muted">{k.replace(/^_/, "")}</span>
                  <span className="tv-mono font-medium">{String(v)}</span>
                </div>
              ))}
          </div>
        </section>

        <section className="tv-panel overflow-hidden rounded-md">
          <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2 text-caption font-semibold uppercase tracking-wider text-tv-muted">
            <TrendingUp className="h-3.5 w-3.5" />
            Multi-TF / Structure bias
          </div>
          {bias ? (
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="text-lg font-bold capitalize" style={{ color: biasColor(bias.bias) }}>
                  {bias.bias || "neutral"}
                </div>
                <div className="tv-mono text-sm" style={{ color: biasColor(bias.bias) }}>
                  {bias.score != null && bias.score !== 0
                    ? `${bias.score > 0 ? "+" : ""}${Number(bias.score).toFixed(0)}`
                    : "—"}
                </div>
                {bias.aligned != null && (
                  <span
                    className={cn(
                      "rounded-sm px-2 py-0.5 text-micro font-semibold uppercase",
                      bias.aligned
                        ? "bg-[color-mix(in_oklab,var(--tv-green)_20%,transparent)] text-tv-green"
                        : "bg-tv-panel-2 text-tv-muted"
                    )}
                  >
                    {bias.aligned ? "HTF aligned" : "HTF not aligned"}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MetaPill label="HTF bias" value={bias.htf_bias || "—"} />
                <MetaPill label="STF bias" value={bias.stf_bias || "—"} />
                <MetaPill label="Structure" value={bias.structure || "—"} />
                <MetaPill label="Zone" value={bias.zone || "—"} />
              </div>
              {bias.divergence_label && (
                <div className="text-xs text-tv-amber">{bias.divergence_label}</div>
              )}
              {!bias.htf_bias && !bias.stf_bias && !bias.structure && (
                <p className="text-xs text-tv-muted">
                  Multi-TF fields empty. Backend pair-bias refresh may have failed
                  (candles / context modules). Trigger a scan or{" "}
                  <span className="tv-mono">POST /api/pair-bias/refresh</span> and
                  check engine logs.
                </p>
              )}
            </div>
          ) : (
            <div className="px-4 py-3 text-xs text-tv-muted">
              No pair-bias row for {displayPair(signal.pair)}. The live-command feed
              did not include multi-TF data for this pair. Run a scan or pair-bias
              refresh on the backend.
            </div>
          )}
        </section>

        {signal.second_opinion && (
          <section className="tv-panel overflow-hidden rounded-md">
            <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2 text-caption font-semibold uppercase tracking-wider text-tv-muted">
              <Shield className="h-3.5 w-3.5" />
              Sister system (Sentinel)
            </div>
            <div className="space-y-2 p-4">
              <div className="flex items-center gap-2">
                <VerdictBadge v={signal.second_opinion.final_verdict} />
                <span className="tv-mono text-desk">{signal.second_opinion.combined_score != null ? Number(signal.second_opinion.combined_score).toFixed(1) : "—"}</span>
              </div>
              {signal.second_opinion.rationale && (
                <p className="text-xs leading-relaxed text-tv-muted">{signal.second_opinion.rationale}</p>
              )}
            </div>
          </section>
        )}

        <section className="tv-panel overflow-hidden rounded-md">
          <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2 text-caption font-semibold uppercase tracking-wider text-tv-muted">
            <Brain className="h-3.5 w-3.5" />
            Stage 4 ML health
          </div>
          <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
            <MetaPill label="Health" value={ml?.health ?? "—"} />
            <MetaPill label="Samples" value={ml?.n_samples != null ? String(ml.n_samples) : "—"} />
            <MetaPill label="Train acc" value={ml?.train_acc != null ? `${(ml.train_acc * 100).toFixed(0)}%` : "—"} />
            <MetaPill
              label="Walk-forward"
              value={ml?.walk_forward != null ? `${(ml.walk_forward * 100).toFixed(0)}%` : "—"}
            />
          </div>
          {hit && (
            <div className="border-t border-tv-border px-4 py-3 text-xs text-tv-muted">
              {patternPretty(signal.pattern)} historical hit-rate{" "}
              <span className="tv-mono text-tv-text">
                {hit.win_rate.toFixed(0)}% ({hit.wins}/{hit.n})
              </span>
              . Auto-retrain {ml?.paused ? "paused" : "active"}
              {ml?.explore ? " · explore mode" : ""}.
            </div>
          )}
          {ml?.message && <p className="border-t border-tv-border px-4 py-3 text-xs leading-relaxed text-tv-muted">{ml.message}</p>}
        </section>

        <div className="tv-mono flex flex-wrap gap-x-4 gap-y-1 px-1 text-caption text-tv-dim">
          <span>Bar {formatTs(signal.bar_time, "yyyy-MM-dd HH:mm")}</span>
          <span>Logged {formatTs(signal.ts || signal.created_at, "yyyy-MM-dd HH:mm:ss")}</span>
          <span>ID #{signal.id}</span>
        </div>
      </div>
    </div>
  );
}

function LiveConvictionStrip({
  live,
  loading,
  pair,
}: {
  live: LiveStatus | null;
  loading: boolean;
  pair: string;
}) {
  const conviction = live?.conviction ?? "unknown";
  const noise = live?.noise?.state ?? "unknown";
  const prob = live?.prob_win;
  const rMult = live?.mtm?.r_multiple;
  const hours = live?.time_in_trade_hours;
  const history = live?.prob_history ?? [];

  const ConvIcon =
    conviction === "rising" ? ArrowUp : conviction === "falling" ? ArrowDown : Minus;

  const noiseColor =
    noise === "favorable"
      ? "var(--tv-green)"
      : noise === "adverse"
        ? "var(--tv-red)"
        : noise === "noise"
          ? "var(--tv-amber)"
          : "var(--tv-muted)";

  const convColor =
    conviction === "rising"
      ? "var(--tv-green)"
      : conviction === "falling"
        ? "var(--tv-red)"
        : "var(--tv-muted)";

  return (
    <section className="tv-panel overflow-hidden rounded-md">
      <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2 text-caption font-semibold uppercase tracking-wider text-tv-muted">
        <Gauge className="h-3.5 w-3.5" />
        Live conviction
        {loading && <span className="ml-auto text-micro font-normal normal-case text-tv-dim">updating…</span>}
        {!loading && live?.ts && (
          <span className="ml-auto text-micro font-normal normal-case text-tv-dim">
            {formatAge(live.ts)}
          </span>
        )}
      </div>
      {!live?.ok && !loading ? (
        <div className="px-4 py-3 text-xs text-tv-muted">
          {live?.error ? `Monitor: ${live.error}` : "No live status yet — waiting for next bar refresh."}
        </div>
      ) : (
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-sm bg-tv-panel-2 px-3 py-2">
              <div className="text-micro uppercase tracking-wider text-tv-muted">Prob win</div>
              <div className="tv-mono mt-0.5 text-base font-bold">
                {prob != null ? `${(prob * 100).toFixed(0)}%` : "—"}
              </div>
            </div>
            <div className="rounded-sm bg-tv-panel-2 px-3 py-2">
              <div className="text-micro uppercase tracking-wider text-tv-muted">Conviction</div>
              <div className="mt-0.5 flex items-center gap-1 text-base font-semibold capitalize" style={{ color: convColor }}>
                <ConvIcon className="h-4 w-4" />
                {conviction}
              </div>
            </div>
            <div className="rounded-sm bg-tv-panel-2 px-3 py-2">
              <div className="text-micro uppercase tracking-wider text-tv-muted">Noise band</div>
              <div className="mt-0.5 text-base font-semibold capitalize" style={{ color: noiseColor }}>
                {noise}
                {live?.noise?.adverse_atr != null && (
                  <span className="tv-mono ml-1 text-caption font-normal text-tv-dim">
                    ({live.noise.adverse_atr.toFixed(2)}×ATR)
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-sm bg-tv-panel-2 px-3 py-2">
              <div className="text-micro uppercase tracking-wider text-tv-muted">MTM / time</div>
              <div className="tv-mono mt-0.5 text-base font-bold">
                {rMult != null ? `${rMult >= 0 ? "+" : ""}${rMult.toFixed(2)}R` : "—"}
                {hours != null && (
                  <span className="ml-1 text-caption font-normal text-tv-dim">{hours.toFixed(1)}h</span>
                )}
              </div>
            </div>
          </div>

          {history.length >= 2 && (
            <div>
              <div className="mb-1 text-micro uppercase tracking-wider text-tv-muted">Prob win sparkline</div>
              <ProbSparkline history={history} />
            </div>
          )}

          {live?.current_price != null && (
            <div className="text-caption text-tv-dim">
              Mark {formatPrice(live.current_price, pair)}
              {live.atr != null && <> · ATR {live.atr.toFixed(5)}</>}
              {live.ml_note && <> · {live.ml_note}</>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ProbSparkline({ history }: { history: Array<{ ts: string; prob_win: number }> }) {
  const w = 240;
  const h = 36;
  const vals = history.map((p) => p.prob_win);
  const min = Math.min(...vals, 0.3);
  const max = Math.max(...vals, 0.7);
  const span = max - min || 0.1;
  const pts = vals
    .map((v, i) => {
      const x = (i / Math.max(1, vals.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = vals[vals.length - 1];
  const rising = last >= vals[0];
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block">
      <polyline
        fill="none"
        stroke={rising ? "var(--tv-green)" : "var(--tv-red)"}
        strokeWidth="1.5"
        points={pts}
      />
    </svg>
  );
}

function LevelBlock({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="px-4 py-4 text-center">
      <div className="text-micro uppercase tracking-wider text-tv-muted">{label}</div>
      <div className="tv-mono mt-1 text-lg font-bold" style={{ color }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-caption text-tv-dim">{sub}</div>}
    </div>
  );
}

function ScoreRow({ label, value, max, signed }: { label: string; value: number; max: number; signed?: boolean }) {
  const pct = Math.min(100, (Math.abs(value) / max) * 100);
  const color = value >= 0 ? "var(--tv-green)" : "var(--tv-red)";
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-tv-muted">{label}</span>
        <span className="tv-mono font-medium" style={{ color }}>
          {signed && value > 0 ? "+" : ""}
          {Number(value).toFixed(1)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-tv-panel-2">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between rounded-sm bg-tv-panel-2 px-3 py-2 text-xs">
      <span className="text-tv-muted">{label}</span>
      <span className="tv-mono font-medium capitalize">{value}</span>
    </div>
  );
}

function VerdictBadge({ v }: { v: string }) {
  const map: Record<string, string> = {
    CONFIRM: "bg-[color-mix(in_oklab,var(--tv-green)_20%,transparent)] text-tv-green",
    CAUTION: "bg-[color-mix(in_oklab,var(--tv-amber)_20%,transparent)] text-tv-amber",
    VETO: "bg-[color-mix(in_oklab,var(--tv-red)_20%,transparent)] text-tv-red",
  };
  return <span className={cn("rounded-sm px-2 py-0.5 text-caption font-bold", map[v] || "")}>{v}</span>;
}

function trendLabel(t: number): string {
  if (t > 0) return "Bullish";
  if (t < 0) return "Bearish";
  return "Neutral";
}
