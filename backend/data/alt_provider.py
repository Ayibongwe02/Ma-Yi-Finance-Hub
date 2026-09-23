"""
Optional secondary data source, used only when yfinance is rate-limited.

Nothing here runs unless you explicitly opt in — there is no default
provider and no request is ever made without you setting an env var first:

  - TWELVE_DATA_API_KEY   real OHLC candles (FX + EU50), free tier: 800
                          calls/day, 8/min. Get a free key (no card) at
                          https://twelvedata.com/pricing — takes ~2 minutes.
                          Set it as an env var and this activates itself;
                          nothing else in the app needs to change.

Without any key set, `fetch_alt_history()` returns None immediately and the
caller (data/candles.py) falls through to its existing cache-or-fail logic.
This file makes NO network calls of its own accord and stores no key.
"""

from __future__ import annotations

import os

import pandas as pd
import requests

# yfinance-style ticker -> Twelve Data symbol
_TWELVE_DATA_SYMBOLS = {
    "EURUSD=X": "EUR/USD",
    "GBPUSD=X": "GBP/USD",
    "USDJPY=X": "USD/JPY",
    "GBPJPY=X": "GBP/JPY",
    "^DJI": "DJI",
    "^STOXX50E": "STOXX50E",
}

# Our timeframe -> Twelve Data interval
_TWELVE_DATA_INTERVAL = {
    "15m": "15min",
    "1h": "1h",
    "4h": "4h",
    "1d": "1day",
}


def fetch_alt_history(pair: str, timeframe: str, bars: int = 300) -> pd.DataFrame | None:
    """
    Fetch OHLC candles from Twelve Data, if (and only if) TWELVE_DATA_API_KEY
    is set. Returns None (never raises for a missing key) so callers can
    treat "no alt provider configured" the same as "alt provider unavailable".
    """
    api_key = os.environ.get("TWELVE_DATA_API_KEY", "").strip()
    if not api_key:
        return None

    symbol = _TWELVE_DATA_SYMBOLS.get(pair)
    interval = _TWELVE_DATA_INTERVAL.get(timeframe)
    if symbol is None or interval is None:
        return None

    try:
        resp = requests.get(
            "https://api.twelvedata.com/time_series",
            params={
                "symbol": symbol,
                "interval": interval,
                "outputsize": min(bars, 5000),
                "apikey": api_key,
                "order": "ASC",
            },
            timeout=15,
        )
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:  # noqa: BLE001 - network/parsing errors alike
        print(f"  [alt_provider] Twelve Data request failed for {pair}: {e}")
        return None

    if payload.get("status") == "error" or "values" not in payload:
        print(f"  [alt_provider] Twelve Data error for {pair}: {payload.get('message')}")
        return None

    rows = payload["values"]
    if not rows:
        return None

    df = pd.DataFrame(rows)
    df["datetime"] = pd.to_datetime(df["datetime"], utc=True)
    df = df.set_index("datetime").sort_index()
    df = df.rename(
        columns={"open": "Open", "high": "High", "low": "Low", "close": "Close"}
    )
    for col in ("Open", "High", "Low", "Close"):
        df[col] = df[col].astype(float)
    df["Volume"] = df.get("volume", 0.0)
    df.index.name = "Datetime"
    return df[["Open", "High", "Low", "Close", "Volume"]]
