// Hyper-Vision (public/js/rideplan/schedule.js): the rider's own stop-by-stop schedule — breaks at their riding
// limit, meals at meal time (early rather than two stops close together), fuel at the last mapped pump before the
// reserve, the rider's edits kept, arrival as a range, and advice (dark riding, arrive-by, the way back) with reasons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HyperVisionCore: H } = require("../../public/js/rideplan/schedule.js");

const M = 1 / 110540, MIN = 60000;
// 300 km due north from Koraput
const line = Array.from({ length: 301 }, (_, i) => [18.8 + i * 1000 * M, 82.7]);
const ist = (h, m = 0) => Date.UTC(2026, 9, 20, h, m) - 330 * MIN;           // 20 Oct 2026, local time
const food = [], fuel = [];
for (let k = 5; k < 300; k += 9) food.push({ sM: k * 1000, offM: 40, cat: "dhaba", name: `Dhaba ${k}` });
for (let k = 30; k < 300; k += 60) fuel.push({ sM: k * 1000, offM: 20, cat: "fuel", name: `Pump ${k}` });
const base = { departAt: ist(6), distanceM: 300000, routeS: 5 * 3600, maxRideMin: 120, tz: 330, line, places: { food, fuel } };

test("breaks at the rider's limit, never in the last 20 min; meals at meal time; every stop says why", () => {
    const p = H.schedule(base);
    const stops = p.items.filter((x) => x.type !== "start" && x.type !== "end");
    assert.equal(p.items[0].type, "start");
    assert.equal(p.items.at(-1).type, "end");
    for (const x of stops) {
        assert.ok(x.reasons.length >= 2, `${x.id} has its reasons`);
        assert.ok(x.departAt - x.arriveAt === x.minutes * MIN);
        assert.ok(x.place, "a mapped place is suggested");
    }
    const bf = stops.find((x) => x.id === "breakfast");
    assert.ok(bf && H.localHours(bf.arriveAt, 330) >= 7.25 && H.localHours(bf.arriveAt, 330) < 9.6, "breakfast in its window (the nearest dhaba may be a few minutes early)");
    assert.match(bf.reasons.join(" "), /Breakfast time/);
    assert.ok(p.totals.longestRideS <= 120 * 60 + 60, "never more than the limit in one go");
    assert.ok(p.items.at(-1).arriveAt - stops.at(-1).departAt >= 19 * MIN, "no stop just before arriving");
    assert.equal(p.totals.totalS, p.totals.rideS + p.totals.stopS);
    const [early, late] = p.totals.arriveRange;
    assert.ok(early < p.totals.arriveAt && late > p.totals.arriveAt, "arrival is a range around the estimate");
});

test("the rider's pace: slower cruising means more riding time, never quicker than the router", () => {
    assert.equal(H.ridingSeconds(300000, 5 * 3600, 100), 5 * 3600, "the router's time is the floor");
    assert.equal(Math.round(H.ridingSeconds(300000, 5 * 3600, 50)), Math.round(300000 / (50 / 3.6 * 0.8)));
    const slow = H.schedule({ ...base, cruiseKmh: 45 }), fast = H.schedule(base);
    assert.ok(slow.totals.rideS > fast.totals.rideS && slow.totals.stops >= fast.totals.stops);
});

test("a meal a little early instead of a break and a meal minutes apart", () => {
    // leaving at 10:30 with a 2 h limit: the break would fall at 12:30 anyway; leaving at 10:00 → at 12:00, lunch from 12:30
    const p = H.schedule({ ...base, departAt: ist(10) });
    const lunch = p.items.find((x) => x.id === "lunch");
    assert.ok(lunch, "lunch planned");
    assert.ok(!p.items.some((x) => x.type === "rest" && Math.abs(x.arriveAt - lunch.arriveAt) < 50 * MIN), "no break just before or after lunch");
    if (H.localHours(lunch.arriveAt, 330) < 12.5) assert.match(lunch.reasons.join(" "), /a little early/);
});

test("fuel: the last mapped pump before the reserve; none → a warning, not an invented pump", () => {
    const p = H.schedule({ ...base, fuel: { rangeKm: 150, startShare: 0.5, kmPerL: 45 } });
    const f = p.items.find((x) => x.kinds && x.kinds.includes("fuel"));
    // half of 150 km = 75 km; reserve at 30 km left → by km 45; last pump before that is at km 30
    assert.equal(f.sM, 30000);
    assert.equal(f.place.name, "Pump 30");
    assert.match(f.reasons.join(" "), /reserve/);
    assert.equal(p.totals.fuelL, Math.round(300 / 45 * 10) / 10);
    const dry = H.schedule({ ...base, places: { food, fuel: [] }, fuel: { rangeKm: 150, startShare: 0.5 } });
    assert.ok(!dry.items.some((x) => x.kinds && x.kinds.includes("fuel")));
    assert.match(dry.warnings[0].text, /No mapped fuel pump/);
});

test("the rider's edits: a removed stop stays removed (with what that means), a longer stop moves everything after it", () => {
    const p = H.schedule(base);
    const first = p.items[1];
    const longer = H.schedule({ ...base, edits: { minutes: { [first.id]: first.minutes + 20 } } });
    assert.equal(longer.items[1].minutes, first.minutes + 20);
    assert.ok(longer.totals.arriveAt >= p.totals.arriveAt + 20 * MIN - 1000);
    const rest = p.items.find((x) => x.type === "rest");
    const without = H.schedule({ ...base, edits: { removed: [rest.id] } });
    assert.ok(!without.items.some((x) => x.id === rest.id));
    assert.ok(without.warnings.some((w) => /With your changes, the longest stretch/.test(w.text)));
});

test("advice: dark riding with the latest daylight departure, arrive-by, the way back after the stay, forecast at the plan's time", () => {
    const evening = { ...base, departAt: ist(13), now: ist(5) };
    const p = H.schedule(evening);
    const a = H.advise({ ...evening, arriveBy: ist(19) }, p);
    const dark = a.find((x) => /in the dark/.test(x.text));
    assert.ok(dark && dark.level === "warning", "arriving after sunset (about 5:35 pm in October here)");
    const by = dark.text.match(/Leave by ([\d:]+ [ap]m)/);
    assert.ok(by, "says when to leave");
    assert.ok(a.some((x) => /arrive by 7:00 pm/.test(x.text)));

    const morning = { ...base, departAt: ist(6), now: ist(5), stayMin: 120 };
    const mp = H.schedule(morning);
    const adv = H.advise({ ...morning, weather: [{ available: true, sM: 150000, at: ist(9), hazards: [{ type: "heavy-rain", level: "warning" }] }] }, mp);
    const back = adv.find((x) => /^Way back/.test(x.text));
    assert.ok(back, "the way back is planned");
    assert.match(back.text, /after 2 h there/);
    assert.ok(adv.some((x) => /Forecast near km 150: heavy rain/.test(x.text) && /you'd be there around/.test(x.text)));
});

test("during the ride: the next stop and minutes ahead of / behind the plan", () => {
    const p = H.schedule(base);
    const next = p.items.find((x) => x.type !== "start");
    const onTime = H.progress(p, 1000, H.planTimeAt(p, 1000));
    assert.equal(onTime.next.id, next.id);
    assert.equal(onTime.behindMin, 0);
    assert.equal(H.progress(p, 1000, H.planTimeAt(p, 1000) + 25 * MIN).behindMin, 25);
    assert.equal(H.progress(p, 300000, p.totals.arriveAt).next, null);
});

test("sun: sunset in Koraput in October is late afternoon local time", () => {
    const ss = H.sunset(18.8, 82.7, ist(12), 330);
    const h = H.localHours(ss, 330);
    assert.ok(h > 17.2 && h < 17.9, `sunset at ${h}`);
});

test("the wiring: loaded by the page, cached for offline, shown in the Ride Plan", async () => {
    const fs = await import("node:fs");
    const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
    const sw = fs.readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
    const app = fs.readFileSync(new URL("../../public/js/rideplan/rideplan-app.js", import.meta.url), "utf8");
    for (const f of ["schedule.js", "hypervision-app.js"]) {
        assert.match(html, new RegExp(`js/rideplan/${f.replace(".", "\\.")}\\?v=`));
        assert.ok(sw.includes(`"/js/rideplan/${f}"`));
    }
    assert.match(app, /HyperVision\.section\(/);
});
