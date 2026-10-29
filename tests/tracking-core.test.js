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

test("confirms a post-gap position before accepting it as a new segment", () => {
  const previous = point(0, 0, now - 60000, true);
  const candidate = Tracking.evaluatePosition(position(0, 0.001, now - 5000), previous, now - 5000);
  assert.equal(candidate.accepted, false);
  assert.equal(candidate.reason, "confirm");

  const result = Tracking.evaluatePosition(position(0, 0.0011), previous, now, undefined, candidate.candidate);
  assert.equal(result.accepted, true);
  assert.equal(result.newSegment, true);
  assert.equal(result.reason, "confirmed-gap");
  assert.equal(result.points[0].segmentStart, true);
  assert.equal(result.points[1].segmentStart, false);
  assert.ok(result.distanceMeters > 0);
  const points = [previous, ...result.points];
  assert.ok(Tracking.distanceForPoints(points) > 0);
  assert.equal(Tracking.distanceForPoints(points), result.distanceMeters);
  assert.ok(Tracking.distanceForPoints(points) < Tracking.distanceMeters(previous, result.points[0]));
  assert.equal(Tracking.splitSegments(points).length, 2);
  assert.equal(Tracking.canCloseTrack(points), false);
});

test("does not accept an isolated jump after an interruption", () => {
  const previous = point(0, 0, now - 60000, true);
  const isolatedJump = Tracking.evaluatePosition(position(0, 0.01, now - 3000), previous, now - 3000);
  assert.equal(isolatedJump.accepted, false);
  assert.equal(isolatedJump.reason, "confirm");

  const returnToRoute = Tracking.evaluatePosition(position(0, 0.00001, now - 2000), previous, now - 2000, undefined, isolatedJump.candidate);
  assert.equal(returnToRoute.accepted, false);
  assert.equal(returnToRoute.reason, "speed");

  const stableRoutePosition = Tracking.evaluatePosition(position(0, 0.00002, now - 1000), previous, now - 1000, undefined, returnToRoute.candidate);
  assert.equal(stableRoutePosition.accepted, true);
  assert.equal(stableRoutePosition.distanceMeters, 0);
  assert.equal(stableRoutePosition.points.length, 1);
  assert.equal(stableRoutePosition.point.segmentStart, true);
});

test("accumulates realistic short walking movements without stationary GPS drift", () => {
  const metersInLongitude = (meters) => meters / 111320;
  let previous = point(0, 0, now - 8000, true);
  let totalDistance = 0;
  const accepted = [];

  for (const [step, meters] of [[1, 2.5], [2, 5], [3, 7.5], [4, 10]]) {
    const result = Tracking.evaluatePosition(position(0, metersInLongitude(meters), now - 8000 + step * 2000, 2), previous, now - 8000 + step * 2000);
    if (result.accepted) {
      accepted.push(result.point);
      totalDistance += result.distanceMeters;
      previous = result.point;
    } else assert.equal(result.reason, "drift");
  }
  assert.equal(accepted.length, 2);
  assert.ok(totalDistance > 9.5 && totalDistance < 10.5);

  previous = point(0, 0, now - 10000, 5);
  for (const [step, meters] of [[1, 1], [2, -1], [3, 2], [4, -2], [5, 1]]) {
    const result = Tracking.evaluatePosition(position(0, metersInLongitude(meters), now - 10000 + step * 1000, 5), previous, now - 10000 + step * 1000);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "drift");
  }
});

test("rejected positions do not replace the last accepted point", () => {
  const previous = point(0, 0, now - 5000, true);
  assert.equal(Tracking.evaluatePosition(position(0, 0.001, now, 60), previous, now).reason, "accuracy");
  assert.equal(Tracking.evaluatePosition(position(0, 0.001, now - 20000), previous, now).reason, "stale");
  assert.equal(Tracking.evaluatePosition(position(0.001, 0, now), previous, now).reason, "speed");
  const next = Tracking.evaluatePosition(position(0, 0.00009, now), previous, now);
  assert.equal(next.accepted, true);
  assert.ok(next.distanceMeters > 9 && next.distanceMeters < 11);
});

test("cleans up a watch when GPS service setup fails after creating it", () => {
  const clearedWatches = [], cancelledTimers = [];
  const error = new Error("timer setup failed");
  const services = Tracking.createGpsServices({
    geolocation: { watchPosition: () => 42, clearWatch: (id) => clearedWatches.push(id) },
    onPosition() {}, onError() {}, onAutosave() {},
    schedule: () => { throw error; },
    cancel: (id) => cancelledTimers.push(id)
  });
  assert.throws(() => services.start(), error);
  services.stop();
  assert.deepEqual(clearedWatches, [42]);
  assert.deepEqual(cancelledTimers, []);
});

test("stops both GPS watch and autosave timer for new walks and restored drafts", () => {
  const clearedWatches = [], cancelledTimers = [];
  let watchId = 0, timerId = 100;
  const services = Tracking.createGpsServices({
    geolocation: { watchPosition: () => ++watchId, clearWatch: (id) => clearedWatches.push(id) },
    onPosition() {}, onError() {}, onAutosave() {},
    schedule: () => ++timerId,
    cancel: (id) => cancelledTimers.push(id)
  });
  services.start(); services.stop();
  services.start(); services.stop();
  assert.deepEqual(clearedWatches, [1, 2]);
  assert.deepEqual(cancelledTimers, [101, 102]);
});

test("keeps a continuous route eligible for closure", () => {
  const points = [point(0, 0, now - 20000, true), point(0, 0.00002, now - 15000), point(0.00002, 0.00002, now - 10000), point(0.00002, 0, now - 5000)];
  assert.equal(Tracking.canCloseTrack(points), true);
});
