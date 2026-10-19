// @ts-check
/* ============================================================================
   MapUnite navigation, minimized — what the small window and the notification say (pure)
   ==============================================================================
   While navigating, when the rider goes to the home screen or another app, a
   car navigator keeps the next turn in a small floating window (picture-in-
   picture) and in a live notification. This file turns the navigation state
   into the words and the icon for both:
     card()      { distance: "200 m", instruction: "Turn left onto NH-26",
                   then: "Then arrive at Araku", eta: "5:19 PM", left: "12 km · 18 min",
                   turn: "left", rotation: -90, progress: 0..1 }
     notice()    the notification's title and text from a card
     changed()   whether a new card is worth an update (a new turn, the
                 distance's next step, the arrival minute)
     turnKind()  "straight" | "slight-left" | "left" | "sharp-left" | "uturn" | … | "arrive"
     arrowPath() the arrow as points on a 100 × 100 square, for the canvas and Android
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).MUNavPipCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** "200 m", "1.4 km", "12 km": the steps a navigator counts down in (10 m under 300 m, then 50 m, then 0.1 km). @param {number|null|undefined} m */
    function distanceText(m) {
        if (m == null || !Number.isFinite(m)) return "";
        if (m < 300) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
        if (m < 1000) return `${Math.round(m / 50) * 50} m`;
        return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
    }
    /** "18 min", "1 h 05 min". @param {number|null|undefined} s */
    function durationText(s) {
        if (s == null || !Number.isFinite(s)) return "";
        const m = Math.max(0, Math.round(s / 60));
        return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
    }
    /** "5:19 PM" on the phone's clock. @param {number} t */
    function clockText(t) {
        try { return new Date(t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase(); } catch (e) { return ""; }
    }

    /** The kind of turn from the banner arrow's rotation (degrees, + right). @param {number|null|undefined} deg @param {boolean} [arrive] */
    function turnKind(deg, arrive) {
        if (arrive) return "arrive";
        const d = Number.isFinite(deg) ? /** @type {number} */ (deg) : 0, a = Math.abs(d), side = d < 0 ? "left" : "right";
        if (a < 20) return "straight";
        if (a >= 170) return "uturn";
        if (a < 60) return `slight-${side}`;
        if (a < 120) return side;
        return `sharp-${side}`;
    }

    /**
     * The card for the small window and the notification. Pure.
     * @param {{ nextManeuver?: string, nextManeuverM?: number|null, thenText?: string, nextTurnDeg?: number|null,
     *   remainingM?: number|null, etaSec?: number|null, destName?: string, totalM?: number|null }} s navigation's state
     * @param {number} now
     */
    function card(s, now) {
        const arrive = !s.nextManeuver || /arrive/i.test(s.nextManeuver);
        const toTurn = arrive ? s.remainingM : s.nextManeuverM;
        const left = [distanceText(s.remainingM), durationText(s.etaSec)].filter(Boolean).join(" · ");
        const progress = s.totalM && s.totalM > 0 && Number.isFinite(s.remainingM) ? Math.max(0, Math.min(1, 1 - /** @type {number} */ (s.remainingM) / s.totalM)) : null;
        return {
            distance: distanceText(toTurn),
            instruction: arrive ? (s.destName ? `Arrive at ${s.destName}` : "Arrive at your destination") : String(s.nextManeuver),
            then: arrive ? "" : s.thenText || "",
            eta: Number.isFinite(s.etaSec) ? clockText(now + /** @type {number} */ (s.etaSec) * 1000) : "",
            left,
            turn: turnKind(s.nextTurnDeg, arrive),
            rotation: arrive ? 0 : (Number.isFinite(s.nextTurnDeg) ? /** @type {number} */ (s.nextTurnDeg) : 0),
            progress
        };
    }
    /** The notification: "200 m · Turn left onto NH-26" / "Then … · Arrive 5:19 PM · 12 km · 18 min". @param {ReturnType<typeof card>} c */
    function notice(c) {
        return {
            title: [c.distance, c.instruction].filter(Boolean).join(" · "),
            text: [c.then, c.eta ? `Arrive ${c.eta}` : "", c.left].filter(Boolean).join(" · ")
        };
    }
    /** Worth an update? A different turn or wording, the distance's next step, the arrival minute. @param {any} a @param {any} b */
    function changed(a, b) {
        if (!a || !b) return a !== b;
        return a.instruction !== b.instruction || a.distance !== b.distance || a.eta !== b.eta || a.then !== b.then || a.turn !== b.turn;
    }

    /**
     * The arrow for a turn, on a 100 × 100 square (y down): a shaft from the bottom centre that bends the way of
     * the turn, ending in a head. Polylines: { shaft: [[x, y], …], head: [[x, y] × 3] }. Pure.
     * @param {string} kind
     */
    function arrowPath(kind) {
        const deg = { straight: 0, "slight-left": -45, left: -90, "sharp-left": -135, "slight-right": 45, right: 90, "sharp-right": 135 }[kind];
        if (kind === "arrive") return { shaft: [], head: [], pin: true };
        if (kind === "uturn") {
            const shaft = [[62, 86], [62, 40]];
            for (let i = 0; i <= 8; i++) { const a = Math.PI * i / 8; shaft.push([50 + 12 * Math.cos(a), 40 - 12 * Math.sin(a)]); }
            shaft.push([38, 58]);
            return { shaft, head: [[26, 50], [38, 68], [50, 50]], pin: false };
        }
        const r = ((deg ?? 0) * Math.PI) / 180;
        const bend = [50, 52], len = 30;
        const tip = [bend[0] + Math.sin(r) * len, bend[1] - Math.cos(r) * len];
        const shaft = deg ? [[50, 88], bend, tip] : [[50, 88], [50, 24]];
        const end = shaft[shaft.length - 1], prev = shaft[shaft.length - 2];
        const ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
        const hl = 16, hw = 14;
        const tipX = end[0] + Math.cos(ang) * hl * 0.6, tipY = end[1] + Math.sin(ang) * hl * 0.6;
        const bx = end[0] - Math.cos(ang) * hl * 0.4, by = end[1] - Math.sin(ang) * hl * 0.4;
        const head = [[bx + Math.sin(ang) * hw, by - Math.cos(ang) * hw], [tipX, tipY], [bx - Math.sin(ang) * hw, by + Math.cos(ang) * hw]];
        return { shaft, head, pin: false };
    }

    return { distanceText, durationText, clockText, turnKind, card, notice, changed, arrowPath };
});
