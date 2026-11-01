"""
Generates a realistic-shaped synthetic dataset:
  - 500 suppliers
  - 10,000 components
  - 50,000 purchase records (order -> promise -> delivery)

The generation is vectorised with numpy and written with executemany,
so the full 60.5k rows land in a couple of seconds on a laptop.
Everything is seeded (RNG seed=42) so the dataset -- and therefore every
KPI on the dashboard -- is stable across restarts / demos.
"""
import sqlite3
import datetime as dt
import numpy as np

from database import get_connection, init_schema

RNG = np.random.default_rng(42)

CATEGORIES = [
    "Connectors", "Wires & Cables", "Terminals", "Relays", "Fasteners",
    "PCBs", "Sensors", "Housings & Enclosures", "Labels & Sleeves", "Switches",
]

REGIONS = [
    "North India", "South India", "West India", "East India",
    "China", "Vietnam", "South Korea", "Germany", "Mexico", "USA",
]

SUP_PREFIX = [
    "Orion", "Nova", "Apex", "Vertex", "Zenith", "Pinnacle", "Meridian", "Atlas",
    "Quantum", "Vector", "Helix", "Summit", "Falcon", "Titan", "Nimbus", "Lumen",
    "Catalyst", "Forge", "Beacon", "Cascade", "Ironclad", "Bright", "Steel", "Aegis",
    "Crest", "Delta", "Echo", "Fusion", "Granite", "Horizon",
]
SUP_SUFFIX = [
    "Components", "Electricals", "Industries", "Manufacturing", "Systems",
    "Wiring Solutions", "Harness Works", "Precision Parts", "Electronics",
    "Auto Components", "Enterprises", "Technologies", "Engineering Co",
]
SUP_LEGAL = ["Pvt Ltd", "Ltd", "Inc", "GmbH", "Co Ltd", ""]

COMP_DESCRIPTORS = {
    "Connectors": ["Pin Header", "Sealed Connector", "Blade Terminal Housing", "Multi-Pin Socket"],
    "Wires & Cables": ["Single-Core Wire", "Twisted Pair Cable", "Shielded Cable", "FLRY Wire"],
    "Terminals": ["Ring Terminal", "Female Terminal", "Male Terminal", "Splice Terminal"],
    "Relays": ["Micro Relay", "Power Relay", "Latching Relay", "PCB Relay"],
    "Fasteners": ["Nylon Clip", "Cable Tie Mount", "Push Rivet", "Harness Clamp"],
    "PCBs": ["Control PCB", "Sensor PCB", "Relay Board", "Interface Board"],
    "Sensors": ["Temp Sensor", "Current Sensor", "Proximity Sensor", "Pressure Sensor"],
    "Housings & Enclosures": ["Connector Housing", "Junction Box", "Splice Enclosure", "Grommet"],
    "Labels & Sleeves": ["Heat Shrink Sleeve", "ID Label", "Braided Sleeve", "Corrugated Tube"],
    "Switches": ["Toggle Switch", "Rocker Switch", "Membrane Switch", "Limit Switch"],
}

CRITICALITY_LEVELS = ["Low", "Medium", "High", "Critical"]
CRITICALITY_WEIGHTS = [0.35, 0.35, 0.20, 0.10]

BASE_UNIT_COST = {
    "Connectors": 18, "Wires & Cables": 9, "Terminals": 4, "Relays": 65,
    "Fasteners": 3, "PCBs": 140, "Sensors": 95, "Housings & Enclosures": 22,
    "Labels & Sleeves": 2, "Switches": 40,
}

N_SUPPLIERS = 500
N_COMPONENTS = 10_000
N_PURCHASE_RECORDS = 50_000

TODAY = dt.date(2026, 8, 9)
HISTORY_DAYS = 730  # 24 months of purchasing history


def _supplier_names(n):
    names = []
    used = set()
    for i in range(n):
        while True:
            pre = RNG.choice(SUP_PREFIX)
            suf = RNG.choice(SUP_SUFFIX)
            legal = RNG.choice(SUP_LEGAL)
            name = f"{pre} {suf}" + (f" {legal}" if legal else "")
            if name not in used:
                used.add(name)
                names.append(name)
                break
    return names


def generate_suppliers(conn):
    names = _supplier_names(N_SUPPLIERS)
    regions = RNG.choice(REGIONS, size=N_SUPPLIERS)
    categories = RNG.choice(CATEGORIES, size=N_SUPPLIERS)
    # underlying reliability: mostly good suppliers, a long tail of risky ones
    on_time = np.clip(RNG.beta(6, 2, size=N_SUPPLIERS), 0.35, 0.995)
    lead_time = RNG.integers(4, 55, size=N_SUPPLIERS)
    quality = np.clip(RNG.beta(7, 2, size=N_SUPPLIERS), 0.4, 1.0)
    volatility = np.clip(RNG.beta(2, 8, size=N_SUPPLIERS), 0.01, 0.6)
    active_since = RNG.integers(2004, 2025, size=N_SUPPLIERS)

    rows = [
        (
            i + 1, names[i], str(regions[i]), str(categories[i]),
            float(on_time[i]), int(lead_time[i]), float(quality[i]),
            float(volatility[i]), int(active_since[i]),
        )
        for i in range(N_SUPPLIERS)
    ]
    conn.executemany(
        """INSERT INTO suppliers
           (id, name, region, category, on_time_rate, avg_lead_time_days,
            quality_score, price_volatility, active_since)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    return rows


def generate_components(conn, supplier_rows):
    # index suppliers by category for quick primary-supplier assignment
    by_cat = {}
    for r in supplier_rows:
        by_cat.setdefault(r[3], []).append(r[0])  # category -> [supplier_id]

    categories = RNG.choice(CATEGORIES, size=N_COMPONENTS)
    criticality = RNG.choice(CRITICALITY_LEVELS, size=N_COMPONENTS, p=CRITICALITY_WEIGHTS)
    rows = []
    for i in range(N_COMPONENTS):
        cat = str(categories[i])
        desc = RNG.choice(COMP_DESCRIPTORS[cat])
        variant = RNG.integers(100, 999)
        sku = f"CMP-{i+1:06d}"
        name = f"{desc} {variant}"
        base_cost = BASE_UNIT_COST[cat]
        unit_cost = round(float(base_cost * RNG.uniform(0.6, 1.8)), 2)
        avg_monthly_demand = float(np.clip(RNG.gamma(2.0, 120), 5, 6000))
        trend = float(RNG.normal(1.0, 0.06))  # >1 growing demand, <1 shrinking
        current_stock = int(max(0, RNG.normal(avg_monthly_demand * RNG.uniform(0.4, 2.2), avg_monthly_demand * 0.3)))
        reorder_point = int(avg_monthly_demand * RNG.uniform(0.5, 1.1))
        primary_supplier_id = int(RNG.choice(by_cat[cat]))
        rows.append((
            i + 1, sku, name, cat, unit_cost, str(criticality[i]),
            current_stock, reorder_point, round(avg_monthly_demand, 1),
            round(trend, 4), primary_supplier_id,
        ))

    conn.executemany(
        """INSERT INTO components
           (id, sku, name, category, unit_cost, criticality, current_stock,
            reorder_point, avg_monthly_demand, trend, primary_supplier_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    return rows


def generate_purchase_records(conn, supplier_rows, component_rows):
    sup_by_id = {r[0]: r for r in supplier_rows}
    by_cat = {}
    for r in supplier_rows:
        by_cat.setdefault(r[3], []).append(r[0])

    comp_ids = np.array([r[0] for r in component_rows])
    comp_by_id = {r[0]: r for r in component_rows}

    chosen_components = RNG.choice(comp_ids, size=N_PURCHASE_RECORDS)
    order_offsets = RNG.integers(0, HISTORY_DAYS, size=N_PURCHASE_RECORDS)
    use_alt_supplier = RNG.random(N_PURCHASE_RECORDS) < 0.2

    rows = []
    for idx in range(N_PURCHASE_RECORDS):
        comp = comp_by_id[int(chosen_components[idx])]
        cat = comp[3]
        primary_sup = comp[10]
        if use_alt_supplier[idx] and len(by_cat[cat]) > 1:
            supplier_id = int(RNG.choice(by_cat[cat]))
        else:
            supplier_id = primary_sup
        sup = sup_by_id[supplier_id]
        on_time_rate, lead_time, volatility = sup[4], sup[5], sup[7]

        order_date = TODAY - dt.timedelta(days=int(order_offsets[idx]))
        promised_date = order_date + dt.timedelta(days=int(lead_time + RNG.integers(-2, 3)))

        # delay model: reliable suppliers rarely slip, risky ones slip often & further
        is_late = RNG.random() > on_time_rate
        if is_late:
            delay_days = int(RNG.gamma(2.0, 4.0 + (1 - on_time_rate) * 10))
        else:
            delay_days = int(max(0, RNG.normal(0, 0.6)))
        delivered_date = promised_date + dt.timedelta(days=delay_days)

        # future orders (delivered_date beyond "today") are still pending
        if delivered_date > TODAY:
            status = "Pending"
            delivered_str = None
            delay_days_eff = 0 if promised_date >= TODAY else (TODAY - promised_date).days
            if delay_days_eff > 0:
                status = "Delayed"
        else:
            delivered_str = delivered_date.isoformat()
            status = "Delayed" if delay_days > 0 else "Delivered"
            delay_days_eff = delay_days

        base_price = comp[4]
        # occasional price-shock anomaly (5% of records) layered on normal volatility
        noise = RNG.normal(0, volatility)
        if RNG.random() < 0.05:
            noise += RNG.choice([-1, 1]) * RNG.uniform(0.35, 0.9)
        unit_price = round(max(0.1, base_price * (1 + noise)), 2)

        quantity = int(max(1, RNG.gamma(2.0, 40)))

        rows.append((
            idx + 1, int(comp[0]), supplier_id, order_date.isoformat(),
            promised_date.isoformat(), delivered_str, quantity, unit_price,
            status, delay_days_eff,
        ))

    conn.executemany(
        """INSERT INTO purchase_records
           (id, component_id, supplier_id, order_date, promised_date,
            delivered_date, quantity, unit_price, status, delay_days)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )


def seed_database(force: bool = False):
    init_schema()
    conn = get_connection()
    try:
        count = conn.execute("SELECT COUNT(*) AS c FROM purchase_records").fetchone()["c"]
        if count > 0 and not force:
            print(f"Database already seeded ({count} purchase records). Skipping.")
            return
        print("Seeding database — this takes a few seconds...")
        conn.execute("DELETE FROM purchase_records")
        conn.execute("DELETE FROM components")
        conn.execute("DELETE FROM suppliers")
        supplier_rows = generate_suppliers(conn)
        component_rows = generate_components(conn, supplier_rows)
        generate_purchase_records(conn, supplier_rows, component_rows)
        conn.commit()
        print(f"Seeded {N_SUPPLIERS} suppliers, {N_COMPONENTS} components, "
              f"{N_PURCHASE_RECORDS} purchase records.")
    finally:
        conn.close()


if __name__ == "__main__":
    seed_database(force=True)
