const test = require("node:test");
const assert = require("node:assert/strict");
const MapLayerPanes = require("../map-layer-panes.js");

const createMapHarness = () => {
  const panes = new Map();
  return {
    panes,
    createPane(name) {
      const pane = { style: {} };
      panes.set(name, pane);
      return pane;
    }
  };
};

test("Leaflet pane order layers territories, routes, game markers, accuracy, and GPS position", () => {
  const map = createMapHarness();
  const panes = MapLayerPanes.createMapPanes(map);
  const zIndex = (name) => Number(map.panes.get(name).style.zIndex);

  assert.deepEqual(panes, {
    territory: "territoryPane", route: "routePane", gameOverlay: "gameOverlayPane",
    gameMarker: "gameMarkerPane", accuracy: "accuracyPane", currentLocation: "currentLocationPane"
  });
  assert.equal(zIndex(panes.territory), 300);
  assert.equal(zIndex(panes.route), 400);
  assert.equal(zIndex(panes.gameOverlay), 520);
  assert.equal(zIndex(panes.gameMarker), 600);
  assert.equal(zIndex(panes.accuracy), 660);
  assert.equal(zIndex(panes.currentLocation), 680);
  assert.ok(zIndex(panes.territory) < zIndex(panes.route));
  assert.ok(zIndex(panes.route) < zIndex(panes.gameOverlay));
  assert.ok(zIndex(panes.gameOverlay) < zIndex(panes.gameMarker));
  assert.ok(zIndex(panes.gameMarker) < zIndex(panes.accuracy));
  assert.ok(zIndex(panes.accuracy) < zIndex(panes.currentLocation));
  assert.ok(zIndex(panes.currentLocation) < 1000, "Leaflet and application controls remain above map data panes");
});

test("map layers use their assigned panes and GPS marker updates reuse the same layer", () => {
  const app = require("node:fs").readFileSync(require.resolve("../app.js"), "utf8");
  const markers = require("node:fs").readFileSync(require.resolve("../expedition-markers.js"), "utf8");
  const line = require("node:fs").readFileSync(require.resolve("../expedition-line.js"), "utf8");

  assert.match(app, /currentLocationMarker\.setLatLng\(latlng\)[\s\S]*?pane: mapPanes\.currentLocation/);
  assert.match(app, /pane: mapPanes\.accuracy/);
  assert.doesNotMatch(app, /currentLocationMarker\.bringToFront\(\)/);
  assert.match(app, /pane: mapPanes\.territory/);
  assert.match(app, /pane: mapPanes\.route/);
  assert.match(app, /pane: mapPanes\.gameOverlay/);
  assert.match(app, /pane: mapPanes\.gameMarker/);
  assert.match(markers, /pane: "gameMarkerPane"/);
  assert.match(line, /pane: "routePane"/);
});
