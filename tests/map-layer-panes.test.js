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

test("Leaflet pane order keeps the city boundary below game layers and UI", () => {
  const map = createMapHarness();
  const panes = MapLayerPanes.createMapPanes(map);
  const zIndex = (name) => Number(map.panes.get(name).style.zIndex);

  assert.deepEqual(panes, {
    cityBoundary: "cityBoundaryPane", territory: "territoryPane", route: "routePane", gameOverlay: "gameOverlayPane",
    gameMarker: "gameMarkerPane", accuracy: "accuracyPane", currentLocation: "currentLocationPane"
  });
  assert.equal(zIndex(panes.cityBoundary), 250);
  assert.equal(map.panes.get(panes.cityBoundary).style.pointerEvents, "none");
  assert.equal(zIndex(panes.territory), 300);
  assert.equal(zIndex(panes.route), 400);
  assert.equal(zIndex(panes.gameOverlay), 520);
  assert.equal(zIndex(panes.gameMarker), 600);
  assert.equal(zIndex(panes.accuracy), 660);
  assert.equal(zIndex(panes.currentLocation), 680);
  assert.ok(200 < zIndex(panes.cityBoundary), "city boundary is above Leaflet's tile pane");
  assert.ok(zIndex(panes.cityBoundary) < zIndex(panes.territory));
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
  assert.match(app, /CityCoverage\.loadBoundary\(\)\.then\(\(geometry\) => \{/);
  assert.match(app, /L\.geoJSON\(geometry, \{\s*pane: mapPanes\.cityBoundary,\s*interactive: false,/);
  assert.match(app, /style: \{ color: "#438253", weight: 2, opacity: 0\.88, fillColor: "#62a873", fillOpacity: 0\.055 \}/);
  assert.match(app, /L\.geoJSON\(geometry,[\s\S]*?\}\)\.addTo\(map\)/);
  assert.match(markers, /pane: "gameMarkerPane"/);
  assert.match(line, /pane: "routePane"/);
});

test("map boundary and city percentage share the same locally cached GeoJSON", () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const coverage = fs.readFileSync(require.resolve("../city-coverage.js"), "utf8");
  const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
  const boundary = JSON.parse(fs.readFileSync(require.resolve("../data/presov-boundary.geojson"), "utf8"));

  assert.equal(boundary.properties.osmId, 2320257);
  assert.match(coverage, /const boundaryUrl = "data\/presov-boundary\.geojson"/);
  assert.match(coverage, /const calculate = async \(walks,[\s\S]*?const boundaryGeometry = await loadBoundary\(\)/);
  assert.match(coverage, /const api = \{ loadBoundary, calculate, calculateCoverage/);
  assert.match(app, /const cityCoverage = await CityCoverage\.calculate\(walks\)/);
  assert.match(bootstrap, /"city-coverage\.js\?v=0\.2\.49"/);
  assert.match(bootstrap, /"map-layer-panes\.js\?v=0\.2\.49"/);
});
