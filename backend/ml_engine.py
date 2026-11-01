"""
Analytics layer. Every "model" here is deliberately transparent —
statistical / rule-based rather than a black-box network — because for
a procurement optimizer the *explainability* of a risk score is a
feature, not a limitation. Swap any function below for a trained model
(e.g. gradient boosting on real ERP history) without touching the API
contract.
"""
import datetime as dt
import math
import numpy as np

TODAY = dt.date(2026, 8, 9)


# --------------------------------------------------------------------------
# Demand forecasting
# --------------------------------------------------------------------------
def forecast_demand(conn, component_id: int, months_ahead: int = 3):
    comp = conn.execute("SELECT * FROM components WHERE id=?", (component_id,)).fetchone()
    if comp is None:
        return None

    rows = conn.execute(
        """SELECT strftime('%Y-%m', order_date) AS ym, SUM(quantity) AS qty
           FROM purchase_records WHERE component_id=?
           GROUP BY ym ORDER BY ym""",
        (component_id,),
    ).fetchall()

    history = [{"month": r["ym"], "quantity": r["qty"]} for r in rows]

    if len(history) >= 3:
        y = np.array([h["quantity"] for h in history], dtype=float)
        x = np.arange(len(y))
        slope, intercept = np.polyfit(x, y, 1)
        forecast = []
        for step in range(1, months_ahead + 1):
            val = max(0.0, slope * (len(y) - 1 + step) + intercept)
            forecast.append(round(float(val), 1))
    else:
        base = comp["avg_monthly_demand"]
        forecast = [round(base * (comp["trend"] ** i), 1) for i in range(1, months_ahead + 1)]

    return {
        "component_id": comp["id"],
        "sku": comp["sku"],
        "name": comp["name"],
        "history": history[-12:],
        "forecast_months": months_ahead,
        "forecast": forecast,
        "current_stock": comp["current_stock"],
        "reorder_point": comp["reorder_point"],
    }


# --------------------------------------------------------------------------
# Shortage risk
# --------------------------------------------------------------------------
def _shortage_score(current_stock, avg_daily_demand, lead_time_days):
    """
    0-100 risk score modelling a stockout-before-replenishment scenario:
    compares days-of-cover left in stock against the supplier's lead time.
    Cover >= lead time -> 0 risk. Cover == 0 -> 100 risk.
    """
    if avg_daily_demand <= 0 or lead_time_days <= 0:
        return 0.0
    days_of_cover = current_stock / avg_daily_demand
    ratio = (lead_time_days - days_of_cover) / lead_time_days
    return float(np.clip(ratio * 100, 0, 100))


def predicted_shortages(conn, limit: int = 25, min_criticality=("High", "Critical")):
    rows = conn.execute(
        """SELECT c.*, s.name AS supplier_name, s.on_time_rate, s.avg_lead_time_days
           FROM components c
           JOIN suppliers s ON s.id = c.primary_supplier_id"""
    ).fetchall()

    results = []
    for c in rows:
        lead_months = max(c["avg_lead_time_days"] / 30.0, 0.2)
        projected_demand = c["avg_monthly_demand"] * (c["trend"] ** 1) * lead_months
        avg_daily_demand = c["avg_monthly_demand"] * (c["trend"] ** 1) / 30.0
        score = _shortage_score(c["current_stock"], avg_daily_demand, c["avg_lead_time_days"])
        if score < 45:
            continue
        results.append({
            "component_id": c["id"],
            "sku": c["sku"],
            "name": c["name"],
            "category": c["category"],
            "criticality": c["criticality"],
            "current_stock": c["current_stock"],
            "reorder_point": c["reorder_point"],
            "projected_demand": round(projected_demand, 1),
            "shortage_risk": round(score, 1),
            "primary_supplier": c["supplier_name"],
            "supplier_id": c["primary_supplier_id"],
            "supplier_on_time_rate": round(c["on_time_rate"] * 100, 1),
        })

    results.sort(key=lambda r: (r["criticality"] not in min_criticality, -r["shortage_risk"]))
    return results[:limit]


# --------------------------------------------------------------------------
# Supplier delay probability & composite risk
# --------------------------------------------------------------------------
def supplier_stats(conn, supplier_id: int):
    sup = conn.execute("SELECT * FROM suppliers WHERE id=?", (supplier_id,)).fetchone()
    if sup is None:
        return None

    agg = conn.execute(
        """SELECT COUNT(*) AS n,
                  SUM(CASE WHEN status='Delayed' THEN 1 ELSE 0 END) AS n_delayed,
                  AVG(delay_days) AS avg_delay,
                  AVG(unit_price) AS avg_price
           FROM purchase_records WHERE supplier_id=?""",
        (supplier_id,),
    ).fetchone()

    recent = conn.execute(
        """SELECT COUNT(*) AS n,
                  SUM(CASE WHEN status='Delayed' THEN 1 ELSE 0 END) AS n_delayed
           FROM purchase_records
           WHERE supplier_id=? AND order_date >= date(?, '-90 day')""",
        (supplier_id, TODAY.isoformat()),
    ).fetchone()

    n = agg["n"] or 0
    hist_late_rate = (agg["n_delayed"] / n) if n else (1 - sup["on_time_rate"])
    recent_n = recent["n"] or 0
    recent_late_rate = (recent["n_delayed"] / recent_n) if recent_n else hist_late_rate

    # blend recent behaviour (60%) with full history (40%) -> "current" delay probability
    delay_probability = 0.6 * recent_late_rate + 0.4 * hist_late_rate
    delay_probability = float(np.clip(delay_probability, 0.01, 0.99))

    risk_score = (
        delay_probability * 45
        + (1 - sup["quality_score"]) * 25
        + sup["price_volatility"] * 20
        + min((agg["avg_delay"] or 0) / 15, 1) * 10
    )
    risk_score = float(np.clip(risk_score, 0, 100))

    return {
        "supplier_id": sup["id"],
        "name": sup["name"],
        "region": sup["region"],
        "category": sup["category"],
        "orders_total": n,
        "on_time_rate_baseline": round(sup["on_time_rate"] * 100, 1),
        "delay_probability": round(delay_probability * 100, 1),
        "avg_delay_days": round(agg["avg_delay"] or 0, 1),
        "avg_price": round(agg["avg_price"] or 0, 2),
        "quality_score": round(sup["quality_score"] * 100, 1),
        "price_volatility": round(sup["price_volatility"] * 100, 1),
        "risk_score": round(risk_score, 1),
        "lead_time_days": sup["avg_lead_time_days"],
    }


def top_risk_suppliers(conn, limit: int = 20):
    ids = [r["id"] for r in conn.execute("SELECT id FROM suppliers").fetchall()]
    # cheap approximation pass using stored fields, then refine top candidates precisely
    approx = conn.execute(
        """SELECT id, (
              (1-on_time_rate)*45 + (1-quality_score)*25 + price_volatility*20
           ) AS approx_risk FROM suppliers ORDER BY approx_risk DESC LIMIT ?""",
        (limit * 3,),
    ).fetchall()
    detailed = [supplier_stats(conn, r["id"]) for r in approx]
    detailed.sort(key=lambda d: -d["risk_score"])
    return detailed[:limit]


# --------------------------------------------------------------------------
# Price anomaly detection
# --------------------------------------------------------------------------
def price_anomalies(conn, limit: int = 25, z_threshold: float = 2.0):
    rows = conn.execute(
        """SELECT pr.id, pr.component_id, pr.supplier_id, pr.unit_price, pr.order_date,
                  c.sku, c.name, c.unit_cost, c.category,
                  s.name AS supplier_name
           FROM purchase_records pr
           JOIN components c ON c.id = pr.component_id
           JOIN suppliers s ON s.id = pr.supplier_id"""
    ).fetchall()

    by_component = {}
    for r in rows:
        by_component.setdefault(r["component_id"], []).append(r)

    anomalies = []
    for comp_id, recs in by_component.items():
        prices = np.array([r["unit_price"] for r in recs])
        if len(prices) < 3:
            continue
        mean, std = prices.mean(), prices.std()
        if std < 1e-6:
            continue
        for r, p in zip(recs, prices):
            z = (p - mean) / std
            if abs(z) >= z_threshold:
                anomalies.append({
                    "purchase_id": r["id"],
                    "component_id": comp_id,
                    "sku": r["sku"],
                    "name": r["name"],
                    "category": r["category"],
                    "supplier_id": r["supplier_id"],
                    "supplier_name": r["supplier_name"],
                    "order_date": r["order_date"],
                    "unit_price": round(float(p), 2),
                    "expected_price": round(float(mean), 2),
                    "z_score": round(float(z), 2),
                    "deviation_pct": round(float((p - mean) / mean * 100), 1),
                })

    anomalies.sort(key=lambda a: -abs(a["z_score"]))
    return anomalies[:limit]


# --------------------------------------------------------------------------
# AI agent: reallocation optimizer
# --------------------------------------------------------------------------
def recommend_reallocation(conn, supplier_id: int, component_id: int | None = None):
    """
    Given a supplier that's at risk of missing deadlines (optionally scoped
    to one component), find the best alternate supplier in the same category
    and propose a partial-order reallocation, quantifying the projected
    shortage-risk reduction and the incremental cost — mirroring the kind
    of sentence a procurement agent should be able to say out loud.
    """
    src = supplier_stats(conn, supplier_id)
    if src is None:
        return None

    sup_row = conn.execute("SELECT * FROM suppliers WHERE id=?", (supplier_id,)).fetchone()
    category = sup_row["category"]

    if component_id is not None:
        comp = conn.execute("SELECT * FROM components WHERE id=?", (component_id,)).fetchone()
    else:
        comp = conn.execute(
            """SELECT * FROM components WHERE primary_supplier_id=?
               ORDER BY avg_monthly_demand DESC LIMIT 1""",
            (supplier_id,),
        ).fetchone()

    candidates = conn.execute(
        """SELECT id FROM suppliers WHERE category=? AND id != ?
           ORDER BY on_time_rate DESC LIMIT 8""",
        (category, supplier_id),
    ).fetchall()

    best = None
    for c in candidates:
        stats = supplier_stats(conn, c["id"])
        if stats is None:
            continue
        if best is None or stats["risk_score"] < best["risk_score"]:
            best = stats

    if best is None or comp is None:
        return {
            "supplier_id": supplier_id,
            "supplier_name": src["name"],
            "message": f"{src['name']} has a {src['delay_probability']}% probability of missing "
                       f"the delivery deadline, but no lower-risk alternate supplier exists in "
                       f"the {category} category yet.",
            "source": src,
            "alternate": None,
        }

    # --- reallocation heuristic ---------------------------------------
    # shift enough volume so the blended delay probability drops meaningfully,
    # capped at 40% of the order to avoid over-concentrating with an unproven
    # alternate, and scaled by how much safer the alternate actually is.
    risk_gap = max(src["risk_score"] - best["risk_score"], 1.0)
    shift_pct = float(np.clip(risk_gap / 100 * 1.8, 0.1, 0.4))

    blended_delay_prob = (
        (1 - shift_pct) * src["delay_probability"] + shift_pct * best["delay_probability"]
    )
    shortage_risk_reduction_pct = float(
        np.clip((src["delay_probability"] - blended_delay_prob) / src["delay_probability"] * 100, 0, 95)
    )

    qty = comp["avg_monthly_demand"] if comp else 100
    shifted_units = qty * shift_pct
    price_delta_per_unit = best["avg_price"] - src["avg_price"]
    additional_cost = round(shifted_units * price_delta_per_unit, 2)

    message = (
        f"Supplier {src['name']} has a {src['delay_probability']}% probability of missing "
        f"the delivery deadline for {comp['name'] if comp else 'this order'}. "
        f"Switching {round(shift_pct * 100)}% of the order to {best['name']} reduces projected "
        f"shortage risk by {round(shortage_risk_reduction_pct)}% at an estimated additional cost "
        f"of ₹{additional_cost:,.0f}."
    )

    return {
        "supplier_id": supplier_id,
        "component_id": comp["id"] if comp else None,
        "component_name": comp["name"] if comp else None,
        "source": src,
        "alternate": best,
        "shift_pct": round(shift_pct * 100, 1),
        "shortage_risk_reduction_pct": round(shortage_risk_reduction_pct, 1),
        "additional_cost_inr": additional_cost,
        "shifted_units_per_month": round(shifted_units, 1),
        "message": message,
    }


# --------------------------------------------------------------------------
# Overview KPIs
# --------------------------------------------------------------------------
def overview_kpis(conn):
    n_components = conn.execute("SELECT COUNT(*) AS c FROM components").fetchone()["c"]
    n_suppliers = conn.execute("SELECT COUNT(*) AS c FROM suppliers").fetchone()["c"]
    n_purchases = conn.execute("SELECT COUNT(*) AS c FROM purchase_records").fetchone()["c"]

    delayed = conn.execute(
        "SELECT COUNT(*) AS c FROM purchase_records WHERE status='Delayed'"
    ).fetchone()["c"]

    spend = conn.execute(
        "SELECT SUM(unit_price * quantity) AS s FROM purchase_records"
    ).fetchone()["s"] or 0

    shortages = predicted_shortages(conn, limit=100_000)
    anomalies = price_anomalies(conn, limit=100_000)
    risky_suppliers = conn.execute(
        """SELECT COUNT(*) AS c FROM suppliers WHERE on_time_rate < 0.75"""
    ).fetchone()["c"]

    return {
        "components": n_components,
        "suppliers": n_suppliers,
        "purchase_records": n_purchases,
        "delayed_orders": delayed,
        "delayed_rate_pct": round(delayed / n_purchases * 100, 1) if n_purchases else 0,
        "total_spend_inr": round(spend, 0),
        "predicted_shortages": len(shortages),
        "price_anomalies": len(anomalies),
        "at_risk_suppliers": risky_suppliers,
    }


def category_breakdown(conn):
    rows = conn.execute(
        """SELECT category, COUNT(*) AS n, AVG(unit_cost) AS avg_cost
           FROM components GROUP BY category ORDER BY n DESC"""
    ).fetchall()
    return [
        {"category": r["category"], "components": r["n"], "avg_unit_cost": round(r["avg_cost"], 2)}
        for r in rows
    ]


def monthly_spend_trend(conn, months: int = 12):
    rows = conn.execute(
        """SELECT strftime('%Y-%m', order_date) AS ym,
                  SUM(unit_price * quantity) AS spend,
                  SUM(CASE WHEN status='Delayed' THEN 1 ELSE 0 END) AS delayed,
                  COUNT(*) AS total
           FROM purchase_records
           GROUP BY ym ORDER BY ym DESC LIMIT ?""",
        (months,),
    ).fetchall()
    data = [
        {
            "month": r["ym"],
            "spend": round(r["spend"], 0),
            "delayed_rate_pct": round(r["delayed"] / r["total"] * 100, 1) if r["total"] else 0,
        }
        for r in rows
    ]
    return list(reversed(data))
