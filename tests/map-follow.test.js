const test = require("node:test");
const assert = require("node:assert/strict");
const MapFollow = require("../map-follow.js");

class FakeMap {
  constructor() { this.handlers = new Map(); this.center = [0, 0]; this.zoom = 14; this.bearing = 32; this.markerPoint = new FakePoint(200, 300); }
  on(name, handler) { this.handlers.set(name, handler); }
  off(name) { this.handlers.delete(name); }
  fire(name) { this.handlers.get(name)?.(); }
  getSize() { return new FakePoint(400, 600); }
  getZoom() { return this.zoom; }
  getMinZoom() { return 2; }
  getMaxZoom() { return 19; }
  latLngToContainerPoint(center) { this.center = center; return this.markerPoint; }
  containerPointToLayerPoint(point) { return point; }
  setZoomAround(center, zoom) {
    this.fire("zoomstart");
    this.center = center;
    this.zoom = zoom;
    this.fire("zoomend");
  }
  panBy(offset, options) {
    this.markerPoint = this.markerPoint.subtract(offset);
    this.panOptions = options;
    this.fire("dragstart");
  }
}

class FakeZoomControl {
  constructor() { this.listeners = new Set(); }
  addEventListener(type, listener, capture) { if (type === "click" && capture) this.listeners.add(listener); }
  removeEventListener(type, listener, capture) { if (type === "click" && capture) this.listeners.delete(listener); }
  click(direction) {
    const button = { classList: { contains: (name) => name === `leaflet-control-zoom-${direction}` } };
    const event = { target: { closest: () => button }, defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
    for (const listener of this.listeners) listener(event);
    return event;
  }
}

class FakePoint {
  constructor(x, y) { this.x = x; this.y = y; }
  subtract(other) { return new FakePoint(this.x - other.x, this.y - other.y); }
  divideBy(value) { return new FakePoint(this.x / value, this.y / value); }
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

test("GPS marker is panned into its target point while preserving zoom and bearing", () => {
  const map = new FakeMap();
  const follow = MapFollow.createMapFollow({ map, storage: makeStorage() });
  follow.setEnabled(true);
  assert.equal(follow.centerOn({ lat: 48.9, lng: 21.2 }), true);
  assert.deepEqual(map.center, [48.9, 21.2]);
  assert.deepEqual(map.panOptions, { animate: false });
  assert.deepEqual(map.markerPoint, new FakePoint(200, 300));
  assert.equal(map.zoom, 14);
  assert.equal(map.bearing, 32);
});

test("GPS movement cannot recenter the map when follow mode is off", () => {
  const map = new FakeMap(), follow = MapFollow.createMapFollow({ map, storage: makeStorage() });
  assert.equal(follow.centerOn({ lat: 48.9, lng: 21.2 }), false);
  assert.deepEqual(map.center, [0, 0]);
});

test("follow zoom controls anchor the current GPS point and pinch restores its screen position", () => {
  const map = new FakeMap(), control = new FakeZoomControl();
  const follow = MapFollow.createMapFollow({ map, storage: makeStorage() });
  const unbind = follow.bindZoomControl(control);
  const location = { lat: 48.9, lng: 21.2, timestamp: Date.now() };
  follow.setEnabled(true);
  follow.centerOn(location);
  const originalPoint = map.markerPoint;

  assert.equal(control.click("in").defaultPrevented, true);
  assert.equal(map.zoom, 15);
  assert.deepEqual(map.markerPoint, originalPoint);
  assert.equal(control.click("in").defaultPrevented, true);
  assert.equal(map.zoom, 16);
  assert.deepEqual(map.markerPoint, originalPoint);
  assert.equal(control.click("out").defaultPrevented, true);
  assert.equal(map.zoom, 15);
  assert.deepEqual(map.markerPoint, originalPoint);

  map.fire("zoomstart");
  map.markerPoint = new FakePoint(originalPoint.x + 31, originalPoint.y - 22);
  map.fire("zoomend");
  assert.deepEqual(map.markerPoint, originalPoint, "pinch zoom returns GPS to the same screen point after zooming");
  assert.equal(follow.enabled, true, "zoom corrections do not count as a manual drag");
  unbind();
  follow.dispose();
  assert.equal(control.listeners.size, 0);
});

test("zoom remains native when follow is disabled and following resumes at the visible-area center", () => {
  const map = new FakeMap(), control = new FakeZoomControl();
  let target = new FakePoint(200, 220);
  const follow = MapFollow.createMapFollow({ map, storage: makeStorage(), getTargetPoint: () => target });
  follow.bindZoomControl(control);
  follow.setEnabled(true);
  follow.centerOn({ lat: 48.9, lng: 21.2 });
  follow.setEnabled(false);

  const ordinaryZoom = control.click("in");
  assert.equal(ordinaryZoom.defaultPrevented, false);
  assert.equal(map.zoom, 14, "the module leaves disabled-follow zoom to Leaflet");

  target = new FakePoint(200, 180);
  follow.setEnabled(true);
  assert.equal(follow.centerOn({ lat: 48.9, lng: 21.2 }), true);
  assert.deepEqual(map.markerPoint, target, "follow can resume using the current visible-area center");
  follow.dispose();
});

test("visual center uses the free map area above the panel and falls back on desktop", () => {
  const mapElement = { clientWidth: 375, clientHeight: 800, getBoundingClientRect: () => ({ top: 50, bottom: 850 }) };
  const panelElement = { getBoundingClientRect: () => ({ top: 550, bottom: 850 }) };
  const createPoint = (x, y) => new FakePoint(x, y);
  assert.deepEqual(MapFollow.getVisibleMapCenter({ mapElement, panelElement, mobile: true, createPoint }), new FakePoint(187.5, 250));
  assert.deepEqual(MapFollow.getVisibleMapCenter({ mapElement, panelElement, mobile: false, createPoint }), new FakePoint(187.5, 400));
  panelElement.getBoundingClientRect = () => ({ top: 400, bottom: 850 });
  assert.deepEqual(MapFollow.getVisibleMapCenter({ mapElement, panelElement, mobile: true, createPoint }), new FakePoint(187.5, 175));
});

test("territory fit padding centers bounds above the mobile panel and stays symmetric on desktop", () => {
  const mapElement = { getBoundingClientRect: () => ({ top: 50, bottom: 850 }) };
  const panelElement = { getBoundingClientRect: () => ({ top: 550 }) };
  assert.deepEqual(MapFollow.getVisibleMapFitPadding({ mapElement, panelElement, mobile: true }), {
    paddingTopLeft: [16, 16], paddingBottomRight: [16, 316]
  });
  panelElement.getBoundingClientRect = () => ({ top: 400 });
  assert.deepEqual(MapFollow.getVisibleMapFitPadding({ mapElement, panelElement, mobile: true }), {
    paddingTopLeft: [16, 16], paddingBottomRight: [16, 466]
  });
  assert.deepEqual(MapFollow.getVisibleMapFitPadding({ mapElement, panelElement, mobile: false }), {
    paddingTopLeft: [16, 16], paddingBottomRight: [16, 16]
  });
});

test("the initial GPS view can center visually even before the follow preference is enabled", () => {
  const map = new FakeMap(), follow = MapFollow.createMapFollow({ map, storage: makeStorage(), getTargetPoint: () => new FakePoint(200, 180) });
  assert.equal(follow.centerOn({ lat: 48.9, lng: 21.2 }, { force: true }), true);
  assert.deepEqual(map.markerPoint, new FakePoint(200, 180));
  assert.equal(follow.enabled, false);
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
  assert.ok(app.includes("mapFollow.bindZoomControl(zoomControl)"));
  assert.ok(app.includes("isPositionFresh: locationIsFresh"));
  assert.match(app, /button\.classList\.toggle\("is-following", mapFollow\?\.enabled === true\)/);
  assert.match(app, /button\.setAttribute\("aria-pressed", String\(mapFollow\?\.enabled === true\)\)/);
  assert.match(app, /Отключить следование за вашим местоположением/);
  assert.ok(bootstrap.includes('"map-follow.js?v=0.1.75"'));
  assert.ok(bootstrap.includes('"app.js?v=0.2.50"'));
  assert.doesNotMatch(fs.readFileSync(require.resolve("../map-follow.js"), "utf8"), /watchPosition/);
});

test("startup, locate, follow and layout changes share the measured visual center", () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.ok(app.includes("const getMapVisualCenter = () => MapFollow.getVisibleMapCenter({"));
  assert.ok(app.includes("mapElement: map.getContainer()"));
  assert.ok(app.includes("panelElement: walkPanel"));
  assert.ok(app.includes("getTargetPoint: getMapVisualCenter"));
  assert.ok(app.includes("mapFollow.centerOn(point, { force: true })"));
  assert.ok(app.includes("mapFollow.centerOn(point);"));
  assert.match(app, /MapFollow\.getVisibleMapFitPadding\(\{[\s\S]*?mapElement: map\.getContainer\(\),[\s\S]*?panelElement: walkPanel,[\s\S]*?mobile: isMobileViewport\(\)/);
  assert.match(app, /map\.fitBounds\(focusedTerritory\.getBounds\(\), \{[\s\S]*?maxZoom: 16/);
  assert.ok(app.includes("if (!mapFollow.enabled || !locationIsFresh(latestLocation) || followLayoutFrame) return"));
  assert.ok(app.includes("new ResizeObserver(recenterFollowingLocation).observe(walkPanel)"));
});
