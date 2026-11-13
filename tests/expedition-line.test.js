const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ExpeditionLine = require("../expedition-line.js");
const ExpeditionMarkers = require("../expedition-markers.js");
const Colors = require("../walk-colors.js");

const createHarness = () => {
  const layers = new Set();
  const calls = { created: 0, updates: 0, added: 0, removed: 0, options: null };
  const map = {
    addLayer(layer) { calls.added += 1; layers.add(layer); },
    removeLayer(layer) { calls.removed += 1; layers.delete(layer); },
    hasLayer(layer) { return layers.has(layer); }
  };
  const leaflet = {
    polyline(points, options) {
      calls.created += 1;
      calls.options = options;
      return {
        points,
        setLatLngs(nextPoints) { calls.updates += 1; this.points = nextPoints; }
      };
    }
  };
  const line = ExpeditionLine.createExpeditionLine({ map, leaflet, isLocationFresh: (point) => point.fresh });
  return { line, map, calls, layers };
};

const point = (lat, lng, fresh = true) => ({ lat, lng, fresh });
const target = { lat: 48.2, lng: 17.2 };

test("line is absent before an expedition, then starts at GPS and ends at the target", () => {
  const { line, calls, layers } = createHarness();
  assert.equal(layers.size, 0);
  assert.equal(line.update(point(48.1, 17.1), target, false), false);
  assert.equal(layers.size, 0);
  assert.equal(line.update(point(48.1, 17.1), target, true), true);
  const [layer] = layers;
  assert.deepEqual(layer.points, [[48.1, 17.1], [target.lat, target.lng]]);
  assert.equal(calls.created, 1);
});

test("accepted movement updates the start, preserves the target and reuses one polyline", () => {
  const { line, calls, layers } = createHarness();
  line.update(point(48.1, 17.1), target, true);
  const [layer] = layers;
  line.update(point(48.11, 17.12), target, true);
  assert.deepEqual(layer.points, [[48.11, 17.12], [target.lat, target.lng]]);
  assert.equal(calls.created, 1);
  assert.equal(calls.updates, 2);
  assert.equal(calls.added, 1);
});

test("a rejected stale measurement preserves the line while the last accepted fix is fresh", () => {
  const { line, calls, layers } = createHarness();
  const lastAccepted = point(48.1, 17.1);
  line.update(lastAccepted, target, true);
  const [layer] = layers;
  // A rejected measurement is not passed to update; the accepted fix remains fresh.
  const rejectedMeasurement = point(48.12, 17.15, false);
  assert.equal(rejectedMeasurement.fresh, false);
  assert.equal(lastAccepted.fresh, true);
  assert.equal(layers.has(layer), true);
  assert.deepEqual(layer.points, [[48.1, 17.1], [target.lat, target.lng]]);
  line.update(point(48.11, 17.12), target, true);
  assert.equal(layers.has(layer), true);
  assert.deepEqual(layer.points, [[48.11, 17.12], [target.lat, target.lng]]);
  assert.equal(calls.created, 1);
});

test("actual expiry of the last accepted position hides and then restores the same line", () => {
  const { line, calls, layers } = createHarness();
  const lastAccepted = point(48.1, 17.1);
  line.update(lastAccepted, target, true);
  const [layer] = layers;
  lastAccepted.fresh = false;
  line.update(lastAccepted, target, true);
  assert.equal(layers.size, 0);
  assert.deepEqual(layer.points, [[48.1, 17.1], [target.lat, target.lng]]);
  const recovered = point(48.11, 17.12);
  line.update(recovered, target, true);
  assert.equal([...layers][0], layer);
  assert.deepEqual(layer.points, [[48.11, 17.12], [target.lat, target.lng]]);
  assert.equal(calls.created, 1);
});

test("GPS recovery restores the same layer, while completion and retreat hide it", () => {
  const { line, calls, layers } = createHarness();
  line.update(point(48.1, 17.1), target, true);
  const [layer] = layers;
  line.hide();
  assert.equal(layers.size, 0);
  line.update(point(48.11, 17.11), target, true);
  assert.equal([...layers][0], layer);
  line.update(point(48.12, 17.12), target, false); // completion/retreat
  assert.equal(layers.size, 0);
  assert.equal(calls.created, 1);
});

test("line uses a visible cyan dashed non-interactive style", () => {
  const { line, calls } = createHarness();
  line.update(point(48.1, 17.1), target, true);
  assert.equal(calls.options.color, "#29b6e6");
  assert.ok(calls.options.dashArray);
  assert.equal(calls.options.interactive, false);
  assert.equal(calls.options.bubblingMouseEvents, false);
});

test("active route palette distinguishes expedition from territory without changing GPS line styling", () => {
  assert.equal(ExpeditionMarkers.getActiveRouteColor("expedition"), "#2877DF");
  assert.equal(ExpeditionMarkers.getActiveRouteColor("territory"), Colors.activeTerritoryRoute);
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(app, /ExpeditionMarkers\.getActiveRouteColor\(activeMode\)/);
});

test("app wires line updates only through accepted expedition progress and hides it on lifecycle changes", () => {
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
  const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
  const processingStart = app.indexOf("const processPosition");
  const processingEnd = app.indexOf('$(&quot;manualWarmupStart&quot;)', processingStart);
  const processing = app.slice(processingStart, processingEnd < 0 ? undefined : processingEnd);
  const rejected = processing.indexOf("if (!result.accepted) {");
  const acceptedUpdate = processing.lastIndexOf("updateExpeditionProgress(result.point)");
  assert.ok(rejected >= 0 && acceptedUpdate > rejected);
  assert.ok(processing.indexOf("return;", rejected) < acceptedUpdate);
  assert.ok(app.includes("expeditionLine.update(point, expeditionTarget"));
  assert.ok(app.includes("expeditionLine.hide();"));
  assert.ok(app.includes("ExpeditionLine.createExpeditionLine"));
  assert.ok(app.includes('activeMode = draft.mode === "expedition" ? "expedition" : "territory"'));
  assert.ok(app.includes("startTrackingServices();"));
  assert.match(html, /name="app-version" content="0\.2\.32"/);
  assert.ok(bootstrap.includes('"expedition-line.js?v=0.2.4"'));
  assert.ok(bootstrap.includes('"app.js?v=0.2.32"'));
  assert.doesNotMatch(processing, /result\.reason === "stale"[^\n]*expeditionLine\.hide/);
  assert.match(app, /if \(recordingActive && activeMode === "expedition" && !locationIsFresh\(latestLocation\)\)[\s\S]*?expeditionLine\.hide\(\)/);
});
