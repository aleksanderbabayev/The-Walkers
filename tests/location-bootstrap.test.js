const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createLocationStartupGate } = require("../location-bootstrap.js");

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
  env.requests[0].success({ coords: { latitude: 48, longitude: 21, accuracy: 90 } });
  assert.equal(env.readyResults[0].state, "ready", "permission success is separate from GPS accuracy validation");
});

test("an already granted permission still requires a Geolocation API response before startup", async () => {
  const env = makeEnvironment({ permissionState: "granted" });
  env.gate.start();
  await Promise.resolve();
  assert.equal(env.requests.length, 1);
  assert.deepEqual(env.readyResults, []);
  env.requests[0].success({ coords: { latitude: 48, longitude: 21, accuracy: 6 } });
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
  env.requests[1].success({ coords: { latitude: 48, longitude: 21, accuracy: 12 } });
  assert.equal(env.readyResults[0].state, "ready");
});

for (const [name, error] of [["timeout", { code: 3 }], ["unavailable GPS", { code: 2 }]]) {
  test(`temporary ${name} does not become a permission denial or wait indefinitely`, () => {
    const env = makeEnvironment();
    env.gate.start();
    env.requests[0].error(error);
    assert.equal(env.gateStates.some(({ state }) => state === "denied"), false);
    assert.equal(env.readyResults[0].state, "unavailable");
  });
}

test("startup fallback is bounded and runs the app only after geolocation resolves", () => {
  const env = makeEnvironment();
  env.gate.start();
  const [timer] = env.timers.values();
  assert.equal(timer.delay, 21000);
  timer.callback();
  assert.equal(env.readyResults[0].state, "unavailable");
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
});
