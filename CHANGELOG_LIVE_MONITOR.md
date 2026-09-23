# Live Monitor fixes (2026-09-18)

## Problems fixed
1. **Live status flash** – Deep Dive showed live status for ~1s then cleared it.
2. **Dedicated Monitor page** – continuous live feed belongs on Monitor, not Deep Dive.
3. **Ideas from closed trades (4h)** – continuous idea feed from recent win/loss outcomes.
4. **Multi-TF / structure bias empty** – backend rows lacked `bias`/`score`; UI hid the block.
5. **ML "waiting for backend"** – opaque empty state when learner failed to load.

## Changes
### Frontend
- `desk/SignalDeepDive.tsx` – keep last good live_status; poll every 25s while open; never blank on failed refresh.
- `desk/MonitorPage.tsx` – dedicated Live Monitor; polls `/api/monitor/open` + `/api/monitor/ideas` (4h closed trades); Ideas sidebar; clearer ML empty state.
- `desk/api.ts` – `fetchMonitorIdeas()`.

### Backend
- `api/main.py`
  - `GET /api/monitor/ideas?hours=4` – closed trades + pattern/pair ideas.
  - `_normalize_pair_bias_row()` – map htf/stf → bias + score for the desk.
  - `/api/ml/status` – explicit message when learner missing or errors.

## Deploy
```bash
cd backend
docker compose up --build -d
```
Open http://localhost:8000 → **Monitor** tab.

If multi-TF still empty:
```bash
curl -X POST http://localhost:8000/api/pair-bias/refresh
```
Check engine logs for candles/context/yfinance errors.

If ML still unavailable, confirm `engine/ml/model.joblib` is in the image and learner imports without traceback.
