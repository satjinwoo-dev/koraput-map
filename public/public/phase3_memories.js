// ============================================================
// KORAPUT MAP — PHASE 3 MEMORIES
// 13. Memory Gallery
// 14. Better Memory Popup
// 15. Filter Memories
// 16. Photo Timeline
// ============================================================

(() => {
    "use strict";

    // --------------------------------------------------------
    // SAFETY / DEPENDENCIES
    // --------------------------------------------------------
    if (typeof L === "undefined") {
        console.error("Phase 3: Leaflet is not loaded.");
        return;
    }
    if (typeof socket === "undefined") {
        console.error("Phase 3: Socket.IO is not available.");
        return;
    }

    const mapElement = document.getElementById("map");
    if (!mapElement) {
        console.error("Phase 3: #map not found.");
        return;
    }

    // --------------------------------------------------------
    // STATE
    // --------------------------------------------------------
    let memories = [];
    let activeFilter = "all";
    let currentSearch = "";
    let selectedMemory = null;

    const memoryLayer = L.layerGroup().addTo(map);

    // --------------------------------------------------------
    // HELPERS
    // --------------------------------------------------------
    function escapeHTML(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function cleanMemoryName(name) {
        return String(name || "Memory").trim().replace(/\s+/g, " ").slice(0, 40);
    }

    function validCoordinate(lat, lng) {
        const a = Number(lat);
        const b = Number(lng);
        return (Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180);
    }

    function formatDate(value) {
        if (!value) return "Unknown date";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    function getDateValue(memory) {
        const date = new Date(memory?.time || 0).getTime();
        return Number.isFinite(date) ? date : 0;
    }

    function sortNewestFirst(list) {
        return [...list].sort((a, b) => getDateValue(b) - getDateValue(a));
    }

    function isMine(memory) {
        return typeof currentUser !== "undefined" && cleanMemoryName(memory.name) === cleanMemoryName(currentUser.name);
    }

    function getFilteredMemories() {
        let result = Array.from(memories);

        if (activeFilter === "today") {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            result = result.filter(m => getDateValue(m) >= start);
        } else if (activeFilter === "week") {
            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            result = result.filter(m => getDateValue(m) >= sevenDaysAgo);
        } else if (activeFilter === "mine") {
            result = result.filter(isMine);
        } else if (activeFilter === "others") {
            result = result.filter(m => !isMine(m));
        }

        if (currentSearch) {
            const search = currentSearch.toLowerCase();
            result = result.filter(m => cleanMemoryName(m.name).toLowerCase().includes(search));
        }

        return sortNewestFirst(result);
    }

    // --------------------------------------------------------
    // PHASE 3 UI
    // --------------------------------------------------------
    function createUI() {
        if (document.getElementById("phase3-memory-panel")) return;

        const style = document.createElement("style");
        style.id = "phase3-memory-style";
        style.textContent = `
        /* HIDE OLD PINS FROM APP.JS SO THEY DON'T DOUBLE OVERLAP */
        .custom-pin { display: none !important; }

        /* =====================================================
           PHASE 3 MEMORY UI
        ===================================================== */
        #phase3-memory-open {
            position: fixed; left: 76px; bottom: 17px; z-index: 1200;
            width: 48px; height: 48px; border: 1px solid rgba(255,255,255,0.12); border-radius: 14px;
            background: rgba(7,16,24,0.94); color: white; display: flex; align-items: center; justify-content: center;
            font-size: 20px; box-shadow: 0 12px 40px rgba(0,0,0,0.55); backdrop-filter: blur(14px); cursor: pointer;
        }
        #phase3-memory-open:hover { background: rgba(16,185,129,0.18); }
        #phase3-memory-overlay {
            position: fixed; inset: 0; z-index: 8000; display: none;
            background: rgba(0,0,0,0.65); backdrop-filter: blur(8px);
        }
        #phase3-memory-panel {
            position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
            width: min(760px, calc(100vw - 24px)); height: min(680px, calc(100vh - 30px));
            overflow: hidden; display: flex; flex-direction: column;
            background: #0b151c; border: 1px solid rgba(255,255,255,0.10); border-radius: 22px;
            box-shadow: 0 30px 100px rgba(0,0,0,0.75);
        }
        #phase3-memory-header {
            flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
            padding: 15px 17px; border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        #phase3-memory-title { display: flex; flex-direction: column; }
        #phase3-memory-title strong { font-size: 16px; color: white; }
        #phase3-memory-title span { margin-top: 3px; font-size: 10px; color: #84949d; }
        #phase3-memory-close {
            width: 34px; height: 34px; border: 0; border-radius: 10px;
            background: rgba(255,255,255,0.06); color: white; font-size: 19px; cursor: pointer;
        }
        #phase3-memory-filters {
            display: flex; gap: 6px; padding: 10px 13px; overflow-x: auto;
            border-bottom: 1px solid rgba(255,255,255,0.06); align-items: center;
        }
        .phase3-filter {
            flex: 0 0 auto; padding: 7px 11px; border: 1px solid rgba(255,255,255,0.08); border-radius: 999px;
            background: rgba(255,255,255,0.04); color: #aab7bd; font-size: 10px; cursor: pointer;
        }
        .phase3-filter.active { background: rgba(16,185,129,0.16); border-color: rgba(24,214,163,0.35); color: #18d6a3; }
        #phase3-memory-search {
            flex: 1; min-width: 120px; border: 1px solid rgba(255,255,255,.10); border-radius: 999px;
            padding: 7px 11px; background: rgba(255,255,255,.04); color: white; outline: none; font-size: 10px;
        }
        #phase3-memory-content { flex: 1; min-height: 0; overflow-y: auto; padding: 13px; }
        #phase3-memory-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
        .phase3-memory-card { position: relative; aspect-ratio: 1 / 1; overflow: hidden; border-radius: 13px; background: #111d24; border: 1px solid rgba(255,255,255,0.08); cursor: pointer; }
        .phase3-memory-card img { width: 100%; height: 100%; display: block; object-fit: cover; transition: transform 0.25s ease; }
        .phase3-memory-card:hover img { transform: scale(1.05); }
        .phase3-memory-card-info { position: absolute; left: 0; right: 0; bottom: 0; padding: 24px 8px 8px; background: linear-gradient(transparent, rgba(0,0,0,0.8)); color: white; }
        .phase3-memory-card-name { font-size: 10px; font-weight: 700; }
        .phase3-memory-card-date { margin-top: 2px; color: #bdc8cd; font-size: 8px; }
        #phase3-memory-empty { padding: 50px 20px; text-align: center; color: #819099; font-size: 12px; }
        
        #phase3-photo-viewer { position: fixed; inset: 0; z-index: 9000; display: none; align-items: center; justify-content: center; padding: 18px; background: rgba(0,0,0,0.88); backdrop-filter: blur(7px); }
        #phase3-photo-card { width: min(700px, 100%); max-height: calc(100vh - 36px); overflow: hidden; display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; background: #0c171e; box-shadow: 0 30px 100px rgba(0,0,0,0.8); }
        #phase3-photo-image { width: 100%; max-height: 60vh; object-fit: contain; background: #020608; }
        #phase3-photo-info { padding: 15px; }
        #phase3-photo-name { color: white; font-size: 16px; font-weight: 750; }
        #phase3-photo-date { margin-top: 4px; color: #8999a2; font-size: 10px; }
        #phase3-photo-location { margin-top: 10px; padding: 9px 11px; border-radius: 10px; background: rgba(255,255,255,0.05); color: #c9d3d8; font-size: 10px; }
        #phase3-photo-actions { display: flex; gap: 7px; margin-top: 10px; }
        .phase3-photo-action { flex: 1; padding: 10px; border: 0; border-radius: 10px; background: rgba(16,185,129,0.16); color: #18d6a3; font-size: 11px; font-weight: 700; cursor: pointer; }
        #phase3-photo-close { background: rgba(255,255,255,0.07); color: #d5dde0; }

        #phase3-memory-timeline { margin-top: 20px; }
        .phase3-timeline-title { margin-bottom: 10px; color: white; font-size: 12px; font-weight: 750; }
        .phase3-timeline-item { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; }
        .phase3-timeline-thumb { flex: 0 0 52px; width: 52px; height: 52px; overflow: hidden; border-radius: 10px; }
        .phase3-timeline-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .phase3-timeline-info { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
        .phase3-timeline-name { color: #e8eef0; font-size: 11px; font-weight: 700; }
        .phase3-timeline-date { margin-top: 3px; color: #84949d; font-size: 9px; }
        .phase3-timeline-location { margin-top: 3px; color: #6f8088; font-size: 8px; }

        /* LEAFLET POPUP CSS OVERRIDE FOR MEMORIES */
        .leaflet-popup-content-wrapper { background: #111b21 !important; color: #fff !important; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; box-shadow: 0 15px 40px rgba(0,0,0,0.6); }
        .leaflet-popup-tip { background: #111b21 !important; border: 1px solid rgba(255,255,255,0.1); }
        .leaflet-popup-close-button { color: #fff !important; }

        @media (max-width: 600px) {
            #phase3-memory-open { left: 74px; bottom: 12px; }
            #phase3-memory-panel { width: 100vw; height: 100dvh; border-radius: 0; border: 0; }
            #phase3-memory-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            #phase3-photo-card { width: 100%; border-radius: 16px; }
            #phase3-photo-image { max-height: 58vh; }
        }
        @media (max-width: 380px) {
            #phase3-memory-grid { gap: 6px; }
            #phase3-memory-content { padding: 9px; }
        }
        `;
        document.head.appendChild(style);

        // ----------------------------------------------------
        // MEMORY GALLERY BUTTON
        // ----------------------------------------------------
        const openButton = document.createElement("button");
        openButton.id = "phase3-memory-open";
        openButton.type = "button";
        openButton.title = "Memory gallery";
        openButton.textContent = "🖼️";
        document.body.appendChild(openButton);

        // ----------------------------------------------------
        // GALLERY OVERLAY
        // ----------------------------------------------------
        const overlay = document.createElement("div");
        overlay.id = "phase3-memory-overlay";
        overlay.innerHTML = `
            <div id="phase3-memory-panel">
                <div id="phase3-memory-header">
                    <div id="phase3-memory-title">
                        <strong>Memories</strong>
                        <span id="phase3-memory-count">0 memories</span>
                    </div>
                    <button id="phase3-memory-close" type="button">×</button>
                </div>
                <div id="phase3-memory-filters">
                    <button class="phase3-filter active" data-filter="all" type="button">All</button>
                    <button class="phase3-filter" data-filter="today" type="button">Today</button>
                    <button class="phase3-filter" data-filter="week" type="button">Last 7 days</button>
                    <button class="phase3-filter" data-filter="mine" type="button">Mine</button>
                    <button class="phase3-filter" data-filter="others" type="button">Others</button>
                    <input id="phase3-memory-search" type="text" placeholder="Search name...">
                </div>
                <div id="phase3-memory-content">
                    <div id="phase3-memory-grid"></div>
                    <div id="phase3-memory-empty">No memories yet.</div>
                    <div id="phase3-memory-timeline">
                        <div class="phase3-timeline-title">Photo Timeline</div>
                        <div id="phase3-timeline-list"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // ----------------------------------------------------
        // PHOTO VIEWER
        // ----------------------------------------------------
        const viewer = document.createElement("div");
        viewer.id = "phase3-photo-viewer";
        viewer.innerHTML = `
            <div id="phase3-photo-card">
                <img id="phase3-photo-image" src="" alt="Memory">
                <div id="phase3-photo-info">
                    <div id="phase3-photo-name">Memory</div>
                    <div id="phase3-photo-date">--</div>
                    <div id="phase3-photo-location">📍 Location unavailable</div>
                    <div id="phase3-photo-actions">
                        <button id="phase3-photo-focus" class="phase3-photo-action" type="button">📍 Focus on map</button>
                        <button id="phase3-photo-close" class="phase3-photo-action" type="button">Close</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(viewer);

        setupEvents();
    }

    // ======================================
    // EVENT BINDINGS
    // ======================================
    function setupEvents() {
        document.getElementById("phase3-memory-open")?.addEventListener("click", openGallery);
        document.getElementById("phase3-memory-close")?.addEventListener("click", closeGallery);
        document.getElementById("phase3-memory-overlay")?.addEventListener("click", event => {
            if (event.target.id === "phase3-memory-overlay") closeGallery();
        });

        document.getElementById("phase3-photo-close")?.addEventListener("click", closeViewer);
        document.getElementById("phase3-photo-viewer")?.addEventListener("click", event => {
            if (event.target.id === "phase3-photo-viewer") closeViewer();
        });

        document.getElementById("phase3-photo-focus")?.addEventListener("click", () => {
            if (!selectedMemory) return;
            if (validCoordinate(selectedMemory.lat, selectedMemory.lng)) {
                map.flyTo([Number(selectedMemory.lat), Number(selectedMemory.lng)], 17, { animate: true });
                closeViewer();
                closeGallery();
            }
        });

        document.querySelectorAll(".phase3-filter").forEach(button => {
            button.addEventListener("click", () => {
                activeFilter = button.dataset.filter || "all";
                document.querySelectorAll(".phase3-filter").forEach(item => item.classList.remove("active"));
                button.classList.add("active");
                refreshMemoryUI();
            });
        });

        document.getElementById("phase3-memory-search")?.addEventListener("input", (e) => {
            currentSearch = e.target.value;
            refreshMemoryUI();
        });

        document.addEventListener("keydown", event => {
            if (event.key === "Escape") { closeViewer(); closeGallery(); }
        });
    }

    // =================================-----------------------
    // OPEN / CLOSE OVERLAYS
    // --------------------------------------------------------
    function openGallery() {
        const overlay = document.getElementById("phase3-memory-overlay");
        if (overlay) { overlay.style.display = "block"; refreshMemoryUI(); }
    }
    function closeGallery() {
        const overlay = document.getElementById("phase3-memory-overlay");
        if (overlay) overlay.style.display = "none";
    }

    function openViewer(memory) {
        if (!memory || typeof memory !== "object") return;
        selectedMemory = memory;

        const image = document.getElementById("phase3-photo-image");
        const name = document.getElementById("phase3-photo-name");
        const date = document.getElementById("phase3-photo-date");
        const location = document.getElementById("phase3-photo-location");

        if (image) image.src = memory.image || "";
        if (name) name.textContent = memory.name || "Memory";
        if (date) date.textContent = formatDate(memory.time);
        if (location) {
            if (validCoordinate(memory.lat, memory.lng)) location.textContent = `📍 ${Number(memory.lat).toFixed(5)}, ${Number(memory.lng).toFixed(5)}`;
            else location.textContent = "📍 Location unavailable";
        }

        const viewer = document.getElementById("phase3-photo-viewer");
        if (viewer) viewer.style.display = "flex";
    }

    function closeViewer() {
        const viewer = document.getElementById("phase3-photo-viewer");
        if (viewer) viewer.style.display = "none";
        selectedMemory = null;
    }

    // --------------------------------------------------------
    // RENDER GALLERY & TIMELINE
    // --------------------------------------------------------
    function renderGallery() {
        const grid = document.getElementById("phase3-memory-grid");
        const empty = document.getElementById("phase3-memory-empty");
        const timeline = document.getElementById("phase3-timeline-list");
        const count = document.getElementById("phase3-memory-count");

        if (!grid || !empty || !timeline) return;

        const filtered = getFilteredMemories();

        if (count) {
            count.textContent = `${filtered.length} ${filtered.length === 1 ? "memory" : "memories"}`;
        }

        grid.innerHTML = "";
        timeline.innerHTML = "";
        empty.style.display = filtered.length === 0 ? "block" : "none";

        // Render Grid
        filtered.forEach(memory => {
            if (!memory.image) return;
            const card = document.createElement("div");
            card.className = "phase3-memory-card";
            card.innerHTML = `
                <img src="${escapeHTML(memory.image)}" alt="Memory" loading="lazy">
                <div class="phase3-memory-card-info">
                    <div class="phase3-memory-card-name">${escapeHTML(memory.name || "Memory")}</div>
                    <div class="phase3-memory-card-date">${escapeHTML(formatDate(memory.time))}</div>
                </div>
            `;
            card.addEventListener("click", () => openViewer(memory));
            grid.appendChild(card);
        });

        // Render Timeline
        filtered.forEach(memory => {
            const item = document.createElement("div");
            item.className = "phase3-timeline-item";
            const coords = validCoordinate(memory.lat, memory.lng) ? `${Number(memory.lat).toFixed(4)}, ${Number(memory.lng).toFixed(4)}` : "Location unavailable";
            item.innerHTML = `
                <div class="phase3-timeline-thumb">
                    <img src="${escapeHTML(memory.image || "")}" alt="Memory" loading="lazy">
                </div>
                <div class="phase3-timeline-info">
                    <div class="phase3-timeline-name">${escapeHTML(memory.name || "Memory")}</div>
                    <div class="phase3-timeline-date">${escapeHTML(formatDate(memory.time))}</div>
                    <div class="phase3-timeline-location">📍 ${escapeHTML(coords)}</div>
                </div>
            `;
            item.addEventListener("click", () => openViewer(memory));
            timeline.appendChild(item);
        });
    }

    function refreshMemoryUI() {
        renderGallery();
    }

    // --------------------------------------------------------
    // MEMORY MAP MARKERS (Phase 3 Override)
    // --------------------------------------------------------
    function createMemoryIcon(memory) {
        return L.divIcon({
            className: "phase3-memory-marker",
            html: `
                <div style="width:46px; height:46px; border-radius:50%; overflow:hidden; background:#071018; border:2px solid white; box-shadow: 0 4px 15px rgba(0,0,0,0.65);">
                    <img src="${escapeHTML(memory.image)}" style="width:100%; height:100%; object-fit:cover; display:block;" alt="Memory">
                </div>
            `,
            iconSize: [46, 46],
            iconAnchor: [23, 23]
        });
    }

    function renderMemoryMarkers() {
        memoryLayer.clearLayers();
        memories.forEach(memory => {
            if (!validCoordinate(memory.lat, memory.lng) || !memory.image) return;

            const marker = L.marker([Number(memory.lat), Number(memory.lng)], { icon: createMemoryIcon(memory) });

            marker.bindPopup(`
                <div style="width:230px; padding:3px; color:#111;">
                    <img src="${escapeHTML(memory.image)}" style="width:100%; max-height:180px; object-fit:cover; border-radius:10px; display:block; margin-bottom:9px;" alt="Memory">
                    <strong style="font-size:14px; color:#18d6a3;">📸 ${escapeHTML(memory.name || "Memory")}</strong>
                    <div style="margin-top:4px; color:#8fa1aa; font-size:10px;">${escapeHTML(formatDate(memory.time))}</div>
                    <button type="button" class="phase3-open-memory" style="width:100%; margin-top:9px; padding:8px; border:0; border-radius:8px; background:#10b981; color:white; font-weight:700; cursor:pointer;">View Memory</button>
                </div>
            `);

            marker.on("popupopen", event => {
                const popupElement = event.popup.getElement();
                if (!popupElement) return;
                const button = popupElement.querySelector(".phase3-open-memory");
                if (button) {
                    button.onclick = () => openViewer(memory);
                }
            });

            marker.addTo(memoryLayer);
        });
    }

    // --------------------------------------------------------
    // MEMORY DATA SYNC
    // --------------------------------------------------------
    function replaceMemories(list) {
        if (!Array.isArray(list)) return;
        memories = list.filter(memory => {
            if (!memory || typeof memory !== "object") return false;
            if (typeof memory.image !== "string" || !memory.image) return false;
            return validCoordinate(memory.lat, memory.lng);
        }).slice(-500);

        renderMemoryMarkers();
        if (document.getElementById("phase3-memory-overlay")?.style.display === "block") refreshMemoryUI();
    }

    function addMemory(memory) {
        if (!memory || typeof memory !== "object" || !memory.image || !validCoordinate(memory.lat, memory.lng)) return;

        const exists = memories.some(item => {
            if (memory.id && item.id) return item.id === memory.id;
            return (item.image === memory.image && Number(item.lat) === Number(memory.lat) && Number(item.lng) === Number(memory.lng));
        });

        if (exists) return;

        memories.push(memory);
        if (memories.length > 500) memories.shift();

        renderMemoryMarkers();
        if (document.getElementById("phase3-memory-overlay")?.style.display === "block") refreshMemoryUI();
    }

    // --------------------------------------------------------
    // SOCKET EVENTS
    // --------------------------------------------------------
    socket.on("loadMemoryPhotos", list => {
        replaceMemories(list);
        console.log(`Phase 3: loaded ${memories.length} memories`);
    });

    socket.on("newMemoryPin", memory => {
        addMemory(memory);
        console.log("Phase 3: new memory received");
    });

    // --------------------------------------------------------
    // START
    // --------------------------------------------------------
    function init() {
        createUI();
        console.log("Koraput Map Phase 3 Memories loaded.");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();
