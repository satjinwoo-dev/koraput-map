"use strict";

/* ============================================================================
   MapUnite client — js/memories.js
   ==============================================================================
   Memories: photo pins, gallery, timeline and viewer, and the memory heatmap.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ==========================================
// MEMORIES — canvas downscale + JPEG compress before upload
// ==========================================
function setupMemoriesSafe() {
    const pgb = $("phase3-gallery-btn");
    if (pgb) pgb.onclick = () => { safeShow("phase3-memory-overlay", "block"); renderMemGallery(); };
    const pmc = $("phase3-memory-close");
    if (pmc) pmc.onclick = () => safeHide("phase3-memory-overlay");
    const pvc = $("p3-view-close");
    if (pvc) pvc.onclick = () => safeHide("phase3-photo-viewer");

    document.querySelectorAll(".phase3-filter").forEach(b => {
        b.onclick = () => { document.querySelectorAll(".phase3-filter").forEach(x => x.classList.remove("active")); b.classList.add("active"); currentGalleryFilter = b.dataset.filter; renderMemGallery(); };
    });

    const pms = $("phase3-memory-search");
    if (pms) pms.oninput = e => { currentGallerySearch = e.target.value.toLowerCase(); renderMemGallery(); };

    const pvf = $("p3-view-focus");
    if (pvf) pvf.onclick = () => { const m = memories.get(selectedMemoryId); if (m) map.flyTo([m.lat, m.lng], 17); safeHide("phase3-photo-viewer"); safeHide("phase3-memory-overlay"); };

    function openViewer(m) {
        selectedMemoryId = m.id;
        const pvi = $("p3-view-image"); if (pvi) pvi.src = m.image;
        const pvn = $("p3-view-name"); if (pvn) pvn.textContent = m.name;
        const pvd = $("p3-view-date"); if (pvd) pvd.textContent = new Date(m.time).toLocaleString();
        safeShow("phase3-photo-viewer", "flex");
    }

    function renderMemGallery() {
        let arr = Array.from(memories.values());
        if (currentGalleryFilter === "today") arr = arr.filter(m => new Date(m.time) >= new Date().setHours(0, 0, 0, 0));
        else if (currentGalleryFilter === "mine") arr = arr.filter(m => m.ownerKey && m.ownerKey === myOwnerKey);
        if (currentGallerySearch) arr = arr.filter(m => cleanName(m.name).toLowerCase().includes(currentGallerySearch));
        arr.sort((a, b) => new Date(b.time) - new Date(a.time));

        const pmc2 = $("phase3-memory-count"); if (pmc2) pmc2.textContent = `${arr.length} memories`;
        const grid = $("phase3-memory-grid"), time = $("phase3-timeline-list"), emp = $("phase3-memory-empty");
        if (grid) grid.innerHTML = ""; if (time) time.innerHTML = ""; if (emp) emp.style.display = arr.length ? "none" : "block";

        arr.forEach(m => {
            if (grid) {
                const c = document.createElement("div"); c.className = "p3-card";
                c.innerHTML = `<img src="${escapeHTML(m.image)}" loading="lazy"><div class="p3-card-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleDateString()}</span></div>`;
                c.onclick = () => openViewer(m);
                grid.appendChild(c);
            }
            if (time) {
                const t = document.createElement("div"); t.className = "p3-time-item";
                t.innerHTML = `<div class="p3-time-thumb"><img src="${escapeHTML(m.image)}" loading="lazy"></div><div class="p3-time-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleString()}</span></div>`;
                t.onclick = () => openViewer(m);
                time.appendChild(t);
            }
        });
    }

    function renderPins() {
        memoryLayer.clearLayers();
        memories.forEach(m => {
            const icon = L.divIcon({ className: "p3-memory-marker", html: `<div style="width:46px;height:46px;border-radius:50%;overflow:hidden;border:2px solid #fff;background:#071018;box-shadow:0 4px 15px rgba(0,0,0,.65)"><img src="${escapeHTML(m.image)}" style="width:100%;height:100%;object-fit:cover;"></div>`, iconSize: [46, 46], iconAnchor: [23, 23] });
            const marker = L.marker([m.lat, m.lng], { icon }).addTo(memoryLayer);
            marker.bindPopup(`<div class="p3-map-popup" style="width:220px; text-align:center;"><img src="${escapeHTML(m.image)}" style="width:100%; height:140px; object-fit:cover; border-radius:8px; margin-bottom:8px; box-shadow:0 4px 10px rgba(0,0,0,0.2);"><br><b style="color:var(--mint); font-size:14px;">📸 ${escapeHTML(m.name)}</b><br><small style="color:#aaa;">${new Date(m.time).toLocaleString()}</small><br><button class="p3-open-map-memory" style="margin-top:8px;padding:8px;width:100%;background:#34e0b4;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer;">View Detail</button></div>`);
            marker.on("popupopen", e => { const b = e.popup.getElement()?.querySelector(".p3-open-map-memory"); if (b) b.onclick = () => openViewer(m); });
        });
    }
    const memoriesChanged = () => document.dispatchEvent(new CustomEvent("mu:memories-changed", { detail: { count: memories.size } }));
    // serverUrl(): photo links are /media/… on the server — absolute in the Android app.
    socket.on("loadMemoryPhotos", l => { memories.clear(); l.forEach(m => memories.set(m.id, { ...m, image: serverUrl(m.image) })); renderPins(); memoriesChanged(); });
    socket.on("newMemoryPin", m => { m = { ...m, image: serverUrl(m.image) }; memories.set(m.id, m); renderPins(); const pmo = $("phase3-memory-overlay"); if (pmo && pmo.style.display === "block") renderMemGallery(); memoriesChanged(); });
    socket.on("memoryRejected", (d) => showToast(d?.reason === "type-mismatch" ? "📸 That file isn't a photo we can pin." : d?.reason === "too-large" ? "📸 Photo too large to pin." : "📸 Couldn't pin that memory — try again.", 4000));
    // The heatmap opens a memory with the same viewer the gallery uses.
    window.MemoryUI = { open: openViewer, closeGallery: () => safeHide("phase3-memory-overlay") };

    const mInp = $("memoryPhotoInput");
    const mb = $("memoryButton");
    if (mb) mb.onclick = () => { if (!currentUser.name) return showToast("❌ Please Join map first."); if (mInp) mInp.click(); };

    const addMemBtn = $("p3-add-memory-btn");
    if (addMemBtn) addMemBtn.onclick = () => { safeHide("phase3-memory-overlay"); setTimeout(() => { if (mInp) mInp.click(); }, 300); };

    if (mInp) {
        mInp.onchange = (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (!f.type.startsWith("image/") && !f.name.match(/\.(jpg|jpeg|png|gif|webp|heic)$/i)) {
                showToast("❌ Invalid format! Please select an image file.");
                mInp.value = "";
                return;
            }
            showToast("⏳ Processing high-quality photo...", 2000);
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement("canvas");
                    const MAX_SIZE = 1000;
                    let w = img.width, h = img.height;
                    if (w > h && w > MAX_SIZE) { h *= MAX_SIZE / w; w = MAX_SIZE; }
                    else if (h > MAX_SIZE) { w *= MAX_SIZE / h; h = MAX_SIZE; }
                    canvas.width = w; canvas.height = h;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0, w, h);
                    pendingMemoryImage = canvas.toDataURL("image/jpeg", 0.7);
                    mapActionMode = 'memory';
                    showToast("✅ Photo Ready! TAP ANYWHERE on the map to pin it.", 6000);
                };
                img.onerror = () => {
                    pendingMemoryImage = ev.target.result;
                    mapActionMode = 'memory';
                    showToast("✅ Photo Ready! TAP ANYWHERE on the map to pin it.", 6000);
                };
                img.src = ev.target.result;
                mInp.value = "";
            };
            reader.readAsDataURL(f);
        };
    }
}

// ============================================================================
// MEMORY HEATMAP — roadmap Sections 4 + 28 #12 ("memory heatmap over time")
// ============================================================================
// Where the squad's memories cluster, for a chosen time window. Honest
// density, not a blur: memories are binned into square cells that are a
// fixed 44 px on screen at the current zoom (re-binned on zoom, so zooming
// in splits a busy cell), and each cell's COUNT picks one of five ordinal
// steps of a single blue ramp: 1 · 2–3 · 4–7 · 8–15 · 16+.
//   - Ramp direction follows the base map: light map (Street/Terrain) ->
//     light-to-dark steps; Satellite/Dark -> the dark-mode steps, light =
//     many. Both 5-step ramps pass the ordinal checks (monotone lightness,
//     visible step gaps, light end >= 2:1 on the map surface). Satellite
//     imagery has no single surface, so every cell also wears a 2 px ring in
//     the opposite ink — the cell edge never depends on the photo under it.
//   - Identity is never colour alone: the legend names each step, the busiest
//     three cells carry their count, every cell has a tooltip and an ARIA
//     label ("5 memories, Mar–Sep 2026"), and "Top areas" is the table view.
//   - Tap a cell: zoom into it; once it can't split further, list its photos.
//   - Photo pins are hidden while the heatmap is on (they'd cover the cells)
//     and come back when it's turned off.
const MemoryHeatmap = {
    KEY: "mu_mem_heat_prefs",
    on: false, range: "all", who: "all",
    CELL_PX: 44, GAP_PX: 4, MAX_FOCUS_ZOOM: 17,
    BUCKETS: [
        { min: 1, max: 1, label: "1" }, { min: 2, max: 3, label: "2–3" }, { min: 4, max: 7, label: "4–7" },
        { min: 8, max: 15, label: "8–15" }, { min: 16, max: Infinity, label: "16+" }
    ],
    // Sequential blue ramp steps (dataviz reference palette), validated as
    // ordinal ramps: light map vs #f2efe9, dark map vs #262626.
    RAMP: {
        light: ["#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
        dark: ["#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"]
    },
    RANGES: { all: null, year: 365, month: 30 },
    RANGE_LABEL: { all: "all time", year: "the past year", month: "the past 30 days" },
    layer: null, pane: "memHeatPane", cells: [], lastStats: null,

    init() {
        try {
            const p = JSON.parse(localStorage.getItem(this.KEY) || "{}");
            if (p.range in this.RANGES) this.range = p.range;
            if (p.who === "mine" || p.who === "all") this.who = p.who;
        } catch (e) { /* defaults */ }
        if (!map.getPane(this.pane)) {
            map.createPane(this.pane);
            const pane = map.getPane(this.pane);
            if (pane) pane.style.zIndex = 450;           // above routes (400), below rider markers (600)
        }
        this.layer = L.layerGroup().addTo(map);
        map.on("zoomend", () => { if (this.on) this.render(); });
        document.addEventListener("mu:memories-changed", () => { if (this.on) this.render(); });
        document.addEventListener("mu:map-style", () => { if (this.on) this.render(); });

        const toggle = $("mem-heat-toggle");
        if (toggle) toggle.addEventListener("click", () => { safeHide("map-style-menu"); this.setOn(!this.on); });
        const galleryBtn = $("p3-heatmap-btn");
        if (galleryBtn) galleryBtn.addEventListener("click", () => { if (window.MemoryUI) window.MemoryUI.closeGallery(); this.setOn(true, { fit: true }); });
        const close = $("mem-heat-close");
        if (close) close.addEventListener("click", () => this.setOn(false));
        const rangeSeg = document.querySelector('[data-segment="memHeatRange"]');
        if (rangeSeg) rangeSeg.addEventListener("segment", (e) => { this.range = e.detail.value; this.savePrefs(); this.render(); });
        const whoSeg = document.querySelector('[data-segment="memHeatWho"]');
        if (whoSeg) whoSeg.addEventListener("segment", (e) => { this.who = e.detail.value; this.savePrefs(); this.render(); });
        this.syncSegments();
    },

    savePrefs() { try { localStorage.setItem(this.KEY, JSON.stringify({ range: this.range, who: this.who })); } catch (e) { /* ignore */ } },
    syncSegments() {
        [["memHeatRange", this.range], ["memHeatWho", this.who]].forEach(([g, v]) => {
            document.querySelectorAll(`[data-segment="${g}"] [data-value]`).forEach((b) => {
                const onB = b.dataset.value === v;
                b.setAttribute("aria-pressed", onB ? "true" : "false");
                b.classList.toggle("on", onB);
            });
        });
    },

    setOn(on, { fit = false } = {}) {
        this.on = Boolean(on);
        const toggle = $("mem-heat-toggle");
        if (toggle) { toggle.setAttribute("aria-checked", this.on ? "true" : "false"); toggle.classList.toggle("active", this.on); }
        const panel = $("mem-heat-panel");
        if (panel) panel.hidden = !this.on;
        if (this.on) {
            if (map.hasLayer(memoryLayer)) map.removeLayer(memoryLayer);
            this.render();
            if (fit) this.fitAll();
        } else {
            this.layer.clearLayers();
            this.cells = [];
            if (!map.hasLayer(memoryLayer)) memoryLayer.addTo(map);
        }
    },

    tone() {
        const active = document.querySelector("#map-style-menu button[data-style].active");
        const style = active ? active.dataset.style : "satellite";
        return style === "street" || style === "terrain" ? "light" : "dark";
    },
    bucketIndex(count) { return this.BUCKETS.findIndex((b) => count >= b.min && count <= b.max); },

    filtered(now = Date.now()) {
        const days = this.RANGES[this.range];
        const since = days ? now - days * 86400000 : -Infinity;
        return Array.from(memories.values()).filter((m) =>
            m && validCoord(Number(m.lat), Number(m.lng)) && Number.isFinite(Number(m.time)) && Number(m.time) >= since &&
            (this.who !== "mine" || (m.ownerKey && m.ownerKey === myOwnerKey)));
    },

    // Screen-space binning at the current zoom: cell (ix, iy) covers the
    // CELL_PX × CELL_PX square of world pixels [ix*S, (ix+1)*S) at this zoom.
    bin(list, zoom = map.getZoom()) {
        const S = this.CELL_PX, byKey = new Map();
        list.forEach((m) => {
            const pt = map.project([Number(m.lat), Number(m.lng)], zoom);
            const ix = Math.floor(pt.x / S), iy = Math.floor(pt.y / S), key = `${ix}:${iy}`;
            let c = byKey.get(key);
            if (!c) { c = { key, ix, iy, items: [] }; byKey.set(key, c); }
            c.items.push(m);
        });
        return Array.from(byKey.values()).map((c) => {
            const times = c.items.map((m) => Number(m.time));
            c.count = c.items.length;
            c.t0 = Math.min(...times); c.t1 = Math.max(...times);
            c.center = map.unproject([(c.ix + 0.5) * S, (c.iy + 0.5) * S], zoom);
            c.bucket = this.bucketIndex(c.count);
            return c;
        }).sort((a, b) => b.count - a.count || b.t1 - a.t1);
    },

    monthSpan(t0, t1) {
        const fmt = (t, withYear) => new Date(t).toLocaleDateString("en-IN", withYear ? { month: "short", year: "numeric" } : { month: "short" });
        const a = new Date(t0), b = new Date(t1);
        if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return fmt(t0, true);
        if (a.getFullYear() === b.getFullYear()) return `${fmt(t0, false)}–${fmt(t1, true)}`;
        return `${fmt(t0, true)} – ${fmt(t1, true)}`;
    },
    whoText(items) {
        const names = [];
        items.forEach((m) => {
            const n = m.ownerKey && m.ownerKey === myOwnerKey ? "You" : (m.name || "Someone");
            if (!names.includes(n)) names.push(n);
        });
        return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
    },
    describeCell(c) { return `${c.count} ${c.count === 1 ? "memory" : "memories"} · ${this.monthSpan(c.t0, c.t1)} · ${this.whoText(c.items)}`; },

    render() {
        if (!this.layer) return;
        this.layer.clearLayers();
        if (!this.on) return;
        const tone = this.tone(), ramp = this.RAMP[tone];
        const list = this.filtered();
        this.cells = this.bin(list);
        const labelled = new Set(this.cells.slice(0, 3).filter((c) => c.count >= 2).map((c) => c.key));
        const size = this.CELL_PX - this.GAP_PX;
        this.cells.forEach((c) => {
            const fill = ramp[c.bucket];
            // Label ink = a text token picked for contrast with the fill, never the ramp colour.
            const ink = (tone === "dark" ? c.bucket >= 2 : c.bucket <= 0) ? "#0b1220" : "#ffffff";
            const html = `<div class="mem-heat-box" style="background:${fill};color:${ink}">${labelled.has(c.key) ? `<span>${c.count}</span>` : ""}</div>`;
            const marker = L.marker(c.center, {
                pane: this.pane, keyboard: true, riseOnHover: true,
                icon: L.divIcon({ className: `mem-heat-cell ring-${tone}`, html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
            });
            marker.bindTooltip(this.describeCell(c), { direction: "top", offset: [0, -size / 2], className: "mem-heat-tip" });
            marker.on("click", () => this.focusCell(c));
            marker.on("add", () => {
                const el = marker.getElement();
                if (el) { el.setAttribute("role", "button"); el.setAttribute("aria-label", `${this.describeCell(c).replace(/ · /g, ", ")}. Tap to zoom in.`); }
            });
            marker.addTo(this.layer);
        });
        this.renderPanel(list, tone, ramp);
    },

    renderPanel(list, tone, ramp) {
        const summary = $("mem-heat-summary");
        if (summary) {
            summary.textContent = list.length
                ? `${list.length} ${list.length === 1 ? "memory" : "memories"} in ${this.cells.length} ${this.cells.length === 1 ? "area" : "areas"} · ${this.RANGE_LABEL[this.range]}`
                : `No ${this.who === "mine" ? "memories of yours" : "memories"} from ${this.RANGE_LABEL[this.range]}.`;
        }
        const legend = $("mem-heat-legend");
        if (legend) {
            legend.dataset.tone = tone;
            legend.innerHTML = this.BUCKETS.map((b, i) =>
                `<span class="mh-step"><i class="ring-${tone}" style="background:${ramp[i]}" aria-hidden="true"></i>${b.label}</span>`).join("") +
                `<span class="mh-unit">memories per square</span>`;
        }
        const top = $("mem-heat-top-list");
        if (top) {
            top.innerHTML = "";
            this.cells.slice(0, 5).forEach((c) => {
                const li = document.createElement("li");
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = this.describeCell(c);
                btn.addEventListener("click", () => this.focusCell(c));
                li.appendChild(btn);
                top.appendChild(li);
            });
            const wrap = $("mem-heat-top");
            if (wrap) wrap.hidden = this.cells.length === 0;
        }
        this.lastStats = { memories: list.length, cells: this.cells.length, tone };
    },

    fitAll() {
        const list = this.filtered();
        if (!list.length) return;
        const b = L.latLngBounds(list.map((m) => [Number(m.lat), Number(m.lng)]));
        if (b.isValid()) map.fitBounds(b.pad(0.2), { maxZoom: 15 });
    },

    focusCell(c) {
        const b = L.latLngBounds(c.items.map((m) => [Number(m.lat), Number(m.lng)]));
        const spreadPx = (() => {
            const z = Math.min(this.MAX_FOCUS_ZOOM, map.getZoom() + 3);
            const nw = map.project(b.getNorthWest(), z), se = map.project(b.getSouthEast(), z);
            return Math.max(Math.abs(se.x - nw.x), Math.abs(se.y - nw.y));
        })();
        // Zoom in while zooming can still split the cell; otherwise list the photos.
        if (map.getZoom() < this.MAX_FOCUS_ZOOM && c.count > 1 && spreadPx >= this.CELL_PX) {
            map.fitBounds(b.pad(0.35), { maxZoom: this.MAX_FOCUS_ZOOM });
            return;
        }
        const items = c.items.slice().sort((a, b2) => Number(b2.time) - Number(a.time));
        const box = document.createElement("div");
        box.className = "mem-heat-popup";
        const head = document.createElement("b");
        head.textContent = this.describeCell(c);
        box.appendChild(head);
        const grid = document.createElement("div");
        grid.className = "mem-heat-thumbs";
        items.slice(0, 6).forEach((m) => {
            const t = document.createElement("button");
            t.type = "button";
            t.setAttribute("aria-label", `${m.name || "Memory"}, ${new Date(Number(m.time)).toLocaleDateString("en-IN")}`);
            const img = document.createElement("img");
            img.src = m.image; img.alt = ""; img.loading = "lazy";
            t.appendChild(img);
            t.addEventListener("click", () => { if (window.MemoryUI) window.MemoryUI.open(m); });
            grid.appendChild(t);
        });
        box.appendChild(grid);
        if (items.length > 6) { const more = document.createElement("small"); more.textContent = `+${items.length - 6} more in the gallery`; box.appendChild(more); }
        L.popup({ maxWidth: 260, className: "mem-heat-popup-wrap" }).setLatLng(c.center).setContent(box).openOn(map);
    }
};
