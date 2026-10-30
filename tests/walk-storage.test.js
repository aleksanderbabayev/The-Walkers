const test = require("node:test");
const assert = require("node:assert/strict");
const Storage = require("../walk-storage.js");
const Diagnostics = require("../walk-diagnostics.js");

class MemoryDatabase {
  constructor() {
    this.records = { walks: new Map(), drafts: new Map(), diagnostics: new Map(), diagnosticEvents: new Map() };
    this.failNext = false;
    this.successCallbacks = 0;
  }

  transaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const operations = [];
    const transaction = {
      error: null,
      objectStore: (name) => ({
        get: (key) => {
          const request = { result: undefined };
          queueMicrotask(() => { request.result = this.records[name].get(key); request.onsuccess?.(); });
          return request;
        },
        getAll: () => {
          const request = { result: [] };
          queueMicrotask(() => { request.result = [...this.records[name].values()]; request.onsuccess?.(); });
          return request;
        },
        index: (indexName) => ({
          getAll: (key) => {
            const request = { result: [] };
            queueMicrotask(() => {
              request.result = [...this.records[name].values()].filter((record) => record[indexName === "bySessionId" ? "sessionId" : indexName] === key);
              this.successCallbacks += 1;
              request.onsuccess?.();
            });
            return request;
          }
        }),
        add: (value) => { operations.push({ type: "add", name, value }); return {}; },
        put: (value) => { operations.push({ type: "put", name, value }); return {}; },
        delete: (key) => { operations.push({ type: "delete", name, key }); return {}; }
      })
    };

    queueMicrotask(() => queueMicrotask(() => {
      if (this.failNext) {
        this.failNext = false;
        transaction.error = new Error("simulated storage failure");
        transaction.onerror?.();
        return;
      }
      const addConflict = operations.some(({ type, name, value }) => type === "add" && this.records[name].has(value.id));
      if (addConflict) {
        transaction.error = new Error("duplicate key");
        transaction.onabort?.();
        return;
      }
      for (const operation of operations) {
        const records = this.records[operation.name];
        if (operation.type === "add" || operation.type === "put") records.set(operation.value.id, operation.value);
        if (operation.type === "delete") records.delete(operation.key);
      }
      transaction.oncomplete?.();
    }));
    return transaction;
  }
}

test("starting a walk cannot replace an unfinished draft", async () => {
  const db = new MemoryDatabase();
  const draft = { id: "active", points: [{ lat: 1, lng: 2 }], startedAt: 123 };
  db.records.drafts.set("active", draft);
  await assert.rejects(Storage.createDraft(db, { id: "active", points: [], startedAt: 456 }));
  assert.equal(db.records.drafts.get("active"), draft);
});

test("initial validation buffer survives draft autosave and reload", async () => {
  const db = new MemoryDatabase();
  const initialBuffer = [{ lat: 48.9, lng: 21.2, accuracy: 5, timestamp: 123, segmentStart: true }];
  await Storage.createDraft(db, { id: "active", points: [], initialBuffer, startedAt: 100 });
  const restored = await Storage.readDraft(db);
  assert.deepEqual(restored.initialBuffer, initialBuffer);
  assert.deepEqual(restored.points, []);
});

test("diagnostic events and session metadata survive reload", async () => {
  const db = new MemoryDatabase();
  await Storage.writeDiagnosticSession(db, { id: "active", formatVersion: 1, appVersion: "0.1.43", events: [] });
  await Storage.writeDiagnosticEvent(db, "active", { sequence: 1, type: "start", at: 123 });
  await Storage.writeDiagnosticEvent(db, "active", { sequence: 2, type: "gps-measurement", phase: "warm-up", rawMeasurement: { timestamp: 456 } });

  const restored = await Storage.readDiagnostics(db, "active");
  assert.equal(restored.appVersion, "0.1.43");
  assert.deepEqual(restored.events.map((event) => event.sequence), [1, 2]);
  assert.equal(restored.events[1].rawMeasurement.timestamp, 456);
});

test("diagnostic events remain recoverable if session metadata could not be written", async () => {
  const db = new MemoryDatabase();
  await Storage.writeDiagnosticEvent(db, "active", { sequence: 1, type: "start", at: 123 });
  const restored = await Storage.readDiagnostics(db, "active");

  assert.equal(restored.appVersion, "metadata unavailable");
  assert.equal(restored.events[0].type, "start");
});

test("failed completion preserves the draft and does not add a completed walk", async () => {
  const db = new MemoryDatabase();
  const draft = { id: "active", points: [{ lat: 1, lng: 2 }], startedAt: 123 };
  db.records.drafts.set("active", draft);
  db.failNext = true;
  await assert.rejects(Storage.completeWalk(db, { id: "walk-1", points: [] }));
  assert.equal(db.records.drafts.get("active"), draft);
  assert.equal(db.records.walks.size, 0);
});

test("walk completion succeeds independently from diagnostic finalization", async () => {
  const db = new MemoryDatabase();
  db.records.drafts.set("active", { id: "active", points: [], startedAt: 123 });
  db.failNext = true;
  await assert.rejects(Storage.writeDiagnosticSession(db, { id: "active", formatVersion: 1, events: [] }));
  await Storage.completeWalk(db, { id: "walk-1", points: [], finishedAt: 456 });
  assert.equal(db.records.walks.has("walk-1"), true);
  assert.equal(db.records.drafts.has("active"), false);
});

test("diagnostics are finalized with a completed walk and can be copied from its id", async () => {
  const db = new MemoryDatabase();
  await Storage.writeDiagnosticSession(db, { id: "active", formatVersion: 1, state: "finalizing", walkId: "walk-1", events: [] });
  await Storage.writeDiagnosticEvent(db, "active", { sequence: 1, type: "start", at: 100 });
  await Storage.writeDiagnosticEvent(db, "active", { sequence: 2, type: "gps-measurement", includedInRoute: true });
  const recoveredFinalization = await Storage.readDiagnostics(db, "active");
  const route = [{ lat: 48.9, lng: 21.2, accuracy: 8, timestamp: 456, segmentStart: true }];
  const callbacksBeforeCompletion = db.successCallbacks;
  const events = [
    { sequence: 1, type: "start", at: 100 },
    { sequence: 2, type: "gps-measurement", phase: "recording", decision: "accepted", filteringReason: null, thresholds: { maxAccuracyMeters: 35 }, rawMeasurement: { timestamp: 456, latitude: 48.9, longitude: 21.2, accuracyMeters: 8 }, includedInRoute: true }
  ];
  await Storage.completeDiagnostics(db, "walk-1", { ...recoveredFinalization, events, finalRoute: route, finishedAt: 456 });
  assert.equal(db.records.diagnostics.has("active"), false);
  assert.equal(db.successCallbacks, callbacksBeforeCompletion + 1, "completeDiagnostics asynchronous success callback ran");
  const completed = await Storage.readDiagnostics(db, "walk-1");
  assert.equal(completed.events[1].includedInRoute, true);
  assert.equal(completed.state, "completed");
  assert.equal("walkId" in completed, false);
  const report = Diagnostics.buildReport(completed, completed.finalRoute, completed.events);
  assert.deepEqual(report.events.map((event) => event.sequence), [1, 2]);
  assert.equal(report.rawMeasurements[0].includedInRoute, true);
  assert.equal(report.rawMeasurements[0].decision, "accepted");
  assert.equal(report.rawMeasurements[0].rawPosition.accuracyMeters, 8);
  assert.equal(report.rawMeasurements[0].thresholds.maxAccuracyMeters, 35);
  assert.deepEqual(report.finalAcceptedRoute, [{ latitude: 48.9, longitude: 21.2, accuracyMeters: 8, timestamp: 456, segmentStart: true }]);
});

test("failed diagnostic finalization leaves the saved walk and active diagnostic events intact", async () => {
  const db = new MemoryDatabase();
  const walk = { id: "walk-1", points: [{ lat: 48.9, lng: 21.2, timestamp: 456 }], finishedAt: 789 };
  db.records.walks.set(walk.id, walk);
  await Storage.writeDiagnosticSession(db, { id: "active", formatVersion: 1, state: "finalizing", walkId: walk.id, events: [] });
  await Storage.writeDiagnosticEvent(db, "active", { sequence: 1, type: "start", at: 123 });
  db.failNext = true;

  await assert.rejects(Storage.completeDiagnostics(db, walk.id, { id: "active", events: [{ sequence: 1, type: "start", at: 123 }] }));
  assert.equal(db.records.walks.get(walk.id), walk);
  assert.equal((await Storage.readDiagnostics(db, "active")).events[0].type, "start");
});

test("cancelling GPS warm-up deletes only the empty active draft", async () => {
  const db = new MemoryDatabase();
  const completedWalk = { id: "walk-1", points: [{ lat: 1, lng: 2 }] };
  db.records.walks.set(completedWalk.id, completedWalk);
  db.records.drafts.set("active", { id: "active", points: [], startedAt: 123 });

  await Storage.deleteDraft(db);
  assert.equal(db.records.drafts.has("active"), false);
  assert.equal(db.records.walks.get(completedWalk.id), completedWalk);
});

test("retreat deletes the active route draft without changing completed walks or adding a walk", async () => {
  const db = new MemoryDatabase();
  const completedWalk = { id: "walk-1", closed: true, points: [{ lat: 1, lng: 2 }] };
  db.records.walks.set(completedWalk.id, completedWalk);
  db.records.drafts.set("active", { id: "active", points: [{ lat: 1, lng: 2 }, { lat: 1.001, lng: 2 }], startedAt: 123 });

  await Storage.deleteDraft(db);
  assert.equal(db.records.drafts.has("active"), false);
  assert.equal(db.records.walks.size, 1);
  assert.equal(db.records.walks.get(completedWalk.id), completedWalk);
});

test("failed retreat preserves the draft and prevents a new draft from overwriting it", async () => {
  const db = new MemoryDatabase();
  const draft = { id: "active", points: [{ lat: 1, lng: 2 }, { lat: 1.001, lng: 2 }], startedAt: 123 };
  db.records.drafts.set("active", draft);
  db.failNext = true;

  await assert.rejects(Storage.deleteDraft(db));
  assert.equal(db.records.drafts.get("active"), draft);
  await assert.rejects(Storage.createDraft(db, { id: "active", points: [], startedAt: 456 }));
  assert.equal(db.records.drafts.get("active"), draft);
});

test("deleting a history item leaves other walks and the active draft intact", async () => {
  const db = new MemoryDatabase();
  const selected = { id: "walk-1", closed: true };
  const otherWalk = { id: "walk-2", closed: false };
  const draft = { id: "active", points: [{ lat: 1, lng: 2 }] };
  db.records.walks.set(selected.id, selected);
  db.records.walks.set(otherWalk.id, otherWalk);
  db.records.drafts.set(draft.id, draft);
  db.records.diagnostics.set(selected.id, { id: selected.id });
  db.records.diagnosticEvents.set(`${selected.id}:1`, { id: `${selected.id}:1`, sessionId: selected.id });
  db.records.diagnostics.set(otherWalk.id, { id: otherWalk.id });
  db.records.diagnosticEvents.set(`${otherWalk.id}:1`, { id: `${otherWalk.id}:1`, sessionId: otherWalk.id });

  await Storage.deleteWalk(db, selected.id);
  assert.equal(db.records.walks.has(selected.id), false);
  assert.equal(db.records.walks.get(otherWalk.id), otherWalk);
  assert.equal(db.records.drafts.get(draft.id), draft);
  assert.equal(db.records.diagnostics.has(selected.id), false);
  assert.equal(db.records.diagnosticEvents.has(`${selected.id}:1`), false);
  assert.equal(db.records.diagnostics.has(otherWalk.id), true);
});

test("abandoning a draft also removes its diagnostic events", async () => {
  const db = new MemoryDatabase();
  db.records.drafts.set("active", { id: "active" });
  db.records.diagnostics.set("active", { id: "active" });
  db.records.diagnosticEvents.set("active:1", { id: "active:1", sessionId: "active" });
  await Storage.deleteDraft(db);
  assert.equal(db.records.drafts.has("active"), false);
  assert.equal(db.records.diagnostics.has("active"), false);
  assert.equal(db.records.diagnosticEvents.has("active:1"), false);
});

test("failed history deletion preserves the selected walk", async () => {
  const db = new MemoryDatabase();
  const walk = { id: "walk-1", closed: true };
  db.records.walks.set(walk.id, walk);
  db.failNext = true;

  await assert.rejects(Storage.deleteWalk(db, walk.id));
  assert.equal(db.records.walks.get(walk.id), walk);
});
