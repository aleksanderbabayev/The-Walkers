const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
const css = fs.readFileSync(require.resolve("../styles.css"), "utf8");
const core = fs.readFileSync(require.resolve("../tracking-core.js"), "utf8");

test("territory start marker is flag-only, compact, and named for assistive technology", () => {
  const createMarker = app.slice(app.indexOf("const updateRouteStartMarker"), app.indexOf("const updateExpeditionStartMarker"));
  assert.match(createMarker, /iconSize: \[24, 32\]/);
  assert.match(createMarker, /iconAnchor: \[5, 30\]/);
  assert.match(createMarker, /<svg class="route-start-flag" viewBox="0 0 24 32" role="img" aria-label="Старт маршрута">/);
  assert.match(createMarker, /class="route-start-cloth"/);
  assert.match(createMarker, /class="route-start-checks"/);
  assert.match(createMarker, /title: "Старт маршрута"/);
  assert.doesNotMatch(createMarker, /<span>Старт<\/span>|route-start-content/);
  assert.match(css, /\.route-start-marker \{ border: 0; background: transparent; \}/);
  assert.match(css, /\.route-start-flag \{ display: block; width: 24px; height: 32px; overflow: visible;/);
  assert.doesNotMatch(css, /route-start-content|route-start-flag[^}]*background/);
});

test("recording, accepted positions, and restored territory drafts reuse the same flag marker", () => {
  const beginRecording = app.slice(app.indexOf("const beginRecordingAt"), app.indexOf("const processPosition"));
  const acceptedPosition = app.slice(app.indexOf("const processPosition"), app.indexOf("const receivePosition"));
  const restoredDraft = app.slice(app.indexOf("const restoredValidatedPoints"), app.indexOf("} else {\n          try { await WalkStorage.deleteDraft"));
  assert.match(beginRecording, /updateRouteStartMarker\(recordedStartPoint\)/);
  assert.match(acceptedPosition, /updateRouteStartMarker\(points\[0\]\)/);
  assert.match(restoredDraft, /else updateRouteStartMarker\(restoredValidatedPoints\[0\]\)/);
  assert.match(core, /const FINISH_ZONE_RADIUS_METERS = 13/);
});
