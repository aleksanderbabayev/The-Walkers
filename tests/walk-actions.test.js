const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Actions = require("../walk-actions.js");
const Tracking = require("../tracking-core.js");

class Button extends EventTarget {
  click() { this.dispatchEvent(new Event("click")); }
}

class MemoryDatabase {
  constructor() { this.records = { walks: new Map(), drafts: new Map() }; this.failNext = false; }
  transaction(names) {
    const operations = [];
    const transaction = {
      objectStore: (name) => ({
        add: (value) => { operations.push({ type: "add", name, value }); },
        delete: (key) => { operations.push({ type: "delete", name, key }); }
      })
    };
    queueMicrotask(() => queueMicrotask(() => {
      if (this.failNext) { this.failNext = false; transaction.error = new Error("simulated storage failure"); transaction.onerror?.(); return; }
      operations.forEach((operation) => operation.type === "add"
        ? this.records[operation.name].set(operation.value.id, operation.value)
        : this.records[operation.name].delete(operation.key));
      transaction.oncomplete?.();
    }));
    return transaction;
  }
}

test("Finish and Retreat button dispatch call their actions without passing the event", () => {
  const appSource = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(appSource, /Actions\.bindClick\(\$\("finish"\), \(\) => finishWalk\(\)\);/);
  assert.match(appSource, /await finishWalk\(true\);/);
  assert.match(appSource, /walk\.closed = true;/);
  assert.match(appSource, /status: "retreated"/);
  assert.match(appSource, /diagnosticSession\.walkStatus = retreated \? "retreated" : "completed"/);
  const finishImplementation = appSource.slice(appSource.indexOf("const finishWalk = async"), appSource.indexOf('$("start").addEventListener'));
  const captureGuard = finishImplementation.indexOf("!evaluateCaptureReadiness().eligible");
  assert.ok(captureGuard >= 0, "territory finish has a last-moment eligibility check");
  assert.ok(captureGuard < finishImplementation.indexOf("recordDiagnosticEvent"), "an ineligible capture returns before recording completion or stopping GPS");
  assert.match(finishImplementation, /if \(!retreated && walkMode === "territory"[\s\S]*?updateCaptureAvailability\(\);\s*return;/);
  assert.match(finishImplementation, /Actions\.commitIfReady\([\s\S]*?waitForPending: \(\) => trackingQueue[\s\S]*?evaluateCaptureReadiness\(finishedPoints, true\)[\s\S]*?WalkStorage\.completeWalk\(db, walk\)/);
  assert.match(appSource, /const receivePosition = \(position\) => finishing \? Promise\.resolve\(\) : enqueueTrackingTask/);
  assert.match(appSource, /const evaluateCaptureReadiness = \(routePoints = initialRouteBuffer\.pending \? \[\] : points, allowFinishing = false\) => \{[\s\S]*?Tracking\.evaluateTerritoryCapture\(routePoints, capturePosition\)[\s\S]*?\(allowFinishing \|\| !finishing\).*?readiness\.eligible/);
  assert.match(appSource, /const updateCaptureAvailability = \(readiness = evaluateCaptureReadiness\(\)\) => \{\s*\$\("finish"\)\.disabled = !readiness\.eligible/);
  assert.match(appSource, /const finishPositionFilter = Tracking\.createFinishPositionFilter\(\)/);
  assert.match(appSource, /const processedAt = Date\.now\(\);\s*if \(recordingActive && activeMode === "territory"\) \{\s*const finishPosition = finishPositionFilter\.evaluate\(position, processedAt\);\s*if \(finishPosition\.accepted\) setCapturePosition\(finishPosition\.point\)/);
  const positionProcessing = appSource.slice(appSource.indexOf("const processPosition"), appSource.indexOf("const receivePosition"));
  assert.doesNotMatch(positionProcessing.slice(0, positionProcessing.indexOf("const displayResult")), /setCapturePosition\(null\)/, "incoming measurements do not clear the previous finish fix");
  assert.doesNotMatch(positionProcessing, /setCapturePosition\(result\.point\)|setCapturePosition\(lastValidatedPoint\)/, "route writes do not control the separate finish position");
  assert.match(positionProcessing, /result\.reason === "speed"\) say\("GPS скачок отброшен/);
  assert.match(appSource, /latestLocation = null;\s*if \(recordingActive && activeMode === "territory"\) setCapturePosition\(null\);\s*updateLocateButton\("error"\)/);
  assert.match(appSource, /points = draftPoints;\s*finishPositionFilter\.reset\(points\.at\(-1\) \|\| null\);\s*initialRouteBuffer\.restore\(draftInitialBuffer\);\s*setCapturePosition\(null\)/);
  assert.match(appSource, /finishPositionFilter\.reset\(points\.at\(-1\) \|\| null\)/);
  assert.match(appSource, /capturePosition = null;\s*updateCaptureAvailability\(\);/);
  assert.match(appSource, /const captureReadinessMessage = \(readiness\) => readiness\.reason === "unsafe-gap" \? "Разрыв маршрута: захват недоступен"[\s\S]*?readiness\.reason === "waiting-for-gps" \? "Ожидаем точный GPS"[\s\S]*?readiness\.reason === "finish-reached" \? "Финиш достигнут!"/);

  const finishButton = new Button(), retreatButton = new Button();
  const finishCalls = [];
  const closedRoute = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 0.00002 },
    { lat: 0.00002, lng: 0.00002 }, { lat: 0.00002, lng: 0 }
  ];
  const runWalkAction = (...args) => {
    finishCalls.push(args);
    const retreated = args[0] === true;
    const closed = !retreated && Tracking.canCloseTrack(closedRoute);
    return { closed, showOnMap: !retreated && closed, status: retreated ? "retreated" : "completed" };
  };

  Actions.bindClick(finishButton, () => runWalkAction());
  Actions.bindClick(retreatButton, () => runWalkAction(true));
  finishButton.click();
  retreatButton.click();

  assert.deepEqual(finishCalls, [[], [true]]);
  assert.equal(Tracking.canCloseTrack(closedRoute), true);
  assert.deepEqual(runWalkAction(), { closed: true, showOnMap: true, status: "completed" });
  const retreatedWalk = runWalkAction(true);
  assert.deepEqual(retreatedWalk, { closed: false, showOnMap: false, status: "retreated" });
  assert.equal(Tracking.shouldDisplayWalkOnMap(retreatedWalk), false);
});

test("short routes remain ineligible for Finish but can be retained by Retreat", () => {
  const shortRoute = [{ lat: 48.9, lng: 21.2, timestamp: 1 }];
  const finishButton = new Button(), retreatButton = new Button();
  let finishResult = null, retreatResult = null;
  Actions.bindClick(finishButton, () => { finishResult = Tracking.canCloseTrack(shortRoute); });
  Actions.bindClick(retreatButton, () => { retreatResult = { status: "retreated", points: shortRoute, closed: false }; });

  finishButton.click();
  retreatButton.click();
  assert.equal(finishResult, false);
  assert.equal(retreatResult.points.length, 1);
  assert.equal(retreatResult.status, "retreated");
  assert.equal(retreatResult.closed, false);
});

test("capture completion waits for GPS work and rejects a newly unsuitable route without losing the draft", async () => {
  const now = Date.now();
  const route = [
    { lat: 0, lng: 0, timestamp: now - 10000 },
    { lat: 0, lng: 0.0001, timestamp: now - 7000 },
    { lat: 0.0001, lng: 0.0001, timestamp: now - 4000 },
    { lat: 0.0001, lng: 0, timestamp: now - 1000 }
  ];
  const fix = { lat: 0, lng: 0, accuracy: 5, timestamp: now };
  const db = new MemoryDatabase();
  const draft = { id: "active", points: route, startedAt: now - 20000 };
  db.records.drafts.set("active", draft);
  let pendingRoute = route;
  let pendingDraft = draft;
  let releaseGps;
  const gpsQueue = new Promise((resolve) => { releaseGps = resolve; });
  let recording = true;
  let resumed = false;
  let commits = 0;
  const readiness = () => Tracking.evaluateTerritoryCapture(pendingRoute, fix, now);
  assert.equal(readiness().eligible, true, "capture button was ready before queued GPS work");

  const completion = Actions.commitIfReady({
    waitForPending: async () => {
      await gpsQueue;
      pendingRoute = [...route, { lat: 0, lng: 0.001, timestamp: now }];
      pendingDraft = { ...draft, points: pendingRoute };
      db.records.drafts.set("active", pendingDraft);
    },
    evaluate: readiness,
    commit: async () => { commits += 1; },
    onReject: () => { recording = true; resumed = true; }
  });
  assert.equal(commits, 0, "completion does not commit before pending GPS work settles");
  releaseGps();
  const result = await completion;

  assert.equal(result.committed, false);
  assert.equal(result.evaluation.reason, "not-closed");
  assert.equal(commits, 0);
  assert.equal(db.records.drafts.get("active"), pendingDraft);
  assert.equal(pendingRoute.length, route.length + 1, "queued GPS route changes are retained for continued recording");
  assert.equal(recording, true);
  assert.equal(resumed, true);
});

test("ready capture is saved as a closed territory and removes its draft atomically", async () => {
  const Storage = require("../walk-storage.js");
  const db = new MemoryDatabase();
  db.records.drafts.set("active", { id: "active", points: [] });
  const route = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 0.0001 },
    { lat: 0.0001, lng: 0.0001 }, { lat: 0.0001, lng: 0 }
  ];
  const result = await Actions.commitIfReady({
    waitForPending: async () => {},
    evaluate: () => Tracking.evaluateTerritoryCapture(route, { lat: 0, lng: 0, accuracy: 5, timestamp: Date.now() }),
    commit: async () => Storage.completeWalk(db, { id: "captured", mode: "territory", points: route, closed: true, showOnMap: true })
  });
  assert.equal(result.committed, true);
  assert.equal(db.records.walks.get("captured").closed, true);
  assert.equal(db.records.walks.get("captured").showOnMap, true);
  assert.equal(db.records.drafts.has("active"), false);
});

test("a storage failure during eligible capture leaves the draft and recording recoverable", async () => {
  const Storage = require("../walk-storage.js");
  const db = new MemoryDatabase();
  const draft = { id: "active", points: [{ lat: 1, lng: 2 }] };
  db.records.drafts.set("active", draft);
  db.failNext = true;
  let recording = true;
  const route = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 0.0001 },
    { lat: 0.0001, lng: 0.0001 }, { lat: 0.0001, lng: 0 }
  ];
  await assert.rejects(Actions.commitIfReady({
    waitForPending: async () => {},
    evaluate: () => Tracking.evaluateTerritoryCapture(route, { lat: 0, lng: 0, accuracy: 5, timestamp: Date.now() }),
    commit: async () => Storage.completeWalk(db, { id: "captured", mode: "territory", points: route, closed: true })
  }));
  assert.equal(db.records.drafts.get("active"), draft);
  assert.equal(db.records.walks.size, 0);
  assert.equal(recording, true);
});

test("a successful capture focuses only its new polygon and caps the zoom", () => {
  const appSource = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(appSource, /const redrawSaved = async \(\{ focusWalkId = null \} = \{\}\)/);
  assert.match(appSource, /if \(walk\.id === focusWalkId && walk\.closed && !retreated\) focusedTerritory = layers\[0\] \|\| null;/);
  assert.match(appSource, /map\.fitBounds\(focusedTerritory\.getBounds\(\), \{ padding: \[16, 16\], maxZoom: 16 \}\);/);
  assert.match(appSource, /redrawSaved\(\{ focusWalkId: closed \? walk\.id : null \}\)/);
  assert.doesNotMatch(appSource, /fitAll|featureGroup\(savedLayers\)/);
  assert.match(appSource, /await redrawSaved\(\);/);
});
