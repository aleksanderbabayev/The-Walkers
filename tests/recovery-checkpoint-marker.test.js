const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
const css = fs.readFileSync(require.resolve("../styles.css"), "utf8");

test("recovery checkpoint renders as a light blue-outlined flag marker in the game marker pane", () => {
  const markerFactory = app.slice(app.indexOf("const recoveryCheckpointIcon"), app.indexOf("const updateTerritoryFinishZone"));
  assert.match(markerFactory, /L\.divIcon\(\{[\s\S]*?className: "recovery-checkpoint-icon"[\s\S]*?iconSize: \[32, 32\], iconAnchor: \[16, 16\]/);
  assert.match(markerFactory, /<circle cx="16" cy="16" r="14" fill="#f7fbff" stroke="#1769d2"/);
  assert.match(markerFactory, /<path d="M16\.5 10h7/);
  assert.match(markerFactory, /L\.marker\(latlng, \{\s*icon: recoveryCheckpointIcon, pane: mapPanes\.gameMarker/);
  assert.match(markerFactory, /if \(routeRecoveryMarker\) routeRecoveryMarker\.setLatLng\(latlng\)/);
  assert.match(css, /\.recovery-checkpoint-icon \{ display: block; border: 0; background: transparent;/);
  assert.match(css, /\.recovery-checkpoint-icon svg \{ display: block; width: 32px; height: 32px; \}/);
});

test("checkpoint zone and marker share coordinates and keep recovery lifecycle behavior", () => {
  const markerFactory = app.slice(app.indexOf("const updateRouteRecoveryMarker"), app.indexOf("const updateTerritoryFinishZone"));
  const recoveryStart = app.slice(app.indexOf("const beginRouteRecovery"), app.indexOf("const processRecoveryPosition"));
  const recoveryProgress = app.slice(app.indexOf("const processRecoveryPosition"), app.indexOf("const processPosition"));
  const activeCleanup = app.slice(app.indexOf("const clearActiveWalkView"), app.indexOf("const finishWalk"));
  const finish = app.slice(app.indexOf("const finishWalk"), app.indexOf('$(' + '"start"' + ').addEventListener'));
  const draftRestore = app.slice(app.indexOf("points = draftPoints;"), app.indexOf("finishPositionFilter.reset(points.at(-1) || null)"));

  assert.match(markerFactory, /const latlng = \[point\.lat, point\.lng\]/);
  assert.match(markerFactory, /setLatLng\(latlng\)\.setRadius\(Tracking\.ROUTE_RECOVERY_RADIUS_METERS\)/);
  assert.match(markerFactory, /radius: Tracking\.ROUTE_RECOVERY_RADIUS_METERS/);
  assert.match(recoveryStart, /updateRouteRecoveryMarker\(anchor\)/);
  assert.match(recoveryProgress, /clearRouteRecoveryMarker\(\)[\s\S]*?type: "recovery-completed"/);
  assert.match(activeCleanup, /routeRecovery\.clear\(\); clearRouteRecoveryMarker\(\)/);
  assert.match(finish, /routeRecovery\.clear\(\); clearRouteRecoveryMarker\(\)/);
  assert.match(draftRestore, /routeRecovery\.restore\(draft\.routeRecovery\)\)\s*\{\s*recoveryDistanceToPoint[\s\S]*?updateRouteRecoveryMarker\(routeRecovery\.anchor\)/);
  assert.match(app, /currentLocationMarker = L\.circleMarker\(latlng, \{[^}]*fillColor: WALK_COLORS\.currentLocation[^}]*pane: mapPanes\.currentLocation/);
});
