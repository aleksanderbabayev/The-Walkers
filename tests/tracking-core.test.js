const test = require("node:test");
const assert = require("node:assert/strict");
const Tracking = require("../tracking-core.js");

const now = 1_800_000_000_000;
const position = (lat, lng, timestamp = now, accuracy = 5) => ({ timestamp, coords: { latitude: lat, longitude: lng, accuracy } });
const point = (lat, lng, timestamp, segmentStart = false, accuracy = 5) => ({ lat, lng, accuracy, timestamp, segmentStart });

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

test("current-location fixes allow up to 50 m accuracy and expire after 30 seconds", () => {
  assert.equal(Tracking.evaluateLocationPosition(position(48.9, 21.2, now, 50), now).accepted, true);
  assert.equal(Tracking.evaluateLocationPosition(position(48.9, 21.2, now, 50.1), now).reason, "accuracy");
  assert.equal(Tracking.evaluateLocationPosition(position(48.9, 21.2, now - 30001, 10), now).reason, "stale");
  assert.equal(Tracking.evaluateLocationPosition(position(48.9, 21.2, now - 30000, 10), now).accepted, true);
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

test("reset discards an unconfirmed post-gap GPS candidate", () => {
  const filter = Tracking.createPositionFilter();
  const previous = point(0, 0, now - 60000, true);
  const jump = filter.evaluate(position(0, 0.01, now - 5000), previous, now - 5000);
  assert.equal(jump.reason, "confirm");

  filter.reset();
  const next = filter.evaluate(position(0, 0.01, now), previous, now);
  assert.equal(next.accepted, false);
  assert.equal(next.reason, "confirm");
});

test("GPS warm-up accepts the latest of three fresh consistent positions", () => {
  const warmup = Tracking.createGpsWarmup();
  const first = warmup.add(position(48.9, 21.2, now - 2000, 6), now - 2000);
  const second = warmup.add(position(48.90001, 21.2, now - 1000, 5), now - 1000);
  const third = warmup.add(position(48.90002, 21.2, now, 5), now);

  assert.equal(first.stable, false);
  assert.equal(second.stable, false);
  assert.equal(third.stable, true);
  assert.equal(third.count, 3);
  assert.equal(third.point.lat, 48.90002);
  assert.equal(third.point.lng, 21.2);
});

test("GPS warm-up restarts its consecutive count for inaccurate and inconsistent fixes", () => {
  const metersInLongitude = (meters) => meters / 111320;
  const warmup = Tracking.createGpsWarmup();
  assert.equal(warmup.add(position(0, 0, now - 3000, 5), now - 3000).count, 1);
  assert.equal(warmup.add(position(0, 0.00001, now - 2000, 36), now - 2000).reason, "accuracy");
  assert.equal(warmup.add(position(0, metersInLongitude(40), now - 1000, 5), now - 1000).count, 1);
  const afterJump = warmup.add(position(0, metersInLongitude(42), now, 5), now);
  assert.equal(afterJump.stable, false);
  assert.equal(afterJump.count, 2);
  const stable = warmup.add(position(0, metersInLongitude(44), now + 1000, 5), now + 1000);
  assert.equal(stable.stable, true);
  assert.equal(stable.point.lng, metersInLongitude(44));
});

test("GPS warm-up restarts after an interrupted sequence", () => {
  const warmup = Tracking.createGpsWarmup();
  const start = now - 60000;
  assert.equal(warmup.add(position(0, 0, start, 5), start).count, 1);
  const resumed = warmup.add(position(0, 0.00001, start + 31000, 5), start + 31000);
  assert.equal(resumed.stable, false);
  assert.equal(resumed.count, 1);
  assert.equal(warmup.add(position(0, 0.00002, start + 32000, 5), start + 32000).count, 2);
  const stable = warmup.add(position(0, 0.00003, start + 33000, 5), start + 33000);
  assert.equal(stable.stable, true);
  assert.equal(stable.point.lng, 0.00003);
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

test("filters realistic short movement and stationary drift at 15 to 30 meter accuracy", () => {
  const metersInLongitude = (meters) => meters / 111320;
  for (const accuracy of [15, 30]) {
    let shortWalkPrevious = point(0, 0, now - 12000, true, accuracy);
    let shortWalkDistance = 0;
    for (const [step, meters] of [[1, 3], [2, 6], [3, 9], [4, 12]]) {
      const timestamp = now - 12000 + step * 2000;
      const result = Tracking.evaluatePosition(position(0, metersInLongitude(meters), timestamp, accuracy), shortWalkPrevious, timestamp);
      if (result.accepted) {
        shortWalkDistance += result.distanceMeters;
        shortWalkPrevious = result.point;
      } else assert.equal(result.reason, "drift");
    }
    assert.ok(shortWalkDistance > 8.5 && shortWalkDistance < 9.5, `short walk at ±${accuracy} m accuracy`);

    let previous = point(0, 0, now - 20000, true, accuracy);
    let totalDistance = 0;
    for (const [step, meters] of [[1, 3], [2, 6], [3, 9], [4, 12], [5, 15], [6, 18]]) {
      const timestamp = now - 20000 + step * 2000;
      const result = Tracking.evaluatePosition(position(0, metersInLongitude(meters), timestamp, accuracy), previous, timestamp);
      if (result.accepted) {
        totalDistance += result.distanceMeters;
        previous = result.point;
      } else assert.equal(result.reason, "drift");
    }
    assert.ok(totalDistance > 17.5 && totalDistance < 18.5, `walking distance at ±${accuracy} m accuracy`);

    previous = point(0, 0, now - 10000, true, accuracy);
    for (const [step, meters] of [[1, 3], [2, -4], [3, 6], [4, -7], [5, 2]]) {
      const timestamp = now - 10000 + step * 1000;
      const result = Tracking.evaluatePosition(position(0, metersInLongitude(meters), timestamp, accuracy), previous, timestamp);
      assert.equal(result.accepted, false, `stationary drift at ±${accuracy} m accuracy`);
      assert.equal(result.reason, "drift");
    }
  }
});

test("confirms recovery after a gap at 30 meter accuracy without counting the gap", () => {
  const metersInLongitude = (meters) => meters / 111320;
  const previous = point(0, 0, now - 60000, true, 30);
  const filter = Tracking.createPositionFilter();
  const candidate = filter.evaluate(position(0, metersInLongitude(100), now - 5000, 30), previous, now - 5000);
  assert.equal(candidate.reason, "confirm");

  const confirmed = filter.evaluate(position(0, metersInLongitude(109), now, 30), previous, now);
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.points[0].segmentStart, true);
  assert.equal(Tracking.splitSegments([previous, ...confirmed.points]).length, 2);
  assert.ok(Tracking.distanceForPoints([previous, ...confirmed.points]) > 8);
  assert.ok(Tracking.distanceForPoints([previous, ...confirmed.points]) < 10);
});

test("initial route buffering filters an early drift outlier without straightening the walk", () => {
  const meters = (value) => value / 111320;
  const buffer = Tracking.createInitialRouteBuffer(18000);
  buffer.begin(point(0, 0, now - 18000, true, 5));
  buffer.add(position(0, meters(40), now - 16000, 5), now - 16000);
  buffer.add(position(0, meters(2), now - 15000, 5), now - 15000);
  buffer.add(position(0, meters(6), now - 12000, 5), now - 12000);
  buffer.add(position(0, meters(12), now - 9000, 5), now - 9000);
  buffer.add(position(0, meters(18), now - 6000, 5), now - 6000);
  buffer.add(position(0, meters(24), now - 3000, 5), now - 3000);
  const result = buffer.add(position(0, meters(30), now, 5), now);

  assert.equal(result.ready, true);
  assert.ok(result.validatedPoints.every((point) => Math.abs(point.lng - meters(40)) > meters(1)));
  assert.ok(result.distanceMeters > 28 && result.distanceMeters < 31);
  assert.deepEqual(result.validatedPoints.map((point) => point.timestamp), [now - 18000, now - 12000, now - 9000, now - 6000, now - 3000, now]);
  assert.equal(result.validatedPoints.some((point) => point.timestamp === now - 16000 || point.timestamp === now - 15000), false);
});

test("initial validation cannot distinguish gradual GPS correction from plausible walking", () => {
  const meters = (value) => value / 111320;
  const buffer = Tracking.createInitialRouteBuffer(18000);
  // The same 1.43 m/s coordinates can describe either drift correction or a real walk.
  const route = [point(0, meters(25.8), now - 18000, true, 2)];
  for (let index = 1; index <= 6; index += 1) {
    route.push(point(0, meters(25.8 - index * 4.3), now - 18000 + index * 3000, false, 2));
  }

  buffer.begin(route[0]);
  let result;
  for (const candidate of route.slice(1)) {
    result = buffer.add(position(candidate.lat, candidate.lng, candidate.timestamp, candidate.accuracy), candidate.timestamp);
  }

  assert.equal(result.ready, true);
  assert.equal(result.validatedPoints.length, route.length);
  assert.ok(result.distanceMeters > 25 && result.distanceMeters < 27);
  assert.deepEqual(result.validatedPoints.map((point) => point.timestamp), route.map((point) => point.timestamp));
});

test("initial route validation preserves a genuine early turn", () => {
  const meters = (value) => value / 111320;
  const route = [
    point(0, 0, now - 12000, true, 2),
    point(0, meters(5), now - 8000, false, 2),
    point(meters(5), meters(5), now - 4000, false, 2),
    point(meters(5), meters(10), now, false, 2)
  ];
  const result = Tracking.validateInitialRoute(route);

  assert.equal(result.points.length, route.length);
  assert.ok(result.distanceMeters > 14 && result.distanceMeters < 16);
  assert.equal(result.points[2].lat, route[2].lat);
  assert.equal(result.points[2].lng, route[2].lng);
});

test("short walks can flush the initial buffer before its validation window ends", () => {
  const meters = (value) => value / 111320;
  const buffer = Tracking.createInitialRouteBuffer(18000);
  buffer.begin(point(0, 0, now - 10000, true, 2));
  buffer.add(position(0, meters(5), now - 5000, 2), now - 5000);
  buffer.add(position(0, meters(10), now, 2), now);
  const result = buffer.flush();

  assert.equal(result.points.length, 3);
  assert.ok(result.distanceMeters > 9 && result.distanceMeters < 11);
});

test("initial stationary GPS noise does not add route distance", () => {
  const meters = (value) => value / 111320;
  const buffer = Tracking.createInitialRouteBuffer(18000);
  buffer.begin(point(0, 0, now - 10000, true, 5));
  buffer.add(position(0, meters(2), now - 9000, 5), now - 9000);
  buffer.add(position(0, meters(-2), now - 8000, 5), now - 8000);
  buffer.add(position(0, meters(1), now - 7000, 5), now - 7000);
  const result = buffer.flush();

  assert.equal(result.points.length, 1);
  assert.equal(result.distanceMeters, 0);
});

test("initial buffer preserves route segments across tracking interruptions", () => {
  const meters = (value) => value / 111320;
  const buffer = Tracking.createInitialRouteBuffer(18000);
  const start = now - 60000;
  buffer.begin(point(0, 0, start, true, 5));
  assert.equal(buffer.add(position(0, meters(100), start + 40000, 5), start + 40000).reason, "confirm");
  assert.equal(buffer.add(position(0, meters(109), start + 41000, 5), start + 41000).reason, "speed");
  const resumed = buffer.add(position(0, meters(118), start + 44000, 5), start + 44000);
  const result = buffer.flush();

  assert.equal(resumed.ready, true);
  assert.equal(Tracking.splitSegments(result.points).length, 2);
  assert.ok(result.distanceMeters > 8 && result.distanceMeters < 10);
  assert.equal(result.points[1].segmentStart, true);
});

test("initial validation resumes from a persisted buffer with original timestamps", () => {
  const meters = (value) => value / 111320;
  const original = Tracking.createInitialRouteBuffer(10000);
  original.begin(point(0, 0, now - 10000, true, 2));
  original.add(position(0, meters(5), now - 5000, 2), now - 5000);
  const restored = Tracking.createInitialRouteBuffer(10000);
  restored.restore(original.snapshot());
  const completed = restored.add(position(0, meters(10), now, 2), now);

  assert.equal(completed.ready, true);
  assert.deepEqual(completed.validatedPoints.map((point) => point.timestamp), [now - 10000, now - 5000, now]);
});

test("initial buffer flush and reset support finish and retreat before validation ends", () => {
  const buffer = Tracking.createInitialRouteBuffer(18000);
  buffer.begin(point(0, 0, now - 5000, true));
  buffer.add(position(0, 0.00005, now), now);
  assert.equal(buffer.flush().points.length, 2);
  buffer.reset();
  assert.equal(buffer.pending, false);
  assert.deepEqual(buffer.flush(), { points: [], distanceMeters: 0, discardedCount: 0 });
});

test("validated initial route keeps distance and territory geometry consistent", () => {
  const meters = (value) => value / 111320;
  const buffer = Tracking.createInitialRouteBuffer(18000);
  const route = [
    point(0, 0, now - 20000, true, 2),
    point(0, meters(10), now - 15000, false, 2),
    point(meters(10), meters(10), now - 10000, false, 2),
    point(meters(10), 0, now - 5000, false, 2),
    point(0, 0, now, false, 2)
  ];
  buffer.begin(route[0]);
  let result;
  for (const candidate of route.slice(1)) {
    result = buffer.add(position(candidate.lat, candidate.lng, candidate.timestamp, candidate.accuracy), candidate.timestamp);
  }

  assert.equal(result.ready, true);
  assert.equal(Tracking.canCloseTrack(result.validatedPoints), true);
  assert.equal(result.distanceMeters, Tracking.distanceForPoints(result.validatedPoints));
  assert.ok(result.distanceMeters > 39 && result.distanceMeters < 41);
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

test("hides unclosed finished walks without changing legacy or captured walk visibility", () => {
  assert.equal(Tracking.shouldDisplayWalkOnMap({ closed: false, showOnMap: false }), false);
  assert.equal(Tracking.shouldDisplayWalkOnMap({ closed: false }), true);
  assert.equal(Tracking.shouldDisplayWalkOnMap({ closed: true, showOnMap: false }), true);
});
