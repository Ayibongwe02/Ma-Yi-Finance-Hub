# =============================================================================
# Ma-yi Sentinel — convenience wrapper for building from the REPO ROOT.
#
# This file must stay in lockstep with backend/Dockerfile (same stages, same
# ENV defaults) — the only difference is that COPY sources are prefixed with
# backend/ because the build context here is the repo root, not backend/.
# If you change one, change the other. If you don't need repo-root builds,
# prefer building from backend/ directly and delete this file:
#   cd backend && docker compose up --build
#
# Build from repo root:
#   docker build -f Dockerfile -t mayi-sentinel:latest .
# =============================================================================

# ---------- Stage 1: build React frontend ----------
FROM node:22-slim AS frontend
WORKDIR /fe

COPY backend/frontend/package.json backend/frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

COPY backend/frontend/ ./
# Empty VITE_API_URL → browser uses same origin (FastAPI serves SPA + /api)
ENV VITE_API_URL=
RUN npm run build

# ---------- Stage 2: install Python dependencies ----------
FROM python:3.11-slim AS builder
WORKDIR /build

COPY backend/requirements-frozen.txt backend/requirements.txt ./
RUN pip install --prefix=/install --no-cache-dir -r requirements-frozen.txt \
    || pip install --prefix=/install --no-cache-dir -r requirements.txt

# ---------- Stage 3: lean runtime image ----------
FROM python:3.11-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local

# Application source (backend context)
COPY backend/ ./

# Overlay production SPA build
COPY --from=frontend /fe/dist /app/frontend/dist

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000 \
    DATA_SOURCE=yfinance \
    PAIRS=EURUSD=X,GBPUSD=X,^STOXX50E \
    TIMEFRAMES=1h,4h \
    RUNNER_MODE=replay \
    AUTO_SCAN_ENABLED=true \
    AUTO_SCAN_INTERVAL_SEC=3600 \
    AUTO_SCAN_MODE=replay \
    AUTO_SCAN_TIMEFRAME=1h \
    AUTO_SCAN_PERIOD=5d \
    MONITOR_INTERVAL_SEC=1800 \
    EXECUTE_ENABLED=false \
    ML_MIN_SAMPLES=8 \
    ML_MIN_NEW_LABELS=2 \
    ML_OVERFIT_GAP=0.22 \
    ML_BOOTSTRAP_MAX_RATIO=1.0 \
    ML_BOOTSTRAP_FLOOR=40 \
    ML_AUTO_RETRAIN=true \
    EXEC_KILL_SWITCH=false

RUN mkdir -p delivery/logs execution/logs data/store backtest/reports frontend/dist \
    && chmod +x start.sh start-react.sh start-stage2.sh 2>/dev/null || true

# Run as a non-root user (see backend/Dockerfile for the rationale).
RUN groupadd -r mayi && useradd -r -g mayi -d /app mayi \
    && chown -R mayi:mayi /app
USER mayi

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=25s --retries=3 \
    CMD curl -f "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["bash", "start-react.sh"]
