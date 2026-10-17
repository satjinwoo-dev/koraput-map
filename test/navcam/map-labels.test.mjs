// The satellite view (the default map) shows names like Google's satellite "hybrid" view: road and place label
// layers over the imagery, in their own pane above the route line, and the navigation camera's low-res underlay
// copies the imagery, never the labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("satellite = imagery + road names + place names, as one layer the style menu switches", () => {
    const core = read("public/js/core.js");
    assert.match(core, /const satelliteLayer = L\.layerGroup\(\[satelliteImagery, \.\.\.satelliteLabels\]\);/);
    assert.match(core, /\["World_Transportation", "World_Boundaries_and_Places"\]/);
    assert.match(core, /const ESRI_REFERENCE = "https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/Reference";/);
    assert.match(core, /`\$\{ESRI_REFERENCE\}\/\$\{svc\}\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}`/);
    assert.match(core, /pane: "mu-labels", muOverlay: true/);
    assert.match(core, /getPane\("mu-labels"\)\.style\.pointerEvents = "none"/, "labels never take a tap");
    assert.match(core, /satelliteLayer\.addTo\(map\)/, "still the default");
    // the style menu removes and adds satelliteLayer as a whole
    assert.match(read("public/js/controls.js"), /\[satelliteLayer, streetLayer, darkLayer, terrainLayer\]\.forEach/);
    // the labels' host is registered and cached offline like the imagery
    const reg = JSON.parse(read("data/sources.json"));
    assert.ok(reg.sources.find((s) => s.id === "esri-imagery").use.includes("World_Transportation"));
    assert.match(read("public/sw.js"), /arcgisonline\\\.com/);
});

test("the navigation camera's underlay and wider tile ring use the base map, not the labels", () => {
    const cam = read("public/js/navcam/navcam.js");
    assert.match(cam, /const isBase = \(\/\*\* @type \{any\} \*\/ l\) => l instanceof L\.TileLayer && !l\.options\.muOverlay;/);
    assert.match(cam, /if \(!base && isBase\(l\)/);
    assert.match(cam, /if \(l !== underlay && isBase\(l\)\)/);
});
