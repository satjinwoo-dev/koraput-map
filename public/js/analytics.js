"use strict";

/* ============================================================================
   MapUnite client — js/analytics.js
   ==============================================================================
   Trip analytics: the ride upload queue, day/week/month rollups, charts and
   trip replay.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ============================================================================
// TRIP ANALYTICS (Phase 3) — roadmap Section 13
// ============================================================================
// Server contract (server.js + Phase 3 server additions):
//   tripFinished    {name, mode, startedAt, endedAt, totalDistKm, avgSpeed,
//                    maxSpeed, fuelUsedL, points:[{ts,lat,lng,speedKmh,accuracy}]}
//                   -> ack {ok, tripId, points} | {ok:false, reason}
//   getTripRollups  {period:"day"|"week"|"month", tzOffsetMin, limit}
//                   -> ack {ok, period, rows:[{bucket, trips, distanceKm,
//                      durationMin, avgSpeed, maxSpeed, fuelL}], retentionDays}
//   listMyTrips     {limit} -> ack {ok, trips:[{id, name, mode, started_at,
//                      ended_at, total_dist_km, avg_speed, max_speed, fuel_used_l}]}
//   getTripPoints   {tripId} -> ack {ok, points:[{ts, lat, lng, speed_kmh, accuracy}]}
//
// Buckets are computed server-side in the rider's LOCAL time: the server adds
// tzOffsetMin to UTC, so tzOffsetMin must be minutes EAST of UTC (+330 for
// IST) — the NEGATION of Date.getTimezoneOffset(). The client rebuilds the
// same bucket keys (localDateKey / weekKeyFor / monthKeyFor) so empty days
// show as zero-height bars instead of silently closing the gap.

// Speed tiers for ride replay — the same thresholds as the speed alerts, so
// the colors mean what the alerts meant. Validated palette (dataviz
// validator, dark surface #0e1724): lightness band, chroma floor, CVD ΔE 8.6,
// normal-vision ΔE 15.5, contrast ≥ 3:1 — all pass. Always shown with a text
// legend, never color alone.
const SPEED_BANDS = [
    { label: "Under 80 km/h", color: "#24a684" },
    { label: "80–100 km/h", color: "#ac8b26" },
    { label: "100+ km/h", color: "#c2555a" }
];
const NO_SPEED_COLOR = "#8b9bab";
const CHART_BAR_COLOR = "#34e0b4";        // single series -> the app accent
const CHART_BAR_SELECTED = "#8ff2d6";

// Ack-based emit with a timeout that works on any socket.io 4.x client
// (socket.timeout() only exists from 4.4 on).
function emitWithAck(event, payload, timeoutMs, cb) {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; cb(new Error("timeout")); } }, timeoutMs);
    socket.emit(event, payload, (res) => { if (!done) { done = true; clearTimeout(timer); cb(null, res); } });
}

const pad2 = (n) => String(n).padStart(2, "0");
// "YYYY-MM-DD" in LOCAL time — mirrors date(started_at/1000 + tz, 'unixepoch').
function localDateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
// Monday on/before d, local — mirrors "... '-6 days', 'weekday 1'".
function weekKeyFor(d) {
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    return localDateKey(monday);
}
// "YYYY-MM" local — mirrors strftime('%Y-%m', ...).
function monthKeyFor(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }

// The `count` most recent bucket keys ending with the one containing `now`,
// oldest first.
function analyticsBucketKeys(period, count, now = new Date()) {
    const keys = [];
    for (let i = count - 1; i >= 0; i--) {
        if (period === "month") keys.push(monthKeyFor(new Date(now.getFullYear(), now.getMonth() - i, 1)));
        else if (period === "week") {
            const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) - 7 * i);
            keys.push(localDateKey(monday));
        } else keys.push(localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    }
    return keys;
}

function bucketLabel(period, key, style = "short") {
    const parts = String(key).split("-").map(Number);
    if (period === "month") {
        const d = new Date(parts[0], parts[1] - 1, 1);
        return style === "short" ? d.toLocaleDateString(undefined, { month: "short" }) : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    if (period === "week") {
        return style === "short" ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : `Week of ${d.toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
    }
    return style === "short" ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

const fmtNum = (v, digits) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
function fmtDuration(min) {
    const m = Math.max(0, Math.round(min || 0));
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

// A round axis maximum with three gridlines (0, max/2, max).
function niceAxisMax(maxValue, fallback) {
    if (!(maxValue > 0)) return fallback;
    const half = maxValue / 2;
    const pow = Math.pow(10, Math.floor(Math.log10(half)));
    for (const m of [1, 2, 2.5, 5, 10]) {
        if (m * pow >= half) return 2 * m * pow;
    }
    return 2 * 10 * pow;
}

const TripAnalytics = {
    PENDING_KEY: "mu_pending_trips",
    MAX_PENDING: 5,
    PENDING_MAX_AGE_MS: 7 * 86400000,       // same 7-day horizon as TripDB's local backup
    PERIODS: {
        day: { count: 14, windowLabel: "Last 14 days" },
        week: { count: 8, windowLabel: "Last 8 weeks" },
        month: { count: 6, windowLabel: "Last 6 months" }
    },
    METRICS: {
        distance: { label: "Distance", pick: (r) => r.distanceKm, fmt: (v) => `${fmtNum(v, 1)} km`, axis: (v) => `${fmtNum(v, 0)}`, fallbackMax: 10 },
        duration: { label: "Ride time", pick: (r) => r.durationMin, fmt: (v) => fmtDuration(v), axis: (v) => (v >= 60 ? `${fmtNum(v / 60, 1)}h` : `${fmtNum(v, 0)}m`), fallbackMax: 60 },
        fuel: { label: "Fuel (est.)", pick: (r) => r.fuelL, fmt: (v) => `${fmtNum(v, 2)} L`, axis: (v) => `${fmtNum(v, 1)}`, fallbackMax: 1 }
    },
    period: "day",
    metric: "distance",
    rows: [],
    trips: [],
    retentionDays: null,
    selectedKey: null,
    loadingSeq: 0,
    tripsSeq: 0,
    profileVerified: false,
    flushing: false,
    flushTimer: null,
    replayLayer: null,
    resizeTimer: null,

    init() {
        this.replayLayer = L.layerGroup().addTo(map);

        const openBtn = $("analytics-btn");
        if (openBtn) openBtn.addEventListener("click", () => this.open());
        const closeBtn = $("analytics-close");
        if (closeBtn) closeBtn.addEventListener("click", () => this.close());

        const periodSeg = document.querySelector('[data-segment="analyticsPeriod"]');
        if (periodSeg) periodSeg.addEventListener("segment", (e) => {
            if (!this.PERIODS[e.detail.value]) return;
            this.period = e.detail.value;
            this.selectedKey = null;
            this.loadRollups();
        });
        const metricSeg = document.querySelector('[data-segment="analyticsMetric"]');
        if (metricSeg) metricSeg.addEventListener("segment", (e) => {
            if (!this.METRICS[e.detail.value]) return;
            this.metric = e.detail.value;
            this.renderChart();
            this.renderDetail();
        });

        const clearReplayBtn = $("replay-clear-btn");
        if (clearReplayBtn) clearReplayBtn.addEventListener("click", () => this.clearReplay());

        // The server persists trips only for a verified device; losing the
        // socket means waiting for the next profileAccepted before flushing.
        socket.on("disconnect", () => { this.profileVerified = false; });

        window.addEventListener("resize", () => {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = setTimeout(() => { if (this.isOpen()) this.renderChart(); }, 150);
        }, { passive: true });
    },

    tzOffsetMin() { return -new Date().getTimezoneOffset(); },
    isOpen() { const m = $("analytics-modal"); return Boolean(m && m.style.display === "flex"); },

    open() {
        safeShow("analytics-modal", "flex");
        this.render();              // paint whatever we already have (keeps the frame)
        this.refresh();
    },
    close() { safeHide("analytics-modal"); this.hideTip(); },

    refresh() {
        this.loadRollups();
        this.loadTrips();
    },

    setLoading(on) {
        const host = $("analytics-chart");
        if (host) host.classList.toggle("is-loading", Boolean(on));
    },
    setNotice(text) {
        const el = $("analytics-notice");
        if (!el) return;
        el.textContent = text || "";
        el.hidden = !text;
    },

    loadRollups(retriesLeft = 2) {
        const seq = ++this.loadingSeq;
        const cfg = this.PERIODS[this.period];
        if (!socket.connected) {
            this.setNotice("You're offline — showing the last numbers loaded.");
            this.render();
            return;
        }
        this.setLoading(true);
        emitWithAck("getTripRollups", { period: this.period, tzOffsetMin: this.tzOffsetMin(), limit: cfg.count }, 8000, (err, res) => {
            if (seq !== this.loadingSeq) return;            // a newer period click superseded this one
            if (err) { this.setLoading(false); this.setNotice("Couldn't reach the server — try again in a moment."); return; }
            if (!res || !res.ok) {
                const reason = res && res.reason;
                if ((reason === "too-frequent" || reason === "rate-limited") && retriesLeft > 0) {
                    // Server throttles rollups to 1/s per socket; quick
                    // period switches (or a laggy link bunching requests)
                    // shouldn't surface as an error.
                    setTimeout(() => { if (seq === this.loadingSeq) this.loadRollups(retriesLeft - 1); }, 1100);
                    return;
                }
                this.setLoading(false);
                this.setNotice(reason === "no-device-identity" ? "Join the map to start building your ride history." : "Couldn't load your ride stats right now.");
                return;
            }
            this.setLoading(false);
            this.rows = Array.isArray(res.rows) ? res.rows : [];
            if (Number.isFinite(res.retentionDays)) this.retentionDays = res.retentionDays;
            this.setNotice("");
            this.render();
        });
    },

    loadTrips() {
        const seq = ++this.tripsSeq;
        if (!socket.connected) { this.renderTrips(); return; }
        emitWithAck("listMyTrips", { limit: 10 }, 8000, (err, res) => {
            if (seq !== this.tripsSeq) return;
            if (!err && res && res.ok && Array.isArray(res.trips)) this.trips = res.trips;
            this.renderTrips();
        });
    },

    // Window of bucket keys (oldest -> newest) joined with the server rows.
    series() {
        const cfg = this.PERIODS[this.period];
        const metric = this.METRICS[this.metric];
        const byKey = new Map(this.rows.map((r) => [r.bucket, r]));
        return analyticsBucketKeys(this.period, cfg.count).map((key) => {
            const row = byKey.get(key) || null;
            return { key, row, value: row ? Number(metric.pick(row)) || 0 : 0 };
        });
    },

    render() {
        this.renderTotals();
        this.renderChart();
        this.renderDetail();
        this.renderTable();
        this.renderFootnote();
    },

    renderTotals() {
        const host = $("analytics-totals");
        if (!host) return;
        const data = this.series();
        const sum = (f) => data.reduce((a, d) => a + (d.row ? Number(f(d.row)) || 0 : 0), 0);
        const tiles = [
            ["Rides", fmtNum(sum((r) => r.trips), 0)],
            ["Distance", `${fmtNum(sum((r) => r.distanceKm), 1)} km`],
            ["Ride time", fmtDuration(sum((r) => r.durationMin))],
            ["Fuel (est.)", `${fmtNum(sum((r) => r.fuelL), 1)} L`]
        ];
        host.textContent = "";
        tiles.forEach(([label, value]) => {
            const card = document.createElement("div");
            card.className = "list-card";
            const l = document.createElement("span"); l.className = "l"; l.textContent = label;
            const v = document.createElement("span"); v.className = "v"; v.textContent = value;
            card.appendChild(l); card.appendChild(v);
            host.appendChild(card);
        });
        const win = $("analytics-window");
        if (win) win.textContent = this.PERIODS[this.period].windowLabel;
    },

    renderChart() {
        const host = $("analytics-chart");
        if (!host) return;
        const data = this.series();
        const metric = this.METRICS[this.metric];
        const NS = "http://www.w3.org/2000/svg";
        const W = Math.max(260, Math.floor(host.clientWidth || 320));
        const H = 196, padL = 38, padR = 8, padT = 24, padB = 26;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const maxV = Math.max(0, ...data.map((d) => d.value));
        const yMax = niceAxisMax(maxV, metric.fallbackMax);
        const y = (v) => padT + plotH - (v / yMax) * plotH;
        const slot = plotW / data.length;
        const barW = Math.min(24, Math.max(4, slot * 0.62));

        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.setAttribute("width", String(W));
        svg.setAttribute("height", String(H));
        svg.setAttribute("role", "group");
        svg.setAttribute("aria-label", `${metric.label} per ${this.period}, ${this.PERIODS[this.period].windowLabel.toLowerCase()}`);

        const mk = (tag, attrs) => { const el = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v))); return el; };
        const txt = (x, yy, s, attrs = {}) => { const t = mk("text", { x, y: yy, ...attrs }); t.textContent = s; return t; };

        // Recessive solid hairline grid + tick labels (0, half, max).
        [0, yMax / 2, yMax].forEach((v) => {
            const yy = Math.round(y(v)) + 0.5;
            svg.appendChild(mk("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: v === 0 ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.08)", "stroke-width": 1 }));
            svg.appendChild(txt(padL - 6, yy + 3.5, metric.axis(v), { "text-anchor": "end", class: "an-tick" }));
        });

        // X labels: thin them so they never collide; the newest bucket is always labeled.
        const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 40))));
        let maxIdx = -1;
        data.forEach((d, i) => { if (d.value > 0 && (maxIdx < 0 || d.value > data[maxIdx].value)) maxIdx = i; });

        data.forEach((d, i) => {
            const cx = padL + slot * i + slot / 2;
            const g = mk("g", { class: "an-bar", tabindex: 0, role: "button", "data-idx": i });
            const label = bucketLabel(this.period, d.key, "long");
            const rides = d.row ? d.row.trips : 0;
            g.setAttribute("aria-label", `${label}: ${rides ? `${rides} ride${rides === 1 ? "" : "s"}, ${metric.fmt(d.value)}` : "no rides"}`);
            if (this.selectedKey === d.key) g.setAttribute("aria-pressed", "true");

            // Hit target: the whole column slot, bigger than the painted bar.
            g.appendChild(mk("rect", { x: padL + slot * i, y: padT, width: slot, height: plotH, fill: "transparent" }));

            if (d.value > 0) {
                const top = y(d.value);
                const h = Math.max(2, padT + plotH - top);
                const x0 = cx - barW / 2, x1 = cx + barW / 2, yb = padT + plotH, yt = yb - h;
                const r = Math.min(4, h, barW / 2);
                // 4px rounded data-end, square at the baseline.
                const path = `M${x0},${yb} L${x0},${yt + r} Q${x0},${yt} ${x0 + r},${yt} L${x1 - r},${yt} Q${x1},${yt} ${x1},${yt + r} L${x1},${yb} Z`;
                g.appendChild(mk("path", { d: path, fill: this.selectedKey === d.key ? CHART_BAR_SELECTED : CHART_BAR_COLOR, class: "an-mark" }));
            }
            if (i === maxIdx) {
                // Selective direct label: the peak only, in text ink.
                g.appendChild(txt(cx, y(d.value) - 6, metric.fmt(d.value), { "text-anchor": "middle", class: "an-peak" }));
            }
            if ((data.length - 1 - i) % every === 0) {
                g.appendChild(txt(cx, H - 8, bucketLabel(this.period, d.key, "short"), { "text-anchor": "middle", class: "an-xlabel" }));
            }

            const show = () => this.showTip(i, cx, d.value > 0 ? y(d.value) : padT + plotH);
            g.addEventListener("pointerenter", show);
            g.addEventListener("focus", show);
            g.addEventListener("pointerleave", () => this.hideTip());
            g.addEventListener("blur", () => this.hideTip());
            g.addEventListener("click", () => this.select(d.key));
            g.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.select(d.key); }
                else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const nextIdx = i + (e.key === "ArrowRight" ? 1 : -1);
                    const target = host.querySelector(`.an-bar[data-idx="${nextIdx}"]`);
                    if (target) target.focus();
                }
            });
            svg.appendChild(g);
        });

        if (maxV === 0) {
            svg.appendChild(txt(padL + plotW / 2, padT + plotH / 2, "No rides in this period yet", { "text-anchor": "middle", class: "an-empty" }));
        }

        host.querySelectorAll("svg").forEach((s) => s.remove());
        host.insertBefore(svg, host.firstChild);
        this._chartData = data;
        this._chartW = W;
    },

    showTip(i, cx, topY) {
        const tip = $("analytics-tip");
        const d = this._chartData && this._chartData[i];
        if (!tip || !d) return;
        const metric = this.METRICS[this.metric];
        tip.textContent = "";
        const v = document.createElement("strong");
        v.textContent = d.row ? metric.fmt(d.value) : "No rides";
        const s = document.createElement("span");
        const rides = d.row ? d.row.trips : 0;
        s.textContent = `${bucketLabel(this.period, d.key, "long")}${rides ? ` · ${rides} ride${rides === 1 ? "" : "s"}` : ""}`;
        tip.appendChild(v); tip.appendChild(s);
        tip.hidden = false;
        const tipW = tip.offsetWidth || 160;
        const left = Math.min(Math.max(4, cx - tipW / 2), (this._chartW || 320) - tipW - 4);
        tip.style.left = `${left}px`;
        tip.style.top = `${Math.max(0, topY - 50)}px`;
    },
    hideTip() { const tip = $("analytics-tip"); if (tip) tip.hidden = true; },

    select(key) {
        this.selectedKey = this.selectedKey === key ? null : key;
        this.renderChart();
        this.renderDetail();
        const again = $("analytics-chart")?.querySelector(`.an-bar[aria-pressed="true"]`);
        if (again) again.focus({ preventScroll: true });
    },

    renderDetail() {
        const el = $("analytics-detail");
        if (!el) return;
        const d = this.selectedKey && this.series().find((x) => x.key === this.selectedKey);
        if (!d) { el.textContent = "Tap a bar for that period's details."; return; }
        const label = bucketLabel(this.period, d.key, "long");
        if (!d.row) { el.textContent = `${label} · no rides`; return; }
        const r = d.row;
        el.textContent = `${label} · ${r.trips} ride${r.trips === 1 ? "" : "s"} · ${fmtNum(r.distanceKm, 1)} km · ${fmtDuration(r.durationMin)} · avg ${fmtNum(r.avgSpeed, 0)} km/h · top ${fmtNum(r.maxSpeed, 0)} km/h · ~${fmtNum(r.fuelL, 2)} L fuel (est.)`;
    },

    // Table twin of the chart — every value reachable without hover.
    renderTable() {
        const table = $("analytics-table");
        if (!table) return;
        table.textContent = "";
        const head = table.createTHead().insertRow();
        ["Period", "Rides", "Distance", "Time", "Avg", "Top", "Fuel (est.)"].forEach((h) => {
            const th = document.createElement("th"); th.scope = "col"; th.textContent = h; head.appendChild(th);
        });
        const body = table.createTBody();
        this.series().slice().reverse().forEach((d) => {
            const tr = body.insertRow();
            const r = d.row;
            [bucketLabel(this.period, d.key, "long"),
                r ? fmtNum(r.trips, 0) : "0",
                r ? `${fmtNum(r.distanceKm, 1)} km` : "—",
                r ? fmtDuration(r.durationMin) : "—",
                r ? `${fmtNum(r.avgSpeed, 0)} km/h` : "—",
                r ? `${fmtNum(r.maxSpeed, 0)} km/h` : "—",
                r ? `${fmtNum(r.fuelL, 2)} L` : "—"].forEach((c, idx) => {
                    const cell = idx === 0 ? document.createElement("th") : tr.insertCell();
                    if (idx === 0) { cell.scope = "row"; tr.appendChild(cell); }
                    cell.textContent = c;
                });
        });
    },

    renderFootnote() {
        const el = $("analytics-footnote");
        if (!el) return;
        const keep = this.retentionDays > 0 ? `Rides are kept on the server for ${this.retentionDays} days.` : "Rides are kept until you clear your history.";
        el.textContent = `Distances and fuel come from GPS speed samples and your km/L setting — they're estimates, not odometer readings. ${keep}`;
    },

    renderTrips() {
        const host = $("analytics-trips");
        if (!host) return;
        host.textContent = "";
        const pending = this.loadPending().length;
        if (pending) {
            const p = document.createElement("div");
            p.className = "list-card";
            p.textContent = `⏳ ${pending} finished ride${pending === 1 ? "" : "s"} waiting to upload — they'll save automatically when you're back online.`;
            host.appendChild(p);
        }
        if (!this.trips.length) {
            const empty = document.createElement("p");
            empty.className = "field-hint";
            empty.textContent = "No saved rides yet. A ride is saved when a navigation drive or a group trip ends.";
            host.appendChild(empty);
            return;
        }
        const modeIcon = { drive: "🚗", bike: "🏍️", walk: "🚶" };
        this.trips.forEach((t) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "list-card trip-row";
            const left = document.createElement("div");
            const name = document.createElement("strong");
            name.textContent = `${modeIcon[t.mode] || "🚗"} ${t.name || "Ride"}`;
            const when = document.createElement("div");
            when.className = "field-hint";
            when.style.margin = "2px 0 0";
            const started = new Date(t.started_at);
            const mins = t.ended_at ? Math.round((t.ended_at - t.started_at) / 60000) : 0;
            when.textContent = `${started.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${fmtDuration(mins)}`;
            left.appendChild(name); left.appendChild(when);
            const right = document.createElement("div");
            right.style.textAlign = "right";
            const dist = document.createElement("strong");
            dist.textContent = `${fmtNum(t.total_dist_km, 1)} km`;
            const sp = document.createElement("div");
            sp.className = "field-hint";
            sp.style.margin = "2px 0 0";
            sp.textContent = `avg ${fmtNum(t.avg_speed, 0)} · top ${fmtNum(t.max_speed, 0)} km/h`;
            right.appendChild(dist); right.appendChild(sp);
            btn.appendChild(left); btn.appendChild(right);
            btn.setAttribute("aria-label", `Replay ${t.name || "ride"} from ${started.toLocaleString()}`);
            btn.addEventListener("click", () => this.replay(t));
            host.appendChild(btn);
        });
    },

    // ---- Ride replay ---------------------------------------------------------
    replay(trip) {
        emitWithAck("getTripPoints", { tripId: trip.id }, 10000, (err, res) => {
            if (err || !res || !res.ok) { showToast("Couldn't load that ride's route."); return; }
            const pts = (res.points || []).filter((p) => validCoord(p.lat, p.lng));
            if (!pts.length) { showToast("This ride has no saved route points."); return; }
            this.drawReplay(trip, pts);
        });
    },

    drawReplay(trip, pts) {
        this.replayLayer.clearLayers();
        const latlngs = pts.map((p) => [p.lat, p.lng]);
        const bandOf = (s) => (s == null || !Number.isFinite(Number(s)) ? -1 : Number(s) >= 100 ? 2 : Number(s) >= 80 ? 1 : 0);

        // Each segment takes the band of the speed recorded at its END point;
        // consecutive same-band segments merge into one polyline.
        const segs = [];
        for (let i = 1; i < pts.length; i++) {
            const b = bandOf(pts[i].speed_kmh);
            const last = segs[segs.length - 1];
            if (last && last.band === b) last.latlngs.push(latlngs[i]);
            else segs.push({ band: b, latlngs: [latlngs[i - 1], latlngs[i]] });
        }
        if (latlngs.length >= 2) {
            // Dark casing so the colored line reads on satellite AND street tiles.
            L.polyline(latlngs, { color: "#0b1220", weight: 8, opacity: 0.85, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(this.replayLayer);
        }
        const present = new Set();
        segs.forEach((s) => {
            present.add(s.band);
            L.polyline(s.latlngs, { color: s.band < 0 ? NO_SPEED_COLOR : SPEED_BANDS[s.band].color, weight: 4.5, opacity: 1, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(this.replayLayer);
        });
        L.circleMarker(latlngs[0], { radius: 6, color: "#0b1220", weight: 2, fillColor: "#ffffff", fillOpacity: 1 }).bindTooltip("Start").addTo(this.replayLayer);
        L.marker(latlngs[latlngs.length - 1], { icon: L.divIcon({ className: "geofence-marker", html: "🏁" }) }).bindTooltip("Finish").addTo(this.replayLayer);

        if (latlngs.length >= 2) map.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60] });
        else map.flyTo(latlngs[0], 16);
        this.close();

        // Legend: swatch + text for every band actually on the map.
        const title = $("replay-title");
        if (title) {
            const started = new Date(trip.started_at);
            title.textContent = `${trip.name || "Ride"} · ${started.toLocaleDateString(undefined, { day: "numeric", month: "short" })} · top ${fmtNum(trip.max_speed, 0)} km/h`;
        }
        const list = $("replay-bands");
        if (list) {
            list.textContent = "";
            const rows = SPEED_BANDS.map((b, i) => ({ ...b, i })).filter((b) => present.has(b.i));
            if (present.has(-1)) rows.push({ label: "No speed data", color: NO_SPEED_COLOR, i: -1 });
            rows.forEach((b) => {
                const li = document.createElement("li");
                const sw = document.createElement("span");
                sw.className = "swatch";
                sw.style.background = b.color;
                const t = document.createElement("span");
                t.textContent = b.label;
                li.appendChild(sw); li.appendChild(t);
                list.appendChild(li);
            });
        }
        safeShow("replay-legend", "flex");
    },

    clearReplay() {
        if (this.replayLayer) this.replayLayer.clearLayers();
        safeHide("replay-legend");
    },

    // ---- Offline-safe tripFinished queue ------------------------------------
    // Duplicate risk, stated honestly: if the server saves a ride but the ack
    // is lost (disconnect in that instant), the retry saves it again — the
    // server has no idempotency key for tripFinished. Rare, and preferable
    // to silently losing rides that end in a dead zone.
    loadPending() {
        try {
            const q = JSON.parse(localStorage.getItem(this.PENDING_KEY) || "[]");
            if (!Array.isArray(q)) return [];
            return q.filter((i) => i && i.payload && Date.now() - (i.queuedAt || 0) < this.PENDING_MAX_AGE_MS);
        } catch (e) { return []; }
    },

    savePending(q) {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                if (q.length) localStorage.setItem(this.PENDING_KEY, JSON.stringify(q));
                else localStorage.removeItem(this.PENDING_KEY);
                return true;
            } catch (e) {
                // Storage full: shed breadcrumbs from the oldest ride first —
                // the summary row is what the rollups need.
                const victim = q.find((i) => Array.isArray(i.payload.points) && i.payload.points.length > 0);
                if (!victim) return false;
                victim.payload.points = victim.payload.points.length > 200 ? victim.payload.points.filter((_, idx) => idx % 4 === 0) : [];
            }
        }
        return false;
    },

    submitFinishedTrip(payload) {
        const q = this.loadPending();
        const qid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : DeviceIdentity._fallbackUuid();
        q.push({ qid, queuedAt: Date.now(), attempts: 0, payload });
        while (q.length > this.MAX_PENDING) q.shift();
        this.savePending(q);
        if (!socket.connected || !this.profileVerified) showToast("📴 Ride saved on this phone — it'll upload when you're back online.", 4500);
        this.flushPending();
    },

    flushPending() {
        if (this.flushing || !this.profileVerified || !socket.connected) return;
        const q = this.loadPending();
        if (!q.length) return;
        const item = q[0];
        this.flushing = true;
        emitWithAck("tripFinished", item.payload, 15000, (err, res) => {
            this.flushing = false;
            if (err) return;                                   // no ack: keep it, retry on next profileAccepted
            const q2 = this.loadPending();
            const idx = q2.findIndex((i) => i.qid === item.qid);
            if (res && res.ok) {
                if (idx >= 0) q2.splice(idx, 1);
                this.savePending(q2);
                showToast(`💾 Ride saved to your history${Number.isFinite(res.points) ? ` (${res.points} route point${res.points === 1 ? "" : "s"})` : ""}.`, 3500);
                if (this.isOpen()) this.refresh();
                // The server throttles tripFinished to one per 5 s per socket.
                if (q2.length) { clearTimeout(this.flushTimer); this.flushTimer = setTimeout(() => this.flushPending(), 5500); }
                return;
            }
            const reason = res && res.reason;
            if (reason === "too-frequent" || reason === "rate-limited") {
                clearTimeout(this.flushTimer);
                this.flushTimer = setTimeout(() => this.flushPending(), 5500);
                return;
            }
            if (reason === "no-device-identity") { this.profileVerified = false; return; }
            // Anything else (e.g. internal-error): count attempts so one bad
            // record can't block the queue forever.
            if (idx >= 0) {
                q2[idx].attempts = (q2[idx].attempts || 0) + 1;
                if (q2[idx].attempts >= 3) { q2.splice(idx, 1); showToast("A ride couldn't be saved to the server and was dropped.", 5000); }
                this.savePending(q2);
                if (q2.length) { clearTimeout(this.flushTimer); this.flushTimer = setTimeout(() => this.flushPending(), 5500); }
            }
        });
    },

    // Zero-trace: called after "Clear my history" succeeds.
    clearLocal() {
        try { localStorage.removeItem(this.PENDING_KEY); } catch (e) { /* ignore */ }
        this.rows = [];
        this.trips = [];
        this.selectedKey = null;
        this.clearReplay();
        if (this.isOpen()) { this.render(); this.renderTrips(); }
    }
};
