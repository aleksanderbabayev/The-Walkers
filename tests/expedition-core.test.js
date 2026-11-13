const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Expedition = require("../expedition-core.js");
const Tracking = require("../tracking-core.js");

test("random expedition targets use the selected straight-line radius", () => {
  const origin = { lat: 48.15, lng: 17.11 };
  for (const radius of [500, 1000, 2000, 3000]) {
    const target = Expedition.createRandomTarget(origin, radius, () => 0.23);
    const distance = Tracking.distanceMeters(origin, target);
    assert.ok(Math.abs(distance - radius) < 0.01, `expected ${radius} m, got ${distance}`);
  }
});

test("random target generation varies direction and stays within valid coordinates", () => {
  const origin = { lat: 48.15, lng: 17.11 };
  const north = Expedition.createRandomTarget(origin, 1000, () => 0);
  const east = Expedition.createRandomTarget(origin, 1000, () => 0.25);
  assert.notDeepEqual(north, east);
  assert.ok(north.lat > origin.lat);
  assert.ok(east.lng > origin.lng);
  assert.equal(Expedition.createRandomTarget({ lat: 95, lng: 0 }, 500), null);
});

test("an expedition is reached only inside the 30 meter radius", () => {
  const target = { lat: 48.15, lng: 17.11 };
  const atThirtyMeters = { lat: target.lat + 30 / 111195, lng: target.lng };
  const outside = { lat: target.lat + 30.1 / 111195, lng: target.lng };
  const distance = (left, right) => Tracking.distanceMeters(left, right);
  assert.equal(Expedition.hasReachedTarget(atThirtyMeters, target, distance), true);
  assert.equal(Expedition.hasReachedTarget(outside, target, distance), false);
  assert.equal(Expedition.hasReachedTarget(null, target, distance), false);
});

const compassReadingAfterNorthWalk = (target) => {
  const compass = Expedition.createCompassState(Tracking.distanceMeters);
  const points = [
    { lat: -0.00012, lng: 0, timestamp: 1000 },
    { lat: -0.00006, lng: 0, timestamp: 2000 },
    { lat: 0, lng: 0, timestamp: 3000 }
  ];
  return points.map((point) => compass.update(point, target, Tracking.distanceMeters(point, target))).at(-1);
};

test("relative compass points up, right, down, and left for cardinal targets", () => {
  const targets = [
    [{ lat: 0.001, lng: 0 }, 0],
    [{ lat: 0, lng: 0.001 }, 90],
    [{ lat: -0.001, lng: 0 }, 180],
    [{ lat: 0, lng: -0.001 }, 270]
  ];
  for (const [target, expectedAngle] of targets) {
    const reading = compassReadingAfterNorthWalk(target);
    assert.ok(Math.abs(reading.relativeBearing - expectedAngle) < 1e-6);
    assert.equal(reading.headingUpdated, true);
  }
});

test("bearing remains geographic while movement and target use different coordinates", () => {
  const origin = { lat: 48.1486, lng: 17.1077 };
  const target = { lat: 48.2082, lng: 16.3738 };
  const firstBearing = Expedition.calculateBearing(origin, target);
  assert.ok(firstBearing > 250 && firstBearing < 330);
  assert.equal(Expedition.calculateBearing({ lat: 95, lng: 0 }, target), null);
});

test("compass waits for movement, suppresses small GPS noise, and retains heading while stopped", () => {
  assert.equal(Expedition.COMPASS_MIN_MOVEMENT_METERS, 8);
  assert.equal(Expedition.COMPASS_MOVEMENT_WINDOW_SIZE, 5);
  const compass = Expedition.createCompassState(Tracking.distanceMeters);
  const target = { lat: 0.01, lng: 0 };
  const stationary = [
    { lat: 0, lng: 0, timestamp: 1000 },
    { lat: 0.00001, lng: 0, timestamp: 2000 },
    { lat: -0.00001, lng: 0, timestamp: 3000 },
    { lat: 0.000005, lng: 0, timestamp: 4000 }
  ];
  let reading;
  for (const point of stationary) reading = compass.update(point, target, Tracking.distanceMeters(point, target));
  assert.equal(reading.relativeBearing, null);

  const walking = [
    { lat: 0.00005, lng: 0, timestamp: 5000 },
    { lat: 0.0001, lng: 0, timestamp: 6000 }
  ];
  for (const point of walking) reading = compass.update(point, target, Tracking.distanceMeters(point, target));
  const walkingBearing = reading.relativeBearing;
  assert.notEqual(walkingBearing, null);

  const stopped = [
    { lat: 0.0001, lng: 0, timestamp: 7000 },
    { lat: 0.000101, lng: 0, timestamp: 8000 },
    { lat: 0.000099, lng: 0, timestamp: 9000 },
    { lat: 0.0001, lng: 0, timestamp: 10000 },
    { lat: 0.000101, lng: 0, timestamp: 11000 }
  ];
  for (const point of stopped) reading = compass.update(point, target, Tracking.distanceMeters(point, target));
  assert.equal(reading.relativeBearing, walkingBearing);
  assert.equal(reading.headingUpdated, false);
});

test("compass updates after a turn and resumes with fresh points after restoration", () => {
  const compass = Expedition.createCompassState(Tracking.distanceMeters);
  const target = { lat: 0.01, lng: 0 };
  let reading;
  const route = [
    { lat: 0, lng: 0, timestamp: 1000 },
    { lat: 0.00006, lng: 0, timestamp: 2000 },
    { lat: 0.00012, lng: 0, timestamp: 3000 },
    { lat: 0.00012, lng: 0.00006, timestamp: 4000 },
    { lat: 0.00012, lng: 0.00012, timestamp: 5000 },
    { lat: 0.00012, lng: 0.00018, timestamp: 6000 },
    { lat: 0.00012, lng: 0.00024, timestamp: 7000 },
    { lat: 0.00012, lng: 0.0003, timestamp: 8000 }
  ];
  for (const point of route) reading = compass.update(point, target, Tracking.distanceMeters(point, target));
  assert.ok(reading.relativeBearing > 240 && reading.relativeBearing < 300);

  const restoredCompass = Expedition.createCompassState(Tracking.distanceMeters);
  const restored = restoredCompass.update(route.at(-1), target, Tracking.distanceMeters(route.at(-1), target));
  assert.equal(restored.relativeBearing, null);
});

test("compass uses the shortest visual rotation through north", () => {
  assert.equal(Expedition.nearestContinuousAngle(350, 10), 370);
  assert.equal(Expedition.nearestContinuousAngle(10, 350), -10);
  assert.equal(Expedition.nearestContinuousAngle(90, 90), 90);
});

test("stale compass state preserves the last reliable relative direction and distance", () => {
  const compass = Expedition.createCompassState(Tracking.distanceMeters);
  const target = { lat: 0, lng: 0.01 };
  let fresh;
  for (const point of [
    { lat: -0.00012, lng: 0, timestamp: 1000 },
    { lat: -0.00006, lng: 0, timestamp: 2000 },
    { lat: 0, lng: 0, timestamp: 3000 }
  ]) fresh = compass.update(point, target, Tracking.distanceMeters(point, target));
  const stale = compass.markStale();
  assert.deepEqual(stale, { ...fresh, stale: true });
  assert.deepEqual(compass.update(null, target, NaN), stale);
  compass.reset();
  assert.equal(compass.markStale(), null);
});

test("expedition UI, accepted GPS completion, persistence and territory isolation are wired into shared tracking", () => {
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
  const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
  assert.match(html, /id="territoryMode"/);
  assert.match(html, /id="expeditionMode"/);
  assert.match(html, /id="manualTargetMode"/);
  assert.match(html, /id="randomTargetMode"/);
  assert.match(html, /id="startExpedition"[^>]+disabled/);
  assert.ok(app.includes('map.on("click", (event) => {'));
  assert.ok(app.includes('setExpeditionTarget(event.latlng, "manual")'));
  assert.ok(app.includes("Expedition.createRandomTarget(latestLocation, radius)"));
  assert.ok(app.includes('$("expeditionRadius").addEventListener("change", () => {'));
  assert.ok(app.includes('if (mode === "expedition" && !expeditionTarget)'));
  assert.ok(app.includes('$("startExpedition").addEventListener("click", () => startWalk("expedition"))'));
  assert.ok(app.includes("mode: activeMode,"));
  assert.ok(app.includes("target: { ...expeditionTarget }"));
  assert.ok(app.includes('activeMode = draft.mode === "expedition" ? "expedition" : "territory"'));
  assert.ok(app.includes("Expedition.createCompassState(Tracking.distanceMeters)"));
  assert.ok(app.includes("expeditionCompassState.update("));
  assert.ok(app.includes("Expedition.nearestContinuousAngle(displayedCompassRotation, reading.relativeBearing)"));
  assert.ok(app.includes("expeditionCompassState.markStale()"));
  assert.ok(app.includes('if (recordingActive && activeMode === "expedition") setExpeditionCompassStale()'));
  assert.ok(app.includes('activeMode !== "expedition" || finishing || expeditionCompletionPending'));
  assert.ok(app.includes('$("expeditionCompassFreshness").textContent = "Начните движение"'));
  assert.ok(app.includes('if (reading.relativeBearing === null)'));
  assert.ok(app.includes('needle.style.visibility = "hidden"'));
  assert.ok(app.includes('if (!active || activeMode !== "expedition" || finishing || expeditionCompletionPending) hideExpeditionCompass()'));
  assert.match(html, /id="expeditionCompass"[^>]+hidden/);
  assert.doesNotMatch(html, /compassNorth|>N</);
  assert.doesNotMatch(app + html, /DeviceOrientation|deviceorientation/);
  assert.ok(app.includes("const receivePosition = Actions.createPositionReceiver({"));
  const processingStart = app.indexOf("const processPosition");
  const processingEnd = app.indexOf('$("manualWarmupStart").addEventListener', processingStart);
  const processing = app.slice(processingStart, processingEnd);
  const rejectedPosition = processing.indexOf("if (!result.accepted) {");
  const acceptedUpdate = processing.lastIndexOf("updateExpeditionProgress(result.point)");
  assert.ok(rejectedPosition >= 0 && acceptedUpdate > rejectedPosition);
  assert.ok(processing.indexOf("return;", rejectedPosition) < acceptedUpdate);
  assert.ok(app.includes("const closed = walkMode === \"territory\" && !retreated"));
  assert.ok(app.includes('expeditionStatus: retreated ? "incomplete" : "reached"'));
  assert.ok(app.includes('active ? activeMode === "expedition" ? "Идёт экспедиция"'));
  assert.ok(app.includes('if (walk.expeditionStatus === "reached") showExpeditionResult(walk)'));
  assert.match(html, /Экспедиция завершена/);
  assert.ok(bootstrap.includes('"expedition-core.js?v=0.2.3"'));
  assert.ok(bootstrap.includes('"app.js?v=0.2.29"'));
  assert.doesNotMatch(app, /router|routing service|OSRM|GraphHopper/i);
});
