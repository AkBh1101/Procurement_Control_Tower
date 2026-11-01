"use strict";
/* ==========================================================================
   Procurement Control Tower — frontend
   Hash-routed multi-view app (no framework, compiled with plain `tsc`).
   Every number comes from the FastAPI backend.
   ========================================================================== */
const API_BASE = location.protocol === "file:" ? "http://localhost:8000" : "";
/* ------------------------------------------------------------------ API */
const cache = new Map();
function api(path) {
    let p = cache.get(path);
    if (!p) {
        p = fetch(API_BASE + path).then((r) => {
            if (!r.ok)
                throw new Error(`${path} -> ${r.status}`);
            return r.json();
        });
        p.catch(() => cache.delete(path));
        cache.set(path, p);
    }
    return p;
}
async function postJSON(path, body) {
    const r = await fetch(API_BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!r.ok)
        throw new Error(`${path} -> ${r.status}`);
    return r.json();
}
const SHORT_URL = "/api/shortages?limit=300";
const SUP_URL = "/api/suppliers/risk?limit=40";
const ANOM_URL = "/api/price-anomalies?limit=100";
/* -------------------------------------------------------------- helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const inrCompact = (n) => n >= 1e7 ? `₹${(n / 1e7).toFixed(1)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : inr(n);
const num = (n) => Math.round(n).toLocaleString("en-IN");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function debounce(fn, ms) {
    let t;
    return (...a) => { window.clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
}
const level = (score) => (score >= 70 ? "high" : score >= 45 ? "med" : "low");
const meter = (v, cls) => `<div class="meter"><span class="${cls ?? level(v)}" style="--w:${Math.min(100, Math.max(0, v))}%"></span></div>`;
const critBadge = (l) => `<span class="badge b-${esc(l.toLowerCase())}">${esc(l)}</span>`;
function monthLabel(ym) {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short" }) + " " + String(y).slice(2);
}
function nextMonths(lastYm, n) {
    const now = new Date();
    let [y, m] = lastYm ? lastYm.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];
    const out = [];
    for (let i = 0; i < n; i++) {
        m++;
        if (m > 12) {
            m = 1;
            y++;
        }
        out.push(`${y}-${String(m).padStart(2, "0")}`);
    }
    return out;
}
function countUp(el, to, fmt) {
    const start = performance.now(), dur = 1100;
    const tick = (now) => {
        const p = Math.min(1, (now - start) / dur);
        el.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
        if (p < 1)
            requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}
const errorState = () => `<div class="state"><b>Couldn't reach the API</b><br>Start the backend with <code>uvicorn main:app --port 8000</code> and refresh.</div>`;
const skRows = (n, h = 44) => Array.from({ length: n }, () => `<div class="sk" style="height:${h}px;margin:8px 12px"></div>`).join("");
function setStatus(ok) {
    const s = $("#status");
    s.classList.toggle("ok", ok);
    s.classList.toggle("bad", !ok);
    $("#status-t").textContent = ok ? "API online" : "Backend offline";
}
/* ---------------------------------------------------------------- charts */
const charts = {};
const PALETTE = ["#3B3FD8", "#1FB58F", "#E8590C", "#8B5CF6", "#E5484D", "#6C8CFF", "#5FD3B3", "#FFB020", "#9AA3D6", "#1B1D5E"];
function setupChartDefaults() {
    if (typeof Chart === "undefined")
        return;
    const d = Chart.defaults;
    d.font.family = "'Inter', sans-serif";
    d.font.size = 12;
    d.color = "#4D5285";
    d.borderColor = "#D3D8FA";
    d.animation.duration = 900;
    d.plugins.legend.labels.usePointStyle = true;
    d.plugins.legend.labels.boxWidth = 8;
    d.plugins.tooltip.backgroundColor = "#1B1D5E";
    d.plugins.tooltip.padding = 10;
    d.plugins.tooltip.cornerRadius = 8;
    d.plugins.tooltip.titleFont = { weight: "600" };
}
function mk(id, cfg) {
    if (typeof Chart === "undefined")
        return;
    const el = document.getElementById(id);
    if (!el)
        return;
    charts[id]?.destroy();
    charts[id] = new Chart(el.getContext("2d"), cfg);
}
async function drawSpend(canvasId, months) {
    const rows = await api(`/api/spend-trend?months=${months}`);
    mk(canvasId, {
        type: "bar",
        data: {
            labels: rows.map((r) => monthLabel(r.month)),
            datasets: [
                { type: "bar", label: "Spend (₹ lakh)", data: rows.map((r) => +(r.spend / 1e5).toFixed(1)), backgroundColor: "#A9B4FF", hoverBackgroundColor: "#3B3FD8", borderRadius: 6, yAxisID: "y" },
                { type: "line", label: "Delayed orders %", data: rows.map((r) => r.delayed_rate_pct), borderColor: "#E8590C", backgroundColor: "#E8590C", tension: 0.35, pointRadius: 3, yAxisID: "y1" },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true, position: "left" },
                y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (v) => v + "%" } },
            },
        },
    });
    return rows;
}
/* --------------------------------------------------------- global events */
document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("a, button, select, input"))
        return;
    const row = t.closest("[data-href]");
    if (row) {
        location.hash = row.dataset.href;
        return;
    }
    const dr = t.closest("[data-drawer]");
    if (dr)
        openSupplierDrawer(Number(dr.dataset.drawer));
});
/* --------------------------------------------------------------- drawer */
function closeDrawer() {
    $("#drawer").classList.remove("on");
    $("#scrim").classList.remove("on");
    $("#drawer").setAttribute("aria-hidden", "true");
}
async function openSupplierDrawer(id) {
    const list = await api(SUP_URL).catch(() => []);
    const s = list.find((x) => x.supplier_id === id);
    if (!s)
        return;
    const color = s.risk_score >= 70 ? "var(--red)" : s.risk_score >= 45 ? "#FFB020" : "var(--teal)";
    const m = (label, v, cls) => `<div><span>${label}<b>${v.toFixed(1)}%</b></span>${meter(v, cls)}</div>`;
    const d = $("#drawer");
    d.innerHTML = `
    <div class="dr-h">
      <div><h3>${esc(s.name)}</h3><p>${esc(s.region)} · ${esc(s.category)}</p></div>
      <button class="dr-x" id="dr-close" aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button>
    </div>
    <div class="dr-b">
      <div class="dr-top">
        <div class="ring" style="--v:${s.risk_score};--c:${color}"><i>${s.risk_score.toFixed(0)}</i></div>
        <div><b style="font-family:var(--display);font-size:16px">Composite risk score</b><p style="margin:4px 0 0;color:var(--muted);font-size:13px">Delay probability, quality, price volatility and average delay combined.</p></div>
      </div>
      <div class="mlist">
        ${m("Delay probability", s.delay_probability, "high")}
        ${m("Quality score", s.quality_score, "low")}
        ${m("Price volatility", s.price_volatility, "med")}
        ${m("Historical on-time rate", s.on_time_rate_baseline, "brand")}
      </div>
      <div class="facts">
        <div class="fact"><b>${num(s.orders_total)}</b><span>Orders analysed</span></div>
        <div class="fact"><b>${s.avg_delay_days.toFixed(1)} d</b><span>Avg delay</span></div>
        <div class="fact"><b>${s.lead_time_days} d</b><span>Lead time</span></div>
        <div class="fact"><b>${inr(s.avg_price)}</b><span>Avg unit price</span></div>
      </div>
      <a class="btn btn-p" href="#/optimizer/${s.supplier_id}" id="dr-go"><svg class="i"><use href="#i-spark"/></svg>Find a safer alternate</a>
    </div>`;
    d.classList.add("on");
    $("#scrim").classList.add("on");
    d.setAttribute("aria-hidden", "false");
    $("#dr-close").addEventListener("click", closeDrawer);
    $("#dr-go").addEventListener("click", closeDrawer);
}
/* ----------------------------------------------------------- search box */
function bindSearch(input, list, onPick) {
    let hits = [];
    let hl = -1;
    const close = () => { list.classList.remove("open"); hl = -1; };
    const paint = () => $$(".it", list).forEach((el, i) => el.classList.toggle("hl", i === hl));
    const run = debounce(async () => {
        const q = input.value.trim();
        if (q.length < 2)
            return close();
        try {
            hits = await api(`/api/components/search?q=${encodeURIComponent(q)}&limit=8`);
            list.innerHTML = hits.length
                ? hits.map((h, i) => `<div class="it" data-i="${i}"><b>${esc(h.name)}</b><span>${esc(h.sku)} · ${esc(h.category)} · ${esc(h.criticality)}</span></div>`).join("")
                : `<div class="none">No components match “${esc(q)}”.</div>`;
            list.classList.add("open");
        }
        catch {
            close();
        }
    }, 250);
    input.addEventListener("input", run);
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
            hl = Math.min(hits.length - 1, hl + 1);
            paint();
            e.preventDefault();
        }
        else if (e.key === "ArrowUp") {
            hl = Math.max(0, hl - 1);
            paint();
            e.preventDefault();
        }
        else if (e.key === "Enter" && hl >= 0 && hits[hl]) {
            pick(hits[hl]);
        }
        else if (e.key === "Escape") {
            close();
            input.blur();
        }
    });
    list.addEventListener("click", (e) => {
        const it = e.target.closest(".it");
        if (it)
            pick(hits[Number(it.dataset.i)]);
    });
    document.addEventListener("click", (e) => { if (!list.contains(e.target) && e.target !== input)
        close(); });
    function pick(h) { close(); input.value = h.name; onPick(h.id, h.name); }
}
const VIEWS = {
    home: { title: "Home", init: initHome },
    procurement: { title: "Overview", init: initProcurement },
    overview: { title: "Network health", init: initOverview },
    optimizer: { title: "AI Optimizer", init: initOptimizer, enter: enterOptimizer },
    demand: { title: "Demand forecast", init: initDemand, enter: enterDemand },
    shortages: { title: "Shortages", init: initShortages },
    suppliers: { title: "Suppliers", init: initSuppliers },
    anomalies: { title: "Price anomalies", init: initAnomalies },
    analytics: { title: "Analytics", init: initAnalytics },
};
async function route() {
    closeDrawer();
    const raw = location.hash.replace(/^#\/?/, "");
    const [n, p1, p2] = raw.split("/");
    const name = VIEWS[n] ? n : "home";
    const def = VIEWS[name];
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
    $("#crumb").textContent = def.title;
    document.title = `${def.title} · Procurement Control Tower`;
    window.scrollTo({ top: 0 });
    const view = $(`#view-${name}`);
    $$(".rise, .kpi", view).forEach((el, i) => el.style.setProperty("--i", String(Math.min(i, 8))));
    if (!def.ready) {
        def.ready = true;
        try {
            await def.init?.();
        }
        catch (e) {
            console.error(e);
        }
    }
    try {
        await def.enter?.(p1, p2);
    }
    catch (e) {
        console.error(e);
    }
}
/* ---------------------------------------------------------------- HOME */
async function initHome() {
    const hero = $("#hero"), sc = $("#scene-in");
    hero.addEventListener("pointermove", (e) => {
        const r = hero.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        sc.style.setProperty("--ry", (x * 16).toFixed(1) + "deg");
        sc.style.setProperty("--rx", (6 - y * 12).toFixed(1) + "deg");
    });
    hero.addEventListener("pointerleave", () => { sc.style.removeProperty("--ry"); sc.style.removeProperty("--rx"); });
    try {
        const o = await api("/api/overview");
        setStatus(true);
        countUp($("#h-comp"), o.components, num);
        countUp($("#h-sup"), o.suppliers, num);
        countUp($("#h-late"), o.delayed_rate_pct, (v) => v.toFixed(1) + "%");
        countUp($('[data-h="spend"]'), o.total_spend_inr, inrCompact);
        countUp($('[data-h="short"]'), o.predicted_shortages, num);
        countUp($('[data-h="risk"]'), o.at_risk_suppliers, num);
    }
    catch {
        setStatus(false);
    }
}
/* 3D hover tilt for cards */
function initTilt() {
    const sel = ".kpi, .tile";
    document.addEventListener("pointermove", (e) => {
        const el = e.target.closest(sel);
        if (!el)
            return;
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(800px) rotateX(${(-y * 9).toFixed(2)}deg) rotateY(${(x * 11).toFixed(2)}deg) translateY(-3px)`;
    });
    document.addEventListener("pointerout", (e) => {
        const el = e.target.closest(sel);
        if (el)
            el.style.transform = "";
    });
}
/* --------------------------------------------------------- OVERVIEW (buying cycle) */
async function initProcurement() {
    const cyc = $("#p-cycle");
    cyc.innerHTML = Array.from({ length: 5 }, () => `<div class="sk" style="height:150px;border-radius:0"></div>`).join("");
    $("#p-short").innerHTML = skRows(5);
    $("#p-sup").innerHTML = skRows(3);
    $("#p-flags").innerHTML = skRows(3, 36);
    api("/api/overview").then((o) => {
        setStatus(true);
        const pct = (a, b) => Math.min(100, Math.max(0, (a / Math.max(b, 1)) * 100));
        const steps = [
            { href: "#/demand", ic: "i-trend", tone: "", label: "Plan demand", to: o.components, fmt: num, note: `components forecast · ${(100 - pct(o.predicted_shortages, o.components)).toFixed(0)}% not at shortage risk`, bar: 100 - pct(o.predicted_shortages, o.components) },
            { href: "#/suppliers", ic: "i-truck", tone: o.at_risk_suppliers ? "warn" : "", label: "Source suppliers", to: o.at_risk_suppliers, fmt: num, note: `at risk of ${num(o.suppliers)} active suppliers`, bar: pct(o.at_risk_suppliers, o.suppliers) },
            { href: "#/anomalies", ic: "i-cart", tone: o.price_anomalies ? "warn" : "", label: "Place orders", to: o.total_spend_inr, fmt: inrCompact, note: `spend · ${num(o.price_anomalies)} prices outside the normal range`, bar: pct(o.price_anomalies, o.purchase_records) * 10 },
            { href: "#/analytics", ic: "i-clock", tone: o.delayed_rate_pct > 20 ? "bad" : o.delayed_rate_pct > 10 ? "warn" : "", label: "Receive deliveries", to: o.delayed_rate_pct, fmt: (v) => v.toFixed(1) + "%", note: `${num(o.delayed_orders)} of ${num(o.purchase_records)} orders arrived late`, bar: o.delayed_rate_pct },
            { href: "#/shortages", ic: "i-box", tone: o.predicted_shortages ? "bad" : "", label: "Replenish stock", to: o.predicted_shortages, fmt: num, note: `components predicted to run short`, bar: pct(o.predicted_shortages, o.components) },
        ];
        cyc.innerHTML = steps.map((c, i) => `
      <a class="step ${c.tone}" href="${c.href}">
        <span class="s-ic"><svg class="i"><use href="#${c.ic}"/></svg></span>
        <span class="s-n">${c.label}</span>
        <span class="s-v" data-p="${i}">0</span>
        <span class="s-d">${c.note}</span>
        <div class="s-bar"><span style="--w:${Math.min(100, c.bar).toFixed(0)}%"></span></div>
      </a>`).join("");
        steps.forEach((c, i) => countUp($(`[data-p="${i}"]`), c.to, c.fmt));
        const nav = $("#nav-short");
        nav.textContent = o.predicted_shortages > 999 ? Math.floor(o.predicted_shortages / 1000) + "k+" : String(o.predicted_shortages);
        nav.classList.add("on");
        for (const [id, v] of [["sc-sup", o.suppliers], ["sc-comp", o.components], ["sc-rec", o.purchase_records]])
            $("#" + id).textContent = num(v);
    }).catch(() => { setStatus(false); cyc.innerHTML = errorState(); });
    api(SHORT_URL).then((rows) => {
        const top = [...rows].sort((a, b) => b.shortage_risk - a.shortage_risk).slice(0, 6);
        $("#p-short").innerHTML = top.map((r) => `
      <div class="q-row li" data-href="#/demand/${r.component_id}">
        <div class="li-main"><b>${esc(r.name)}</b><span>${esc(r.sku)} · ${esc(r.criticality)} · ${esc(r.primary_supplier)}</span></div>
        <div class="li-r q-risk">${meter(r.shortage_risk)}<span class="mono">${r.shortage_risk.toFixed(0)}</span></div>
        <a class="btn btn-sm" href="#/optimizer/${r.supplier_id}/${r.component_id}">Optimize</a>
      </div>`).join("") || `<div class="q-empty">Nothing needs reordering right now.</div>`;
    }).catch(() => { $("#p-short").innerHTML = errorState(); });
    api(SUP_URL).then((rows) => {
        $("#p-sup").innerHTML = rows.slice(0, 4).map((s) => `
      <div class="li" data-href="#/optimizer/${s.supplier_id}">
        <div class="li-main"><b>${esc(s.name)}</b><span>${esc(s.region)} · ${s.delay_probability.toFixed(0)}% delay probability</span></div>
        <div class="li-r">${meter(s.risk_score)}<span class="mono">${s.risk_score.toFixed(0)}</span></div>
      </div>`).join("");
    }).catch(() => { $("#p-sup").innerHTML = errorState(); });
    api(ANOM_URL).then((rows) => {
        $("#p-flags").innerHTML = rows.slice(0, 4).map((a) => `
      <div class="flag" data-href="#/demand/${a.component_id}">
        <div class="li-main"><b>${esc(a.name)}</b><span>${esc(a.supplier_name)}</span></div>
        <span class="${a.deviation_pct >= 0 ? "pos" : "neg"}">${a.deviation_pct >= 0 ? "+" : ""}${a.deviation_pct.toFixed(0)}%</span>
      </div>`).join("") || `<div class="q-empty">No unusual prices.</div>`;
    }).catch(() => { $("#p-flags").innerHTML = errorState(); });
}
/* ------------------------------------------------------------- OVERVIEW */
async function initOverview() {
    $("#ov-suppliers").innerHTML = skRows(5);
    $("#ov-shortages").innerHTML = skRows(5);
    $("#kpi-grid").innerHTML = Array.from({ length: 6 }, () => `<div class="sk" style="height:92px;border-radius:14px"></div>`).join("");
    // KPIs
    api("/api/overview").then((o) => {
        setStatus(true);
        const cards = [
            { ic: "i-dollar", tone: "brand", label: "Total spend", to: o.total_spend_inr, fmt: inrCompact, note: "Across all purchase records" },
            { ic: "i-clock", tone: "amber", label: "Delayed orders", to: o.delayed_rate_pct, fmt: (v) => v.toFixed(1) + "%", note: `${num(o.delayed_orders)} of ${num(o.purchase_records)} orders` },
            { ic: "i-box", tone: "red", label: "Predicted shortages", to: o.predicted_shortages, fmt: num, note: `Of ${num(o.components)} components` },
            { ic: "i-truck", tone: "amber", label: "At-risk suppliers", to: o.at_risk_suppliers, fmt: num, note: `Of ${num(o.suppliers)} suppliers` },
            { ic: "i-tag", tone: "teal", label: "Price anomalies", to: o.price_anomalies, fmt: num, note: "Beyond 2σ of component history" },
            { ic: "i-layers", tone: "brand", label: "Components tracked", to: o.components, fmt: num, note: `${num(o.purchase_records)} purchase records` },
        ];
        $("#kpi-grid").innerHTML = cards.map((c, i) => `
      <div class="kpi" style="--i:${i}">
        <div class="ic ${c.tone}"><svg class="i"><use href="#${c.ic}"/></svg></div>
        <div><div class="v" data-k="${i}">0</div><div class="l">${c.label}</div><div class="n">${c.note}</div></div>
      </div>`).join("");
        cards.forEach((c, i) => countUp($(`[data-k="${i}"]`), c.to, c.fmt));
        $("#net-s").textContent = num(o.suppliers);
        $("#net-c").textContent = num(o.components);
        $("#net-o").textContent = num(o.purchase_records);
        $("#sc-sup").textContent = num(o.suppliers);
        $("#sc-comp").textContent = num(o.components);
        $("#sc-rec").textContent = num(o.purchase_records);
        const nav = $("#nav-short");
        nav.textContent = o.predicted_shortages > 999 ? Math.floor(o.predicted_shortages / 1000) + "k+" : String(o.predicted_shortages);
        nav.classList.add("on");
    }).catch(() => { setStatus(false); $("#kpi-grid").innerHTML = errorState(); });
    // spend trend
    drawSpend("ch-trend", 12).catch(() => { $("#ch-trend").parentElement.innerHTML = errorState(); });
    // top suppliers
    api(SUP_URL).then((rows) => {
        $("#ov-suppliers").innerHTML = rows.slice(0, 5).map((s) => `
      <div class="li" data-href="#/optimizer/${s.supplier_id}">
        <div class="li-main"><b>${esc(s.name)}</b><span>${esc(s.region)} · ${esc(s.category)}</span></div>
        <div class="li-r">${meter(s.risk_score)}<span class="mono">${s.risk_score.toFixed(0)}</span></div>
      </div>`).join("");
    }).catch(() => { $("#ov-suppliers").innerHTML = errorState(); });
    // top shortages
    api(SHORT_URL).then((rows) => {
        const top = [...rows].sort((a, b) => b.shortage_risk - a.shortage_risk).slice(0, 5);
        $("#ov-shortages").innerHTML = top.map((r) => `
      <div class="li" data-href="#/demand/${r.component_id}">
        <div class="li-main"><b>${esc(r.name)}</b><span>${esc(r.sku)} · ${esc(r.criticality)}</span></div>
        <div class="li-r">${meter(r.shortage_risk)}<span class="mono">${r.shortage_risk.toFixed(0)}</span></div>
      </div>`).join("");
    }).catch(() => { $("#ov-shortages").innerHTML = errorState(); });
}
const runs = [];
let runToken = 0;
async function initOptimizer() {
    const sel = $("#opt-select");
    try {
        const [sups, sugg] = await Promise.all([
            api(SUP_URL),
            api("/api/agent/suggestions?limit=6"),
        ]);
        sel.innerHTML = sups.map((s) => `<option value="${s.supplier_id}">${esc(s.name)} — risk ${s.risk_score.toFixed(0)}</option>`).join("");
        $("#opt-quick").innerHTML = sugg.map((g) => `<button class="chip" data-sid="${g.supplier_id}" data-cid="${g.component_id ?? ""}"><i></i>${esc(g.supplier_name)} · ${g.risk_score.toFixed(0)}</button>`).join("");
        $$("#opt-quick .chip").forEach((c) => c.addEventListener("click", () => {
            const sid = Number(c.dataset.sid);
            sel.value = String(sid);
            runOptimizer(sid, c.dataset.cid ? Number(c.dataset.cid) : null);
        }));
    }
    catch {
        sel.innerHTML = `<option>Backend unavailable</option>`;
        $("#opt-quick").innerHTML = errorState();
    }
    $("#opt-run").addEventListener("click", () => {
        const id = Number(sel.value);
        if (id)
            runOptimizer(id, null);
    });
}
async function enterOptimizer(p1, p2) {
    if (!p1)
        return;
    const sid = Number(p1);
    if (!sid)
        return;
    const sel = $("#opt-select");
    if (!Array.from(sel.options).some((o) => o.value === String(sid))) {
        try {
            const s = await api(`/api/suppliers/${sid}`);
            sel.insertAdjacentHTML("afterbegin", `<option value="${sid}">${esc(s.name)} — risk ${s.risk_score.toFixed(0)}</option>`);
        }
        catch { /* ignore */ }
    }
    sel.value = String(sid);
    runOptimizer(sid, p2 ? Number(p2) : null);
}
async function runOptimizer(supplierId, componentId) {
    const token = ++runToken;
    const stage = $("#opt-stage");
    const labels = ["Reading delivery history", "Scoring alternate suppliers", "Optimizing the order split"];
    stage.innerHTML = `<div class="run"><h3>Analyzing supplier…</h3><ul class="steps">${labels.map((l) => `<li><span class="dot"></span>${l}</li>`).join("")}</ul></div>`;
    const items = $$("li", stage);
    const req = postJSON("/api/agent/recommend", { supplier_id: supplierId, component_id: componentId }).catch(() => null);
    for (const li of items) {
        li.classList.add("run-on");
        await sleep(420);
        if (token !== runToken)
            return;
        li.classList.remove("run-on");
        li.classList.add("done");
    }
    const rec = await req;
    if (token !== runToken)
        return;
    if (!rec) {
        stage.innerHTML = errorState();
        return;
    }
    renderRecommendation(rec);
}
function cmpRow(label, a, b, lowerBetter, f) {
    const bBetter = lowerBetter ? b < a : b > a;
    const aBetter = lowerBetter ? a < b : a > b;
    return `<tr><td>${label}</td><td class="${aBetter ? "better" : ""}">${f(a)}</td><td class="${bBetter ? "better" : ""}">${f(b)}</td></tr>`;
}
function renderRecommendation(rec) {
    const stage = $("#opt-stage");
    const s = rec.source, a = rec.alternate;
    if (!a || rec.shift_pct === undefined) {
        stage.innerHTML = `<div class="callout">${esc(rec.message)}</div>`;
        return;
    }
    const cost = rec.additional_cost_inr ?? 0;
    const costPhrase = cost >= 0
        ? `an estimated additional cost of <b class="hl-num">${inr(cost)}</b> per month`
        : `an estimated saving of <b class="hl-good">${inr(-cost)}</b> per month`;
    const comp = rec.component_name ? esc(rec.component_name) : "this order";
    stage.innerHTML = `
    <div class="callout">
      <b>${esc(s.name)}</b> has a <b class="hl-bad">${s.delay_probability}%</b> probability of missing the delivery deadline for ${comp}.
      Switching <b class="hl-num">${rec.shift_pct}%</b> of the order to <b class="hl-good">${esc(a.name)}</b>
      reduces projected shortage risk by <b class="hl-good">${rec.shortage_risk_reduction_pct}%</b> at ${costPhrase}.
    </div>
    <div class="mets">
      <div class="met"><div class="v">${rec.shift_pct}%</div><div class="l">Order shifted to alternate</div></div>
      <div class="met"><div class="v" style="color:var(--teal-d)">−${rec.shortage_risk_reduction_pct}%</div><div class="l">Projected shortage risk</div></div>
      <div class="met"><div class="v">${cost >= 0 ? "+" : "−"}${inr(Math.abs(cost))}</div><div class="l">Monthly cost impact</div></div>
    </div>
    <div class="res-grid">
      <div>
        <h4>Current vs recommended</h4>
        <table class="cmp">
          <thead><tr><th></th><th>Current</th><th>Alternate</th></tr></thead>
          <tbody>
            <tr><td>Supplier</td><td>${esc(s.name)}</td><td>${esc(a.name)}</td></tr>
            <tr><td>Region</td><td>${esc(s.region)}</td><td>${esc(a.region)}</td></tr>
            ${cmpRow("Delay probability", s.delay_probability, a.delay_probability, true, (v) => v.toFixed(1) + "%")}
            ${cmpRow("Risk score", s.risk_score, a.risk_score, true, (v) => v.toFixed(0))}
            ${cmpRow("Avg unit price", s.avg_price, a.avg_price, true, inr)}
            ${cmpRow("Lead time", s.lead_time_days, a.lead_time_days, true, (v) => v + " d")}
            ${cmpRow("Quality", s.quality_score, a.quality_score, false, (v) => v.toFixed(1) + "%")}
          </tbody>
        </table>
      </div>
      <div>
        <h4>Recommended allocation</h4>
        <div class="chart sm tall-sm"><canvas id="ch-split"></canvas></div>
        <h4 style="margin-top:14px">Risk comparison</h4>
        <div class="chart sm"><canvas id="ch-cmp"></canvas></div>
      </div>
    </div>`;
    mk("ch-split", {
        type: "doughnut",
        data: { labels: ["Current supplier", "Alternate supplier"], datasets: [{ data: [100 - rec.shift_pct, rec.shift_pct], backgroundColor: ["#C5CBFF", "#1FB58F"], borderColor: "#F6F7FF", borderWidth: 3 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: "64%", plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => ` ${c.parsed}%` } } } },
    });
    mk("ch-cmp", {
        type: "bar",
        data: {
            labels: ["Delay probability %", "Risk score"],
            datasets: [
                { label: "Current", data: [s.delay_probability, s.risk_score], backgroundColor: "#FFB020", borderRadius: 6 },
                { label: "Alternate", data: [a.delay_probability, a.risk_score], backgroundColor: "#1FB58F", borderRadius: 6 },
            ],
        },
        options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, scales: { x: { beginAtZero: true, max: 100 }, y: { grid: { display: false } } } },
    });
    runs.unshift({ sid: s.supplier_id, cid: rec.component_id, name: s.name, shift: rec.shift_pct, red: rec.shortage_risk_reduction_pct ?? 0 });
    if (runs.length > 5)
        runs.pop();
    $("#opt-recent").innerHTML = runs.map((r, i) => `
    <div class="li" data-run="${i}">
      <div class="li-main"><b>${esc(r.name)}</b><span>Shift ${r.shift}% · risk −${r.red}%</span></div>
      <svg class="i" style="color:var(--brand)"><use href="#i-arrow"/></svg>
    </div>`).join("");
    $$("#opt-recent .li").forEach((el) => el.addEventListener("click", () => {
        const r = runs[Number(el.dataset.run)];
        if (r) {
            $("#opt-select").value = String(r.sid);
            runOptimizer(r.sid, r.cid);
        }
    }));
}
/* --------------------------------------------------------------- DEMAND */
let dmHorizon = 6;
let dmCurrent = null;
async function initDemand() {
    bindSearch($("#dm-search"), $("#dm-suggest"), (id) => { location.hash = `#/demand/${id}`; });
    $$("#dm-horizon button").forEach((b) => b.addEventListener("click", () => {
        $$("#dm-horizon button").forEach((x) => x.classList.toggle("on", x === b));
        dmHorizon = Number(b.dataset.v);
        if (dmCurrent)
            loadForecast(dmCurrent);
    }));
    try {
        const rows = await api(SHORT_URL);
        const top = [...rows].sort((a, b) => b.shortage_risk - a.shortage_risk).slice(0, 6);
        $("#dm-quick").innerHTML = `<span class="muted-s">Flagged:</span>` + top.map((r) => `<button class="chip" data-id="${r.component_id}"><i></i>${esc(r.sku)}</button>`).join("");
        $$("#dm-quick .chip").forEach((c) => c.addEventListener("click", () => { location.hash = `#/demand/${c.dataset.id}`; }));
    }
    catch { /* quick picks are optional */ }
}
async function enterDemand(p1) {
    let id = p1 ? Number(p1) : dmCurrent;
    if (!id) {
        try {
            const rows = await api(SHORT_URL);
            id = [...rows].sort((a, b) => b.shortage_risk - a.shortage_risk)[0]?.component_id ?? null;
        }
        catch {
            id = null;
        }
    }
    if (id)
        await loadForecast(id);
}
async function loadForecast(id) {
    dmCurrent = id;
    $("#dm-detail").innerHTML = `<div class="dd">${skRows(5, 30)}</div>`;
    try {
        const f = await api(`/api/demand-forecast/${id}?months=${dmHorizon}`);
        if (dmCurrent !== id)
            return;
        $("#dm-title").textContent = f.name;
        $("#dm-sku").textContent = f.sku;
        drawForecast(f);
        drawForecastDetail(f);
    }
    catch {
        $("#dm-detail").innerHTML = errorState();
    }
}
function drawForecast(f) {
    const hist = f.history;
    const last = hist.length ? hist[hist.length - 1] : null;
    const future = nextMonths(last ? last.month : null, f.forecast.length);
    const labels = [...hist.map((h) => monthLabel(h.month)), ...future.map(monthLabel)];
    const historySeries = [...hist.map((h) => h.quantity), ...f.forecast.map(() => null)];
    const forecastSeries = [...hist.slice(0, -1).map(() => null), ...(last ? [last.quantity] : []), ...f.forecast];
    mk("ch-demand", {
        type: "line",
        data: {
            labels,
            datasets: [
                { label: "Ordered quantity", data: historySeries, borderColor: "#3B3FD8", backgroundColor: "rgba(59,63,216,.12)", fill: true, tension: 0.35, pointRadius: 3, pointBackgroundColor: "#F6F7FF", pointBorderWidth: 2 },
                { label: "Forecast", data: forecastSeries, borderColor: "#E8590C", borderDash: [6, 5], tension: 0.35, pointRadius: 3, pointBackgroundColor: "#F6F7FF", pointBorderWidth: 2 },
            ],
        },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } },
    });
}
async function drawForecastDetail(f) {
    const next = f.forecast[0] ?? 0;
    const covers = f.current_stock >= next;
    const below = f.current_stock < f.reorder_point;
    const maxF = Math.max(...f.forecast, 1);
    $("#dm-detail").innerHTML = `
    <div class="dd">
      <div class="sku">${esc(f.sku)}</div>
      <h3>${esc(f.name)}</h3>
      <span class="badge ${covers && !below ? "b-good" : "b-critical"}">${below ? "Below reorder point" : covers ? "Covers next month" : "Short next month"}</span>
      <div class="row"><span>Current stock</span><b>${num(f.current_stock)} units</b></div>
      ${meter(Math.min(100, (f.current_stock / Math.max(f.reorder_point * 2, 1)) * 100), below ? "high" : "low")}
      <div class="row"><span>Reorder point</span><b>${num(f.reorder_point)} units</b></div>
      <div class="row" style="margin-top:20px"><span>Forecast demand</span><b>next ${f.forecast_months} months</b></div>
      <div class="fc-list">
        ${f.forecast.map((v, i) => `<div><span>+${i + 1} mo</span>${meter((v / maxF) * 100, "brand")}<b>${num(v)}</b></div>`).join("")}
      </div>
      <div id="dm-sup"></div>
    </div>`;
    try {
        const rows = await api(SHORT_URL);
        const hit = rows.find((r) => r.component_id === f.component_id);
        if (hit && dmCurrent === f.component_id) {
            $("#dm-sup").innerHTML = `
        <div class="row"><span>Primary supplier</span><b>${esc(hit.primary_supplier)}</b></div>
        <a class="btn btn-p block" href="#/optimizer/${hit.supplier_id}/${hit.component_id}"><svg class="i"><use href="#i-spark"/></svg>Optimize this supplier</a>`;
        }
    }
    catch { /* optional */ }
}
/* ------------------------------------------------------------ SHORTAGES */
let shAll = [];
let shFilter = "all";
let shShown = 25;
async function initShortages() {
    $("#sh-body").innerHTML = `<tr><td colspan="8">${skRows(6)}</td></tr>`;
    try {
        shAll = await api(SHORT_URL);
    }
    catch {
        $("#sh-body").innerHTML = `<tr><td colspan="8">${errorState()}</td></tr>`;
        return;
    }
    const count = (l) => shAll.filter((r) => r.criticality.toLowerCase() === l).length;
    const opts = [["all", `All (${shAll.length})`], ["critical", `Critical (${count("critical")})`], ["high", `High (${count("high")})`], ["medium", `Medium (${count("medium")})`], ["low", `Low (${count("low")})`]];
    const seg = $("#sh-filter");
    seg.innerHTML = opts.map(([v, l]) => `<button data-v="${v}" class="${v === "all" ? "on" : ""}">${l}</button>`).join("");
    $$("button", seg).forEach((b) => b.addEventListener("click", () => {
        $$("button", seg).forEach((x) => x.classList.toggle("on", x === b));
        shFilter = b.dataset.v;
        shShown = 25;
        renderShortages();
    }));
    $("#sh-more").addEventListener("click", () => { shShown += 25; renderShortages(); });
    renderShortages();
}
function renderShortages() {
    const rows = shAll.filter((r) => shFilter === "all" || r.criticality.toLowerCase() === shFilter);
    $("#sh-body").innerHTML = rows.slice(0, shShown).map((r) => `
    <tr data-href="#/demand/${r.component_id}">
      <td><b>${esc(r.name)}</b><span class="mono">${esc(r.sku)}</span></td>
      <td>${esc(r.category)}</td>
      <td>${critBadge(r.criticality)}</td>
      <td class="num">${num(r.current_stock)} / ${num(r.reorder_point)}</td>
      <td class="num">${num(r.projected_demand)}</td>
      <td>${esc(r.primary_supplier)}</td>
      <td style="min-width:150px"><div class="meter-row">${meter(r.shortage_risk)}<b>${r.shortage_risk.toFixed(0)}%</b></div></td>
      <td><a class="btn btn-sm" href="#/optimizer/${r.supplier_id}/${r.component_id}">Optimize</a></td>
    </tr>`).join("") || `<tr><td colspan="8"><div class="state">No components in this group.</div></td></tr>`;
    $("#sh-count").textContent = `Showing ${Math.min(shShown, rows.length)} of ${rows.length}`;
    $("#sh-more").style.display = rows.length > shShown ? "" : "none";
}
/* ------------------------------------------------------------ SUPPLIERS */
let spAll = [];
async function initSuppliers() {
    $("#sp-body").innerHTML = `<tr><td colspan="7">${skRows(6)}</td></tr>`;
    try {
        spAll = await api(SUP_URL);
    }
    catch {
        $("#sp-body").innerHTML = `<tr><td colspan="7">${errorState()}</td></tr>`;
        return;
    }
    const uniq = (k) => Array.from(new Set(spAll.map((s) => String(s[k])))).sort();
    $("#sp-cat").insertAdjacentHTML("beforeend", uniq("category").map((c) => `<option>${esc(c)}</option>`).join(""));
    $("#sp-region").insertAdjacentHTML("beforeend", uniq("region").map((c) => `<option>${esc(c)}</option>`).join(""));
    ["#sp-search", "#sp-cat", "#sp-region"].forEach((s) => $(s).addEventListener("input", renderSuppliers));
    const avg = (f) => spAll.reduce((a, s) => a + f(s), 0) / Math.max(spAll.length, 1);
    const worst = spAll[0];
    const tiles = [
        { ic: "i-alert", tone: "red", v: worst ? worst.risk_score.toFixed(0) : "—", l: "Highest risk score", n: worst ? worst.name : "" },
        { ic: "i-truck", tone: "amber", v: avg((s) => s.risk_score).toFixed(0), l: "Average risk score", n: `Top ${spAll.length} suppliers` },
        { ic: "i-clock", tone: "amber", v: avg((s) => s.delay_probability).toFixed(1) + "%", l: "Avg delay probability", n: "Blended recent + history" },
        { ic: "i-layers", tone: "brand", v: String(new Set(spAll.map((s) => s.category)).size), l: "Categories affected", n: "Across the watchlist" },
    ];
    $("#sp-summary").innerHTML = tiles.map((t, i) => `
    <div class="kpi" style="--i:${i}"><div class="ic ${t.tone}"><svg class="i"><use href="#${t.ic}"/></svg></div>
    <div><div class="v">${esc(t.v)}</div><div class="l">${t.l}</div><div class="n">${esc(t.n)}</div></div></div>`).join("");
    renderSuppliers();
}
function renderSuppliers() {
    const q = $("#sp-search").value.trim().toLowerCase();
    const cat = $("#sp-cat").value;
    const reg = $("#sp-region").value;
    const rows = spAll.filter((s) => (!q || s.name.toLowerCase().includes(q)) && (!cat || s.category === cat) && (!reg || s.region === reg));
    $("#sp-body").innerHTML = rows.map((s) => `
    <tr data-drawer="${s.supplier_id}">
      <td><b>${esc(s.name)}</b></td>
      <td>${esc(s.region)}</td>
      <td>${esc(s.category)}</td>
      <td class="num">${s.delay_probability.toFixed(1)}%</td>
      <td class="num">${s.avg_delay_days.toFixed(1)} d</td>
      <td class="num">${s.lead_time_days} d</td>
      <td style="min-width:150px"><div class="meter-row">${meter(s.risk_score)}<b>${s.risk_score.toFixed(0)}</b></div></td>
    </tr>`).join("") || `<tr><td colspan="7"><div class="state">No suppliers match these filters.</div></td></tr>`;
}
/* ------------------------------------------------------------ ANOMALIES */
let anAll = [];
let anFilter = "all";
async function initAnomalies() {
    $("#an-body").innerHTML = `<tr><td colspan="5">${skRows(5)}</td></tr>`;
    let overview = null;
    try {
        [anAll, overview] = await Promise.all([api(ANOM_URL), api("/api/overview")]);
    }
    catch {
        $("#an-body").innerHTML = `<tr><td colspan="5">${errorState()}</td></tr>`;
        return;
    }
    const over = anAll.filter((a) => a.deviation_pct >= 0).length;
    const maxDev = anAll.reduce((m, a) => Math.max(m, Math.abs(a.deviation_pct)), 0);
    const tiles = [
        { ic: "i-tag", tone: "teal", v: num(overview.price_anomalies), l: "Total flagged", n: "Across all components" },
        { ic: "i-alert", tone: "red", v: String(over), l: "Overpaid (top 100)", n: "Paid above expected" },
        { ic: "i-trend", tone: "brand", v: String(anAll.length - over), l: "Underpriced (top 100)", n: "Paid below expected" },
        { ic: "i-dollar", tone: "amber", v: maxDev.toFixed(0) + "%", l: "Largest deviation", n: "From expected unit price" },
    ];
    $("#an-summary").innerHTML = tiles.map((t, i) => `
    <div class="kpi" style="--i:${i}"><div class="ic ${t.tone}"><svg class="i"><use href="#${t.ic}"/></svg></div>
    <div><div class="v">${t.v}</div><div class="l">${t.l}</div><div class="n">${t.n}</div></div></div>`).join("");
    const top = anAll.slice(0, 15);
    mk("ch-anom", {
        type: "bar",
        data: { labels: top.map((a) => a.sku), datasets: [{ label: "Deviation %", data: top.map((a) => a.deviation_pct), backgroundColor: top.map((a) => (a.deviation_pct >= 0 ? "#E5484D" : "#1FB58F")), borderRadius: 5 }] },
        options: {
            indexAxis: "y", responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => top[c[0].dataIndex].name, label: (c) => ` ${c.parsed.x}% vs expected` } } },
            scales: { x: { ticks: { callback: (v) => v + "%" } }, y: { grid: { display: false }, ticks: { font: { family: "'IBM Plex Mono', monospace", size: 10 } } } },
        },
    });
    $$("#an-filter button").forEach((b) => b.addEventListener("click", () => {
        $$("#an-filter button").forEach((x) => x.classList.toggle("on", x === b));
        anFilter = b.dataset.v;
        renderAnomalies();
    }));
    renderAnomalies();
}
function renderAnomalies() {
    const rows = anAll.filter((a) => anFilter === "all" || (anFilter === "over" ? a.deviation_pct >= 0 : a.deviation_pct < 0));
    $("#an-body").innerHTML = rows.map((a) => `
    <tr data-href="#/demand/${a.component_id}">
      <td><b>${esc(a.name)}</b><span class="mono">${esc(a.sku)} · ${esc(a.order_date)}</span></td>
      <td>${esc(a.supplier_name)}</td>
      <td class="num">${inr(a.unit_price)}</td>
      <td class="num">${inr(a.expected_price)}</td>
      <td class="num ${a.deviation_pct >= 0 ? "pos" : "neg"}">${a.deviation_pct >= 0 ? "+" : ""}${a.deviation_pct.toFixed(1)}%</td>
    </tr>`).join("") || `<tr><td colspan="5"><div class="state">Nothing in this group.</div></td></tr>`;
}
/* ------------------------------------------------------------ ANALYTICS */
const axDone = new Set();
async function initAnalytics() {
    $$("#ax-tabs button").forEach((b) => b.addEventListener("click", () => {
        $$("#ax-tabs button").forEach((x) => x.classList.toggle("on", x === b));
        const tab = b.dataset.tab;
        $$(".panel", $("#view-analytics")).forEach((p) => p.classList.toggle("on", p.id === `ax-${tab}`));
        renderAnalyticsTab(tab);
    }));
    renderAnalyticsTab("spend");
}
async function renderAnalyticsTab(tab) {
    if (axDone.has(tab))
        return;
    axDone.add(tab);
    try {
        if (tab === "spend") {
            const rows = (await drawSpend("ch-spend", 24)) ?? [];
            if (rows.length) {
                const total = rows.reduce((a, r) => a + r.spend, 0);
                const peak = rows.reduce((m, r) => (r.spend > m.spend ? r : m), rows[0]);
                const avgDelay = rows.reduce((a, r) => a + r.delayed_rate_pct, 0) / rows.length;
                $("#ax-spend-stats").innerHTML = [
                    [inrCompact(total / rows.length), "Average monthly spend"],
                    [`${monthLabel(peak.month)} · ${inrCompact(peak.spend)}`, "Peak month"],
                    [avgDelay.toFixed(1) + "%", "Average delayed-order rate"],
                ].map(([v, l]) => `<div class="mini"><b>${v}</b><span>${l}</span></div>`).join("");
            }
        }
        else if (tab === "category") {
            const cats = await api("/api/categories");
            mk("ch-cat", {
                type: "doughnut",
                data: { labels: cats.map((c) => c.category), datasets: [{ data: cats.map((c) => c.components), backgroundColor: PALETTE, borderColor: "#F6F7FF", borderWidth: 3 }] },
                options: { responsive: true, maintainAspectRatio: false, cutout: "58%", plugins: { legend: { position: "right" } } },
            });
            mk("ch-cat-cost", {
                type: "bar",
                data: { labels: cats.map((c) => c.category), datasets: [{ label: "Avg unit cost (₹)", data: cats.map((c) => c.avg_unit_cost), backgroundColor: "#A9B4FF", hoverBackgroundColor: "#3B3FD8", borderRadius: 6 }] },
                options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { grid: { display: false } }, x: { beginAtZero: true } } },
            });
        }
        else if (tab === "shortage") {
            const rows = await api(SHORT_URL);
            const cats = Array.from(new Set(rows.map((r) => r.category))).sort();
            const levels = [["Critical", "#E5484D"], ["High", "#FFB020"], ["Medium", "#6C8CFF"], ["Low", "#B8BEE8"]];
            mk("ch-short", {
                type: "bar",
                data: { labels: cats, datasets: levels.map(([l, c]) => ({ label: l, data: cats.map((cat) => rows.filter((r) => r.category === cat && r.criticality === l).length), backgroundColor: c, borderRadius: 3 })) },
                options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true } } },
            });
        }
        else if (tab === "risk") {
            const sups = await api(SUP_URL);
            const buckets = Array.from({ length: 10 }, (_, i) => `${i * 10}–${i * 10 + 10}`);
            const counts = buckets.map((_, i) => sups.filter((s) => Math.min(9, Math.floor(s.risk_score / 10)) === i).length);
            mk("ch-hist", {
                type: "bar",
                data: { labels: buckets, datasets: [{ label: "Suppliers", data: counts, backgroundColor: buckets.map((_, i) => (i >= 7 ? "#E5484D" : i >= 4 ? "#FFB020" : "#1FB58F")), borderRadius: 6 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, title: { display: true, text: "Risk score" } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
            });
            mk("ch-scatter", {
                type: "bubble",
                data: { datasets: [{ label: "Suppliers", data: sups.map((s) => ({ x: s.lead_time_days, y: s.delay_probability, r: Math.max(4, s.risk_score / 7), n: s.name, rs: s.risk_score })), backgroundColor: "rgba(59,63,216,.45)", borderColor: "#3B3FD8" }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.raw.n}: ${c.raw.y}% delay · ${c.raw.x} d lead · risk ${c.raw.rs}` } } },
                    scales: { x: { title: { display: true, text: "Lead time (days)" } }, y: { title: { display: true, text: "Delay probability %" }, beginAtZero: true } },
                },
            });
        }
    }
    catch (e) {
        axDone.delete(tab);
        console.error(e);
    }
}
/* ----------------------------------------------------------------- boot */
document.addEventListener("DOMContentLoaded", () => {
    setupChartDefaults();
    initTilt();
    bindSearch($("#g-search"), $("#g-suggest"), (id) => { location.hash = `#/demand/${id}`; });
    document.addEventListener("keydown", (e) => {
        const tag = e.target.tagName;
        if (e.key === "/" && tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
            e.preventDefault();
            $("#g-search").focus();
        }
        if (e.key === "Escape")
            closeDrawer();
    });
    $("#scrim").addEventListener("click", closeDrawer);
    window.addEventListener("hashchange", route);
    if (!location.hash)
        location.hash = "#/home";
    else
        route();
    // status ping independent of the active view
    api("/api/overview").then(() => setStatus(true)).catch(() => setStatus(false));
});