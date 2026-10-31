const test = require("node:test");
const assert = require("node:assert/strict");
const LocationUi = require("../location-ui.js");

test("location UI distinguishes permission denial without showing technical instructions", () => {
  const denied = LocationUi.getLocationState({ error: { code: 1 } });
  assert.equal(denied.state, "denied");
  assert.equal(denied.title, "Геолокация недоступна");
  assert.equal(denied.message, "Доступ к геолокации запрещён. Нажмите кнопку, чтобы проверить доступ ещё раз.");
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
  assert.match(screen, /<p id="locationAccessMessage">Разрешите доступ к местоположению в настройках браузера\.<\/p>/);
  assert.match(screen, /<button id="locationAccessRetry" type="button">Проверить доступ<\/button>/);
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

test("access retry reports checking, repeated denial, temporary error, and timeout states", () => {
  const checking = LocationUi.getAccessRetryState("checking");
  assert.equal(checking.buttonText, "Проверяем доступ…");
  assert.equal(checking.disabled, true);

  const denied = LocationUi.getAccessRetryState("denied");
  assert.equal(denied.buttonText, "Проверить доступ");
  assert.equal(denied.disabled, false);
  assert.equal(denied.message, "Геолокация всё ещё отключена. Разрешите доступ в настройках браузера.");

  const temporaryError = LocationUi.getAccessRetryState("error");
  assert.equal(temporaryError.buttonText, "Проверить доступ");
  assert.equal(temporaryError.disabled, false);
  assert.match(temporaryError.message, /Попробуйте ещё раз/);

  const timeout = LocationUi.getAccessRetryState("timeout");
  assert.equal(timeout.buttonText, "Проверить доступ");
  assert.equal(timeout.disabled, false);
  assert.match(timeout.message, /слишком много времени/);
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

test("access retry rechecks geolocation, keeps the denied screen, and hides it on success", () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(app, /\$\("locationRetry"\)\.addEventListener\("click"/);
  assert.match(app, /locationFresh: locationIsFresh\(latestLocation\)/);
  assert.match(app, /LocationUi\.canStartWalk\(/);
  assert.match(app, /\$\("locationAccessRetry"\)\.addEventListener\("click", \(\) => \{\s*requestCurrentLocation\(\{ accessRetry: true \}\);\s*\}\)/);
  assert.match(app, /if \(accessRetry\) updateLocationAccessRetry\("checking"\)/);
  assert.match(app, /if \(accessRetry\) updateLocationAccessRetry\("denied"\)/);
  assert.match(app, /if \(accessRetry\) updateLocationAccessRetry\("timeout"\)/);
  assert.match(app, /if \(accessRetry\) updateLocationAccessRetry\("error"\)/);
  assert.match(app, /if \(accessRetry\) updateLocationAccessRetry\("idle"\);\s*musicControl\.setLocationAllowed\(true\);\s*setLocationPermissionScreen\(false\)/);
  assert.match(app, /if \(details\.state === "denied"\) setLocationPermissionScreen\(true\)/);
  assert.match(app, /permission\.addEventListener\("change", updatePermission\)/);
  assert.match(app, /setLocationPermissionScreen\(false\);\s*const result = Tracking\.evaluateLocationPosition/);
  assert.match(app, /window\.addEventListener\("focus", handleLocationResume\)/);
  assert.match(app, /body\.classList\.toggle\("location-denied", denied\)/);
});
