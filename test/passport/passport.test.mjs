// Rider Passport, place sharing and the share-menu wiring (public/js/passport/): self-reported vs recorded vs
// confirmed-by-others kept apart; "confirmed" only from independent riders (likes never); badges for quality with
// their reasons; nothing travel-related on the card by default; place messages previewed and minimal.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../../public/js/passport/passport-model.js");
const { MUPlaceShareCore: S } = require("../../public/js/passport/place-share.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const NOW = Date.UTC(2026, 9, 17);
const rides = [
    { distance: 42000, startedAt: Date.UTC(2026, 5, 1), moving: 5400, place: "Koraput" },
    { distance: 18000, startedAt: Date.UTC(2026, 6, 1), moving: 2400, place: "Jeypore" },
    { distance: 150, startedAt: Date.UTC(2026, 7, 1), place: "Nowhere" }          // under 200 m: never counted
];

test("three kinds of line, labelled and kept apart", () => {
    const p = P.build({ self: { name: "Satyam", ridingSince: 2016, bike: "Pulsar 150", about: "Ghat roads" }, rides, now: NOW,
        reports: { a: { detected: 6, reviewed: 5, published: 3 } }, community: { confirmed: 2, pending: 1, accuracy: 0.75, thanksReceived: 4, badges: [] }, placesShared: 3 });
    assert.deepEqual(p.sections.map((s) => [s.source, s.tag]), [["self", "Self-reported"], ["app", "Recorded on this phone"], ["community", "Independent rides"]]);
    const self = p.sections[0].items;
    assert.equal(self[0].value, "2016");
    assert.match(self[0].note, /10 years, as the rider says/);
    const app = Object.fromEntries(p.sections[1].items.map((i) => [i.id, i]));
    assert.equal(app.distance.value, "60 km");
    assert.equal(app.rides.value, "2", "rides under 200 m aren't counted");
    assert.equal(app.towns.value, "2");
    assert.match(app.reports.note, /6 detected by the phone · 5 reviewed by you · 3 published/);
    assert.match(app.placesShared.note, /not checked by anyone/);
    const com = Object.fromEntries(p.sections[2].items.map((i) => [i.id, i]));
    assert.equal(com.confirmed.value, "2");
    assert.match(com.confirmed.note, /other riders' rides/);
    assert.match(com.helpful.note, /thanks, not proof/);
    // the rider's own published count never appears as "confirmed"
    assert.ok(!/confirm/i.test(app.reports.value + app.reports.note));
});

test("without the community server nothing is claimed as confirmed", () => {
    const p = P.build({ self: {}, rides, reports: { a: { detected: 9, reviewed: 9, published: 9 } }, community: null, now: NOW });
    assert.equal(p.sections[2].items.length, 0);
    assert.match(p.sections[2].empty, /nothing here is claimed/);
    assert.ok(p.badges.every((b) => !b.earned), "no badge without other riders' evidence");
    // a nonsense year isn't shown
    assert.equal(P.build({ self: { ridingSince: 2099 }, now: NOW }).sections[0].items.length, 0);
});

test("badges: from the server's independent-evidence rule; likes alone earn nothing; each says why", () => {
    const thanksOnly = P.badges({ confirmed: 0, accuracy: 0.5, thanksReceived: 500, badges: [] });
    assert.ok(thanksOnly.every((b) => !b.earned), "500 thank-yous and no confirmed reports: nothing");
    const helper = P.badges({ confirmed: 3, accuracy: 0.8, thanksReceived: 10, badges: [] }).find((b) => b.id === "route_helper");
    assert.equal(helper.earned, true);
    assert.match(helper.why, /10 thank-yous.*3 of your reports confirmed/);
    const scout = P.badges({ confirmed: 6, accuracy: 0.78, thanksReceived: 0, badges: [{ id: "rasta_scout" }] }).find((b) => b.id === "rasta_scout");
    assert.equal(scout.earned, true);
    assert.equal(scout.name, "Road Scout");
    assert.match(scout.why, /6 reports confirmed by other riders' rides, 78 % accuracy/);
    const notYet = P.badges({ confirmed: 6, accuracy: 0.78, badges: [{ id: "rasta_scout" }] }).find((b) => b.id === "pakka_scout");
    assert.match(notYet.why, /^Needs: 25 reports confirmed/);
    const guide = P.badges({ confirmed: 99, accuracy: 1, badges: [] }).find((b) => b.id === "local_guide");
    assert.equal(guide.earned, false);
    assert.equal(guide.available, false);
    // never for distance or speed
    for (const b of P.BADGES) assert.ok(!/speed|fastest|distance|ridden|\bkm (ridden|travelled)/i.test(b.rule), b.id);
});

test("card: only lines marked 'On my card'; towns and riding time start private", () => {
    assert.equal(P.DEFAULT_VIS.towns, "private");
    assert.equal(P.DEFAULT_VIS.time, "private");
    const p = P.build({ self: { ridingSince: 2016 }, rides, community: { confirmed: 6, accuracy: 0.8, thanksReceived: 0, badges: [{ id: "rasta_scout" }] }, now: NOW });
    const card = P.forCard(p, P.DEFAULT_VIS);
    const ids = card.sections.flatMap((s) => s.items.map((i) => i.id));
    assert.ok(!ids.includes("towns") && !ids.includes("time"));
    assert.ok(ids.includes("distance") && ids.includes("confirmed"));
    assert.deepEqual(card.badges.map((b) => b.id), ["rasta_scout"]);
    const priv = P.build({ self: {}, rides, community: null, now: NOW, visibility: { distance: "private", rides: "private", placesShared: "private", reports: "private" } });
    assert.deepEqual(P.forCard(priv, { ...P.DEFAULT_VIS, badges: "private" }).sections, [], "everything private: an empty card");
});

test("place message: name, kind, note, a link; coordinates only when asked or needed", () => {
    const m = S.compose({ lat: 18.81123456, lng: 82.71098765, name: "HP Petrol Pump", category: "fuel", note: "Air for tyres too" }, { origin: "https://mapunite.app" });
    assert.equal(m.ok, true);
    assert.equal(m.text.split("\n")[0], "⛽ HP Petrol Pump (Fuel station)");
    assert.equal(m.text.split("\n")[1], "Air for tyres too");
    assert.equal(m.url, "https://mapunite.app/?place=18.81123%2C82.71099&n=HP+Petrol+Pump&c=fuel&note=Air+for+tyres+too");
    assert.equal(m.coords, false);
    assert.ok(!m.text.includes("18.81123, 82.71099"), "no bare coordinates unless asked");
    assert.ok(S.compose({ lat: 18.8, lng: 82.7, name: "X", includeCoords: true }).text.includes("18.80000, 82.70000"));
    // no name: the numbers are needed
    const anon = S.compose({ lat: 18.8, lng: 82.7 }, { origin: "https://mapunite.app" });
    assert.equal(anon.coords, true);
    assert.match(anon.text, /^📍 A place/);
    // no public address (the Android app's https://localhost, or none): an OpenStreetMap link instead
    assert.equal(S.compose({ lat: 18.8, lng: 82.7, name: "X" }, { origin: "https://localhost" }).url, "https://www.openstreetmap.org/?mlat=18.80000&mlon=82.70000#map=17/18.80000/82.70000");
    assert.equal(S.compose({ lat: 95, lng: 82 }).ok, false);
    // control characters and length cut
    assert.equal(S.compose({ lat: 1, lng: 1, name: "a\u0000b".padEnd(100, "c") }).title.length, 60);
    assert.equal(S.categoryFromKind("service"), "repair");
    assert.equal(S.categoryFromKind("lodging"), "stay");
});

test("a shared link opens the place; anything malformed is ignored", () => {
    assert.deepEqual(S.parseLink("?place=18.81123,82.71099&n=HP%20Pump&c=fuel&note=Air"), { lat: 18.81123, lng: 82.71099, name: "HP Pump", category: "fuel", note: "Air" });
    assert.equal(S.parseLink("?place=999,82"), null);
    assert.equal(S.parseLink("?place=abc"), null);
    assert.equal(S.parseLink(""), null);
    assert.equal(S.parseLink("?place=18.8,82.7&c=<script>").category, "other");
    // round trip
    const m = S.compose({ lat: 18.8, lng: 82.7, name: "Viewpoint", category: "viewpoint", note: "Sunset" }, { origin: "https://mapunite.app" });
    assert.deepEqual(S.parseLink(new URL(m.url).search), { lat: 18.8, lng: 82.7, name: "Viewpoint", category: "viewpoint", note: "Sunset" });
});

test("wiring: the phone's share menu (native in the app), previews, no auto-upload, the review's tally, no top speed", () => {
    const java = read("native/android/MapUniteNativePlugin.java");
    assert.match(java, /public void share\(PluginCall call\)/);
    assert.match(java, /Intent\.createChooser\(send, title\)/);
    assert.match(java, /replaceAll\("\[\^A-Za-z0-9\._-\]", "-"\)/, "only a plain file name, never a path from the page");
    const out = read("public/js/passport/share-out.js");
    assert.match(out, /registerPlugin\("MapUniteNative"\)/);
    assert.ok(!/wa\.me|api\.whatsapp|graph\.facebook/.test(out), "no WhatsApp-specific API");
    const place = read("public/js/passport/place-share.js");
    assert.match(place, /Preview: this is exactly what will be shared/);
    assert.match(place, /if \(W\.NavCamera && W\.NavCamera\.active\) return;/, "no long-press sharing during a drive");
    const review = read("public/js/master/roadsense/review.js");
    assert.match(review, /"mu:roadpulse-reviewed"/);
    assert.match(review, /published: shared \? out\.reports\.length : 0/, "published only when it was really shared");
    const ui = read("public/js/share/share-ui.js");
    assert.match(ui, /Your photo is redrawn onto the card, so its location data isn't in the image\./);
    assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(ui + read("public/js/passport/passport-app.js")), "nothing uploaded from the recap or the Passport");
    assert.ok(!/maxSpeed/.test(read("public/js/share/card-render.js").replace(/card\.maxSpeed/g, "")));
    const html = read("public/index.html");
    assert.match(html, /id="passport-open-btn"/);
    for (const f of ["share-out", "place-share", "passport-model", "passport-app"]) assert.ok(html.includes(`<script src="js/passport/${f}.js`), f);
    const sw = read("public/sw.js");
    for (const f of ["share-out.js", "place-share.js", "passport-model.js", "passport-app.js", "passport.css"]) assert.ok(sw.includes(`"/js/passport/${f}"`), f);
});
