"""
Keyless, no-signup fallback for FX *reference* prices via Frankfurter.app
(European Central Bank daily rates). No API key, no rate limit as of this
writing.

Important: this deliberately does NOT feed into fetch_history(), the
pattern-detection engine, or alerting. Frankfurter gives one rate per
currency per day (not real open/high/low/close candles), so treating it as
a candle would produce a flat, zero-range bar that could confuse or falsely
trigger pattern detectors. It exists purely so the UI/API can show *some*
real, non-fabricated current price when yfinance is rate-limited and no
cache/alt-provider data is available — never as a substitute candle for
signal generation.

Coverage: FX pairs only (EURUSD=X, GBPUSD=X, ...). No equity indices
(EU50/^STOXX50E is out of scope for this source — ECB doesn't publish
index levels).
"""

from __future__ import annotations

import requests

# yfinance-style ticker -> (base, quote) for Frankfurter's base/symbols params
_FX_LEGS = {
    "EURUSD=X": ("EUR", "USD"),
    "GBPUSD=X": ("GBP", "USD"),
    "USDJPY=X": ("USD", "JPY"),
    "GBPJPY=X": ("GBP", "JPY"),
}


def fetch_reference_rate(pair: str) -> dict | None:
    """
    Return {"rate": float, "date": "YYYY-MM-DD", "source": "frankfurter/ecb"}
    for a supported FX pair, or None if unsupported/unavailable. Never
    raises — this is a best-effort display fallback, not a critical path.
    """
    legs = _FX_LEGS.get(pair)
    if legs is None:
        return None
    base, quote = legs
    try:
        resp = requests.get(
            "https://api.frankfurter.app/latest",
            params={"base": base, "symbols": quote},
            timeout=8,
        )
        resp.raise_for_status()
        data = resp.json()
        rate = data.get("rates", {}).get(quote)
        if rate is None:
            return None
        return {"rate": float(rate), "date": data.get("date"), "source": "frankfurter/ecb"}
    except Exception:
        return None
