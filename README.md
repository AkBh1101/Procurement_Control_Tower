# Procurement Control Tower
### An AI Supply Chain / Procurement Optimizer — hackathon build

Predicts demand, shortages, delayed suppliers, and price anomalies across a
synthetic dataset of **10,000 components · 500 suppliers · 50,000 purchase
records**, scores every supplier on real (simulated) delivery behaviour, and
exposes an **AI agent** that reasons about trade-offs the way a procurement
lead would:

> Supplier Echo Manufacturing Ltd has a 57.3% probability of missing the
> delivery deadline for PCB Relay 918. Switching 40% of the order to
> Ironclad Enterprises reduces projected shortage risk by 39% at an
> estimated additional cost of ₹639.

That sentence isn't scripted — it's generated live from the reallocation
optimizer in `backend/ml_engine.py`.

---

## Stack

| Layer          | Tech                                                   |
|----------------|---------------------------------------------------------|
| Frontend       | HTML5 + CSS3 + **TypeScript** (compiled with `tsc`, no bundler) |
| Charts         | Chart.js (CDN)                                          |
| Backend        | **FastAPI** (Python), served with Uvicorn                |
| Database       | **SQLite** (stdlib `sqlite3`, no ORM)                     |
| "ML" layer     | NumPy — linear-trend demand forecasting, z-score price anomaly detection, blended-recency delay-probability scoring, a rule-based reallocation optimizer |

Everything is transparent/statistical rather than a black-box model — for a
procurement tool, being able to explain *why* a risk score is what it is
matters as much as the score itself. Every function in `ml_engine.py` is a
drop-in point for a trained model later (e.g. gradient boosting on real ERP
history) without touching the API contract.

## Project structure

```
supply-chain-optimizer/
├── backend/
│   ├── main.py          FastAPI app + routes, mounts the frontend as static files
│   ├── database.py      SQLite schema + connection helper
│   ├── seed_data.py     Generates the 500/10k/50k synthetic dataset (numpy, seeded)
│   ├── ml_engine.py      Forecasting, shortage risk, supplier risk, anomalies, the agent
│   ├── requirements.txt
│   └── data/             SQLite file lives here (pre-seeded, ships in the repo)
└── frontend/
    ├── index.html        Dashboard markup
    ├── style.css          Design system (dark "control tower" theme)
    ├── app.ts             All frontend logic (source of truth)
    ├── app.js             Compiled output — regenerate with `tsc`
    └── tsconfig.json
```

## Run it

```bash
cd backend
pip install -r requirements.txt --break-system-packages   # drop the flag outside a managed env
uvicorn main:app --reload --port 8000
```

Open **http://localhost:8000** — FastAPI serves the compiled frontend
directly, so there's nothing else to start. The database is pre-seeded; to
regenerate it (or reseed with a different dataset), run:

```bash
python3 seed_data.py
```

### Editing the frontend

`app.ts` is the source of truth. After changing it:

```bash
cd frontend
tsc -p tsconfig.json     # outputs app.js next to app.ts
```

No npm install needed — `tsc` is the only dependency, and the page loads
Chart.js from a CDN.

## API surface

| Endpoint                             | Returns                                      |
|---------------------------------------|-----------------------------------------------|
| `GET  /api/overview`                  | Top-line KPIs                                 |
| `GET  /api/categories`                | Component count & avg cost per category       |
| `GET  /api/spend-trend?months=12`     | Monthly spend + delayed-order rate            |
| `GET  /api/shortages?limit=25`        | Ranked predicted stockouts                    |
| `GET  /api/suppliers/risk?limit=20`   | Ranked supplier risk leaderboard              |
| `GET  /api/suppliers/{id}`            | Single supplier's stats                       |
| `GET  /api/price-anomalies?limit=25`  | Flagged purchase-price outliers (z-score)     |
| `GET  /api/demand-forecast/{id}`      | History + linear-trend forecast for one SKU   |
| `GET  /api/components/search?q=`      | Live component search (autocomplete)          |
| `POST /api/agent/recommend`           | `{supplier_id, component_id?}` → reallocation recommendation |
| `GET  /api/agent/suggestions`         | Pre-computed "ask the agent" quick prompts    |

## Design notes

The hero's animated node network is a deliberate callback: traces pulsing
between supplier and component nodes read as a literal circuit — current
flowing through a harness — which is the same visual language as wire
routing diagrams. Palette, type (Space Grotesk / Inter / JetBrains Mono) and
the terminal-style agent console follow the same "control room" idea:
readouts, not illustrations.
