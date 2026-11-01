import os
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import database
import ml_engine
from seed_data import seed_database

app = FastAPI(title="Procurement Optimizer API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    database.init_schema()
    if not database.is_seeded():
        seed_database()


def db():
    return database.get_connection()


# --------------------------------------------------------------------------
# Overview / dashboard
# --------------------------------------------------------------------------
@app.get("/api/overview")
def get_overview():
    conn = db()
    try:
        return ml_engine.overview_kpis(conn)
    finally:
        conn.close()


@app.get("/api/categories")
def get_categories():
    conn = db()
    try:
        return ml_engine.category_breakdown(conn)
    finally:
        conn.close()


@app.get("/api/spend-trend")
def get_spend_trend(months: int = 12):
    conn = db()
    try:
        return ml_engine.monthly_spend_trend(conn, months)
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Shortages
# --------------------------------------------------------------------------
@app.get("/api/shortages")
def get_shortages(limit: int = 25):
    conn = db()
    try:
        return ml_engine.predicted_shortages(conn, limit=limit)
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Suppliers
# --------------------------------------------------------------------------
@app.get("/api/suppliers/risk")
def get_supplier_risk(limit: int = 20):
    conn = db()
    try:
        return ml_engine.top_risk_suppliers(conn, limit=limit)
    finally:
        conn.close()


@app.get("/api/suppliers/{supplier_id}")
def get_supplier(supplier_id: int):
    conn = db()
    try:
        stats = ml_engine.supplier_stats(conn, supplier_id)
        if stats is None:
            raise HTTPException(404, "Supplier not found")
        return stats
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Price anomalies
# --------------------------------------------------------------------------
@app.get("/api/price-anomalies")
def get_price_anomalies(limit: int = 25):
    conn = db()
    try:
        return ml_engine.price_anomalies(conn, limit=limit)
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Demand forecast
# --------------------------------------------------------------------------
@app.get("/api/demand-forecast/{component_id}")
def get_demand_forecast(component_id: int, months: int = 3):
    conn = db()
    try:
        result = ml_engine.forecast_demand(conn, component_id, months_ahead=months)
        if result is None:
            raise HTTPException(404, "Component not found")
        return result
    finally:
        conn.close()


@app.get("/api/components/search")
def search_components(q: str = Query(..., min_length=1), limit: int = 10):
    conn = db()
    try:
        rows = conn.execute(
            """SELECT id, sku, name, category, criticality, current_stock, reorder_point
               FROM components WHERE sku LIKE ? OR name LIKE ?
               LIMIT ?""",
            (f"%{q}%", f"%{q}%", limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# --------------------------------------------------------------------------
# AI Agent
# --------------------------------------------------------------------------
class RecommendRequest(BaseModel):
    supplier_id: int
    component_id: Optional[int] = None


@app.post("/api/agent/recommend")
def agent_recommend(req: RecommendRequest):
    conn = db()
    try:
        result = ml_engine.recommend_reallocation(conn, req.supplier_id, req.component_id)
        if result is None:
            raise HTTPException(404, "Supplier not found")
        return result
    finally:
        conn.close()


@app.get("/api/agent/suggestions")
def agent_suggestions(limit: int = 5):
    """Pre-computed 'ask the agent' quick-start prompts for the demo UI."""
    conn = db()
    try:
        risky = ml_engine.top_risk_suppliers(conn, limit=limit)
        out = []
        for r in risky:
            comp = conn.execute(
                """SELECT id, name FROM components
                   WHERE primary_supplier_id=? ORDER BY avg_monthly_demand DESC LIMIT 1""",
                (r["supplier_id"],),
            ).fetchone()
            out.append({
                "supplier_id": r["supplier_id"],
                "supplier_name": r["name"],
                "component_id": comp["id"] if comp else None,
                "component_name": comp["name"] if comp else None,
                "risk_score": r["risk_score"],
            })
        return out
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Static frontend
# --------------------------------------------------------------------------
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
