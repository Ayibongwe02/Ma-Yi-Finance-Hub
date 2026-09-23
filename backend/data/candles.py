"""
Stage 1 — Data ingestion.

Fetches OHLC candle data for configured pairs/timeframes and stores it
locally as CSV so the backtester (Stage 4) never has to re-fetch. Also
exposes a function to grab the latest closed candle for live use (Stage 5).

Data source priority:
  1. Twelve Data — primary, used whenever TWELVE_DATA_API_KEY is set.
  2. yfinance — fallback, used when no Twelve Data key is set, or when
     Twelve Data fails/returns nothing for a given call.
  3. Cached CSV — last resort for fetch_history() when both live sources
     fail and a not-too-stale cache exists.

Everything downstream depends on the DataFrame shape, not the source, so
either provider is a drop-in for the other.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pandas as pd

try:
    import yfinance as yf
    from yfinance.exceptions import YFRateLimitError
except ImportError:  # optional — synthetic fallback still works offline
    yf = None
    YFRateLimitError = None

from alt_provider import fetch_alt_history

DATA_DIR = Path(__file__).parent / "store"
DATA_DIR.mkdir(exist_ok=True)

# yfinance interval codes. 1h/4h aren't both natively supported for FX with
# long history, so 4h is resampled from 1h.
_YF_INTERVAL_MAP = {
    "15m": "15m",
    "1h": "60m",
    "4h": "60m",  # fetched as 1h then resampled
    "1d": "1d",
}

# Timedelta for each supported timeframe — used to detect still-forming bars.
_TF_DELTA = {
    "15m": pd.Timedelta(minutes=15),
    "1h": pd.Timedelta(hours=1),
    "4h": pd.Timedelta(hours=4),
    "1d": pd.Timedelta(days=1),
}


def _resample_to_4h(df: pd.DataFrame) -> pd.DataFrame:
    agg = {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
    out = df.resample("4h").agg(agg).dropna(how="any")
    return out


def _drop_forming_candle(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """
    Drop the last row when it is still forming (not yet closed).

    yfinance (and most OHLC feeds) include the currently open bar. Alerting
    or training on that partial bar is unsafe — patterns and scores can
    change before the close. Mirror the conservative policy used by
    fetch_latest_candle(): only return fully closed candles.

    Logic:
      - If the last bar's open time + timeframe duration is still in the
        future (UTC), treat it as forming and drop it.
      - If we cannot parse times or have only one bar, fall back to dropping
        the last row when len > 1 (same as the previous fetch_latest_candle
        heuristic).
    """
    if df is None or df.empty or len(df) < 2:
        return df

    delta = _TF_DELTA.get(timeframe)
    if delta is None:
        # Unknown TF — conservative: drop last row
        return df.iloc[:-1].copy()

    try:
        last_open = df.index[-1]
        if not isinstance(last_open, pd.Timestamp):
            last_open = pd.Timestamp(last_open)
        # Normalize to UTC for comparison
        if last_open.tzinfo is None:
            last_open = last_open.tz_localize("UTC")
        else:
            last_open = last_open.tz_convert("UTC")

        now = pd.Timestamp.now(tz="UTC")
        # Bar is still forming if its close time is still in the future
        # (with a small 5s grace so we don't race the exact second of close)
        close_time = last_open + delta
        if now < close_time - pd.Timedelta(seconds=5):
            return df.iloc[:-1].copy()
        return df
    except Exception:
        # Fallback: always drop the most recent row when we have history
        return df.iloc[:-1].copy()


def _twelve_data_key_set() -> bool:
    return bool(os.environ.get("TWELVE_DATA_API_KEY", "").strip())


def _period_to_bars(period: str, timeframe: str) -> int:
    """Convert a yfinance-style period string ('60d', '10d', '5d', ...) into
    an approximate candle count for Twelve Data's `outputsize` param.

    Adds a ~15% buffer so we don't under-fetch relative to what the
    equivalent yfinance period call would have returned, and caps at
    Twelve Data's max outputsize (5000).
    """
    delta = _TF_DELTA.get(timeframe)
    try:
        days = int(period.strip().lower().rstrip("d"))
    except (ValueError, AttributeError):
        days = 60  # sane default if period isn't a plain "Nd" string

    if not delta or delta.total_seconds() <= 0:
        return 300

    candles_per_day = pd.Timedelta(days=1) / delta
    bars = int(days * candles_per_day * 1.15) + 10
    return max(10, min(bars, 5000))


def _is_rate_limit_error(exc: Exception) -> bool:
    if YFRateLimitError is not None and isinstance(exc, YFRateLimitError):
        return True
    msg = str(exc).lower()
    return "too many requests" in msg or "rate limit" in msg


def _cache_age_sec(pair: str, timeframe: str) -> float | None:
    path = _cache_path(pair, timeframe)
    if not path.exists():
        return None
    return time.time() - path.stat().st_mtime


# How many times to retry a single fetch after a rate-limit response, and how
# long to wait between attempts (seconds).
#
# yfinance is now the *fallback* (Twelve Data is primary — see module
# docstring), not the primary path it used to be, so this budget is
# intentionally lean: one quick retry to shrug off a truly transient blip,
# not the heavy multi-minute backoff campaign that made sense when yfinance
# had to be made to work no matter what. A slow fallback is worse than no
# fallback — it silently turns a 10-second Twelve Data failure into a
# multi-minute stall for every caller waiting on this data (this is what
# caused scans to appear to "hang" and the frontend to time out into demo
# mode). Both values are env-overridable if a slower/more patient fallback
# is ever wanted again.
_RATE_LIMIT_RETRIES = int(os.environ.get("YF_RATE_LIMIT_RETRIES", "1"))
try:
    _RATE_LIMIT_BACKOFF_SEC = tuple(
        float(x) for x in os.environ.get("YF_RATE_LIMIT_BACKOFF_SEC", "8").split(",")
    )
except ValueError:
    _RATE_LIMIT_BACKOFF_SEC = (8.0,)

# If a fresh fetch is rate-limited after all retries, a cached copy of the
# same pair/timeframe younger than this is considered good enough to use
# instead of producing zero signals for the cycle. Set generously relative
# to MONITOR_INTERVAL_SEC / AUTO_SCAN_INTERVAL_SEC so a couple of missed
# cycles in a row don't force a hard failure.
_STALE_CACHE_MAX_AGE_SEC = float(os.environ.get("CANDLE_CACHE_MAX_AGE_SEC", "10800"))  # 3h


def fetch_history(pair: str, timeframe: str, period: str = "60d") -> pd.DataFrame:
    """
    Fetch historical OHLC candles for a pair/timeframe and cache to CSV.

    Always returns only *closed* candles (the still-forming bar is trimmed),
    matching the contract of fetch_latest_candle(). Downstream engines,
    live alerts, and ML training must never see a partial bar.

    pair: yfinance FX ticker, e.g. "EURUSD=X"
    timeframe: one of "15m", "1h", "4h", "1d"
    period: how far back to pull (yfinance limits intraday history, e.g.
            15m/60m intervals only go back ~60 days)

    On a persistent rate-limit error, falls back to the last cached CSV for
    this pair/timeframe if it's not older than CANDLE_CACHE_MAX_AGE_SEC
    (default 3h) — real historical data that's a bit stale is a much safer
    fallback for live alerting than raising and producing zero signals, or
    (worse) the synthetic random-walk fallback used elsewhere.
    """
    if timeframe not in _YF_INTERVAL_MAP:
        raise ValueError(f"Unsupported timeframe: {timeframe}")

    # --- Primary: Twelve Data, if a key is configured ---------------------
    tried_twelve_data = False
    if _twelve_data_key_set():
        tried_twelve_data = True
        bars = _period_to_bars(period, timeframe)
        alt_df = fetch_alt_history(pair, timeframe, bars=bars)
        if alt_df is not None and not alt_df.empty:
            alt_df = _drop_forming_candle(alt_df, timeframe)
            if not alt_df.empty:
                _save(alt_df, pair, timeframe)
                return alt_df
        print(
            f"  [candles] {pair} @ {timeframe} Twelve Data unavailable/empty — "
            f"falling back to yfinance."
        )

    if yf is None:
        if tried_twelve_data:
            raise RuntimeError(
                "Twelve Data fetch failed and yfinance is not installed; "
                "cannot fetch live history"
            )
        raise RuntimeError("yfinance is not installed; cannot fetch live history")

    yf_interval = _YF_INTERVAL_MAP[timeframe]

    last_exc: Exception | None = None
    for attempt in range(_RATE_LIMIT_RETRIES + 1):
        try:
            ticker = yf.Ticker(pair)
            df = ticker.history(period=period, interval=yf_interval)
            break
        except Exception as e:  # noqa: BLE001 - yfinance raises several types
            last_exc = e
            if not _is_rate_limit_error(e) or attempt == _RATE_LIMIT_RETRIES:
                df = None
                break
            wait = _RATE_LIMIT_BACKOFF_SEC[min(attempt, len(_RATE_LIMIT_BACKOFF_SEC) - 1)]
            print(
                f"  [candles] {pair} @ {timeframe} rate limited "
                f"(attempt {attempt + 1}/{_RATE_LIMIT_RETRIES + 1}), "
                f"retrying in {wait}s..."
            )
            time.sleep(wait)
    else:
        df = None

    if df is None or df.empty:
        if last_exc is not None and _is_rate_limit_error(last_exc):
            age = _cache_age_sec(pair, timeframe)
            if age is not None and age <= _STALE_CACHE_MAX_AGE_SEC:
                print(
                    f"  [candles] {pair} @ {timeframe} still rate limited after "
                    f"retries — using cached data ({age / 60:.0f}m old) instead "
                    f"of failing this cycle."
                )
                return load_cached(pair, timeframe)

            # Note: Twelve Data is no longer retried here. Whenever a key is
            # configured it's already tried first, at the top of this
            # function (`tried_twelve_data`) — retrying the identical call
            # again after a yfinance rate-limit would just burn an extra
            # Twelve Data request for no benefit. If no key is configured,
            # there's nothing to fall back to here either.
        if last_exc is not None:
            raise last_exc
        raise RuntimeError(f"No data returned for {pair} @ {timeframe} (period={period})")

    df = df[["Open", "High", "Low", "Close", "Volume"]].copy()
    df.index.name = "Datetime"

    if timeframe == "4h":
        df = _resample_to_4h(df)

    # Critical: never cache / return the still-forming candle
    df = _drop_forming_candle(df, timeframe)

    if df.empty:
        raise RuntimeError(
            f"No closed candles for {pair} @ {timeframe} after dropping forming bar"
        )

    _save(df, pair, timeframe)
    return df


def _cache_path(pair: str, timeframe: str) -> Path:
    safe_pair = pair.replace("=", "_").replace("/", "_")
    return DATA_DIR / f"{safe_pair}_{timeframe}.csv"


def _save(df: pd.DataFrame, pair: str, timeframe: str) -> None:
    df.to_csv(_cache_path(pair, timeframe))


def load_cached(pair: str, timeframe: str) -> pd.DataFrame:
    """Load previously cached candles without hitting the network.

    Still applies the forming-bar trim so a stale cache written before this
    fix (or mid-bar) never feeds an incomplete candle into charts/engine.
    """
    path = _cache_path(pair, timeframe)
    if not path.exists():
        raise FileNotFoundError(
            f"No cached data for {pair} @ {timeframe}. Run fetch_history() first."
        )
    df = pd.read_csv(path, index_col="Datetime", parse_dates=True)
    return _drop_forming_candle(df, timeframe)


def fetch_latest_candle(pair: str, timeframe: str) -> pd.Series:
    """
    Return the most recent *closed* candle for a pair/timeframe.
    Used by the live delivery module (Stage 5) — pulls a short recent
    window rather than the full history for speed.

    Shares the same forming-bar trim as fetch_history() so live and
    historical paths never disagree on which bar is "current".

    Same Twelve Data (primary) / yfinance (fallback) priority as
    fetch_history() — previously this function was yfinance-only with no
    fallback at all, which meant open-trade re-scoring (the live monitor
    loop) had no resilience to a yfinance rate limit even when Twelve Data
    was configured and working fine for the rest of the pipeline.
    """
    if _twelve_data_key_set():
        alt_df = fetch_alt_history(pair, timeframe, bars=_period_to_bars("5d", timeframe))
        if alt_df is not None and not alt_df.empty:
            alt_df = _drop_forming_candle(alt_df, timeframe)
            if not alt_df.empty:
                return alt_df.iloc[-1]
        print(
            f"  [candles] {pair} @ {timeframe} Twelve Data unavailable/empty "
            f"for latest candle — falling back to yfinance."
        )

    if yf is None:
        raise RuntimeError("yfinance is not installed; cannot fetch live candles")

    yf_interval = _YF_INTERVAL_MAP[timeframe]
    ticker = yf.Ticker(pair)
    df = ticker.history(period="5d", interval=yf_interval)
    if df.empty:
        raise RuntimeError(f"No recent data for {pair} @ {timeframe}")

    if timeframe == "4h":
        df = _resample_to_4h(df)

    df = _drop_forming_candle(df, timeframe)
    if df.empty:
        raise RuntimeError(f"No closed candles for {pair} @ {timeframe}")
    return df.iloc[-1]


def load_pairs_from_env() -> tuple[list[str], list[str]]:
    """Read PAIRS and TIMEFRAMES from environment (.env), with fallback defaults."""
    pairs = os.environ.get("PAIRS", "EURUSD=X,GBPUSD=X").split(",")
    timeframes = os.environ.get("TIMEFRAMES", "1h,4h").split(",")
    return [p.strip() for p in pairs], [t.strip() for t in timeframes]
