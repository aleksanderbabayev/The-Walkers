const test = require("node:test");
const assert = require("node:assert/strict");
const MapFollow = require("../map-follow.js");

class FakeMap {
  constructor() { this.handlers = new Map(); this.center = [0, 0]; this.zoom = 14; this.bearing = 32; }
  on(name, handler) { this.handlers.set(name, handler); }
  off(name) { this.handlers.delete(name); }
  fire(name) { this.handlers.get(name)?.(); }
  panTo(center, options) {
    this.center = center;
    this.panOptions = options;
    this.fire("dragstart");
  }
}

const makeStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
};

test("follow mode toggles and persists the user's preference", () => {
  const map = new FakeMap(), storage = makeStorage(), changes = [];
  const follow = MapFollow.createMapFollow({ map, storage, onChange: (enabled) => changes.push(enabled) });
  assert.equal(follow.enabled, false);
  assert.equal(follow.toggle(), true);
  assert.equal(storage.getItem("the-walkers-follow-location"), "true");
  assert.equal(follow.toggle(), false);
  assert.equal(storage.getItem("the-walkers-follow-location"), "false");
  assert.deepEqual(changes, [true, false]);
});

test("GPS updates pan the map center while preserving zoom and bearing", () => {
  const map = new FakeMap();
  const follow = MapFollow.createMapFollow({ map, storage: makeStorage() });
  follow.setEnabled(true);
  assert.equal(follow.centerOn({ lat: 48.9, lng: 21.2 }), true);
  assert.deepEqual(map.center, [48.9, 21.2]);
  assert.deepEqual(map.panOptions, { animate: false });
  assert.equal(map.zoom, 14);
  assert.equal(map.bearing, 32);
});

test("GPS movement cannot recenter the map when follow mode is off", () => {
  const map = new FakeMap(), follow = MapFollow.createMapFollow({ map, storage: makeStorage() });
  assert.equal(follow.centerOn({ lat: 48.9, lng: 21.2 }), false);
  assert.deepEqual(map.center, [0, 0]);
});

test("manual drag disables following, while a programmatic pan does not", () => {
  const map = new FakeMap(), follow = MapFollow.createMapFollow({ map, storage: makeStorage() });
  follow.setEnabled(true);
  follow.centerOn({ lat: 48.9, lng: 21.2 });
  assert.equal(follow.enabled, true);
  map.fire("dragstart");
  assert.equal(follow.enabled, false);
});

test("restored follow preference waits for a position before centering", () => {
  const map = new FakeMap(), storage = makeStorage();
  storage.setItem("the-walkers-follow-location", "true");
  const follow = MapFollow.createMapFollow({ map, storage });
  assert.equal(follow.enabled, true);
  assert.equal(follow.centerOn(null), false);
  assert.deepEqual(map.center, [0, 0]);
  follow.centerOn({ lat: 48.9, lng: 21.2 });
  assert.deepEqual(map.center, [48.9, 21.2]);
});

test("capture completion disables follow and GPS following reuses the shared watcher", () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
  assert.match(app, /if \(closed\) mapFollow\.setEnabled\(false\);/);
  assert.match(app, /mapFollow\.centerOn\(result\.point\)/);
  assert.match(app, /button\.classList\.toggle\("is-following", mapFollow\?\.enabled === true\)/);
  assert.match(app, /button\.setAttribute\("aria-pressed", String\(mapFollow\?\.enabled === true\)\)/);
  assert.match(app, /Отключить следование за вашим местоположением/);
  assert.ok(bootstrap.includes('"map-follow.js?v=0.1.72"'));
  assert.ok(bootstrap.includes('"app.js?v=0.2.3"'));
  assert.doesNotMatch(fs.readFileSync(require.resolve("../map-follow.js"), "utf8"), /watchPosition/);
});
