const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ExpeditionMarkers = require("../expedition-markers.js");
const Colors = require("../walk-colors.js");

const createHarness = () => {
  const layers = new Set();
  const created = [];
  const map = {
    addLayer(layer) { layers.add(layer); },
    removeLayer(layer) { layers.delete(layer); }
  };
  const leaflet = {
    circleMarker(latlng, options) {
      const marker = {
        latlng,
        options,
        addTo(targetMap) { targetMap.addLayer(this); return this; },
        setLatLng(nextLatLng) { this.latlng = nextLatLng; return this; }
      };
      created.push(marker);
      return marker;
    }
  };
  return { markers: ExpeditionMarkers.createExpeditionMarkers({ map, leaflet }), layers, created };
};

const target = { lat: 48.15, lng: 17.11 };
const start = { lat: 48.14, lng: 17.1 };

test("current expedition target is yellow, centered on its coordinates, and reuses one layer", () => {
  const { markers, layers, created } = createHarness();
  markers.updateTarget(target);
  const marker = [...layers][0];
  assert.deepEqual(marker.latlng, [target.lat, target.lng]);
  assert.equal(2 * marker.options.radius + marker.options.weight, 12);
  assert.equal(marker.options.fillColor, Colors.expeditionGoal);
  assert.equal(marker.options.weight, 1);
  assert.equal(marker.options.color, "#fff");
  assert.equal(marker.options.pane, "markerPane");
  assert.equal(marker.options.interactive, false);
  markers.updateTarget({ lat: 48.16, lng: 17.12 });
  assert.equal(created.length, 1);
  assert.equal(layers.size, 1);
});

test("current start marker appears only after a valid point and reuses its layer", () => {
  const { markers, layers, created } = createHarness();
  assert.equal(layers.size, 0);
  markers.updateStart(null);
  markers.updateStart({ lat: NaN, lng: 17.1 });
  assert.equal(layers.size, 0);
  markers.updateStart(start);
  const marker = [...layers][0];
  assert.deepEqual(marker.latlng, [start.lat, start.lng]);
  assert.equal(2 * marker.options.radius + marker.options.weight, 8);
  assert.equal(marker.options.fillColor, Colors.startMarker);
  assert.equal(marker.options.weight, 1);
  assert.equal(marker.options.pane, "markerPane");
  markers.updateStart({ lat: 48.141, lng: 17.101 });
  assert.equal(created.length, 1);
  assert.equal(layers.size, 1);
});

test("successful history uses saved start and target coordinates with a green finish", () => {
  const { markers, created } = createHarness();
  const layers = markers.createHistoryMarkers({
    mode: "expedition", expeditionStatus: "reached", startPosition: start,
    target, points: [{ lat: 1, lng: 1 }]
  });
  assert.equal(layers.length, 2);
  assert.deepEqual(layers[0].latlng, [start.lat, start.lng]);
  assert.equal(layers[0].options.fillColor, Colors.startMarker);
  assert.equal(2 * layers[0].options.radius + layers[0].options.weight, 8);
  assert.deepEqual(layers[1].latlng, [target.lat, target.lng]);
  assert.equal(layers[1].options.fillColor, Colors.completedExpeditionGoal);
  assert.equal(2 * layers[1].options.radius + layers[1].options.weight, 12);
  assert.equal(layers[0].options.weight, 1);
  assert.equal(layers[1].options.weight, 1);
  assert.equal(created.every((marker) => marker.options.interactive === false), true);
});

test("retreated history never gets a green finish and missing starts are not invented", () => {
  const { markers } = createHarness();
  const retreated = markers.createHistoryMarkers({
    mode: "expedition", expeditionStatus: "incomplete", status: "retreated",
    target, points: [{ lat: start.lat, lng: start.lng }]
  });
  assert.equal(retreated.length, 1);
  assert.equal(retreated[0].options.fillColor, Colors.startMarker);
  const noStart = markers.createHistoryMarkers({ mode: "expedition", expeditionStatus: "reached", target, points: [] });
  assert.equal(noStart.length, 1);
  assert.equal(noStart[0].options.fillColor, Colors.completedExpeditionGoal);
  assert.deepEqual(markers.createHistoryMarkers({ mode: "territory", target, points: [start] }), []);
});

test("route palette uses status data for current and saved expeditions and preserves capture colors", () => {
  assert.equal(Colors.activeExpeditionRoute, "#2877DF");
  assert.equal(Colors.completedExpeditionRoute, "#2F874D");
  assert.equal(Colors.retreatedExpeditionRoute, "#929A96");
  assert.equal(ExpeditionMarkers.getHistoryRouteColor({ mode: "expedition", expeditionStatus: "reached" }), Colors.completedExpeditionRoute);
  assert.equal(ExpeditionMarkers.getHistoryRouteColor({ mode: "expedition", expeditionStatus: "incomplete", status: "retreated" }), Colors.retreatedExpeditionRoute);
  assert.equal(ExpeditionMarkers.getHistoryRouteColor({ mode: "expedition" }), Colors.retreatedExpeditionRoute);
  assert.equal(ExpeditionMarkers.getHistoryRouteColor({ mode: "territory", closed: false }), Colors.activeTerritoryRoute);
  assert.deepEqual(ExpeditionMarkers.getHistoryRouteStyle({ mode: "expedition", status: "retreated" }), {
    color: Colors.retreatedExpeditionRoute,
    weight: 4,
    outlineColor: Colors.retreatedExpeditionOutline,
    outlineWeight: 6
  });
  assert.deepEqual(ExpeditionMarkers.getHistoryRouteStyle({ mode: "expedition", expeditionStatus: "reached" }), {
    color: Colors.completedExpeditionRoute,
    weight: 4
  });
  assert.deepEqual(ExpeditionMarkers.getHistoryRouteStyle({ mode: "territory", closed: false }), {
    color: Colors.activeTerritoryRoute,
    weight: 4
  });
  assert.equal(ExpeditionMarkers.isCompletedExpedition({ mode: "expedition", expeditionStatus: "reached" }), true);
  assert.equal(ExpeditionMarkers.isCompletedExpedition({ mode: "expedition", expeditionStatus: "reached", status: "retreated" }), false);
});

test("app draws expedition start only from accepted route data and restores saved history markers", () => {
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
  const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
  assert.match(html, /name="app-version" content="0\.2\.28"/);
  assert.ok(bootstrap.includes('"walk-colors.js?v=0.2.25"'));
  assert.ok(bootstrap.includes('"expedition-markers.js?v=0.2.7"'));
  assert.ok(bootstrap.includes('"app.js?v=0.2.28"'));
  assert.ok(app.includes("if (activeMode === \"expedition\") updateExpeditionStartMarker(recordedStartPoint)"));
  assert.ok(app.includes("if (activeMode === \"expedition\") updateExpeditionStartMarker(restoredValidatedPoints[0])"));
  assert.ok(app.includes("if (activeMode === \"expedition\" && points[0]) updateExpeditionStartMarker(points[0])"));
  assert.ok(app.includes("expeditionMarkers.createHistoryMarkers(walk)"));
  assert.ok(app.includes("ExpeditionMarkers.getHistoryRouteStyle(walk)"));
  assert.match(app, /const displayWalk = \(expedition && retreated\) \|\| Tracking\.shouldDisplayWalkOnMap\(walk\)/);
  assert.ok(app.includes("expeditionMarkers.clearStart()"));
  assert.ok(app.includes("expeditionMarkers.updateTarget(target)"));
  const markerSource = fs.readFileSync(require.resolve("../expedition-markers.js"), "utf8");
  assert.ok(markerSource.includes('walk.expeditionStatus === "reached"'));
});

test("territory finish zone is created, centered, hidden, and restored with an active draft", () => {
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const core = fs.readFileSync(require.resolve("../tracking-core.js"), "utf8");
  assert.match(core, /const FINISH_ZONE_RADIUS_METERS = 25/);
  assert.match(app, /const updateTerritoryFinishZone = \(point\) => \{[\s\S]*?if \(!recordingActive \|\| activeMode !== "territory" \|\| !point\) \{\s*clearTerritoryFinishZone\(\)/);
  assert.match(app, /territoryFinishZone = L\.circle\(latlng, \{\s*radius: Tracking\.FINISH_ZONE_RADIUS_METERS,[\s\S]*?fillOpacity: 0\.14,[\s\S]*?interactive: false/);
  assert.match(app, /const clearTerritoryFinishZone = \(\) => \{\s*if \(territoryFinishZone\) map\.removeLayer\(territoryFinishZone\);\s*territoryFinishZone = null/);
  assert.match(app, /const clearRouteStartMarker = \(\) => \{[\s\S]*?clearTerritoryFinishZone\(\)/);

  const beginRecording = app.slice(app.indexOf("const beginRecordingAt"), app.indexOf("const processPosition"));
  assert.match(beginRecording, /setRecording\(true\); startStopwatch\(\);\s*updateTerritoryFinishZone\(recordedStartPoint\)/);
  assert.match(app, /updateRouteStartMarker\(points\[0\]\);\s*updateTerritoryFinishZone\(points\[0\]\)/);
  const restoreDraft = app.slice(app.indexOf("const restoredValidatedPoints"), app.indexOf("} else {\n          try { await WalkStorage.deleteDraft"));
  assert.match(restoreDraft, /setRecording\(!warmingUp\);\s*if \(!warmingUp && activeMode === "territory" && restoredValidatedPoints\.length\)\s*\{\s*updateTerritoryFinishZone\(restoredValidatedPoints\[0\]\)/);
  assert.match(app, /await Actions\.commitIfReady\([\s\S]*?WalkStorage\.completeWalk\(db, walk\)[\s\S]*?clearRouteStartMarker\(\)/);
  assert.match(app, /const clearActiveWalkView = \(\) => \{[\s\S]*?clearRouteStartMarker\(\)/);
});
