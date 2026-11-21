const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const CityCoverage = require("../city-coverage.js");
const polygonClipping = require("../assets/vendor/polygon-clipping.umd.min.js");

const pointRing = (coordinates) => coordinates.map(([lng, lat]) => ({ lat, lng }));
const walk = (coordinates, overrides = {}) => ({
  closed: true,
  mode: "territory",
  status: "completed",
  points: pointRing(coordinates),
  ...overrides
});
const square = (left, bottom, right, top) => [[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]];
const polygon = (coordinates, holes = []) => ({ type: "Polygon", coordinates: [coordinates, ...holes] });
const calculate = (boundaryGeometry, walks) => CityCoverage.calculateCoverage({ boundaryGeometry, walks, polygonClipping });

test("uses the locally stored OSM admin boundary and computes its geodesic area", () => {
  const feature = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "presov-boundary.geojson"), "utf8"));
  assert.equal(feature.properties.osmId, 2320257);
  assert.equal(feature.properties.adminLevel, 8);
  assert.equal(feature.geometry.type, "Polygon");
  assert.ok(feature.geometry.coordinates[0].length > 1000);
  const coverage = calculate(feature.geometry, []);
  assert.equal(coverage.capturedArea, 0);
  assert.equal(coverage.percentage, 0);
  assert.ok(coverage.cityArea > 70_400_000 && coverage.cityArea < 70_600_000, `unexpected city area: ${coverage.cityArea}`);
  assert.equal(CityCoverage.formatPercentage(coverage), "0,00%");
});

test("clips captures at the city boundary and ignores territories outside it", () => {
  const city = polygon(square(0, 0, 10, 10));
  const inside = calculate(city, [walk(square(2, 2, 4, 4))]);
  const partial = calculate(city, [walk(square(8, 2, 12, 4))]);
  const expectedPartial = calculate(city, [walk(square(8, 2, 10, 4))]);
  const outside = calculate(city, [walk(square(11, 2, 12, 4))]);

  assert.ok(inside.capturedArea > 0);
  assert.ok(inside.capturedArea < inside.cityArea);
  assert.ok(Math.abs(partial.capturedArea - expectedPartial.capturedArea) < 0.01);
  assert.equal(outside.capturedArea, 0);
});

test("unions overlapping and duplicate territories before measuring coverage", () => {
  const city = polygon(square(0, 0, 10, 10));
  const left = walk(square(1, 1, 5, 5));
  const right = walk(square(3, 1, 7, 5));
  const overlapping = calculate(city, [left, right]);
  const joined = calculate(city, [walk(square(1, 1, 7, 5))]);
  const duplicate = calculate(city, [left, left]);
  const single = calculate(city, [left]);

  assert.ok(Math.abs(overlapping.capturedArea - joined.capturedArea) < 0.01);
  assert.ok(Math.abs(duplicate.capturedArea - single.capturedArea) < 0.01);
});

test("respects concave boundaries and holes in administrative geometry", () => {
  const concaveCity = polygon([[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10], [0, 0]]);
  const concaveCapture = calculate(concaveCity, [walk(square(2, 2, 5, 5))]);
  const expectedConcave = calculate(concaveCity, [walk(square(2, 2, 3, 5)), walk(square(3, 2, 5, 3))]);
  const cityWithHole = polygon(square(0, 0, 10, 10), [square(4, 4, 6, 6)]);
  const completeCapture = calculate(cityWithHole, [walk(square(0, 0, 10, 10))]);
  const holeOnly = calculate(cityWithHole, [walk(square(4, 4, 6, 6))]);

  assert.ok(Math.abs(concaveCapture.capturedArea - expectedConcave.capturedArea) < 0.01);
  assert.ok(Math.abs(completeCapture.capturedArea - completeCapture.cityArea) < 0.01);
  assert.equal(holeOnly.capturedArea, 0);
  assert.equal(CityCoverage.formatPercentage(completeCapture), "100,00%");
});

test("counts only previously captured territory records", () => {
  const city = polygon(square(0, 0, 10, 10));
  const captured = walk(square(1, 1, 3, 3));
  const originalRecord = JSON.stringify(captured);
  const ignored = [
    walk(square(4, 4, 8, 8), { mode: "expedition" }),
    walk(square(4, 4, 8, 8), { closed: false }),
    walk(square(4, 4, 8, 8), { status: "retreated" })
  ];
  const onlyCapture = calculate(city, [captured]);
  const result = calculate(city, [captured, ...ignored]);
  assert.equal(result.capturedArea, onlyCapture.capturedArea);
  assert.equal(JSON.stringify(captured), originalRecord, "area calculation does not mutate a saved walk");
});

test("a newly saved capture changes coverage and the same result is reconstructed from saved records", () => {
  const city = polygon(square(0, 0, 10, 10));
  const savedCapture = walk(square(1, 1, 3, 3));
  const beforeCapture = calculate(city, []);
  const afterCapture = calculate(city, [savedCapture]);
  const afterReload = calculate(city, JSON.parse(JSON.stringify([savedCapture])));

  assert.equal(beforeCapture.capturedArea, 0);
  assert.ok(afterCapture.capturedArea > 0);
  assert.equal(afterReload.capturedArea, afterCapture.capturedArea);
});

test("shows an unavailable value instead of fabricating coverage and never rounds partial coverage to 100 percent", () => {
  assert.equal(CityCoverage.calculateCoverage({ boundaryGeometry: null, walks: [], polygonClipping }), null);
  assert.equal(CityCoverage.formatPercentage(null), "—");
  assert.equal(CityCoverage.formatPercentage({ capturedArea: 999999.9, cityArea: 1000000, percentage: 99.99999 }), "99,99%");
});
