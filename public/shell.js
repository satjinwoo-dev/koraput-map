"use strict";

/* ============================================================================
   MapUnite UI shell — shell.js
   ==============================================================================
   Loaded BEFORE the app scripts (js/*.js). Owns everything that is presentation
   plumbing so the HTML needs no inline scripts (CSP-safe) and app logic can
   stay in the app scripts (js/*.js):

     1. Service-worker registration      (the ONLY place that registers /sw.js)
     2. StatusIsland                     priority-aware adaptive status capsule
     3. UI helpers                       confirm sheet, segmented controls,
                                         data-open / data-close / data-action,
                                         popovers, viewport-height variable

   Public API (stable contract for the app scripts in js/):
     StatusIsland.show({ id, kind, title, sub, icon, meta, priority, ttl,
                         sticky, action:{label,onClick}, haptic })   -> id
     StatusIsland.hide(id)          StatusIsland.clear(kind?)
     StatusIsland.setIdle({ text, tone })
     MapUnite.confirm({ title, body, okLabel, cancelLabel, danger,
                        checkboxLabel })          -> Promise<{ok, checked}>
     MapUnite.toast(message, ms)    MapUnite.open(id)   MapUnite.close(id)
     MapUnite.setSegment(group, value)
     MapUnite.sw.purgeTileCache()   MapUnite.sw.version()
   Events dispatched on document:
     "island:show"  detail = the normalised island spec (hook audio / speech here)
     "segment"      bubbles from a [data-segment] element, detail {group, value}
   ============================================================================ */

(function () {
    const $ = (id) => document.getElementById(id);
    const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const safeStorageGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

    // ======================================================================
    // 1. SERVICE WORKER — single, idempotent registration path
    // ======================================================================
    const swApi = (() => {
        let registration = null;

        function postWithReply(message) {
            return new Promise((resolve) => {
                const target = (navigator.serviceWorker && navigator.serviceWorker.controller) || (registration && registration.active);
                if (!target) return resolve(null);
                const ch = new MessageChannel();
                const timer = setTimeout(() => resolve(null), 3000);
                ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
                target.postMessage(message, [ch.port2]);
            });
        }

        function promptUpdate(worker) {
            if (!worker) return;
            StatusIsland.show({
                id: "sw-update", kind: "info", title: "Update ready", sub: "Tap to restart with the latest version",
                icon: "⬆️", priority: 35, ttl: 0, sticky: true,
                action: { label: "Update", onClick: () => worker.postMessage({ type: "SKIP_WAITING" }) }
            });
        }

        function boot() {
            if (!("serviceWorker" in navigator) || window.__muSwBooted) return;
            window.__muSwBooted = true;

            // A reload on controllerchange is right ONLY for an update. The very
            // first install also fires controllerchange (clients.claim); reloading
            // then would flash the app for no reason.
            let controlled = Boolean(navigator.serviceWorker.controller);
            let reloading = false;
            navigator.serviceWorker.addEventListener("controllerchange", () => {
                if (!controlled) { controlled = true; return; }
                if (reloading) return;
                reloading = true;
                window.location.reload();
            });

            const start = async () => {
                try {
                    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
                    if (registration.waiting && navigator.serviceWorker.controller) promptUpdate(registration.waiting);
                    registration.addEventListener("updatefound", () => {
                        const w = registration.installing;
                        if (!w) return;
                        w.addEventListener("statechange", () => {
                            if (w.state === "installed" && navigator.serviceWorker.controller) promptUpdate(w);
                        });
                    });
                    const check = () => registration && registration.update().catch(() => {});
                    setInterval(check, 30 * 60 * 1000);
                    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
                } catch (err) {
                    console.warn("[SW] registration failed:", err);
                }
            };
            if (document.readyState === "complete") start(); else window.addEventListener("load", start, { once: true });
        }

        return {
            boot,
            purgeTileCache: () => postWithReply({ type: "PURGE_TILE_CACHE" }),
            version: async () => { const r = await postWithReply({ type: "GET_VERSION" }); return r ? r.version : null; }
        };
    })();

    // ======================================================================
    // 2. STATUS ISLAND — priority-aware, escalation-safe
    // ======================================================================
    // A lower-priority spec can NEVER replace or suppress a higher-priority one:
    // it waits in the queue (and expires there if its TTL passes first). An equal
    // or higher priority spec pre-empts immediately. A pre-empted STICKY spec
    // (e.g. a turn maneuver) is restored afterwards; a pre-empted transient one
    // is superseded and dropped.
    const KIND_DEFAULTS = {
        idle:          { priority: 0,   ttl: 0,     icon: "●" },
        safe:          { priority: 20,  ttl: 3500,  icon: "✓" },
        info:          { priority: 30,  ttl: 4000,  icon: "ℹ️" },
        turn:          { priority: 40,  ttl: 0,     icon: "➜", sticky: true },
        geofence:      { priority: 50,  ttl: 5500,  icon: "⭕" },
        sensor:        { priority: 55,  ttl: 6000,  icon: "📡" },
        "speed-warn":  { priority: 60,  ttl: 4500,  icon: "⚠️" },
        "speed-danger":{ priority: 90,  ttl: 8000,  icon: "🚨" },
        sos:           { priority: 100, ttl: 15000, icon: "🆘" }
    };
    const HAPTICS = {
        turn: [30], geofence: [40, 30, 40], sensor: [60, 40, 60], "speed-warn": [70, 40, 70],
        "speed-danger": [220, 90, 220, 90, 420], sos: [500, 120, 500, 120, 500]
    };
    const MAX_QUEUE = 6;

    const StatusIsland = (() => {
        let el, iconEl, titleEl, subEl, metaEl, actionEl;
        let current = null;              // normalised spec currently displayed
        let queue = [];
        let expiryTimer = null;
        let swapTimer = null;
        let idle = { text: "Live", tone: "ok" };
        let seq = 0;

        function bind() {
            el = $("status-island");
            if (!el) return false;
            iconEl = $("island-icon"); titleEl = $("island-title"); subEl = $("island-sub");
            metaEl = $("island-meta"); actionEl = $("island-action");
            el.addEventListener("click", (e) => {
                if (e.target === actionEl) return;
                if (current && current.kind !== "idle" && current.kind !== "sos") hide(current.id);
            });
            el.addEventListener("keydown", (e) => {
                if ((e.key === "Escape" || e.key === "Enter" || e.key === " ") && current && current.kind !== "idle" && current.kind !== "sos") {
                    e.preventDefault(); hide(current.id);
                }
            });
            if (actionEl) actionEl.addEventListener("click", (e) => {
                e.stopPropagation();
                const a = current && current.action;
                if (a && typeof a.onClick === "function") { try { a.onClick(); } catch (err) { console.error(err); } }
                if (current && !current.sticky) hide(current.id);
            });
            renderIdle();
            return true;
        }

        function normalise(spec) {
            const kind = KIND_DEFAULTS[spec.kind] ? spec.kind : "info";
            const d = KIND_DEFAULTS[kind];
            const now = Date.now();
            const ttl = Number.isFinite(spec.ttl) ? spec.ttl : d.ttl;
            const sticky = spec.sticky !== undefined ? Boolean(spec.sticky) : Boolean(d.sticky);
            return {
                id: spec.id || `isl-${++seq}`, kind,
                title: String(spec.title ?? ""), sub: spec.sub ? String(spec.sub) : "",
                icon: spec.icon || d.icon, meta: spec.meta ? String(spec.meta) : "",
                priority: Number.isFinite(spec.priority) ? spec.priority : d.priority,
                ttl, sticky, action: spec.action && spec.action.label ? spec.action : null,
                haptic: spec.haptic !== false, createdAt: now,
                expiresAt: ttl > 0 ? now + ttl : null
            };
        }

        const isExpired = (s, now = Date.now()) => s.expiresAt !== null && s.expiresAt <= now;

        function setContent(spec) {
            el.dataset.state = spec.kind;
            el.dataset.size = (spec.sub || spec.action) ? "expanded" : "pill";
            el.setAttribute("aria-live", spec.priority >= 90 ? "assertive" : "polite");
            if (iconEl) iconEl.textContent = spec.icon;
            if (titleEl) titleEl.textContent = spec.title;
            if (subEl) { subEl.textContent = spec.sub; subEl.hidden = !spec.sub; }
            if (metaEl) { metaEl.textContent = spec.meta; metaEl.hidden = !spec.meta; }
            if (actionEl) { actionEl.textContent = spec.action ? spec.action.label : ""; actionEl.hidden = !spec.action; }
        }

        function crossfade(spec) {
            if (reducedMotion()) { setContent(spec); return; }
            el.classList.add("is-swapping");
            clearTimeout(swapTimer);
            swapTimer = setTimeout(() => { setContent(spec); el.classList.remove("is-swapping"); }, 90);
        }

        function renderIdle() {
            if (!el) return;
            current = null;
            clearTimeout(expiryTimer);
            crossfade({
                kind: "idle", title: idle.text, sub: "", icon: idle.tone === "warn" ? "◐" : "●",
                meta: "", priority: 0, action: null
            });
            el.dataset.tone = idle.tone;
        }

        function vibrateFor(spec) {
            if (!spec.haptic || !HAPTICS[spec.kind]) return;
            if (safeStorageGet("mu_haptics") === "0") return;
            try { if (navigator.vibrate) navigator.vibrate(HAPTICS[spec.kind]); } catch { /* ignore */ }
        }

        function present(spec) {
            current = spec;
            clearTimeout(expiryTimer);
            if (spec.expiresAt !== null) {
                expiryTimer = setTimeout(() => hide(spec.id), Math.max(0, spec.expiresAt - Date.now()));
            }
            crossfade(spec);
            vibrateFor(spec);
            document.dispatchEvent(new CustomEvent("island:show", { detail: spec }));
        }

        function nextFromQueue() {
            const now = Date.now();
            queue = queue.filter((s) => !isExpired(s, now));
            if (queue.length === 0) { renderIdle(); return; }
            let best = 0;
            for (let i = 1; i < queue.length; i++) {
                if (queue[i].priority > queue[best].priority ||
                    (queue[i].priority === queue[best].priority && queue[i].createdAt < queue[best].createdAt)) best = i;
            }
            const [spec] = queue.splice(best, 1);
            present(spec);
        }

        function show(input) {
            if (!el && !bind()) return null;
            const spec = normalise(input || {});
            const now = Date.now();
            queue = queue.filter((s) => !isExpired(s, now) && s.id !== spec.id);

            if (current && current.id === spec.id) {           // update in place, keep position
                spec.createdAt = current.createdAt;
                present(spec);
                return spec.id;
            }
            if (!current || spec.priority >= current.priority) {
                if (current && current.sticky && !isExpired(current)) queue.push(current);   // restore later
                present(spec);
            } else {
                queue.push(spec);                                 // lower tier cannot suppress a higher one
                if (queue.length > MAX_QUEUE) {
                    queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
                    queue.length = MAX_QUEUE;
                }
            }
            return spec.id;
        }

        function hide(id) {
            if (!el) return;
            queue = queue.filter((s) => s.id !== id);
            if (current && current.id === id) nextFromQueue();
        }

        function clear(kind) {
            queue = kind ? queue.filter((s) => s.kind !== kind) : [];
            if (!kind || (current && current.kind === kind)) nextFromQueue();
        }

        function setIdle(next) {
            idle = { text: String(next?.text ?? idle.text), tone: next?.tone === "warn" ? "warn" : "ok" };
            if (!current) renderIdle();
        }

        function _debug() { return { current, queue: queue.slice() }; }

        return { bind, show, hide, clear, setIdle, _debug };
    })();

    // ======================================================================
    // 3. UI HELPERS
    // ======================================================================
    function open(id, display = "flex") { const e = $(id); if (e) { e.style.display = display; e.setAttribute("aria-hidden", "false"); } }
    function close(id) { const e = $(id); if (e) { e.style.display = "none"; e.setAttribute("aria-hidden", "true"); } }

    function toast(message, ms = 3500) {
        const c = $("toast-container");
        if (!c) return;
        const t = document.createElement("div");
        t.className = "toast";
        t.textContent = String(message);
        c.appendChild(t);
        setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, ms);
    }

    // Promise-based confirmation sheet — replaces window.confirm() (which is
    // blocked in installed PWAs on some platforms and breaks the visual language).
    function confirmSheet(opts = {}) {
        const modal = $("confirm-modal");
        if (!modal) return Promise.resolve({ ok: window.confirm(String(opts.body || opts.title || "Are you sure?")), checked: false });
        const okBtn = $("confirm-ok"), cancelBtn = $("confirm-cancel");
        const checkWrap = $("confirm-check-wrap"), checkbox = $("confirm-check"), checkLabel = $("confirm-check-label");
        $("confirm-title").textContent = opts.title || "Are you sure?";
        $("confirm-body").textContent = opts.body || "";
        okBtn.textContent = opts.okLabel || "Confirm";
        cancelBtn.textContent = opts.cancelLabel || "Cancel";
        okBtn.classList.toggle("btn-danger-nav", Boolean(opts.danger));
        okBtn.classList.toggle("btn-primary-nav", !opts.danger);
        if (checkWrap) {
            checkWrap.hidden = !opts.checkboxLabel;
            if (checkLabel) checkLabel.textContent = opts.checkboxLabel || "";
            if (checkbox) checkbox.checked = false;
        }
        const previouslyFocused = document.activeElement;
        open("confirm-modal");
        cancelBtn.focus();

        return new Promise((resolve) => {
            const finish = (ok) => {
                close("confirm-modal");
                okBtn.removeEventListener("click", onOk);
                cancelBtn.removeEventListener("click", onCancel);
                modal.removeEventListener("click", onBackdrop);
                document.removeEventListener("keydown", onKey, true);
                if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
                resolve({ ok, checked: Boolean(checkbox && checkbox.checked) });
            };
            const onOk = () => finish(true);
            const onCancel = () => finish(false);
            const onBackdrop = (e) => { if (e.target === modal) finish(false); };
            const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); finish(false); } };
            okBtn.addEventListener("click", onOk);
            cancelBtn.addEventListener("click", onCancel);
            modal.addEventListener("click", onBackdrop);
            document.addEventListener("keydown", onKey, true);
        });
    }

    function setSegment(group, value) {
        document.querySelectorAll(`[data-segment="${group}"] [data-value]`).forEach((b) => {
            const on = b.dataset.value === String(value);
            b.setAttribute("aria-pressed", on ? "true" : "false");
            b.classList.toggle("on", on);
        });
    }

    // Resolve "TripDB.downloadDetailedInfo" style paths and call with the right `this`.
    function callGlobal(path, arg) {
        const parts = String(path).split(".");
        let ctx = window;
        for (let i = 0; i < parts.length - 1; i++) { ctx = ctx && ctx[parts[i]]; }
        const fn = ctx && ctx[parts[parts.length - 1]];
        if (typeof fn === "function") return fn.call(ctx, arg);
        console.warn(`[shell] data-action "${path}" is not defined yet`);
    }

    function closePopovers(except) {
        document.querySelectorAll(".popover.open").forEach((p) => {
            if (p === except) return;
            p.classList.remove("open");
            const t = document.querySelector(`[aria-controls="${p.id}"]`);
            if (t) t.setAttribute("aria-expanded", "false");
        });
    }

    function wireDelegatedUI() {
        document.addEventListener("click", (e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (!target) return;

            const opener = target.closest("[data-open]");
            if (opener) { closePopovers(); open(opener.dataset.open); return; }
            const closer = target.closest("[data-close]");
            if (closer) { close(closer.dataset.close); return; }

            const act = target.closest("[data-action]");
            if (act) { callGlobal(act.dataset.action, act.dataset.arg); }

            const seg = target.closest("[data-segment] [data-value]");
            if (seg) {
                const group = seg.closest("[data-segment]");
                setSegment(group.dataset.segment, seg.dataset.value);
                group.dispatchEvent(new CustomEvent("segment", {
                    bubbles: true, detail: { group: group.dataset.segment, value: seg.dataset.value }
                }));
            }

            const pop = target.closest("[data-popover]");
            if (pop) {
                const panel = $(pop.dataset.popover);
                if (panel) {
                    const willOpen = !panel.classList.contains("open");
                    closePopovers(panel);
                    panel.classList.toggle("open", willOpen);
                    pop.setAttribute("aria-expanded", willOpen ? "true" : "false");
                }
                return;
            }
            if (!target.closest(".popover")) closePopovers();

            const dismissable = target.classList.contains("modal") && target.hasAttribute("data-dismissable") ? target : null;
            if (dismissable) dismissable.style.display = "none";
        });

        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            closePopovers();
            document.querySelectorAll('.modal[data-dismissable]').forEach((m) => {
                if (m.style.display && m.style.display !== "none") m.style.display = "none";
            });
        });
    }

    function wireAvatarPreview() {
        const input = $("avatarInput"), img = $("avatar-preview");
        if (!input || !img) return;
        input.addEventListener("change", () => {
            const f = input.files && input.files[0];
            if (!f || !f.type.startsWith("image/")) return;
            const url = URL.createObjectURL(f);
            img.onload = () => URL.revokeObjectURL(url);
            img.src = url;
            img.hidden = false;
            const ph = $("avatar-placeholder"); if (ph) ph.hidden = true;
        });
    }

    function wireViewportVar() {
        const set = () => document.documentElement.style.setProperty("--app-h", `${window.innerHeight}px`);
        set();
        window.addEventListener("resize", set, { passive: true });
        window.addEventListener("orientationchange", set, { passive: true });
    }

    function wireConnectivity() {
        let wasOffline = !navigator.onLine;
        window.addEventListener("offline", () => {
            wasOffline = true;
            StatusIsland.show({ id: "net", kind: "sensor", title: "You're offline", sub: "Live squad updates are paused", icon: "📵", priority: 45, ttl: 0, sticky: true, haptic: false });
            StatusIsland.setIdle({ text: "Offline", tone: "warn" });
        });
        window.addEventListener("online", () => {
            StatusIsland.hide("net");
            StatusIsland.setIdle({ text: "Live", tone: "ok" });
            if (wasOffline) StatusIsland.show({ id: "net-back", kind: "safe", title: "Back online", haptic: false });
            wasOffline = false;
        });
        if (!navigator.onLine) window.dispatchEvent(new Event("offline"));
    }

    function init() {
        StatusIsland.bind();
        wireDelegatedUI();
        wireAvatarPreview();
        wireViewportVar();
        wireConnectivity();
    }

    window.StatusIsland = StatusIsland;
    window.MapUnite = Object.assign(window.MapUnite || {}, {
        confirm: confirmSheet, toast, open, close, setSegment, sw: swApi,
        prefersReducedMotion: reducedMotion
    });

    swApi.boot();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
