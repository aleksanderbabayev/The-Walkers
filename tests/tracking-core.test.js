const test = require("node:test");
const assert = require("node:assert/strict");
const Tracking = require("../tracking-core.js");

const now = 1_800_000_000_000;
const position = (lat, lng, timestamp = now, accuracy = 5) => ({ timestamp, coords: { latitude: lat, longitude: lng, accuracy } });
const point = (lat, lng, timestamp, segmentStart = false) => ({ lat, lng, accuracy: 5, timestamp, segmentStart });

test("accepts fresh accurate walking positions and measures their distance", () => {
  const previous = point(0, 0, now - 5000, true);
  const result = Tracking.evaluatePosition(position(0, 0.00009), previous, now);
  assert.equal(result.accepted, true);
  assert.equal(result.newSegment, false);
  assert.ok(result.distanceMeters > 9 && result.distanceMeters < 11);
});

test("rejects poor accuracy, stale timestamps, and future timestamps", () => {
  const previous = point(0, 0, now - 5000, true);
  assert.equal(Tracking.evaluatePosition(position(0, 0, now, 36), previous, now).reason, "accuracy");
  assert.equal(Tracking.evaluatePosition(position(0, 0, now - 15001), previous, now).reason, "stale");
  assert.equal(Tracking.evaluatePosition(position(0, 0, now + 5001), previous, now).reason, "stale");
});

test("rejects implausible walking speed and accuracy-sized stationary drift", () => {
  const previous = point(0, 0, now - 5000, true);
  assert.equal(Tracking.evaluatePosition(position(0.001, 0), previous, now).reason, "speed");
  assert.equal(Tracking.evaluatePosition(position(0, 0.000045, now, 10), previous, now).reason, "drift");
});

test("starts a new segment after a long tracking gap without adding connector distance", () => {
  const previous = point(0, 0, now - 60000, true);
  const result = Tracking.evaluatePosition(position(0, 0.001), previous, now);
  assert.equal(result.accepted, true);
  assert.equal(result.newSegment, true);
  assert.equal(result.point.segmentStart, true);
  assert.equal(result.distanceMeters, 0);
  const points = [previous, result.point];
  assert.equal(Tracking.distanceForPoints(points), 0);
  assert.equal(Tracking.splitSegments(points).length, 2);
  assert.equal(Tracking.canCloseTrack(points), false);
});

test("keeps a continuous route eligible for closure", () => {
  const points = [point(0, 0, now - 20000, true), point(0, 0.00002, now - 15000), point(0.00002, 0.00002, now - 10000), point(0.00002, 0, now - 5000)];
  assert.equal(Tracking.canCloseTrack(points), true);
});
