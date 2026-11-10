const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Tracking = require("../tracking-core.js");
const LocationUi = fs.readFileSync(require.resolve("../location-ui.js"), "utf8");

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
const css = fs.readFileSync(require.resolve("../styles.css"), "utf8");
const now = 1_800_000_000_000;
const position = (lat, lng, timestamp = now, accuracy = 89) => ({ timestamp, coords: { latitude: lat, longitude: lng, accuracy } });

test("startup screen covers the map until the first fresh usable GPS coordinate", () => {
  assert.match(html, /id="locationStartupScreen" class="location-access-screen" aria-live="polite">/);
  assert.match(html, /Определяем местоположение/);
  assert.match(html, /id="locationStartupRetry"/);
  assert.match(app, /const completeLocationStartup = \(point\) => \{[\s\S]*?map\.setView\(\[point\.lat, point\.lng\], 15\);[\s\S]*?locationStartupScreen"\)\.hidden = true/);
  assert.match(app, /const onLocationError = \(error\) => \{[\s\S]*?showLocationStartupError/);
  assert.match(css, /\.location-access-screen \{ position: fixed; z-index: 5000/);
});

test("display validation allows a fresh 89 m fix but rejects stale, invalid, or malformed coordinates", () => {
  const result = Tracking.evaluateDisplayPosition(position(48.9, 21.2), now);
  assert.equal(result.accepted, true);
  assert.equal(result.point.accuracy, 89);
  assert.equal(Tracking.evaluateDisplayPosition(position(48.9, 21.2, now - 30001), now).reason, "stale");
  assert.equal(Tracking.evaluateDisplayPosition(position(91, 21.2), now).reason, "invalid");
  assert.equal(Tracking.evaluateDisplayPosition(position(48.9, 21.2, now, 0), now).reason, "accuracy");
  assert.equal(Tracking.evaluateLocationPosition(position(48.9, 21.2), now).reason, "accuracy", "display acceptance does not relax game GPS filtering");
});

test("GPS display uses one reusable Leaflet accuracy circle with radius in meters", () => {
  assert.match(app, /L\.circle\(latlng,\s*\{\s*radius: point\.accuracy/);
  assert.match(app, /accuracyCircle\.setLatLng\(latlng\)\.setRadius\(point\.accuracy\)/);
  assert.match(app, /interactive: false/);
  assert.match(app, /const displayResult = Tracking\.evaluateDisplayPosition\(position, processedAt\)/);
  assert.match(app, /if \(Tracking\.shouldUpdateGpsMarker\("preliminary", recordingActive\)\) updateAccuracyDisplay\(displayResult\.point\);\s*else updateAccuracyCircle\(displayResult\.point\)/);
});

test("GPS accuracy circle is dismissed once the existing warm-up stability criteria pass", () => {
  assert.match(app, /const startupGpsStabilizer = Tracking\.createGpsWarmup\(\)/);
  assert.match(app, /if \(stable\) \{\s*accuracyCircleDismissed = true;\s*map\.removeLayer\(accuracyCircle\)/);
  assert.match(app, /if \(accuracyCircleDismissed\) return/);
  assert.match(app, /const warmup = gpsWarmup\.add\(position, Date\.now\(\)\)/);
  assert.equal((app.match(/accuracyCircleDismissed = false/g) || []).length, 1, "the flag is initialized once and never reset");
});

test("active recording moves the GPS marker only after accepted route filtering", () => {
  const processing = app.slice(app.indexOf("const processPosition"), app.indexOf("const receivePosition"));
  assert.match(processing, /Tracking\.shouldUpdateGpsMarker\("preliminary", recordingActive\)/);
  assert.match(processing, /const result = bufferingInitial\s*\?[\s\S]*?positionFilter\.evaluate\(position, points\.at\(-1\), Date\.now\(\)\)/);
  assert.match(processing, /if \(!result\.accepted\) \{[\s\S]*?return;[\s\S]*?rememberLocation\(lastValidatedPoint\);\s*updateLocationMarker\(lastValidatedPoint\)/);
  assert.match(processing, /rememberLocation\(result\.point\);\s*drawCurrent\(\); updateDistance\(\); updateLocationMarker\(result\.point\)/);
});

test("startup retry and permission errors produce a finite, actionable state", () => {
  assert.match(app, /\$\("locationStartupRetry"\)\.addEventListener\("click"/);
  assert.match(app, /Доступ запрещён\. Разрешите геолокацию для этого сайта в настройках браузера/);
  assert.match(app, /const LOCATION_WAIT_TIMEOUT_MS = 20000/);
  assert.match(app, /showLocationStartupError\(details\);/);
  assert.match(LocationUi, /action: "Попробовать снова"/);
});

test("small-height mobile layout keeps startup, mode, status, and primary actions in view", () => {
  const compactLayout = css.match(/@media \(max-width: 760px\) and \(max-height: 700px\) \{([\s\S]*?)\n\}/)?.[1];
  const veryShortLayout = css.match(/@media \(max-width: 760px\) and \(max-height: 500px\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(compactLayout);
  assert.ok(veryShortLayout);
  assert.match(compactLayout, /grid-template-rows: minmax\(100px, \.48fr\) minmax\(0, 1\.52fr\)/);
  assert.match(compactLayout, /body\.expedition-mode main \{ grid-template-rows:/);
  assert.match(compactLayout, /env\(safe-area-inset-bottom\)/);
  assert.match(compactLayout, /\.location-access-screen \{[\s\S]*?background: transparent;[\s\S]*?pointer-events: none;/);
  assert.match(compactLayout, /\.location-access-card \{[\s\S]*?pointer-events: auto;/);
  assert.match(compactLayout, /#locationRetry \{ min-height: 44px/);
  assert.match(compactLayout, /\.location-access-card button \{ min-height: 44px/);
  assert.match(compactLayout, /\.actions button \{ min-height: 44px/);
  assert.match(compactLayout, /#locationDiagnostics summary \{ min-height: 24px/);
  assert.match(veryShortLayout, /#locationDiagnostics, \.walksToggle \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 760px\) and \(max-height: 400px\)/);
  assert.match(html, /id="modeSelector"/);
  assert.match(html, /id="startExpedition"/);
  assert.match(html, /id="manualWarmupStart"/);
});

test("initial map center comes from first usable GPS before saved history can set focus", () => {
  assert.match(app, /const completeLocationStartup = \(point\) => \{[\s\S]*?map\.setView\(\[point\.lat, point\.lng\], 15\)/);
  assert.match(app, /const gpsServices = Tracking\.createGpsServices\([\s\S]*?onPosition: receivePosition/);
  assert.match(app, /try \{ gpsServices\.startWatch\(\); \}/);
  assert.doesNotMatch(app, /pendingWalkStartMode/);
});

test("weak initial location remains display-only and Start enters existing warm-up", () => {
  const startWalk = app.match(/const startWalk = async \(mode = selectedMode\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(startWalk);
  assert.doesNotMatch(startWalk, /locationIsFresh\(latestLocation\)\) \{[\s\S]*?return;/);
  assert.match(startWalk, /warmingUp = true; warmupStartedAt = startPressedAt/);
  assert.match(startWalk, /startTrackingServices\(\)/);
  assert.match(app, /const result = Tracking\.evaluateLocationUpdate\(position, latestLocation, processedAt\)/);
  assert.match(app, /const warmup = gpsWarmup\.add\(position, Date\.now\(\)\)/);
  assert.match(app, /const freshCandidate = gpsWarmup\.manualStartPoint\(Date\.now\(\), Date\.now\(\) - warmupStartedAt\)/);
  assert.match(app, /if \(!confirm\(`Точность GPS сейчас/);
  assert.match(app, /await beginRecordingAt\(warmup\.point\)/);
  assert.doesNotMatch(app, /pendingWalkStartMode/);
});

test("history and expedition setup remain available after successful startup", () => {
  assert.match(html, /id="walksDrawer"/);
  assert.match(html, /id="expeditionSetup"/);
  assert.match(app, /const redrawSaved = async \(\{ focusWalkId = null \} = \{\}\)/);
  assert.match(app, /const walks = await WalkStorage\.readWalks\(db\)/);
  assert.match(app, /if \(mode === "expedition" && !expeditionTarget\)/);
});
