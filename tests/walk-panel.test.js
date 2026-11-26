const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
const css = fs.readFileSync(require.resolve("../styles.css"), "utf8");

test("active walk panel reuses live timer and distance fields in three labeled metrics", () => {
  assert.match(html, /class="walkMetric"><small class="walkMetricLabel">Время<\/small><b id="elapsed">/);
  assert.match(html, /class="walkMetric"><small class="walkMetricLabel">Расстояние<\/small><small id="distance">/);
  assert.match(html, /id="walkRemainingLabel">До финиша<\/small>[\s\S]*?id="walkRemainingValue">—<\/b>/);
  assert.match(html, /<small class="gps" id="gps">GPS —<\/small>/);

  assert.match(app, /const updateStopwatch = \(at = Date\.now\(\)\) => \{\s*if \(startedAt !== null\) \$\("elapsed"\)\.textContent = formatElapsed\(at - startedAt\);/);
  assert.match(app, /const updateDistance = \(\) => \{ \$\("distance"\)\.textContent = formatKilometers\(distanceMetersTotal\); \}/);
  assert.match(app, /stopwatchTimer = setInterval\(updateStopwatch, 1000\)/);
});

test("remaining value uses trusted finish readiness or a fresh expedition location without affecting mechanics", () => {
  assert.match(app, /const updateWalkRemainingForMode = \(\) => \{[\s\S]*?Tracking\.isLocationFresh\(latestLocation\)[\s\S]*?Tracking\.distanceMeters\(latestLocation, expeditionTarget\)[\s\S]*?Tracking\.evaluateTerritoryCapture\(points, capturePosition\)/);
  assert.match(app, /const updateCaptureAvailability = \(readiness = evaluateCaptureReadiness\(\)\) => \{[\s\S]*?\$\("finish"\)\.disabled = !readiness\.eligible[\s\S]*?updateWalkRemaining\(readiness\.distanceToStartMeters\)/);
  assert.match(app, /expeditionDistanceMeters = Tracking\.distanceMeters\(point, expeditionTarget\);\s*updateWalkRemaining\(expeditionDistanceMeters\)/);
  assert.match(app, /const formatWalkDistance = \(meters\) => !Number\.isFinite\(meters\) \? "—"/);
});

test("compact UI follows the existing walk lifecycle and keeps only important status messages inline", () => {
  const updateMode = app.slice(app.indexOf("const updateModeSelection = () =>"), app.indexOf("const stopStopwatch ="));
  assert.match(updateMode, /walk-compact", inProgress/);
  assert.match(updateMode, /walk-recovering", inProgress && routeRecovery\.active/);
  assert.match(updateMode, /walkRemainingLabel/);
  assert.match(app, /const statusTitle = active \? activeMode === "expedition" \? "Экспедиция" : "Захват территории"/);
  assert.match(app, /\$\("statusText"\)\.hidden = routeRecovery\.active \|\| !important\.includes\(readiness\.reason\)/);
  assert.match(css, /body\.walk-compact \.stopwatch[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /body\.walk-compact \.actions button \{ min-height: 52px; height: 52px/);
  assert.match(css, /body\.walk-compact\.expedition-mode \.actions \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /#message:empty \{ display: none; \}/);
});

test("expedition compass stays inside the status row in compact mode", () => {
  const status = html.match(/<div class="status">([\s\S]*?)<\/div>\s*<div class="stopwatch"/);
  assert.ok(status, "status row should precede the three-metric row");
  assert.match(status[1], /id="expeditionCompass"/);
  assert.match(status[1], /id="gps"/);
  assert.match(css, /body\.walk-compact\.expedition-mode \.status #expeditionCompass:not\(\[hidden\]\)/);
  assert.match(css, /body\.walk-compact\.expedition-mode \.status \.compassReading \{ position: absolute;/);
});
