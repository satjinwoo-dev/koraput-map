/* ============================================================================
   MapUnite Hyper-Vision — the rider's schedule on the phone
   ==============================================================================
   Inside the Ride Plan, for the route the rider is looking at:
     1. their inputs: how long they ride without a break (the Ride Plan's own
        choice), cruising speed, fuel in the tank now, km/L (from My bike when
        it's set: the bike, pillion and luggage are already in it), how long
        they stay at the destination, and an optional "arrive by";
     2. the schedule (schedule.js, on the phone: every edit recomputes at once):
        each stop with its place, arrival and departure, and WHY; totals, the
        arrival as a range, litres; advice (dark riding, leave-by times, the
        way back, the forecast at the plan's time, riders' confirmed hazards);
     3. the rider's edits: a stop 5 minutes longer or shorter, or removed;
     4. "Start with this plan": the route goes on the map and the plan is kept
        on this phone ("mu.hypervision.plan.v1") for the ride;
     5. during the ride, a chip: the next planned stop, how far, and minutes
        ahead of / behind the plan, with the arrival moved to match. Started
        later than planned? The plan moves to the real start, once.
   The inputs are kept on this phone ("mu.hypervision.v1"). Nothing is sent
   anywhere: the server already gave the Ride Plan its data.
   ============================================================================ */
"use strict";

const HyperVision = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return {};
    const C = /** @type {any} */ (W).HyperVisionCore;
    const INPUTS = "mu.hypervision.v1", PLAN = "mu.hypervision.plan.v1", MIN = 60000;
    const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
    const write = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
    function loadInputs() {
        const s = read(INPUTS) || {};
        return {
            cruiseKmh: [40, 50, 60, 70, 80].includes(s.cruiseKmh) ? s.cruiseKmh : null,
            fuelShare: [1, 0.75, 0.5, 0.25].includes(s.fuelShare) ? s.fuelShare : 1,
            kmPerL: Number.isFinite(s.kmPerL) && s.kmPerL >= 5 && s.kmPerL <= 150 ? s.kmPerL : null,
            stayMin: Number.isFinite(s.stayMin) && s.stayMin >= 0 && s.stayMin <= 720 ? s.stayMin : 0
        };
    }

    const h = (tag, a = {}, kids = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(a)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c != null && c !== false) el.append(c);
        return el;
    };
    const sel = (label, opts, value) => {
        const s = /** @type {HTMLSelectElement} */ (h("select", { class: "rp-input", "aria-label": label }, opts.map(([v, l]) => h("option", { value: String(v), text: l }))));
        s.value = String(value);
        return s;
    };
    const tz = (t) => -new Date(t).getTimezoneOffset();
    const time = (t) => C.clock(t, tz(t));
    /** "3:40–4:41 pm" (one am/pm when both share it). */
    const range = (a, b) => { const x = time(a), y = time(b), sx = x.slice(-2), sy = y.slice(-2); return sx === sy ? `${x.slice(0, -3)}–${y}` : `${x} – ${y}`; };
    const bike = () => { try { return typeof BikeFuel !== "undefined" && BikeFuel.active() ? BikeFuel : null; } catch (e) { return null; } };
    const ICON = { start: "🏁", end: "📍", meal: "🍽️", rest: "☕", fuel: "⛽" };
    const brief = (p) => (p ? { sM: p.sM, offM: p.offM || 0, name: p.name || "", cat: p.cat || p.kind || "", kind: p.kind || "", riders: p.riders && p.riders.shown !== false ? { up: p.riders.up, down: p.riders.down, score: p.riders.score } : null } : null);

    /**
     * The Hyper-Vision block for the route on screen.
     * @param {{ res: any, route: any, raw: any, rangeKm: number|null, maxRideMin: number, dest: any, start: (raw: any) => void }} ctx
     */
    function section(ctx) {
        if (!C) return null;
        const { res, route: fr, raw } = ctx;
        const line = raw && raw.geometry ? raw.geometry.coordinates.map(([lng, lat]) => [lat, lng]) : null;
        const P = fr.places && fr.places.available ? fr.places.lists : {};
        const places = { food: (P.food || []).map(brief), fuel: (P.fuel || []).map(brief) };
        const inp = loadInputs();
        const fuelNow = bike();
        const edits = { removed: /** @type {string[]} */ ([]), minutes: /** @type {Record<string, number>} */ ({}) };

        const cruise = sel("Your cruising speed", [["", "The route's usual pace"], [40, "40 km/h"], [50, "50 km/h"], [60, "60 km/h"], [70, "70 km/h"], [80, "80 km/h"]], inp.cruiseKmh || "");
        const fuel = sel("Fuel in the tank now", [[1, "Full"], [0.75, "¾"], [0.5, "½"], [0.25, "¼"]], inp.fuelShare);
        const kmpl = /** @type {HTMLInputElement} */ (h("input", { type: "number", class: "rp-input", min: "5", max: "150", step: "0.5", inputmode: "decimal", placeholder: "e.g. 40", "aria-label": "Your bike's km per litre" }));
        const kmplAuto = () => { const b = bike(); const v = b ? b.kmPerL(Number(cruise.value) || 50) : null; return Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : null; };
        kmpl.value = inp.kmPerL ? String(inp.kmPerL) : kmplAuto() ? String(kmplAuto()) : "";
        const stay = sel("How long you stay there", [[0, "One way only"], [30, "30 min"], [60, "1 h"], [120, "2 h"], [180, "3 h"], [240, "4 h"], [360, "6 h"]], inp.stayMin);
        const byIn = /** @type {HTMLInputElement} */ (h("input", { type: "datetime-local", class: "rp-input", "aria-label": "Arrive by (optional)" }));
        const out = h("div", { class: "hv-out", "aria-live": "polite" });

        const inputs = () => ({
            departAt: res.departAt, distanceM: fr.distanceM, routeS: fr.durationS, cruiseKmh: Number(cruise.value) || null, maxRideMin: ctx.maxRideMin,
            tz: tz(res.departAt), line, places, end: ctx.dest ? [ctx.dest.lat, ctx.dest.lng] : null, start: line ? line[0] : null,
            fuel: { rangeKm: ctx.rangeKm, startShare: Number(fuel.value), kmPerL: Number(kmpl.value) || null },
            stayMin: Number(stay.value) || 0, arriveBy: byIn.value ? new Date(byIn.value).getTime() : undefined, now: Date.now(),
            weather: fr.weather && fr.weather.available ? fr.weather.samples : [], hazards: fr.riders && fr.riders.available ? fr.riders.hazards : [],
            edits
        });
        function save() {
            const k = Number(kmpl.value);
            write(INPUTS, { cruiseKmh: Number(cruise.value) || null, fuelShare: Number(fuel.value), kmPerL: k >= 5 && k <= 150 ? k : null, stayMin: Number(stay.value) || 0 });
        }
        function draw() {
            const o = inputs(), plan = C.schedule(o), adv = C.advise(o, plan), T = plan.totals;
            const rows = plan.items.map((x) => {
                const where = x.type === "start" ? "Set off" : x.type === "end" ? (ctx.dest && ctx.dest.name) || "Destination" : x.place ? x.place.name || ({ dhaba: "Dhaba", tea: "Tea stall", fuel: "Fuel pump", restaurant: "Restaurant", cafe: "Café" })[x.place.cat] || "Unnamed place" : "Somewhere safe off the road";
                const editable = x.type !== "start" && x.type !== "end";
                const step = (d) => () => { edits.minutes[x.id] = Math.max(5, x.minutes + d); draw(); };
                return h("li", { class: `hv-row hv-${x.type}` }, [
                    h("span", { class: "hv-ic", "aria-hidden": "true", text: ICON[x.type] || "•" }),
                    h("div", { class: "hv-main" }, [
                        h("div", { class: "hv-top" }, [
                            h("b", { text: x.type === "start" ? "Start" : x.type === "end" ? "Arrive" : x.label }),
                            h("span", { class: "hv-t", text: editable ? `${time(x.arriveAt)}–${time(x.departAt)} · ${x.minutes} min` : `~${time(x.arriveAt)}` }),
                            h("span", { class: "hv-km", text: `km ${Math.round(x.sM / 1000)}` })
                        ]),
                        h("div", { class: "hv-where", text: where + (x.place && x.place.offM > 150 ? ` · ${Math.round(x.place.offM / 100) / 10} km off the road` : "") }),
                        x.reasons.length ? h("ul", { class: "hv-why" }, x.reasons.map((r) => h("li", { text: r }))) : null,
                        editable ? h("div", { class: "hv-ed" }, [
                            h("button", { type: "button", class: "hv-b", "aria-label": `${x.label}: 5 minutes shorter`, text: "−5 min", onclick: step(-5), disabled: x.minutes <= 5 }),
                            h("button", { type: "button", class: "hv-b", "aria-label": `${x.label}: 5 minutes longer`, text: "+5 min", onclick: step(5) }),
                            h("button", { type: "button", class: "hv-b hv-x", "aria-label": `Remove ${x.label}`, text: "Remove", onclick: () => { edits.removed.push(x.id); draw(); } })
                        ]) : null
                    ])
                ]);
            });
            const lvl = { warning: "⚠️", advice: "💡", ok: "✅" };
            out.replaceChildren(...[
                h("div", { class: "hv-tot" }, [
                    h("div", {}, [h("b", { text: range(T.arriveRange[0], T.arriveRange[1]) }), h("span", { text: "arrival (estimate)" })]),
                    h("div", {}, [h("b", { text: C.fmtDur(T.rideS) }), h("span", { text: "riding" })]),
                    h("div", {}, [h("b", { text: `${T.stops} · ${C.fmtDur(T.stopS)}` }), h("span", { text: "stops" })]),
                    h("div", {}, [h("b", { text: T.fuelL !== null ? `~${T.fuelL} L` : "–" }), h("span", { text: T.fuelL !== null ? "fuel one way" : "add km/L for fuel" })])
                ]),
                adv.length ? h("ul", { class: "hv-adv" }, adv.map((a) => h("li", { class: `hv-${a.level}` }, [h("span", { "aria-hidden": "true", text: lvl[a.level] || "•" }), h("span", { text: a.text })]))) : null,
                ctx.rangeKm ? null : h("p", { class: "rp-note", text: "Add your full-tank range above (and make the plan again) to plan fuel stops." }),
                h("ol", { class: "hv-list" }, rows),
                edits.removed.length || Object.keys(edits.minutes).length ? h("button", { type: "button", class: "hv-b", text: "Undo my changes", onclick: () => { edits.removed = []; edits.minutes = {}; draw(); } }) : null,
                h("button", { type: "button", class: "btn-primary-nav hv-go", text: "Start with this plan", onclick: () => {
                    save();
                    write(PLAN, { v: 1, savedAt: Date.now(), dest: ctx.dest, input: { ...o, now: undefined, weather: undefined, hazards: undefined, line: line ? thin(line, 400) : null } });
                    ctx.start(raw);
                } })
            ].filter(Boolean));
        }
        cruise.addEventListener("change", () => { if (!inp.kmPerL && kmplAuto()) kmpl.value = String(kmplAuto()); });
        // redraw only when a value really changed: a field's late "change" on blur must not rebuild the list under the rider's tap
        let lastKey = "";
        const onInput = () => { const k = [cruise.value, fuel.value, kmpl.value, stay.value, byIn.value].join("|"); if (k === lastKey) return; lastKey = k; save(); draw(); };
        for (const el of [cruise, fuel, kmpl, stay, byIn]) { el.addEventListener("change", onInput); el.addEventListener("input", onInput); }
        lastKey = [cruise.value, fuel.value, kmpl.value, stay.value, byIn.value].join("|");
        draw();
        const b = fuelNow && fuelNow.snap ? fuelNow.snap.title : null;
        return h("details", { class: "rp-sec hv", open: true }, [
            h("summary", { text: "Hyper-Vision: your ride schedule" }),
            h("div", { class: "rp-meta" }, [
                h("span", { text: "From your inputs and this plan's data (OpenStreetMap places, riders' ratings, MET Norway, rider reports) · confidence: estimate" }),
                h("span", { class: "rp-est", text: "estimate" }),
                h("span", { class: "rp-mnote", text: "Traffic, weather and your real stops change it. Each stop says why it's there; change anything." })
            ]),
            h("div", { class: "hv-in" }, [
                h("label", { class: "rp-label", text: "Cruising speed" }), h("label", { class: "rp-label", text: "Fuel now" }),
                cruise, fuel,
                h("label", { class: "rp-label", text: b ? `km/L (${b}, My bike)` : "km/L (optional)" }), h("label", { class: "rp-label", text: "Stay at the destination" }),
                kmpl, stay,
                h("label", { class: "rp-label hv-wide", text: "Arrive by (optional)" }), byIn
            ]),
            h("p", { class: "rp-note", text: `Without a break up to ${C.fmtDur(ctx.maxRideMin * 60)} (change it above).${b ? " Pillion and luggage: as set in My bike." : ""}` }),
            out
        ]);
    }
    function thin(l, max) { if (l.length <= max) return l; const o = [], st = (l.length - 1) / (max - 1); for (let i = 0; i < max; i++) o.push(l[Math.round(i * st)]); return o; }

    // ------------------------------------------------------------ during the ride
    let active = null, chip = null, cum = null, curDest = null;
    document.addEventListener("mu:destination", (e) => { const d = /** @type {CustomEvent} */ (e).detail || {}; if (Number.isFinite(d.lat) && Number.isFinite(d.lng)) curDest = { lat: d.lat, lng: d.lng }; });
    function nearestS(lat, lng) {
        const l = active.input.line;
        if (!l || l.length < 2) return null;
        let best = Infinity, s = 0;
        const k = Math.cos(lat * Math.PI / 180);
        for (let i = 0; i < l.length; i++) {
            const d = (l[i][0] - lat) ** 2 + ((l[i][1] - lng) * k) ** 2;
            if (d < best) { best = d; s = cum[i]; }
        }
        // more than ~2 km from the planned line: off the plan's route
        return Math.sqrt(best) * 111320 > 2000 ? null : s * (active.input.distanceM / cum[cum.length - 1]);
    }
    function begin() {
        const saved = read(PLAN);
        if (!saved || saved.v !== 1 || Date.now() - saved.savedAt > 24 * 3600000 || !saved.input || !saved.input.line) return;
        // only for the ride it was made for
        if (curDest && saved.dest && (Math.abs(curDest.lat - saved.dest.lat) > 0.005 || Math.abs(curDest.lng - saved.dest.lng) > 0.005)) return;
        const input = saved.input, late = Date.now() - input.departAt;
        // a plan for another time of day (or another day) isn't this ride's: keep it for later
        if (Math.abs(late) > 6 * 3600000) return;
        let moved = null;
        if (Math.abs(late) > 10 * MIN) { moved = Math.round(late / MIN); input.departAt = Date.now(); }
        cum = [0];
        for (let i = 1; i < input.line.length; i++) { const a = input.line[i - 1], b = input.line[i], k = Math.cos(a[0] * Math.PI / 180); cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], (b[1] - a[1]) * k) * 111320); }
        active = { input, plan: C.schedule(input), moved };
        if (!chip) {
            // a line inside the turn banner (nothing new floating over the map); on its own without the banner
            const host = document.querySelector("#turn-banner .turn-copy");
            chip = h("div", { id: "hv-chip", class: `hv-chip${host ? " in-banner" : ""}`, role: "status", "aria-live": "polite" });
            (host || document.body).append(chip);
        }
        chip.hidden = false;
        chip.textContent = moved ? `Plan moved to your real start (${C.fmtDur(Math.abs(moved) * 60)} ${moved > 0 ? "later" : "earlier"} than planned).` : "Following your Hyper-Vision plan.";
    }
    function end() { active = null; if (chip) chip.hidden = true; }
    function tick() {
        if (!active || !chip) return;
        let c = null;
        try { c = typeof myCoords !== "undefined" ? myCoords : null; } catch (e) { c = null; }
        if (!c || !Number.isFinite(c.lat)) return;
        const s = nearestS(c.lat, c.lng);
        if (s === null) { chip.textContent = "Off your planned route: the plan's times may not fit."; return; }
        const p = C.progress(active.plan, s, Date.now());
        const T = active.plan.totals, eta = T.arriveAt + p.behindMin * MIN;
        const pace = Math.abs(p.behindMin) < 5 ? "on plan" : p.behindMin > 0 ? `${p.behindMin} min behind plan` : `${-p.behindMin} min ahead of plan`;
        const nx = p.next && p.next.type !== "end" ? p.next : null;
        chip.replaceChildren(
            h("b", { text: nx ? `Next: ${nx.label}${nx.place && nx.place.name ? ` · ${nx.place.name}` : ""}` : "Next: destination" }),
            h("span", { text: `${Math.round(p.distanceM / 1000)} km · ${pace} · ETA ${time(eta)}` })
        );
    }
    document.addEventListener("mu:drive-state", (e) => { const d = /** @type {CustomEvent} */ (e).detail || {}; if (d.navigating && !active) begin(); else if (!d.navigating && !d.driving) end(); });
    document.addEventListener("mu:fix", () => { if (active) tick(); });
    document.addEventListener("mu:trip-end", () => { end(); write(PLAN, null); });

    return { section, loadInputs };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).HyperVision = HyperVision;
