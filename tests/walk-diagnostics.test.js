const test = require("node:test");
const assert = require("node:assert/strict");
const Diagnostics = require("../walk-diagnostics.js");

test("diagnostics capture ordered GPS and significant events with minimal client metadata", () => {
  const session = Diagnostics.createSession({
    appVersion: "0.1.43", startedAt: 100,
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
  const restored = Diagnostics.restoreSession({ id: "active", formatVersion: 1, appVersion: "0.1.43", startedAt: 10 }, [
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
  const session = Diagnostics.createSession({ appVersion: "0.1.43", startedAt: 10 });
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
  assert.equal(Object.hasOwn(report.metadata, "diagnosticsAvailable"), false, "reports with saved diagnostics keep their established metadata shape");
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
  let writeStarted = false;
  const copyPromise = Diagnostics.copyText("{\n  \"ok\": true\n}", { writeText: async (text) => { writeStarted = true; copied = text; } });
  assert.equal(writeStarted, true, "clipboard writing starts synchronously for the click's user activation");
  const success = await copyPromise;
  const failure = await Diagnostics.copyText("report", { writeText: async () => { throw new Error("denied"); } });
  const unsupported = await Diagnostics.copyText("report", null);

  assert.equal(success.copied, true);
  assert.equal(copied, "{\n  \"ok\": true\n}");
  assert.equal(failure.copied, false);
  assert.equal(unsupported.copied, false);
});

test("clipboard rejection and missing Clipboard API expose the complete report for manual copying", async () => {
  const reportText = JSON.stringify({ walkId: "walk-56", events: [] }, null, 2);
  const fallbacks = [];
  let clipboardText = "";
  const copied = await Diagnostics.copyTextOrFallback(reportText, { writeText: async (text) => { clipboardText = text; } }, (text) => fallbacks.push(text));
  const rejected = await Diagnostics.copyTextOrFallback(reportText, { writeText: async () => { throw new Error("denied"); } }, (text) => fallbacks.push(text));
  const unsupported = await Diagnostics.copyTextOrFallback(reportText, undefined, (text) => fallbacks.push(text));

  assert.deepEqual(copied, { copied: true });
  assert.equal(clipboardText, reportText);
  assert.deepEqual(rejected, { copied: false });
  assert.deepEqual(unsupported, { copied: false });
  assert.deepEqual(fallbacks, [reportText, reportText]);
});

test("click-time report loading does not wait for history-menu preload and deduplicates repeated clicks", async () => {
  let releaseLoad;
  let loadCount = 0;
  let copyCount = 0;
  const states = [];
  const statuses = [];
  const button = { disabled: false };
  const controller = Diagnostics.createCompletedCopyController({
    load: () => { loadCount += 1; return new Promise((resolve) => { releaseLoad = resolve; }); },
    copy: async (_walk, stored) => { copyCount += 1; assert.equal(stored.id, "walk-56"); },
    setStatus: (status) => statuses.push(status),
    setBusy: (_button, busy) => { button.disabled = busy; states.push(busy); }
  });
  const walk = { id: "walk-56" };
  const firstClick = controller(walk, button);
  const secondClick = controller(walk, button);
  assert.strictEqual(secondClick, firstClick);
  assert.equal(loadCount, 1, "the click starts its own IndexedDB read without waiting for drawer preload");
  assert.equal(button.disabled, true);
  releaseLoad({ id: "walk-56", events: [{ type: "gps-measurement" }] });
  await Promise.all([firstClick, secondClick]);

  assert.equal(copyCount, 1);
  assert.equal(button.disabled, false);
  assert.deepEqual(states, [true, false]);
  assert.equal(statuses[0], "Загружаем диагностику прогулки…");
});

test("IndexedDB read errors are handled and still allow a fallback report from saved walk data", async () => {
  const statuses = [];
  let copiedData;
  const controller = Diagnostics.createCompletedCopyController({
    load: async () => { throw new Error("IndexedDB unavailable"); },
    copy: async (walk, stored, readError) => { copiedData = Diagnostics.createCompletedReportData(walk, stored, readError); },
    setStatus: (status) => statuses.push(status)
  });
  const walk = {
    id: "walk-56", mode: "territory", status: "retreated", startedAt: 100, finishedAt: 737000,
    durationMs: 637000, distanceMeters: 780, closed: false,
    points: [{ lat: 48.1, lng: 17.1, timestamp: 200 }]
  };
  const before = structuredClone(walk);

  await assert.doesNotReject(controller(walk, null));
  const report = Diagnostics.buildReport(copiedData.session, copiedData.route, copiedData.events);
  assert.equal(report.metadata.diagnosticsAvailable, false);
  assert.equal(report.metadata.diagnosticsUnavailableReason, "read-error");
  assert.equal(report.metadata.walkSummary.pointCount, 1);
  assert.equal(report.metadata.walkSummary.distanceMeters, 780);
  assert.equal(report.events.length, 0);
  assert.equal(report.rawMeasurements.length, 0, "no GPS events are fabricated");
  assert.equal(report.finalAcceptedRoute.length, 1, "the stored walk route remains available");
  assert.deepEqual(walk, before, "report generation does not alter the saved walk");
  assert.equal(statuses[0], "Загружаем диагностику прогулки…");
});

test("report preparation errors are caught and the copy action becomes available again", async () => {
  const statuses = [];
  const button = { disabled: false };
  const controller = Diagnostics.createCompletedCopyController({
    load: async () => ({ id: "walk-56", events: [] }),
    copy: async () => { throw new Error("report serialization failed"); },
    setStatus: (status) => statuses.push(status),
    setBusy: (_button, busy) => { button.disabled = busy; }
  });

  await assert.doesNotReject(controller({ id: "walk-56" }, button));
  assert.equal(button.disabled, false);
  assert.equal(statuses.at(-1), "Не удалось подготовить диагностику для копирования.");
});

test("missing diagnostic events are explicitly marked while retaining the walk route", () => {
  const walk = { id: "walk-56", mode: "expedition", expeditionStatus: "reached", points: [{ lat: 48.1, lng: 17.1 }] };
  const data = Diagnostics.createCompletedReportData(walk, { id: "walk-56", events: [] });
  const report = Diagnostics.buildReport(data.session, data.route, data.events);

  assert.equal(report.metadata.diagnosticsAvailable, false);
  assert.equal(report.metadata.diagnosticsUnavailableReason, "events-not-found");
  assert.equal(report.metadata.walkSummary.status, "reached");
  assert.equal(report.events.length, 0);
  assert.equal(report.finalAcceptedRoute.length, 1);
});

test("app requests completed diagnostics from the copy action and no longer preloads the history drawer", () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
  const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");

  assert.match(html, /name="app-version" content="0\.2\.27"/);
  assert.ok(bootstrap.includes('"walk-diagnostics.js?v=0.1.45"'));
  assert.ok(bootstrap.includes('"app.js?v=0.2.27"'));
  assert.match(app, /Diagnostics\.createCompletedCopyController\([\s\S]*?WalkStorage\.readDiagnostics\(db, walkId\)/);
  assert.match(app, /copyCompletedDiagnostics\(walk, copyButton\)/);
  assert.doesNotMatch(app, /preloadWalkDiagnostics/);
});
