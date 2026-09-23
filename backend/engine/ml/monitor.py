"""Live position monitor — re-score open (fired, pending) trades bar-by-bar.

Does **not** introduce a second model. For each open signal it:

1. Pulls the latest candles for that pair/timeframe.
2. Refreshes slow-moving context features (trend, S/R, volatility) from the
   latest closed bar — sentiment/COT stay at the values stored on the signal
   (they only refresh live/weekly; treating them as intrabar signal would
   overstate their precision).
3. Calls the existing MLLearner.predict() with the updated feature vector.
4. Computes mark-to-market state: progress toward TP vs SL as a fraction of
   planned R, time-in-trade, and a simple noise band (0.5–1× ATR adverse
   move is noise; beyond that is a real adverse signal).
5. Surfaces conviction as rising/falling prob_win, not a direction flip
   (direction was fixed at entry).

Persists a ``live_status`` block onto the signal row via delivery.logger so
the API and WebSocket tape can expose it without a separate store.
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# Adverse move smaller than this multiple of ATR is treated as noise.
_NOISE_ATR_MULT = float(os.environ.get("MONITOR_NOISE_ATR_MULT", "0.75"))
# How far back to pull candles when refreshing an open trade.
_HISTORY_PERIOD = os.environ.get("MONITOR_HISTORY_PERIOD", "30d")
_ATR_PERIOD = 14

_lock = threading.Lock()


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _parse_ts(value: Any) -> Optional[pd.Timestamp]:
    if value is None or value == "":
        return None
    try:
        ts = pd.Timestamp(value)
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        else:
            ts = ts.tz_convert("UTC")
        return ts
    except Exception:
        return None


def _load_candles(pair: str, timeframe: str) -> Optional[pd.DataFrame]:
    """Best-effort candle load: prefer live fetch, fall back to cache."""
    try:
        from data.candles import fetch_history, load_cached  # type: ignore
    except ImportError:
        try:
            from candles import fetch_history, load_cached  # type: ignore
        except ImportError:
            return None

    df: Optional[pd.DataFrame] = None
    try:
        df = fetch_history(pair, timeframe, period=_HISTORY_PERIOD)
    except Exception as e:
        logger.debug("monitor fetch_history failed %s %s: %s", pair, timeframe, e)
    if df is None or df.empty:
        try:
            df = load_cached(pair, timeframe)
        except Exception as e:
            logger.debug("monitor load_cached failed %s %s: %s", pair, timeframe, e)
    if df is None or df.empty:
        return None
    # Normalise column names
    cols = {c.lower(): c for c in df.columns}
    rename = {}
    for want in ("Open", "High", "Low", "Close", "Volume"):
        if want not in df.columns and want.lower() in cols:
            rename[cols[want.lower()]] = want
    if rename:
        df = df.rename(columns=rename)
    if not all(c in df.columns for c in ("Open", "High", "Low", "Close")):
        return None
    return df


def _refresh_context_features(df: pd.DataFrame) -> dict[str, Any]:
    """Compute trend / S/R / volatility on the latest closed bar.

    Uses the same primitives as engine.context so the live feature vector
    stays consistent with what the model was trained on. Does not re-run
    pattern detection — the pattern is fixed at entry.
    """
    out: dict[str, Any] = {
        "trend": 0,
        "sr_score": 0.5,
        "volatility": "normal",
        "atr": None,
        "last_close": None,
        "last_bar_time": None,
    }
    if df is None or len(df) < 5:
        return out

    try:
        from context import (  # type: ignore
            compute_atr,
            compute_same_tf_trend,
            compute_swing_levels,
            volatility_state,
        )
    except ImportError:
        try:
            from engine.context import (  # type: ignore
                compute_atr,
                compute_same_tf_trend,
                compute_swing_levels,
                volatility_state,
            )
        except ImportError:
            # Minimal fallback: only price + ATR
            atr = (df.High - df.Low).rolling(14, min_periods=1).mean()
            out["atr"] = float(atr.iloc[-1])
            out["last_close"] = float(df.Close.iloc[-1])
            out["last_bar_time"] = str(df.index[-1])
            return out

    i = len(df) - 1
    atr = compute_atr(df, _ATR_PERIOD)
    atr_val = float(atr.iloc[i]) if not np.isnan(atr.iloc[i]) else float(df.High.iloc[i] - df.Low.iloc[i])
    out["atr"] = atr_val
    out["last_close"] = float(df.Close.iloc[i])
    out["last_bar_time"] = (
        df.index[i].isoformat() if hasattr(df.index[i], "isoformat") else str(df.index[i])
    )
    out["volatility"] = volatility_state(df, atr, i)

    try:
        trend_series = compute_same_tf_trend(df)
        out["trend"] = int(trend_series.iloc[i]) if i < len(trend_series) else 0
    except Exception:
        out["trend"] = 0

    # Lightweight S/R proximity: distance from last close to nearest recent swing
    # normalised into 0..1 (closer → higher score), matching the spirit of
    # context.sr_confluence without needing the full pattern pipeline.
    try:
        swing_highs, swing_lows = compute_swing_levels(df, window=3)
        close = float(df.Close.iloc[i])
        lookback = max(0, i - 50)
        levels = [p for idx, p in swing_highs + swing_lows if lookback <= idx < i]
        if levels and atr_val > 0:
            nearest = min(levels, key=lambda p: abs(p - close))
            dist_atr = abs(nearest - close) / atr_val
            # 0 ATR away → 1.0, 2+ ATR away → ~0
            out["sr_score"] = float(max(0.0, min(1.0, 1.0 - dist_atr / 2.0)))
        else:
            out["sr_score"] = 0.5
    except Exception:
        out["sr_score"] = 0.5

    return out


def _mtm_state(
    direction: int,
    entry: float,
    sl: float,
    tp: float,
    risk: float,
    current: float,
) -> dict[str, Any]:
    """Mark-to-market progress toward TP / SL as fractions of planned R."""
    if risk is None or risk <= 0:
        risk = abs(entry - sl) if entry and sl else 0.0
    if risk <= 0:
        return {
            "r_multiple": 0.0,
            "progress_tp": 0.0,
            "progress_sl": 0.0,
            "distance_to_tp": None,
            "distance_to_sl": None,
            "side": "long" if direction > 0 else "short",
        }

    if direction > 0:
        pnl = current - entry
        dist_tp = tp - current
        dist_sl = current - sl
    else:
        pnl = entry - current
        dist_tp = current - tp
        dist_sl = sl - current

    r_mult = pnl / risk
    # Progress 0..1+ toward each level (can exceed 1 if beyond)
    planned_tp_r = abs(tp - entry) / risk if risk else 1.5
    progress_tp = max(0.0, r_mult / planned_tp_r) if planned_tp_r else 0.0
    progress_sl = max(0.0, -r_mult)  # 1.0 = at stop

    return {
        "r_multiple": round(r_mult, 3),
        "progress_tp": round(min(progress_tp, 2.0), 3),
        "progress_sl": round(min(progress_sl, 2.0), 3),
        "distance_to_tp": round(dist_tp, 6),
        "distance_to_sl": round(dist_sl, 6),
        "side": "long" if direction > 0 else "short",
    }


def _noise_read(
    direction: int,
    entry: float,
    current: float,
    atr: Optional[float],
    noise_mult: float = _NOISE_ATR_MULT,
) -> dict[str, Any]:
    """Classify adverse price movement relative to ATR noise band.

    - favorable: price moved in the trade direction
    - noise: adverse move smaller than noise_mult × ATR
    - adverse: adverse move at or beyond the band (real signal)
    """
    if atr is None or atr <= 0:
        return {"state": "unknown", "adverse_atr": None, "band_atr": noise_mult}

    if direction > 0:
        adverse = entry - current  # positive when underwater
        favorable_move = current - entry
    else:
        adverse = current - entry
        favorable_move = entry - current

    adverse_atr = adverse / atr
    if favorable_move > 0 and adverse <= 0:
        state = "favorable"
    elif adverse_atr < noise_mult:
        state = "noise"
    else:
        state = "adverse"

    return {
        "state": state,
        "adverse_atr": round(adverse_atr, 3),
        "band_atr": noise_mult,
    }


def _time_in_trade_hours(bar_time: Any) -> Optional[float]:
    ts = _parse_ts(bar_time)
    if ts is None:
        return None
    now = pd.Timestamp.now(tz="UTC")
    return float((now - ts).total_seconds() / 3600.0)


def _conviction_arrow(prev_prob: Optional[float], prob: Optional[float]) -> str:
    """rising / falling / flat / unknown — never a direction re-decision."""
    if prev_prob is None or prob is None:
        return "unknown"
    delta = prob - prev_prob
    if delta > 0.02:
        return "rising"
    if delta < -0.02:
        return "falling"
    return "flat"


def evaluate_open_trade(signal: dict, *, persist: bool = True) -> dict[str, Any]:
    """Build a live_status block for one open (fired, pending) signal.

    Returns the live_status dict. When persist=True, writes it back onto the
    signal row under key ``live_status``.
    """
    pair = str(signal.get("pair") or "")
    timeframe = str(signal.get("timeframe") or "1h")
    direction = int(signal.get("direction") or 0)
    entry = _safe_float(signal.get("entry"))
    sl = _safe_float(signal.get("sl"))
    tp = _safe_float(signal.get("tp"))
    risk = _safe_float(signal.get("risk"))
    if risk <= 0 and entry and sl:
        risk = abs(entry - sl)

    now_iso = datetime.now(timezone.utc).isoformat()
    status: dict[str, Any] = {
        "ts": now_iso,
        "pair": pair,
        "timeframe": timeframe,
        "signal_id": signal.get("id"),
        "outcome": signal.get("outcome") or "pending",
        "ok": False,
        "error": None,
    }

    if not pair or direction == 0 or not entry:
        status["error"] = "incomplete signal (pair/direction/entry)"
        return status

    df = _load_candles(pair, timeframe)
    if df is None or df.empty:
        status["error"] = "no candle data"
        return status

    ctx = _refresh_context_features(df)
    current = ctx.get("last_close")
    if current is None:
        status["error"] = "no last close"
        return status

    # Build a feature-ready signal dict: keep entry-time pattern / score /
    # sentiment / regime, overlay fresh trend / sr / vol / bar_time.
    live_sig = dict(signal)
    live_sig["trend"] = ctx["trend"]
    live_sig["sr_score"] = ctx["sr_score"]
    live_sig["volatility"] = ctx["volatility"]
    # Use wall-clock hour for the live prediction so hour-of-day stays current.
    live_sig["bar_time"] = now_iso

    pred: dict[str, Any] = {
        "prob_win": None,
        "adjusted_score": live_sig.get("final_score"),
        "anomaly": False,
        "note": "ML unavailable",
    }
    try:
        from engine.ml.learner import get_learner  # type: ignore

        learner = get_learner()
        if learner is not None:
            pred = learner.predict(live_sig)
    except Exception as e:
        pred["note"] = f"predict error: {e}"

    prev_status = signal.get("live_status") if isinstance(signal.get("live_status"), dict) else {}
    prev_prob = prev_status.get("prob_win")
    if prev_prob is not None:
        try:
            prev_prob = float(prev_prob)
        except (TypeError, ValueError):
            prev_prob = None

    prob = pred.get("prob_win")
    mtm = _mtm_state(direction, entry, sl, tp, risk, float(current))
    noise = _noise_read(direction, entry, float(current), ctx.get("atr"))
    hours = _time_in_trade_hours(signal.get("bar_time"))

    # Sparkline history: keep last ~24 prob_win samples on the row
    history = list(prev_status.get("prob_history") or [])
    if prob is not None:
        history.append({"ts": now_iso, "prob_win": prob})
        history = history[-24:]

    status.update({
        "ok": True,
        "current_price": round(float(current), 6),
        "atr": round(ctx["atr"], 6) if ctx.get("atr") is not None else None,
        "trend": ctx["trend"],
        "sr_score": round(float(ctx["sr_score"]), 3),
        "volatility": ctx["volatility"],
        "last_bar_time": ctx.get("last_bar_time"),
        "prob_win": prob,
        "prev_prob_win": prev_prob,
        "conviction": _conviction_arrow(prev_prob, prob if isinstance(prob, (int, float)) else None),
        "adjusted_score": pred.get("adjusted_score"),
        "anomaly": bool(pred.get("anomaly")),
        "ml_note": pred.get("note"),
        "mtm": mtm,
        "noise": noise,
        "time_in_trade_hours": round(hours, 2) if hours is not None else None,
        "prob_history": history,
    })

    if persist and signal.get("id") is not None:
        try:
            from logger import update_live_status  # type: ignore

            update_live_status(int(signal["id"]), status)
        except Exception:
            try:
                from delivery.logger import update_live_status  # type: ignore

                update_live_status(int(signal["id"]), status)
            except Exception as e:
                logger.debug("persist live_status failed: %s", e)

    return status


def list_open_signals(limit: int = 200) -> list[dict]:
    """Fired signals whose outcome is still pending."""
    try:
        from logger import get_signals  # type: ignore
    except ImportError:
        from delivery.logger import get_signals  # type: ignore

    rows = get_signals(fired_only=True, limit=limit)
    return [
        r
        for r in rows
        if str(r.get("outcome") or "pending").lower() in ("pending", "", "none")
    ]


def refresh_all_open(*, persist: bool = True, limit: int = 50) -> list[dict[str, Any]]:
    """Evaluate every open trade. Safe to call from a background loop."""
    open_rows = list_open_signals(limit=limit)
    results: list[dict[str, Any]] = []
    with _lock:
        for sig in open_rows:
            try:
                results.append(evaluate_open_trade(sig, persist=persist))
            except Exception as e:
                results.append({
                    "ok": False,
                    "signal_id": sig.get("id"),
                    "pair": sig.get("pair"),
                    "error": str(e),
                    "ts": datetime.now(timezone.utc).isoformat(),
                })
    return results


def get_live_status(signal_id: int, *, refresh: bool = True) -> Optional[dict[str, Any]]:
    """Return live_status for one signal, optionally forcing a recompute."""
    try:
        from logger import get_signals  # type: ignore
    except ImportError:
        from delivery.logger import get_signals  # type: ignore

    rows = get_signals(fired_only=False, limit=50_000)
    match = next((r for r in rows if int(r.get("id", -1)) == int(signal_id)), None)
    if match is None:
        return None

    outcome = str(match.get("outcome") or "pending").lower()
    if outcome in ("win", "loss"):
        # Closed trades keep last live_status snapshot if any; no re-score.
        cached = match.get("live_status")
        if isinstance(cached, dict):
            out = dict(cached)
            out["outcome"] = outcome
            out["closed"] = True
            return out
        return {
            "ok": True,
            "closed": True,
            "outcome": outcome,
            "signal_id": signal_id,
            "ts": datetime.now(timezone.utc).isoformat(),
        }

    if refresh or not isinstance(match.get("live_status"), dict):
        return evaluate_open_trade(match, persist=True)

    return match.get("live_status")
