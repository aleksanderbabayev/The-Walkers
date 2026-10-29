const test = require("node:test");
const assert = require("node:assert/strict");
const Storage = require("../walk-storage.js");

class MemoryDatabase {
  constructor() {
    this.records = { walks: new Map(), drafts: new Map() };
    this.failNext = false;
  }

  transaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const operations = [];
    const transaction = {
      error: null,
      objectStore: (name) => ({
        get: (key) => {
          const request = {};
          queueMicrotask(() => { request.result = this.records[name].get(key); });
          return request;
        },
        add: (value) => { operations.push({ type: "add", name, value }); return {}; },
        put: (value) => { operations.push({ type: "put", name, value }); return {}; },
        delete: (key) => { operations.push({ type: "delete", name, key }); return {}; }
      })
    };

    queueMicrotask(() => {
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
    });
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

test("failed completion preserves the draft and does not add a completed walk", async () => {
  const db = new MemoryDatabase();
  const draft = { id: "active", points: [{ lat: 1, lng: 2 }], startedAt: 123 };
  db.records.drafts.set("active", draft);
  db.failNext = true;
  await assert.rejects(Storage.completeWalk(db, { id: "walk-1", points: [] }));
  assert.equal(db.records.drafts.get("active"), draft);
  assert.equal(db.records.walks.size, 0);
});

test("successful completion atomically adds the walk and removes its draft", async () => {
  const db = new MemoryDatabase();
  db.records.drafts.set("active", { id: "active", points: [], startedAt: 123 });
  await Storage.completeWalk(db, { id: "walk-1", points: [] });
  assert.equal(db.records.walks.has("walk-1"), true);
  assert.equal(db.records.drafts.has("active"), false);
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

test("failed warm-up cancellation keeps the draft and prevents a new draft from overwriting it", async () => {
  const db = new MemoryDatabase();
  const draft = { id: "active", points: [], startedAt: 123 };
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

  await Storage.deleteWalk(db, selected.id);
  assert.equal(db.records.walks.has(selected.id), false);
  assert.equal(db.records.walks.get(otherWalk.id), otherWalk);
  assert.equal(db.records.drafts.get(draft.id), draft);
});

test("failed history deletion preserves the selected walk", async () => {
  const db = new MemoryDatabase();
  const walk = { id: "walk-1", closed: true };
  db.records.walks.set(walk.id, walk);
  db.failNext = true;

  await assert.rejects(Storage.deleteWalk(db, walk.id));
  assert.equal(db.records.walks.get(walk.id), walk);
});
