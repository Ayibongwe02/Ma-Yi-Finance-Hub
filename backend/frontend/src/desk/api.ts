/**
 * Client for the Ma-yi Python FastAPI backend.
 * Falls back to demo-data when the backend is unreachable.
 */
import type { Candle, LiveCommand, LiveStatus, MlStatus, Order, PairBias, Signal, Stats } from "./types";

const API_BASE = (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_API_BASE) || "";

async function getJSON<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const url = new URL(path, API_BASE || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8000"));
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json() as Promise<T>;
}

async function postJSON<T>(path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const url = new URL(path, API_BASE || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8000"));
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json() as Promise<T>;
}

export async function fetchHealth(): Promise<{ status: string; [k: string]: unknown }> {
  return getJSON("/api/health");
}

export async function fetchLiveCommand(): Promise<LiveCommand> {
  return getJSON("/api/live-command");
}

export async function fetchSignals(params?: {
  limit?: number;
  pair?: string;
  min_score?: number;
}): Promise<Signal[]> {
  const data = await getJSON<Signal[] | { signals: Signal[] }>("/api/signals", params as any);
  return Array.isArray(data) ? data : data.signals ?? [];
}

export async function fetchStats(): Promise<Stats> {
  return getJSON("/api/stats");
}

export async function fetchPairBias(): Promise<PairBias[]> {
  const data = await getJSON<PairBias[] | { pairs: PairBias[] }>("/api/pair-bias");
  return Array.isArray(data) ? data : (data as any).pairs ?? [];
}

export async function fetchMlStatus(): Promise<MlStatus> {
  return getJSON("/api/ml/status");
}

export async function fetchOrders(limit = 50): Promise<Order[]> {
  const data = await getJSON<Order[] | { orders: Order[] }>("/api/orders", { limit });
  return Array.isArray(data) ? data : (data as any).orders ?? [];
}

export async function fetchEngineLog(lines = 100): Promise<string[]> {
  const data = await getJSON<string[] | { lines: string[] }>("/api/engine-log", { lines });
  return Array.isArray(data) ? data : (data as any).lines ?? [];
}

export async function triggerScan(body?: {
  pair?: string;
  timeframe?: string;
  mode?: string;
  refresh_bias?: boolean;
}) {
  // The backend's own subprocess budget for a scan is 600s (see
  // api/main.py _run_scan: yfinance rate-limit retries + backoff across
  // every configured pair can legitimately take minutes). The old 60s
  // default here meant the UI gave up and silently swapped in the
  // synthetic demo feed *while the real scan was still running* — a scan
  // that was actually succeeding just looked like a dead backend. Give
  // this call the same headroom as the thing it's waiting on, plus a
  // small buffer.
  return postJSON("/api/scan", { mode: "replay", refresh_bias: true, force: true, ...(body ?? {}) }, 630_000);
}

export async function setKillSwitch(enabled: boolean) {
  return postJSON("/api/kill-switch", { enabled });
}

export async function fetchKillSwitch(): Promise<{ enabled: boolean }> {
  return getJSON("/api/kill-switch");
}

export async function fetchCandles(
  pair: string,
  timeframe = "1h",
  limit = 140
): Promise<Candle[]> {
  // Backend: GET /api/candles/{pair}?timeframe=&limit=
  const encoded = encodeURIComponent(pair);
  const data = await getJSON<Candle[] | { candles: Candle[] }>(`/api/candles/${encoded}`, {
    timeframe,
    limit,
  });
  const rows = Array.isArray(data) ? data : (data as any).candles ?? [];
  // Normalize field names if backend uses different keys
  return rows.map((r: any) => ({
    t: r.t ?? r.time ?? r.datetime ?? r.date ?? "",
    o: Number(r.o ?? r.open),
    h: Number(r.h ?? r.high),
    l: Number(r.l ?? r.low),
    c: Number(r.c ?? r.close),
    v: Number(r.v ?? r.volume ?? 0),
  }));
}

export async function fetchMlInsights() {
  return getJSON("/api/ml/insights");
}

/** Live conviction / MTM / noise for an open (or recently closed) trade. */
export async function fetchLiveStatus(
  signalId: number,
  refresh = true
): Promise<LiveStatus> {
  return getJSON(`/api/signals/${signalId}/live-status`, { refresh });
}

/** Open pending trades + ML block for the dedicated Monitor page. */
export async function fetchMonitorOpen(params?: {
  refresh?: boolean;
  limit?: number;
}): Promise<{
  ts: string;
  count: number;
  trades: Signal[];
  ml?: Record<string, unknown> | null;
}> {
  return getJSON("/api/monitor/open", {
    refresh: params?.refresh ?? false,
    limit: params?.limit ?? 40,
  });
}

/** Ideas + closed trades from the last N hours for the Monitor page. */
export async function fetchMonitorIdeas(params?: {
  hours?: number;
  limit?: number;
}): Promise<{
  ts: string;
  hours: number;
  closed_count: number;
  wins: number;
  losses: number;
  trades: Signal[];
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
    wins?: number;
    losses?: number;
  }>;
  by_pattern?: Record<string, unknown>;
  by_pair?: Record<string, unknown>;
  ml?: Record<string, unknown> | null;
}> {
  return getJSON("/api/monitor/ideas", {
    hours: params?.hours ?? 4,
    limit: params?.limit ?? 40,
  });
}

export async function refreshOpenMonitors(limit = 40): Promise<{
  ok: boolean;
  evaluated: number;
  succeeded: number;
  results: LiveStatus[];
}> {
  const url = new URL(
    "/api/monitor/refresh",
    API_BASE || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8000")
  );
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for /api/monitor/refresh`);
  return res.json();
}

/** Returns true if backend answered /api/health within timeout. */
export async function probeBackend(): Promise<boolean> {
  try {
    await fetchHealth();
    return true;
  } catch {
    return false;
  }
}
