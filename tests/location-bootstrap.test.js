const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
const css = fs.readFileSync(require.resolve("../styles.css"), "utf8");

test("application scripts load without waiting for a GPS result", () => {
  assert.match(bootstrap, /const startApp = async \(\) => \{[\s\S]*?for \(const source of appScripts\) await loadScript\(source\)/);
  assert.match(bootstrap, /startApp\(\);/);
  assert.doesNotMatch(bootstrap, /geolocation|permissions|locationStartupRetry|createLocationStartupGate/i);
  assert.match(bootstrap, /"app\.js\?v=0\.2\.7"/);
});

test("map and main UI are available without GPS and GPS screens are not blocking", () => {
  assert.match(html, /<body>/);
  assert.match(html, /id="locationStartupScreen"[^>]+hidden/);
  assert.doesNotMatch(html, /locationAccessScreen|location-pending|location-access-denied/);
  assert.doesNotMatch(css, /body\.location-pending|body\.location-access-denied/);
  assert.match(html, /id="map" aria-label="Карта"/);
  assert.match(html, /id="walksDrawer"/);
  assert.match(html, /id="expeditionSetup"/);
  assert.match(html, /id="locationNotice"/);
});

test("map uses a neutral fallback without GPS and centers on the first fresh fix only if untouched", () => {
  assert.match(app, /\.setView\(\[0, 0\], 2\)/);
  assert.match(app, /map\.on\("dragstart zoomstart click"/);
  assert.match(app, /if \(!mapInitialPositionSet\) \{\s*mapInitialPositionSet = true;\s*if \(!mapViewInteracted\) map\.setView\(\[point\.lat, point\.lng\], 15\);/);
});

test("history loads independently of GPS and geolocation starts only after the app loads", () => {
  assert.match(app, /requestCurrentLocation\(\);/);
  assert.match(app, /const redrawSaved = async \(\{ focusWalkId = null \} = \{\}\)/);
  assert.match(app, /const walks = await WalkStorage\.readWalks\(db\)/);
  assert.match(app, /try \{ gpsServices\.startWatch\(\); \}\s*catch/);
  assert.match(app, /const requestCurrentLocation = \(\) =>/);
});

test("a start request waits for fresh GPS and resumes the existing warm-up after recovery", () => {
  assert.match(app, /if \(!locationIsFresh\(latestLocation\)\) \{\s*pendingWalkStartMode = mode;[\s\S]*?Ожидаем точную GPS-позицию/);
  assert.match(app, /if \(pendingWalkStartMode\) \{[\s\S]*?startWalk\(mode\)/);
  assert.match(app, /warmingUp = true; warmupStartedAt = startPressedAt;/);
  assert.match(app, /await beginRecordingAt\(warmup\.point\)/);
  assert.match(app, /if \(!result\.accepted\) \{[\s\S]*?return;/);
});

test("location diagnostics remain available in the main interface", () => {
  assert.match(html, /<details id="locationDiagnostics" class="location-diagnostics">/);
  assert.match(html, /id="locationDiagnosticsFields"/);
  assert.match(html, /id="copyLocationDiagnostics"/);
  assert.match(bootstrap, /locationStartupScreen/);
});
