const test = require("node:test");
const assert = require("node:assert/strict");
const LocationUi = require("../location-ui.js");

test("location UI distinguishes permission denial and explains browser settings after retry", () => {
  const denied = LocationUi.getLocationState({ error: { code: 1 } });
  assert.equal(denied.state, "denied");
  assert.equal(denied.title, "Геолокация недоступна");
  assert.equal(denied.action, "Разрешить геолокацию");

  const stillDenied = LocationUi.getLocationState({ error: { code: 1 }, permissionRetryAttempted: true });
  assert.match(stillDenied.message, /настройки сайта в браузере/);
  assert.equal(stillDenied.action, "Разрешить геолокацию");
});

test("only an explicit permission denial opens the access screen and iPhone Safari gets its settings path", () => {
  assert.equal(LocationUi.isPermissionDenied({ code: 1 }), true);
  assert.equal(LocationUi.isPermissionDenied({ code: 2 }), false);
  assert.equal(LocationUi.isPermissionDenied({ code: 3 }), false);
  assert.match(LocationUi.getPermissionHelp("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1"), /Настройки веб-сайта.*Геопозиция/);
  assert.match(LocationUi.getPermissionHelp("Mozilla/5.0 Chrome/130.0"), /настройки браузера.*разрешения сайта/);

  const fs = require("node:fs");
  const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
  assert.match(html, /Необходим доступ к геолокации/);
  assert.match(html, /Чтобы записывать прогулки и захватывать территории, разрешите приложению определять ваше местоположение/);
  assert.match(html, /id="locationAccessRetry" type="button">Разрешить геолокацию/);
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

test("app retries from the notice and gates walk start on a fresh location", () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(app, /\$\("locationRetry"\)\.addEventListener\("click"/);
  assert.match(app, /locationFresh: locationIsFresh\(latestLocation\)/);
  assert.match(app, /LocationUi\.canStartWalk\(/);
  assert.match(app, /showLocationState\(\{ error, permissionRetryAttempted \}\)/);
  assert.match(app, /\$\("locationAccessRetry"\)\.addEventListener\("click"/);
  assert.match(app, /permission\.addEventListener\("change", updatePermission\)/);
  assert.match(app, /setLocationPermissionScreen\(false\);\s*const result = Tracking\.evaluateLocationPosition/);
  assert.match(app, /window\.addEventListener\("focus", handleLocationResume\)/);
  assert.match(app, /body\.classList\.toggle\("location-denied", denied\)/);
});
