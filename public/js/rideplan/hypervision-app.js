/* ============================================================================
   MapUnite Hyper-Vision — the rider's schedule on the phone
   ==============================================================================
   Inside the Ride Plan, for the route the rider is looking at:
     1. "Your ride": cruising speed, fuel in the tank now, km/L (from My bike
        when it's set: the bike, pillion and luggage are already in it), how
        long they stay at the destination, an optional "arrive by". Tap chips,
        not forms. How long they ride without a break is the Ride Plan's own
        choice above.
     2. The plan at a glance: arrival (a range), riding, stops, litres, and a
        strip of the whole ride, daylight and dark, with the stops on it.
        Advice first (dark riding with the daylight window, arrive-by, the way
        back, forecast, rider hazards), then the timeline: each stop with its
        place, arrival and departure, and WHY (tap "Why?").
     3. Edit mode: the plan becomes the RIDER'S. They can change any stop's
        kind (break, meal, fuel, or both), its length, its place (from the
        mapped places near it) or its km, write a note, remove it, or add a
        stop anywhere. MapUnite times and checks their plan (limit, fuel,
        meals) and never changes it; "Fill the gaps" adds MapUnite's stops
        around theirs when they ask; Undo steps back; "MapUnite's plan" starts
        over.
     4. "Start with this plan": the route goes on the map and the plan is kept
        on this phone ("mu.hypervision.plan.v1") for the ride.
     5. During the ride, a line in the turn banner: the next planned stop, how
        far, and minutes ahead of / behind the plan, with the arrival moved to
        match. Started later than planned? The plan moves to the real start,
        once.
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
        const s = read(INPUTS);
        const o = s || {};
        return {
            saved: Boolean(s),
            cruiseKmh: [40, 50, 60, 70, 80].includes(o.cruiseKmh) ? o.cruiseKmh : null,
            fuelShare: [1, 0.75, 0.5, 0.25].includes(o.fuelShare) ? o.fuelShare : 1,
            kmPerL: Number.isFinite(o.kmPerL) && o.kmPerL >= 5 && o.kmPerL <= 150 ? o.kmPerL : null,
            stayMin: Number.isFinite(o.stayMin) && o.stayMin >= 0 && o.stayMin <= 720 ? o.stayMin : 0
        };
    }

    const h = (tag, a = {}, kids = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(a)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
            else if (k === "style") el.setAttribute("style", v);
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c != null && c !== false) el.append(c);
        return el;
    };
    const tz = (t) => -new Date(t).getTimezoneOffset();
    const time = (t) => C.clock(t, tz(t));
    const bike = () => { try { return typeof BikeFuel !== "undefined" && BikeFuel.active() ? BikeFuel : null; } catch (e) { return null; } };
    const ICON = { start: "🏁", end: "📍", meal: "🍽️", rest: "☕", fuel: "⛽" };
    const KINDS = [
        { k: ["rest"], icon: "☕", label: "Break" },
        { k: ["meal"], icon: "🍽️", label: "Meal" },
        { k: ["fuel"], icon: "⛽", label: "Fuel" },
        { k: ["rest", "fuel"], icon: "☕⛽", label: "Break + fuel" },
        { k: ["meal", "fuel"], icon: "🍽️⛽", label: "Meal + fuel" }
    ];
    const sameKinds = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    const CAT = { dhaba: "Dhaba", tea: "Tea stall", fuel: "Fuel pump", restaurant: "Restaurant", cafe: "Café", fast_food: "Fast food" };
    const nameOf = (p) => (p ? p.name || CAT[p.cat] || CAT[p.kind] || "Unnamed place" : "");
    const brief = (p) => (p ? { sM: p.sM, offM: p.offM || 0, name: p.name || "", cat: p.cat || p.kind || "", kind: p.kind || "", riders: p.riders && p.riders.shown !== false ? { up: p.riders.up, down: p.riders.down, score: p.riders.score } : null } : null);
    const reduceMotion = () => { try { return W.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };

    /** A row of chips (one choice). */
    function chips(label, opts, value, onPick) {
        return h("div", { class: "hv-chips", role: "radiogroup", "aria-label": label }, opts.map(([v, text]) => h("button", {
            type: "button", class: "hv-chip-b", role: "radio", "aria-checked": String(String(v) === String(value)), text,
            onclick: () => onPick(v)
        })));
    }

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
        const b0 = bike();
        const kmplAuto = (kmh) => { const b = bike(); const v = b ? b.kmPerL(kmh || 50) : null; return Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : null; };
        const st = {
            cruiseKmh: inp.cruiseKmh, fuelShare: inp.fuelShare, kmPerL: inp.kmPerL || kmplAuto(inp.cruiseKmh), stayMin: inp.stayMin, arriveBy: /** @type {number|undefined} */ (undefined),
            settingsOpen: !inp.saved,
            mode: /** @type {"auto"|"mine"} */ ("auto"), mine: /** @type {any[]} */ ([]), history: /** @type {any[]} */ ([]),
            editing: false, openId: /** @type {string|null} */ (null), pickFor: /** @type {string|null} */ (null), why: new Set(), allAdvice: false, seq: 0, flash: /** @type {string|null} */ (null)
        };
        const root = h("details", { class: "rp-sec hv", open: true });
        const save = () => write(INPUTS, { cruiseKmh: st.cruiseKmh, fuelShare: st.fuelShare, kmPerL: st.kmPerL, stayMin: st.stayMin });

        const inputs = () => ({
            departAt: res.departAt, distanceM: fr.distanceM, routeS: fr.durationS, cruiseKmh: st.cruiseKmh, maxRideMin: ctx.maxRideMin,
            tz: tz(res.departAt), line, places, end: ctx.dest ? [ctx.dest.lat, ctx.dest.lng] : null, start: line ? line[0] : null,
            fuel: { rangeKm: ctx.rangeKm, startShare: st.fuelShare, kmPerL: st.kmPerL },
            stayMin: st.stayMin, arriveBy: st.arriveBy, now: Date.now(),
            weather: fr.weather && fr.weather.available ? fr.weather.samples : [], hazards: fr.riders && fr.riders.available ? fr.riders.hazards : [],
            pinned: st.mode === "mine" ? st.mine : undefined, auto: st.mode !== "mine"
        });
        // ---------------------------------------------------------- the rider's plan: every change can be undone
        const snapshot = () => ({ mode: st.mode, mine: st.mine.map((x) => ({ ...x })) });
        function change(fn, flashId) {
            st.history.push(snapshot());
            if (st.history.length > 40) st.history.shift();
            fn();
            st.flash = flashId || null;
            draw();
        }
        const fromPlan = (plan) => plan.items.filter((x) => x.type !== "start" && x.type !== "end").map((x) => ({
            id: x.mine ? x.id : `m${++st.seq}`, sM: x.sM, kinds: x.kinds.slice(), minutes: x.minutes, meal: x.meal || null, place: x.place || null, note: x.note || ""
        }));
        const mineStop = (id) => st.mine.find((x) => x.id === id);
        /** Another of the rider's stops within 1 km of this one becomes part of it: one stop, not two. */
        function mergeNear(id) {
            const a = mineStop(id);
            if (!a) return;
            for (const b of st.mine.filter((x) => x.id !== id && Math.abs(x.sM - a.sM) <= 1000)) {
                a.kinds = [...new Set([...a.kinds, ...b.kinds])];
                a.minutes = Math.min(240, Math.max(a.minutes, b.minutes) + 5);
                a.note = [a.note, b.note].filter(Boolean).join("; ").slice(0, 80);
                a.place = a.place || b.place;
                a.meal = a.meal || b.meal;
                st.mine = st.mine.filter((x) => x.id !== b.id);
            }
        }
        function startEditing(plan) {
            if (st.mode !== "mine") change(() => { st.mode = "mine"; st.mine = fromPlan(plan); });
            st.editing = true; st.openId = null; st.pickFor = null;
            draw();
        }

        // ---------------------------------------------------------- the screen
        function draw() {
            const o = inputs(), plan = C.schedule(o), adv = C.advise(o, plan), T = plan.totals, L = C.light(o, plan);
            const ref = Date.now();
            const tag = st.mode === "mine" ? h("span", { class: "hv-tag mine", text: "✏️ Your plan" }) : h("span", { class: "hv-tag", text: "✨ MapUnite's plan" });

            // the plan at a glance
            const [ea, la] = T.arriveRange;
            const dayOf = (t) => C.when(t, ref, tz(t)).replace(time(t), "").trim();
            const ra = time(ea), rb = time(la);
            const arrive = dayOf(ea) === dayOf(la) ? `${ra.slice(-2) === rb.slice(-2) ? ra.slice(0, -3) : ra}–${rb}${dayOf(la) ? ` ${dayOf(la)}` : ""}` : `${C.when(ea, ref, tz(ea))} – ${C.when(la, ref, tz(la))}`;
            const D = T.distanceM;
            const strip = h("div", { class: "hv-strip", role: "img", "aria-label": `The ride: ${L.pieces.filter((p) => p.dark).length ? "part of it in the dark" : "all in daylight"}, ${T.stops} stops` }, [
                ...L.pieces.map((p) => h("span", { class: `hv-seg${p.dark ? " dark" : ""}`, style: `left:${(p.a / D * 100).toFixed(2)}%;width:${Math.max(0.5, (p.b - p.a) / D * 100).toFixed(2)}%` })),
                ...plan.items.filter((x) => x.type !== "start" && x.type !== "end").map((x) => h("span", { class: `hv-dot hv-${x.type}${x.mine ? " mine" : ""}`, style: `left:${(x.sM / D * 100).toFixed(2)}%`, title: `${x.label} · km ${Math.round(x.sM / 1000)}`, text: ICON[x.type] }))
            ]);
            const hero = h("div", { class: "hv-hero" }, [
                h("div", { class: "hv-hero-top" }, [tag, h("span", { class: "rp-est", text: "estimate" })]),
                h("div", { class: "hv-arrive" }, [h("span", { text: "Arrive" }), h("b", { text: arrive })]),
                h("div", { class: "hv-stats" }, [
                    h("span", { text: `🕑 Leave ${C.when(T.departAt, ref, tz(T.departAt))}` }),
                    h("span", { text: `🏍️ ${C.fmtDur(T.rideS)} riding` }),
                    h("span", { text: `⏸️ ${T.stops} stop${T.stops === 1 ? "" : "s"} · ${C.fmtDur(T.stopS)}` }),
                    h("span", { text: T.fuelL !== null ? `⛽ ~${T.fuelL} L` : "⛽ add km/L" })
                ]),
                strip,
                h("div", { class: "hv-strip-ends" }, [h("span", { text: "Start" }), h("span", { class: "hv-legend" }, [h("i", { class: "d" }), " day ", h("i", { class: "n" }), " dark"]), h("span", { text: (ctx.dest && ctx.dest.name) || "Destination" })])
            ]);

            // your ride (the inputs), as chips
            const kmplIn = /** @type {HTMLInputElement} */ (h("input", { type: "number", class: "rp-input hv-kmpl", min: "5", max: "150", step: "0.5", inputmode: "decimal", placeholder: "e.g. 40", "aria-label": "Your bike's km per litre", value: st.kmPerL ? String(st.kmPerL) : null }));
            kmplIn.addEventListener("change", () => { const k = Number(kmplIn.value); st.kmPerL = k >= 5 && k <= 150 ? k : null; save(); draw(); });
            const byIn = /** @type {HTMLInputElement} */ (h("input", { type: "datetime-local", class: "rp-input", "aria-label": "Arrive by (optional)" }));
            if (st.arriveBy && W.RidePlan && W.RidePlan.core) byIn.value = W.RidePlan.core.localInput(st.arriveBy);
            byIn.addEventListener("change", () => { st.arriveBy = byIn.value ? new Date(byIn.value).getTime() : undefined; draw(); });
            const set = (k) => (v) => { st[k] = v === "" ? null : Number(v); if (k === "cruiseKmh" && !inp.kmPerL && kmplAuto(st.cruiseKmh)) st.kmPerL = kmplAuto(st.cruiseKmh); save(); draw(); };
            const FUEL = { 1: "Full", 0.75: "¾", 0.5: "½", 0.25: "¼" }, STAY = { 0: "one way", 30: "stay 30 min", 60: "stay 1 h", 120: "stay 2 h", 180: "stay 3 h", 240: "stay 4 h", 360: "stay 6 h" };
            const summaryText = [st.cruiseKmh ? `${st.cruiseKmh} km/h` : "route's pace", `${FUEL[st.fuelShare]} tank`, st.kmPerL ? `${st.kmPerL} km/L` : null, STAY[st.stayMin] || `stay ${st.stayMin} min`, `break by ${C.fmtDur(ctx.maxRideMin * 60)}`].filter(Boolean).join(" · ");
            const settings = h("div", { class: `hv-card hv-settings${st.settingsOpen ? " open" : ""}` }, [
                h("button", { type: "button", class: "hv-settings-h", "aria-expanded": String(st.settingsOpen), onclick: () => { st.settingsOpen = !st.settingsOpen; draw(); } }, [
                    h("span", { class: "hv-settings-t", text: "⚙️ Your ride" }), h("span", { class: "hv-settings-s", text: summaryText }), h("span", { class: "hv-caret", "aria-hidden": "true", text: "▾" })
                ]),
                st.settingsOpen ? h("div", { class: "hv-settings-b" }, [
                    h("div", { class: "hv-lbl", text: "How fast you cruise" }),
                    chips("Your cruising speed", [["", "Route's pace"], [40, "40"], [50, "50"], [60, "60"], [70, "70"], [80, "80 km/h"]], st.cruiseKmh || "", set("cruiseKmh")),
                    h("div", { class: "hv-lbl", text: "Fuel in the tank now" }),
                    chips("Fuel in the tank now", [[1, "⛽ Full"], [0.75, "¾"], [0.5, "½"], [0.25, "¼"]], st.fuelShare, set("fuelShare")),
                    h("div", { class: "hv-lbl", text: "Stay at the destination" }),
                    chips("How long you stay there", [[0, "One way"], [30, "30 min"], [60, "1 h"], [120, "2 h"], [180, "3 h"], [240, "4 h"], [360, "6 h"]], st.stayMin, set("stayMin")),
                    h("div", { class: "hv-row2" }, [
                        h("label", { class: "hv-lbl" }, [b0 && b0.snap ? `km/L · ${b0.snap.title} (My bike)` : "km/L (optional)", kmplIn]),
                        h("label", { class: "hv-lbl hv-wide" }, ["Arrive by (optional)", byIn])
                    ]),
                    h("p", { class: "hv-hint", text: `Breaks: at most ${C.fmtDur(ctx.maxRideMin * 60)} of riding in one go (change it above).${ctx.rangeKm ? "" : " Add your full-tank range above to plan fuel stops."}${b0 ? " Pillion and luggage: as set in My bike." : ""}` })
                ]) : null
            ]);

            // advice: the first two, the rest a tap away
            const LV = { warning: "⚠️", advice: "💡", ok: "✅" };
            const shown = st.allAdvice ? adv : adv.slice(0, 2);
            const advice = adv.length ? h("div", { class: "hv-adv" }, [
                ...shown.map((a) => h("div", { class: `hv-tip ${a.level}` }, [h("span", { class: "hv-tip-i", "aria-hidden": "true", text: LV[a.level] || "•" }), h("span", { text: a.text })])),
                adv.length > 2 ? h("button", { type: "button", class: "hv-more", "aria-expanded": String(st.allAdvice), text: st.allAdvice ? "Show less" : `Show ${adv.length - 2} more`, onclick: () => { st.allAdvice = !st.allAdvice; draw(); } }) : null
            ]) : null;

            // the timeline
            const list = h("ol", { class: `hv-tl${st.editing ? " editing" : ""}` });
            plan.items.forEach((x, i) => {
                list.append(stopCard(x, plan, i));
                if (i < plan.items.length - 1) {
                    const g = L.legs[i], km = Math.round((plan.items[i + 1].sM - x.sM) / 1000);
                    list.append(h("li", { class: `hv-leg${g && g.darkShare > 0.5 ? " dark" : ""}` }, [
                        h("span", { class: "hv-leg-t", text: `${g && g.darkShare > 0.5 ? "🌙" : "🏍️"} ${C.fmtDur(g ? g.rideS : 0)} · ${km} km${g && g.darkShare > 0.05 && g.darkShare <= 0.5 ? " · part in the dark" : ""}` }),
                        st.editing ? h("button", { type: "button", class: "hv-add", text: "＋ Add a stop", onclick: () => addBetween(x.sM, plan.items[i + 1].sM) }) : null
                    ]));
                }
            });

            const bar = st.editing ? h("div", { class: "hv-bar", role: "toolbar", "aria-label": "Edit your plan" }, [
                h("button", { type: "button", class: "hv-tb", disabled: !st.history.length, onclick: () => { const s = st.history.pop(); if (s) { st.mode = s.mode; st.mine = s.mine; if (st.mode !== "mine") st.editing = false; draw(); } } }, [h("span", { text: "↶" }), h("small", { text: "Undo" })]),
                h("button", { type: "button", class: "hv-tb", onclick: () => change(() => { st.mine = fromPlan(C.schedule({ ...inputs(), pinned: st.mine, auto: true })); }) }, [h("span", { text: "✨" }), h("small", { text: "Fill the gaps" })]),
                h("button", { type: "button", class: "hv-tb", onclick: () => change(() => { st.mode = "auto"; st.mine = []; st.editing = false; }) }, [h("span", { text: "↺" }), h("small", { text: "MapUnite's plan" })]),
                h("button", { type: "button", class: "hv-tb done", onclick: () => { st.editing = false; st.openId = null; st.pickFor = null; draw(); } }, [h("span", { text: "✓" }), h("small", { text: "Done" })])
            ]) : null;

            const go = h("div", { class: "hv-actions" }, [
                st.editing ? null : h("button", { type: "button", class: "hv-edit", text: st.mode === "mine" ? "✏️ Keep editing" : "✏️ Edit this plan", onclick: () => startEditing(plan) }),
                h("button", { type: "button", class: "btn-primary-nav hv-go", text: "🏍️ Start with this plan", onclick: () => {
                    save();
                    write(PLAN, { v: 1, savedAt: Date.now(), dest: ctx.dest, input: { ...o, now: undefined, weather: undefined, hazards: undefined, line: line ? thin(line, 400) : null } });
                    ctx.start(raw);
                } })
            ]);

            root.replaceChildren(...[
                h("summary", {}, [h("span", { class: "hv-title", text: "Hyper-Vision" }), h("span", { class: "hv-sub", text: " · your ride schedule" })]),
                hero, settings, advice,
                st.editing ? h("p", { class: "hv-hint edit", text: "Edit mode: tap a stop to change it, or add one between stops. It's your plan: MapUnite times it and checks it, and never changes it." }) : null,
                list, bar, go,
                h("p", { class: "hv-foot", text: "From your inputs and this plan's data (OpenStreetMap places, riders' ratings, MET Norway, rider reports). Estimates: traffic, weather and your real stops change them." })
            ].filter(Boolean));
            if (st.flash) {
                const el = root.querySelector(`[data-id="${st.flash}"]`);
                if (el && !reduceMotion()) el.classList.add("hv-pop");
                st.flash = null;
            }
        }

        function stopCard(x, plan, i) {
            const ends = x.type === "start" || x.type === "end";
            const where = x.type === "start" ? "Set off" : x.type === "end" ? (ctx.dest && ctx.dest.name) || "Destination" : x.place ? nameOf(x.place) : "Somewhere safe off the road";
            const rating = x.place && x.place.riders && x.place.riders.up + x.place.riders.down >= 3 ? `👍 ${x.place.riders.up} · 👎 ${x.place.riders.down}` : null;
            const open = st.editing && st.openId === x.id && !ends;
            const whyOpen = st.why.has(x.id);
            const head = h("div", { class: "hv-card-h" }, [
                h("div", { class: "hv-time" }, [h("b", { text: time(x.arriveAt) }), !ends ? h("small", { text: `${x.minutes} min` }) : null]),
                h("span", { class: `hv-bub hv-${x.type}`, "aria-hidden": "true", text: x.type === "start" || x.type === "end" ? ICON[x.type] : (KINDS.find((k) => sameKinds(k.k, x.kinds)) || { icon: ICON[x.type] }).icon }),
                h("div", { class: "hv-what" }, [
                    h("div", { class: "hv-name" }, [h("b", { text: x.type === "start" ? "Start" : x.type === "end" ? "Arrive" : x.label }), h("span", { class: "hv-km", text: `km ${Math.round(x.sM / 1000)}` })]),
                    h("div", { class: "hv-where", text: where + (x.place && x.place.offM > 150 ? ` · ${Math.round(x.place.offM / 100) / 10} km off the road` : "") + (rating ? ` · ${rating}` : "") }),
                    x.note ? h("div", { class: "hv-note", text: `📝 ${x.note}` }) : null,
                    !ends && !st.editing && x.reasons.length ? h("button", { type: "button", class: "hv-why-b", "aria-expanded": String(whyOpen), text: whyOpen ? "Hide why" : "Why here?", onclick: () => { if (whyOpen) st.why.delete(x.id); else st.why.add(x.id); draw(); } }) : null,
                    whyOpen && !st.editing ? h("ul", { class: "hv-why" }, x.reasons.map((r) => h("li", { text: r }))) : null,
                ])
            ]);
            const card = h("li", { class: `hv-card hv-stop hv-${x.type}${open ? " open" : ""}${st.editing && !ends ? " tappable" : ""}`, "data-id": x.id }, [
                st.editing && !ends ? h("button", { type: "button", class: "hv-card-tap", "aria-expanded": String(open), "aria-label": `${open ? "Close" : "Change"} ${x.label} at km ${Math.round(x.sM / 1000)}`, onclick: () => { st.openId = open ? null : x.id; st.pickFor = null; draw(); } }, [head]) : head,
                open ? editor(x, plan, i) : null
            ]);
            return card;
        }

        // ---------------------------------------------------------- one stop's editor
        function editor(x, plan, i) {
            const m = mineStop(x.id);
            if (!m) return null;
            // the slider moves it anywhere on the route (the plan keeps km order)
            const lo = 1, hi = Math.floor((fr.distanceM - 1000) / 1000);
            const set = (fn) => change(() => fn(/** @type {any} */ (mineStop(x.id))), x.id);
            const dur = h("div", { class: "hv-step" }, [
                h("button", { type: "button", class: "hv-round", "aria-label": "5 minutes shorter", text: "−", disabled: m.minutes <= 5, onclick: () => set((s) => { s.minutes = Math.max(5, s.minutes - 5); }) }),
                h("b", { "aria-live": "polite", text: `${m.minutes} min` }),
                h("button", { type: "button", class: "hv-round", "aria-label": "5 minutes longer", text: "+", disabled: m.minutes >= 240, onclick: () => set((s) => { s.minutes = Math.min(240, s.minutes + 5); }) })
            ]);
            const slider = /** @type {HTMLInputElement} */ (h("input", { type: "range", class: "hv-range", min: String(lo), max: String(Math.max(lo, hi)), step: "1", value: String(Math.round(m.sM / 1000)), "aria-label": "Where on the route (km)", disabled: hi <= lo }));
            const kmOut = h("b", { text: `km ${Math.round(m.sM / 1000)}` });
            slider.addEventListener("input", () => { kmOut.textContent = `km ${slider.value}`; });
            slider.addEventListener("change", () => set((s) => { s.sM = Number(slider.value) * 1000; if (s.place && Math.abs(s.place.sM - s.sM) > 500) s.place = null; mergeNear(s.id); }));
            const noteIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "rp-input", maxlength: "80", placeholder: "e.g. meet Rahul here, buy water", "aria-label": "Your note for this stop", value: m.note || null }));
            noteIn.addEventListener("change", () => set((s) => { s.note = noteIn.value.trim().slice(0, 80); }));
            // places within 30 km of this stop (past a neighbour is fine: the plan keeps km order)
            const wantFuel = m.kinds.includes("fuel"), wantFood = m.kinds.includes("meal") || m.kinds.includes("rest");
            const near = [...(wantFood ? places.food : []), ...(wantFuel || m.kinds.includes("rest") ? places.fuel : [])]
                .filter((p) => p.sM > 500 && p.sM < fr.distanceM - 500 && Math.abs(p.sM - m.sM) <= 30000)
                .sort((a, b) => Math.abs(a.sM - m.sM) - Math.abs(b.sM - m.sM)).slice(0, 12);
            const picking = st.pickFor === x.id;
            return h("div", { class: "hv-ed" }, [
                h("div", { class: "hv-lbl", text: "What" }),
                h("div", { class: "hv-chips", role: "radiogroup", "aria-label": "What this stop is" }, KINDS.map((k) => h("button", {
                    type: "button", class: "hv-chip-b", role: "radio", "aria-checked": String(sameKinds(k.k, m.kinds)), text: `${k.icon} ${k.label}`,
                    onclick: () => set((s) => { s.kinds = k.k.slice(); s.meal = null; if (k.k.includes("meal") && s.minutes < 30) s.minutes = 40; if (sameKinds(k.k, ["fuel"]) && s.minutes > 15) s.minutes = 10; })
                }))),
                h("div", { class: "hv-row2" }, [
                    h("div", {}, [h("div", { class: "hv-lbl", text: "How long" }), dur, chips("Quick length", [[10, "10"], [15, "15"], [30, "30"], [45, "45"], [60, "60"]], m.minutes, (v) => set((s) => { s.minutes = Number(v); }))]),
                    h("div", {}, [h("div", { class: "hv-lbl" }, ["Where on the route ", kmOut]), slider])
                ]),
                h("div", { class: "hv-lbl", text: "Place" }),
                h("button", { type: "button", class: "hv-place-b", "aria-expanded": String(picking), onclick: () => { st.pickFor = picking ? null : x.id; draw(); } }, [
                    h("span", { text: m.place ? `📍 ${nameOf(m.place)}` : "📍 No particular place" }), h("small", { text: picking ? "close" : `choose (${near.length} nearby)` })
                ]),
                picking ? h("div", { class: "hv-picker" }, [
                    h("button", { type: "button", class: `hv-pick${m.place ? "" : " on"}`, onclick: () => set((s) => { s.place = null; st.pickFor = null; }) }, [h("b", { text: "No particular place" }), h("small", { text: `stay at km ${Math.round(m.sM / 1000)}` })]),
                    ...near.map((p) => h("button", { type: "button", class: `hv-pick${m.place && m.place.sM === p.sM && m.place.name === p.name ? " on" : ""}`, onclick: () => set((s) => { s.place = p; s.sM = p.sM; st.pickFor = null; mergeNear(s.id); }) }, [
                        h("b", { text: `${p.cat === "fuel" ? "⛽" : p.cat === "tea" || p.cat === "cafe" ? "🍵" : "🍽️"} ${nameOf(p)}` }),
                        h("small", { text: [`km ${Math.round(p.sM / 1000)}`, Math.abs(p.sM - m.sM) >= 1000 ? `${p.sM > m.sM ? "+" : "−"}${Math.round(Math.abs(p.sM - m.sM) / 1000)} km` : "here", p.offM > 150 ? `${Math.round(p.offM / 100) / 10} km off the road` : null, p.riders && p.riders.up + p.riders.down >= 3 ? `👍 ${p.riders.up} · 👎 ${p.riders.down}` : "no ratings yet"].filter(Boolean).join(" · ") })
                    ])),
                    near.length ? null : h("p", { class: "hv-hint", text: "No mapped places near here. Move the stop, or keep it as \"somewhere safe off the road\"." })
                ]) : null,
                h("div", { class: "hv-lbl", text: "Your note" }), noteIn,
                h("div", { class: "hv-ed-foot" }, [
                    h("button", { type: "button", class: "hv-del", text: "🗑 Remove this stop", onclick: () => change(() => { st.mine = st.mine.filter((s) => s.id !== x.id); st.openId = null; }) }),
                    h("button", { type: "button", class: "hv-ok", text: "Done", onclick: () => { st.openId = null; st.pickFor = null; draw(); } })
                ])
            ]);
        }
        function addBetween(a, b) {
            const id = `m${++st.seq}`;
            change(() => { st.mine.push({ id, sM: Math.round((a + b) / 2 / 1000) * 1000, kinds: ["rest"], minutes: 15, meal: null, place: null, note: "" }); st.openId = id; st.pickFor = null; }, id);
        }

        draw();
        return root;
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
