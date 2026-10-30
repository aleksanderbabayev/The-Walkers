const test = require("node:test");
const assert = require("node:assert/strict");
const Diagnostics = require("../walk-diagnostics.js");

test("diagnostics capture ordered GPS and significant events with minimal client metadata", () => {
  const session = Diagnostics.createSession({
    appVersion: "0.1.42", startedAt: 100,
    navigatorLike: { platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/604.1" }
  });
  const start = Diagnostics.addEvent(session, { type: "start", at: 100 });
  const gps = Diagnostics.addEvent(session, {
    type: "gps-measurement", phase: "warm-up", processedAt: 125,
    rawMeasurement: { timestamp: 120, latitude: 48.9, longitude: 21.2, accuracyMeters: 8 },
    decision: "pending", filteringReason: "warming", thresholds: { maxAccuracyMeters: 35 }
  });

  assert.deepEqual([start.sequence, gps.sequence], [1, 2]);
  assert.equal(session.environment.browser.name, "Safari");
  assert.equal(session.environment.platform, "iOS");
  assert.equal(JSON.stringify(session).includes("iPhone)"), false);
});

test("GPS measurement capture includes raw coordinates, processing time and comparison metrics", () => {
  const event = Diagnostics.createGpsMeasurement({
    position: { timestamp: 5000, coords: { latitude: 48.9, longitude: 21.2, accuracy: 9 } },
    processedAt: 5100, phase: "recording", decision: "rejected", reason: "speed",
    previous: { lat: 48.9, lng: 21.2, timestamp: 0 },
    distanceBetween: () => 20, thresholds: { maxSpeedMetersPerSecond: 3 }, pendingCandidate: true
  });

  assert.deepEqual(event.rawMeasurement, { timestamp: 5000, latitude: 48.9, longitude: 21.2, accuracyMeters: 9 });
  assert.equal(event.processedAt, 5100);
  assert.deepEqual(event.comparison, { previousTimestamp: 0, distanceMeters: 20, elapsedMs: 5000, speedMetersPerSecond: 4 });
  assert.equal(event.filteringReason, "speed");
  assert.equal(event.includedInRoute, false);
  assert.equal(event.pendingCandidate, true);
});

test("diagnostic recovery preserves event ordering and resumes sequence numbers", () => {
  const restored = Diagnostics.restoreSession({ id: "active", formatVersion: 1, appVersion: "0.1.42", startedAt: 10 }, [
    { sequence: 2, type: "gps-measurement" }, { sequence: 1, type: "start" }
  ]);
  const next = Diagnostics.addEvent(restored, { type: "draft-restored", at: 20 });

  assert.deepEqual(restored.events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(next.type, "draft-restored");
  assert.equal(restored.restored, undefined);
});

test("diagnostic event count is bounded per walk", () => {
  const session = Diagnostics.createSession();
  for (let index = 0; index <= Diagnostics.MAX_EVENTS; index += 1) {
    Diagnostics.addEvent(session, { type: "gps-measurement", sequence: index });
  }

  assert.equal(session.events.length, Diagnostics.MAX_EVENTS);
  assert.equal(session.droppedEvents, 1);
});

test("diagnostic report separates raw GPS measurements from accepted route coordinates", () => {
  const session = Diagnostics.createSession({ appVersion: "0.1.42", startedAt: 10 });
  Diagnostics.addEvent(session, {
    type: "gps-measurement", phase: "initial-buffer", processedAt: 200,
    rawMeasurement: { timestamp: 100, latitude: 48.9, longitude: 21.2, accuracyMeters: 12 },
    decision: "accepted", filteringReason: null, includedInRoute: null
  });
  Diagnostics.addEvent(session, {
    type: "gps-measurement", phase: "initial-buffer", processedAt: 300,
    rawMeasurement: { timestamp: 150, latitude: 48.91, longitude: 21.21, accuracyMeters: 60 },
    decision: "rejected", filteringReason: "accuracy", includedInRoute: false
  });
  const route = [{ lat: 48.9, lng: 21.2, accuracy: 12, timestamp: 100, segmentStart: true }];
  const changed = Diagnostics.applyRouteDisposition(session, route);
  const report = Diagnostics.buildReport(session, route);

  assert.equal(changed.length, 2);
  assert.equal(report.rawMeasurements.length, 2);
  assert.equal(report.rawMeasurements[0].includedInRoute, true);
  assert.equal(report.rawMeasurements[1].includedInRoute, false);
  assert.equal(report.finalAcceptedRoute.length, 1);
  assert.equal(report.finalAcceptedRoute[0].latitude, 48.9);
});

test("pending GPS measurements resolve against the final route without changing raw coordinates", () => {
  const session = Diagnostics.createSession();
  const pending = Diagnostics.addEvent(session, {
    type: "gps-measurement", phase: "recording", decision: "pending_confirmation",
    rawMeasurement: { timestamp: 10, latitude: 48.9, longitude: 21.2 }, includedInRoute: null
  });
  const rejected = Diagnostics.addEvent(session, {
    type: "gps-measurement", phase: "initial-buffer", decision: "pending_confirmation",
    rawMeasurement: { timestamp: 20, latitude: 48.91, longitude: 21.21 }, includedInRoute: null
  });

  Diagnostics.applyRouteDisposition(session, [{ timestamp: 10, lat: 48.9, lng: 21.2, segmentStart: true }]);
  assert.equal(pending.decision, "accepted");
  assert.equal(pending.includedInRoute, true);
  assert.equal(rejected.decision, "rejected");
  assert.equal(rejected.includedInRoute, false);
  assert.equal(session.events[0].rawMeasurement.latitude, 48.9);
});

test("copying uses the clipboard API and reports when it is unavailable", async () => {
  let copied = "";
  const success = await Diagnostics.copyText("{\n  \"ok\": true\n}", { writeText: async (text) => { copied = text; } });
  const failure = await Diagnostics.copyText("report", { writeText: async () => { throw new Error("denied"); } });
  const unsupported = await Diagnostics.copyText("report", null);

  assert.equal(success.copied, true);
  assert.equal(copied, "{\n  \"ok\": true\n}");
  assert.equal(failure.copied, false);
  assert.equal(unsupported.copied, false);
});
