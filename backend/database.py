"""
SQLite schema + connection helpers for the Procurement Optimizer.
Uses the stdlib sqlite3 driver directly (no ORM) to keep the footprint
small and the generated queries transparent for a hackathon build.
"""
import sqlite3
import os

DB_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DB_DIR, "supply_chain.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS suppliers (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    region          TEXT NOT NULL,
    category        TEXT NOT NULL,
    on_time_rate    REAL NOT NULL,      -- true underlying reliability (0-1)
    avg_lead_time_days INTEGER NOT NULL,
    quality_score   REAL NOT NULL,      -- 0-1
    price_volatility REAL NOT NULL,     -- 0-1
    active_since    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS components (
    id              INTEGER PRIMARY KEY,
    sku             TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    category        TEXT NOT NULL,
    unit_cost       REAL NOT NULL,
    criticality     TEXT NOT NULL,      -- Low / Medium / High / Critical
    current_stock   INTEGER NOT NULL,
    reorder_point   INTEGER NOT NULL,
    avg_monthly_demand REAL NOT NULL,
    trend           REAL NOT NULL,      -- monthly demand growth factor
    primary_supplier_id INTEGER NOT NULL,
    FOREIGN KEY (primary_supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS purchase_records (
    id              INTEGER PRIMARY KEY,
    component_id    INTEGER NOT NULL,
    supplier_id     INTEGER NOT NULL,
    order_date      TEXT NOT NULL,
    promised_date   TEXT NOT NULL,
    delivered_date  TEXT,
    quantity        INTEGER NOT NULL,
    unit_price      REAL NOT NULL,
    status          TEXT NOT NULL,      -- Delivered / Pending / Delayed
    delay_days      INTEGER NOT NULL,
    FOREIGN KEY (component_id) REFERENCES components(id),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE INDEX IF NOT EXISTS idx_pr_component ON purchase_records(component_id);
CREATE INDEX IF NOT EXISTS idx_pr_supplier ON purchase_records(supplier_id);
CREATE INDEX IF NOT EXISTS idx_comp_category ON components(category);
CREATE INDEX IF NOT EXISTS idx_sup_category ON suppliers(category);
"""


def get_connection():
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_schema():
    conn = get_connection()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def is_seeded() -> bool:
    if not os.path.exists(DB_PATH):
        return False
    conn = get_connection()
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM purchase_records").fetchone()
        return row["c"] > 0
    except sqlite3.OperationalError:
        return False
    finally:
        conn.close()
