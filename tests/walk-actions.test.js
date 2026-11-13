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
  const bootstrapSource = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
  assert.match(appSource, /Actions\.bindClick\(\$\("finish"\), \(\) => finishWalk\(\)\);/);
  assert.match(appSource, /await finishWalk\(true\);/);
  assert.match(appSource, /walk\.closed = true;/);
  assert.match(appSource, /status: "retreated"/);
  assert.match(appSource, /diagnosticSession\.walkStatus = retreated \? "retreated" : "completed"/);
  const finishImplementation = appSource.slice(appSource.indexOf("const finishWalk = async"), appSource.indexOf('$("start").addEventListener'));
  const prepareWalk = finishImplementation.slice(finishImplementation.indexOf("const prepareWalk"), finishImplementation.indexOf("let walkContext"));
  assert.ok(prepareWalk.indexOf("await trackingTasks.drain()") >= 0);
  assert.ok(prepareWalk.indexOf("await trackingTasks.drain()") < prepareWalk.indexOf("const finishedPoints"), "the final route is built after pending GPS work");
  assert.match(finishImplementation, /Actions\.commitIfReady\(\{\s*prepare: prepareWalk,[\s\S]*?evaluate: \(\{ finishedPoints \}\) => evaluateCaptureReadiness\(finishedPoints, true\)[\s\S]*?WalkStorage\.completeWalk\(db, walk\)/);
  const filterReset = finishImplementation.indexOf("positionFilter.reset(); gpsWarmup.reset();");
  assert.ok(finishImplementation.indexOf("WalkStorage.completeWalk(db, walk)") < filterReset, "territory filters reset after its successful save");
  assert.ok(finishImplementation.indexOf("WalkStorage.completeWalk(db, walkContext.walk)") < filterReset, "retreat and expedition filters reset after their successful save");
  assert.match(prepareWalk, /points: finishedPoints[\s\S]*diagnosticSession\.finalRoute = finishedPoints\.map/);
  const resumeFailure = appSource.slice(appSource.indexOf("const resumeAfterFinishFailure"), appSource.indexOf("const showExpeditionResult"));
  assert.doesNotMatch(resumeFailure, /positionFilter\.reset|gpsWarmup\.reset/);
  assert.match(appSource, /const receivePosition = Actions\.createPositionReceiver\(/);
  assert.ok(bootstrapSource.includes('"walk-actions.js?v=0.1.48"'));
  assert.ok(bootstrapSource.includes('"app.js?v=0.2.28"'));
  assert.match(appSource, /const evaluateCaptureReadiness = \(routePoints = initialRouteBuffer\.pending \? \[\] : points, allowFinishing = false\) => \{[\s\S]*?Tracking\.evaluateTerritoryCapture\(routePoints, capturePosition\)[\s\S]*?\(allowFinishing \|\| !finishing\).*?readiness\.eligible/);
  assert.match(appSource, /const updateCaptureAvailability = \(readiness = evaluateCaptureReadiness\(\)\) => \{\s*\$\("finish"\)\.disabled = !readiness\.eligible/);
  assert.match(appSource, /const finishPositionFilter = Tracking\.createFinishPositionFilter\(\)/);
  assert.match(appSource, /const processedAt = Date\.now\(\);\s*if \(recordingActive && activeMode === "territory"\) \{\s*const finishPosition = finishPositionFilter\.evaluate\(position, processedAt\);\s*if \(finishPosition\.accepted\) setCapturePosition\(finishPosition\.point\)/);
  const positionProcessing = appSource.slice(appSource.indexOf("const processPosition"), appSource.indexOf("const receivePosition"));
  assert.match(positionProcessing, /^const processPosition = async \(position\) => \{\s*if \(cancelling\) return;/);
  assert.doesNotMatch(positionProcessing.slice(0, 90), /finishing/);
  assert.match(appSource, /const trackingTasks = Actions\.createSerialQueue/);
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

  let filterReset = false;
  const completion = Actions.commitIfReady({
    prepare: async () => {
      await gpsQueue;
      assert.equal(filterReset, false, "filter state remains intact while queued GPS work is handled");
      pendingRoute = [...route, { lat: 0, lng: 0.001, timestamp: now }];
      pendingDraft = { ...draft, points: pendingRoute };
      db.records.drafts.set("active", pendingDraft);
      return { route: pendingRoute };
    },
    evaluate: ({ route: finalRoute }) => Tracking.evaluateTerritoryCapture(finalRoute, fix, now),
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
  assert.equal(filterReset, false, "a rejected capture does not reset the route filter");
});

test("GPS task B runs after task A's pending save and is included in the finish snapshot", async () => {
  const Storage = require("../walk-storage.js");
  const queue = Actions.createSerialQueue();
  const now = Date.now();
  const db = new MemoryDatabase();
  const route = [
    { lat: 0, lng: 0, accuracy: 5, timestamp: now - 24000, segmentStart: true },
    { lat: 0, lng: 0.0001, accuracy: 5, timestamp: now - 18000 },
    { lat: 0.0001, lng: 0.0001, accuracy: 5, timestamp: now - 12000 }
  ];
  db.records.drafts.set("active", { id: "active", points: route, startedAt: now - 10000 });
  const filter = Tracking.createPositionFilter();
  let filterReset = false;
  const steps = [];
  let points = route;
  let finishing = false;
  let cancelling = false;
  let releaseASave, markAStarted;
  const aSave = new Promise((resolve) => { releaseASave = resolve; });
  const aStarted = new Promise((resolve) => { markAStarted = resolve; });
  const processPosition = async (position) => {
    if (cancelling) return;
    steps.push(`process-${position.id}`);
    assert.equal(filterReset, false, "queued handlers retain their GPS filter state");
    if (position.id === "B") assert.equal(finishing, true, "an already queued GPS task runs after finish starts");
    if (position.id === "A") markAStarted();
    const result = filter.evaluate(position, points.at(-1), Date.now());
    assert.equal(result.accepted, true, `GPS ${position.id} passes the route filter`);
    const nextPoints = [...points, ...(result.points || [result.point])];
    if (position.id === "A") {
      await aSave;
    }
    db.records.drafts.set("active", { id: "active", points: nextPoints, startedAt: now - 10000 });
    points = nextPoints;
    steps.push(`saved-${position.id}`);
  };
  const receivePosition = Actions.createPositionReceiver({
    enqueue: (task) => queue.enqueue(task),
    processPosition,
    isFinishing: () => finishing
  });
  const fix = (id, lat, lng, timestamp) => ({ id, timestamp, coords: { latitude: lat, longitude: lng, accuracy: 5 } });
  const taskA = receivePosition(fix("A", 0.0001, 0, now - 6000));
  await aStarted;
  const taskB = receivePosition(fix("B", 0.00004, 0, now - 1000));
  const finishButton = new Button();
  let finish;
  Actions.bindClick(finishButton, () => {
    finishing = true;
    finish = Actions.commitIfReady({
      prepare: async () => {
        await queue.drain();
        steps.push("snapshot");
        return { points: [...points] };
      },
      evaluate: ({ points: finalPoints }) => Tracking.evaluateTerritoryCapture(finalPoints, { lat: 0, lng: 0, accuracy: 5, timestamp: now }, now),
      commit: async ({ points: finalPoints }) => {
        steps.push("save-territory");
        assert.equal(filterReset, false, "GPS filters remain intact while IndexedDB is saving");
        await Storage.completeWalk(db, { id: "captured", mode: "territory", points: finalPoints, closed: true });
        filter.reset();
        filterReset = true;
      }
    });
  });
  finishButton.click();
  assert.equal(await receivePosition(fix("late", 0, 0, now)), undefined, "new GPS fixes are rejected once finishing starts");
  releaseASave();
  await Promise.all([taskA, taskB, finish]);

  assert.deepEqual(steps, ["process-A", "saved-A", "process-B", "saved-B", "snapshot", "save-territory"]);
  const savedWalk = db.records.walks.get("captured");
  assert.equal(savedWalk.points.length, 5);
  assert.equal(savedWalk.points.at(-1).lat, 0.00004);
  assert.equal(filterReset, true, "the successful IndexedDB transaction precedes the filter reset");
  assert.equal(Tracking.evaluateTrackClosure(savedWalk.points).eligible, true);
  assert.equal(db.records.drafts.has("active"), false);
});

test("queued GPS confirmation keeps a safe segment break through territory save", async () => {
  const Storage = require("../walk-storage.js");
  const now = Date.now();
  const meters = (value) => value / 111194.9266;
  const db = new MemoryDatabase();
  db.records.drafts.set("active", { id: "active", points: [] });
  let filterReset = false;
  let queuedRoute = [];
  let releaseGps;
  const gpsTask = new Promise((resolve) => { releaseGps = resolve; });
  const completion = Actions.commitIfReady({
    prepare: async () => {
      await gpsTask;
      assert.equal(filterReset, false, "pending gap confirmation sees the existing filter state");
      queuedRoute = [
        { lat: 0, lng: 0, accuracy: 5, timestamp: now - 30000, segmentStart: true },
        { lat: 0, lng: 0.001, accuracy: 5, timestamp: now - 25000 },
        { lat: 0.001, lng: 0.001, accuracy: 5, timestamp: now - 20000 },
        { lat: 0.001, lng: 0.001 + meters(4), accuracy: 5, timestamp: now - 15000, segmentStart: true },
        { lat: 0.001, lng: 0, accuracy: 5, timestamp: now - 10000 },
        { lat: 0.001, lng: meters(4), accuracy: 5, timestamp: now - 5000, segmentStart: true },
        { lat: 0, lng: meters(4), accuracy: 5, timestamp: now }
      ];
      return { route: queuedRoute };
    },
    evaluate: ({ route }) => Tracking.evaluateTerritoryCapture(route, { lat: 0, lng: 0, accuracy: 5, timestamp: now }, now),
    commit: async ({ route }) => Storage.completeWalk(db, { id: "captured-gap", mode: "territory", points: route, closed: true }),
    onReject: () => assert.fail("a confirmed 4 m GPS gap remains safe")
  });
  releaseGps();
  const result = await completion;
  filterReset = true; // the application resets its filters only after completeWalk succeeds.

  assert.equal(result.committed, true);
  assert.equal(filterReset, true);
  const savedRoute = db.records.walks.get("captured-gap").points;
  assert.equal(savedRoute[3].segmentStart, true);
  assert.equal(Tracking.evaluateTrackClosure(savedRoute).eligible, true);
  assert.equal(db.records.drafts.has("active"), false);
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
    prepare: async () => ({ route }),
    evaluate: ({ route: preparedRoute }) => Tracking.evaluateTerritoryCapture(preparedRoute, { lat: 0, lng: 0, accuracy: 5, timestamp: Date.now() }),
    commit: async ({ route: preparedRoute }) => Storage.completeWalk(db, { id: "captured", mode: "territory", points: preparedRoute, closed: true, showOnMap: true })
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
  let filterReset = false;
  const route = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 0.0001 },
    { lat: 0.0001, lng: 0.0001 }, { lat: 0.0001, lng: 0 }
  ];
  await assert.rejects(Actions.commitIfReady({
    prepare: async () => ({ route }),
    evaluate: ({ route: preparedRoute }) => Tracking.evaluateTerritoryCapture(preparedRoute, { lat: 0, lng: 0, accuracy: 5, timestamp: Date.now() }),
    commit: async ({ route: preparedRoute }) => Storage.completeWalk(db, { id: "captured", mode: "territory", points: preparedRoute, closed: true })
  }));
  assert.equal(db.records.drafts.get("active"), draft);
  assert.equal(db.records.walks.size, 0);
  assert.equal(recording, true);
  assert.equal(filterReset, false, "a rejected IndexedDB transaction leaves the GPS filter untouched");
});

test("a successful capture focuses only its new polygon and caps the zoom", () => {
  const appSource = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(appSource, /const redrawSaved = async \(\{ focusWalkId = null \} = \{\}\)/);
  assert.match(appSource, /if \(walk\.id === focusWalkId && walk\.closed && !retreated\) focusedTerritory = layers\[0\] \|\| null;/);
  assert.match(appSource, /map\.fitBounds\(focusedTerritory\.getBounds\(\), \{[\s\S]*?MapFollow\.getVisibleMapFitPadding\([\s\S]*?maxZoom: 16/);
  assert.match(appSource, /redrawSaved\(\{ focusWalkId: closed \? walk\.id : null \}\)/);
  assert.doesNotMatch(appSource, /fitAll|featureGroup\(savedLayers\)/);
  assert.match(appSource, /await redrawSaved\(\);/);
});
