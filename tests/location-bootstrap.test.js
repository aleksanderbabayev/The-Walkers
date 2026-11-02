const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createLocationStartupGate, validateStartupPosition } = require("../location-bootstrap.js");
const position = (coords = {}) => ({
  timestamp: Date.now(),
  coords: { latitude: 48.15, longitude: 17.11, accuracy: 8, ...coords }
});

test("startup accepts only fresh valid GPS coordinates within the 50 m location limit", () => {
  const now = Date.now();
  assert.equal(validateStartupPosition(position({ accuracy: 50 }), now).accepted, true);
  assert.deepEqual(validateStartupPosition(position({ accuracy: 50.1 }), now), { accepted: false, reason: "accuracy", accuracy: 50.1 });
  assert.equal(validateStartupPosition({ ...position(), timestamp: now - 30001 }, now).reason, "stale");
  assert.equal(validateStartupPosition({ ...position(), coords: { latitude: 91, longitude: 0, accuracy: 4 } }, now).reason, "invalid");
});

const makePermission = (state) => {
  const listeners = new Set();
  return {
    get state() { return state.value; },
    addEventListener(name, listener) { if (name === "change") listeners.add(listener); },
    removeEventListener(name, listener) { if (name === "change") listeners.delete(listener); },
    change(nextState) { state.value = nextState; listeners.forEach((listener) => listener()); }
  };
};

const makeEnvironment = ({ permissionState = "prompt", timers = new Map() } = {}) => {
  const requests = [];
  const listeners = new Map();
  let timerId = 0;
  const permission = makePermission({ value: permissionState });
  const navigatorLike = {
    geolocation: { getCurrentPosition(success, error, options) { requests.push({ success, error, options }); } },
    permissions: { query: async () => permission },
    window: {
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); }
    },
    document: {
      visibilityState: "visible",
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); }
    }
  };
  const gateStates = [], readyResults = [];
  const gate = createLocationStartupGate({
    navigatorLike,
    onState: (state, result) => gateStates.push({ state, result }),
    onReady: (state, result) => readyResults.push({ state, result }),
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  return { gate, gateStates, readyResults, requests, permission, timers, listeners };
};

test("first launch requests geolocation immediately while the app remains gated", () => {
  const env = makeEnvironment({ permissionState: "prompt" });
  env.gate.start();
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].options.timeout, 20000);
  assert.deepEqual(env.readyResults, []);
  assert.equal(env.gate.getState(), "checking");
  env.requests[0].success(position());
  assert.equal(env.readyResults[0].state, "ready");
  assert.equal(env.readyResults[0].result.position.coords.latitude, 48.15);
});

test("an already granted permission still requires a Geolocation API response before startup", async () => {
  const env = makeEnvironment({ permissionState: "granted" });
  env.gate.start();
  await Promise.resolve();
  assert.equal(env.requests.length, 1);
  assert.deepEqual(env.readyResults, []);
  env.requests[0].success(position());
  assert.equal(env.readyResults[0].state, "ready");
});

test("a denied startup stays on the access screen, then recovers after permission changes", async () => {
  const env = makeEnvironment({ permissionState: "denied" });
  env.gate.start();
  env.requests[0].error({ code: 1 });
  assert.equal(env.gate.getState(), "denied");
  assert.deepEqual(env.readyResults, []);
  await Promise.resolve();
  env.permission.change("granted");
  assert.equal(env.requests.length, 2);
  env.requests[1].success(position());
  assert.equal(env.readyResults[0].state, "ready");
});

for (const [name, error] of [["timeout", { code: 3 }], ["unavailable GPS", { code: 2 }]]) {
  test(`temporary ${name} leaves the map gated and offers a retry`, () => {
    const env = makeEnvironment();
    env.gate.start();
    env.requests[0].error(error);
    assert.equal(env.gateStates.some(({ state }) => state === "denied"), false);
    assert.equal(env.gate.getState(), "unavailable");
    assert.deepEqual(env.readyResults, []);
    env.gate.retry();
    assert.equal(env.requests.length, 2);
  });
}

test("startup fallback is bounded and runs the app only after geolocation resolves", () => {
  const env = makeEnvironment();
  env.gate.start();
  const [timer] = env.timers.values();
  assert.equal(timer.delay, 21000);
  timer.callback();
  assert.equal(env.gate.getState(), "unavailable");
  assert.deepEqual(env.readyResults, []);
});

test("poor accuracy and stale coordinates keep the startup screen until a reliable retry", () => {
  const env = makeEnvironment();
  env.gate.start();
  env.requests[0].success(position({ accuracy: 74 }));
  assert.equal(env.gate.getState(), "unavailable");
  assert.deepEqual(env.readyResults, []);
  env.gate.retry();
  env.requests[1].success({ ...position(), timestamp: Date.now() - 31000 });
  assert.equal(env.gate.getState(), "unavailable");
  env.gate.retry();
  const freshFix = position({ latitude: 50.08, longitude: 14.43, accuracy: 16 });
  env.requests[2].success(freshFix);
  assert.equal(env.readyResults[0].state, "ready");
  assert.equal(env.readyResults[0].result.position.coords.latitude, 50.08);
});

test("the page gates Leaflet and app scripts until startup geolocation completes", () => {
  const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
  const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const css = fs.readFileSync(require.resolve("../styles.css"), "utf8");
  assert.match(html, /<body class="location-pending">/);
  assert.match(html, /Запуск The Walkers\. Проверяем геолокацию…/);
  assert.match(css, /body\.location-pending > :not\(#locationStartupScreen\)[\s\S]*?visibility: hidden/);
  assert.match(html, /location-diagnostics\.js[\s\S]*location-bootstrap\.js/);
  assert.doesNotMatch(html, /<script[^>]+(?:leaflet\.js|app\.js)/);
  assert.match(bootstrap, /onReady: startApp/);
  assert.match(bootstrap, /window\.WalkStartupResult = \{ state, \.\.\.result \}/);
  assert.match(bootstrap, /gate\.start\(\)/);
  assert.match(bootstrap, /if \(state === "denied"\)[\s\S]*location-access-denied/);
  assert.match(bootstrap, /\$\("locationAccessReload"\)\.addEventListener\("click", \(\) => window\.location\.reload\(\)\)/);
  assert.doesNotMatch(bootstrap, /trackingQueue|saveDraftSnapshot|finishWalk/);
  assert.match(app, /const startupResult = window\.WalkStartupResult;\s*delete window\.WalkStartupResult;\s*if \(startupResult\?\.state === "ready"\) handleCurrentLocationSuccess\(startupResult\.position\);\s*else if \(startupResult\) handleCurrentLocationError\(startupResult\.error, startupResult\.reason\);\s*else requestCurrentLocation\(\)/);
  assert.match(html, /id="locationStartupRetry"[^>]+hidden/);
  assert.match(bootstrap, /validateStartupPosition\(position, now\(\)\)/);
  assert.match(bootstrap, /retry\.addEventListener|locationStartupRetry"\)\.addEventListener\("click", \(\) => gate\.retry\(\)\)/);
  assert.match(app, /\.setView\(\[startupPosition\.coords\.latitude, startupPosition\.coords\.longitude\], 15\)/);
  assert.doesNotMatch(app, /setView\([^\n]*mapFollow/);
  assert.doesNotMatch(app, /48\.998|21\.239|redrawSaved\(\{ fitAll: true \}\)/);
  assert.match(app, /const redrawSaved = async \(\{ focusWalkId = null \} = \{\}\)/);
  assert.match(app, /layers\.forEach\(\(layer\) => \{ layer\.addTo\(map\); savedLayers\.push\(layer\); \}\)/);
});
