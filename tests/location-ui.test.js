const test = require("node:test");
const assert = require("node:assert/strict");
const LocationUi = require("../location-ui.js");

test("location UI distinguishes permission denial without showing technical instructions", () => {
  const denied = LocationUi.getLocationState({ error: { code: 1 } });
  assert.equal(denied.state, "denied");
  assert.equal(denied.title, "Геолокация недоступна");
  assert.equal(denied.message, "Доступ к геолокации запрещён.");
  assert.equal(denied.action, "Разрешить геолокацию");
});

test("only an explicit permission denial opens the simplified access screen", () => {
  assert.equal(LocationUi.isPermissionDenied({ code: 1 }), true);
  assert.equal(LocationUi.isPermissionDenied({ code: 2 }), false);
  assert.equal(LocationUi.isPermissionDenied({ code: 3 }), false);

  const fs = require("node:fs");
  const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
  const screen = html.match(/<main id="locationAccessScreen"[\s\S]*?<\/main>/)?.[0];
  assert.ok(screen);
  assert.match(screen, /<h1 id="locationAccessTitle">Включите геолокацию<\/h1>/);
  assert.match(screen, /<p id="locationAccessMessage">Разрешите доступ к геолокации в настройках устройства и браузера и перезагрузите страницу\.<\/p>/);
  assert.doesNotMatch(screen, /locationAccessRetry|Проверить доступ/);
  assert.match(screen, /<button id="locationAccessReload" type="button">Перезагрузить страницу<\/button>/);
  assert.equal((screen.match(/<section class="location-access-card">[\s\S]*?(?=<details)/)?.[0].match(/<(h1|p|button)\b/g) || []).length, 3);
  assert.match(screen, /<details id="locationDiagnostics" class="location-diagnostics">/);
});

test("location UI shows loading, ready, and temporary unavailable states", () => {
  assert.equal(LocationUi.getLocationState().title, "Определяем местоположение");
  assert.equal(LocationUi.getLocationState({ reason: "ready" }).title, "Местоположение определено");

  const unavailable = LocationUi.getLocationState({ error: { code: 3 } });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.action, "Попробовать снова");
  assert.match(unavailable.message, /сигнал GPS/);

  const unsupported = LocationUi.getLocationState({ reason: "unsupported" });
  assert.equal(unsupported.state, "unavailable");
  assert.equal(unsupported.action, "");
});

test("weak or stale fixes do not suggest changing location permissions", () => {
  const weak = LocationUi.getLocationState({ reason: "accuracy", accuracy: 83 });
  assert.equal(weak.state, "weak");
  assert.match(weak.message, /±83 м/);
  assert.doesNotMatch(weak.message, /разреш/i);
  assert.equal(weak.action, "Проверить GPS снова");

  const stale = LocationUi.getLocationState({ reason: "stale" });
  assert.equal(stale.state, "unavailable");
  assert.doesNotMatch(stale.message, /разреш/i);
});

test("walk start is enabled only when storage, draft, and fresh location are ready", () => {
  const base = { storageReady: true, draftResolved: true, locationFresh: true, busy: false };
  assert.equal(LocationUi.canStartWalk(base), true);
  assert.equal(LocationUi.canStartWalk({ ...base, locationFresh: false }), false);
  assert.equal(LocationUi.canStartWalk({ ...base, storageReady: false }), false);
  assert.equal(LocationUi.canStartWalk({ ...base, draftResolved: false }), false);
  assert.equal(LocationUi.canStartWalk({ ...base, busy: true }), false);
});

test("permission lock has a user-triggered safe reload and recovers on background location success", () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(app, /\$\("locationRetry"\)\.addEventListener\("click"/);
  assert.match(app, /locationFresh: locationIsFresh\(latestLocation\)/);
  assert.match(app, /LocationUi\.canStartWalk\(/);
  assert.doesNotMatch(app, /locationAccessRetry|getAccessRetryState|accessRetry/);
  assert.match(app, /musicControl\.setLocationAllowed\(true\);\s*setLocationPermissionScreen\(false\)/);
  assert.match(app, /\$\("locationAccessReload"\)\.addEventListener\("click", async \(\) => \{/);
  assert.match(app, /const pendingTracking = trackingQueue;\s*await pendingTracking;[\s\S]*?await saveDraftSnapshot\(points, startedAt, initialRouteBuffer\.snapshot\(\)\);[\s\S]*?if \(pendingTracking === trackingQueue && pendingDiagnostics === diagnosticsQueue\) break;[\s\S]*?window\.location\.reload\(\)/);
  assert.match(app, /starting \|\| finishing \|\| cancelling[\s\S]*?return;/);
  assert.match(app, /if \(locationPermissionDenied\) \{\s*requestCurrentLocation\(\);\s*return;/);
  assert.match(app, /permission\.addEventListener\("change", updatePermission\)/);
  assert.equal((app.match(/window\.location\.reload\(\)/g) || []).length, 1, "the page reload exists only in the explicit button handler");
  assert.match(app, /if \(details\.state === "denied"\) setLocationPermissionScreen\(true\)/);
  assert.match(app, /setLocationPermissionScreen\(false\);\s*const result = Tracking\.evaluateLocationPosition/);
  assert.match(app, /window\.addEventListener\("focus", handleLocationResume\)/);
  assert.match(app, /body\.classList\.toggle\("location-denied", denied\)/);
});
