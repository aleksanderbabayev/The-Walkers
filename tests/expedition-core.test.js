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
  assert.ok(app.includes("const receivePosition = (position) => enqueueTrackingTask(() => processPosition(position))"));
  const processingStart = app.indexOf("const processPosition");
  const processingEnd = app.indexOf('$("manualWarmupStart").addEventListener', processingStart);
  const processing = app.slice(processingStart, processingEnd);
  const rejectedPosition = processing.indexOf("if (!result.accepted) {");
  const acceptedUpdate = processing.lastIndexOf("updateExpeditionProgress(result.point)");
  assert.ok(rejectedPosition >= 0 && acceptedUpdate > rejectedPosition);
  assert.ok(processing.indexOf("return;", rejectedPosition) < acceptedUpdate);
  assert.ok(app.includes("const closed = walkMode === \"territory\" && !retreated && Tracking.canCloseTrack(finishedPoints)"));
  assert.ok(app.includes('expeditionStatus: retreated ? "incomplete" : "reached"'));
  assert.ok(app.includes('active ? activeMode === "expedition" ? "Идёт экспедиция"'));
  assert.ok(app.includes('if (walk.expeditionStatus === "reached") showExpeditionResult(walk)'));
  assert.match(html, /Экспедиция завершена/);
  assert.ok(bootstrap.includes('"expedition-core.js?v=0.2.0"'));
  assert.ok(bootstrap.includes('"app.js?v=0.2.0"'));
  assert.doesNotMatch(app, /router|routing service|OSRM|GraphHopper/i);
});
