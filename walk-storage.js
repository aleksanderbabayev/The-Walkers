(function (root, factory) {
  const storage = factory();
  if (typeof module === "object" && module.exports) module.exports = storage;
  else root.WalkStorage = storage;
})(globalThis, function () {
  "use strict";

  const transact = (db, stores, mode, operation) => new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(stores, mode);
      const result = operation(transaction);
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    } catch (error) { reject(error); }
  });

  const readDraft = (db) => transact(db, "drafts", "readonly", (tx) => tx.objectStore("drafts").get("active"));
  const readWalks = (db) => transact(db, "walks", "readonly", (tx) => tx.objectStore("walks").getAll());
  const readDiagnosticEvents = (db, sessionId) => transact(db, "diagnosticEvents", "readonly", (tx) => tx.objectStore("diagnosticEvents").index("bySessionId").getAll(sessionId));
  const readDiagnostics = async (db, id) => {
    const [session, events] = await Promise.all([
      transact(db, "diagnostics", "readonly", (tx) => tx.objectStore("diagnostics").get(id)),
      readDiagnosticEvents(db, id)
    ]);
    const orderedEvents = (events || []).sort((a, b) => a.sequence - b.sequence);
    if (session) return { ...session, events: orderedEvents };
    return orderedEvents.length ? { id, formatVersion: 1, appVersion: "metadata unavailable", events: orderedEvents } : null;
  };
  const writeDiagnosticSession = (db, session) => {
    const { events, nextSequence, ...record } = session;
    return transact(db, "diagnostics", "readwrite", (tx) => tx.objectStore("diagnostics").put(record));
  };
  const writeDiagnosticEvent = (db, sessionId, event) => transact(db, "diagnosticEvents", "readwrite", (tx) => {
    return tx.objectStore("diagnosticEvents").put({ ...event, id: `${sessionId}:${event.sequence}`, sessionId });
  });
  const deleteSessionEvents = (tx, sessionId) => {
    const store = tx.objectStore("diagnosticEvents");
    const request = store.index("bySessionId").getAll(sessionId);
    request.onsuccess = () => request.result.forEach((event) => store.delete(event.id));
  };
  const deleteDiagnostics = (db, id) => transact(db, ["diagnostics", "diagnosticEvents"], "readwrite", (tx) => {
    tx.objectStore("diagnostics").delete(id);
    deleteSessionEvents(tx, id);
  });
  const deleteWalk = (db, id) => transact(db, ["walks", "diagnostics", "diagnosticEvents"], "readwrite", (tx) => {
    tx.objectStore("walks").delete(id);
    tx.objectStore("diagnostics").delete(id);
    deleteSessionEvents(tx, id);
  });
  const createDraft = (db, draft) => transact(db, "drafts", "readwrite", (tx) => tx.objectStore("drafts").add(draft));
  const writeDraft = (db, draft) => transact(db, "drafts", "readwrite", (tx) => tx.objectStore("drafts").put(draft));
  const deleteDraft = (db) => transact(db, ["drafts", "diagnostics", "diagnosticEvents"], "readwrite", (tx) => {
    tx.objectStore("drafts").delete("active");
    tx.objectStore("diagnostics").delete("active");
    deleteSessionEvents(tx, "active");
  });
  const completeWalk = (db, walk) => transact(db, ["walks", "drafts"], "readwrite", (tx) => {
    tx.objectStore("walks").add(walk);
    tx.objectStore("drafts").delete("active");
  });
  const completeDiagnostics = (db, walkId, diagnosticSession) => transact(db, ["diagnostics", "diagnosticEvents"], "readwrite", (tx) => {
    if (!diagnosticSession) return;

    const events = diagnosticSession.events || [];
    const record = { ...diagnosticSession };
    delete record.events;
    delete record.nextSequence;
    delete record.walkId;
    const completedRecord = { ...record, id: walkId, state: "completed", finishedAt: diagnosticSession.finishedAt };
    tx.objectStore("diagnostics").delete("active");
    tx.objectStore("diagnostics").put(completedRecord);
    const eventStore = tx.objectStore("diagnosticEvents");
    const request = eventStore.index("bySessionId").getAll("active");
    request.onsuccess = () => {
      const persisted = new Map(request.result.map((event) => [event.sequence, event]));
      for (const event of events) persisted.set(event.sequence, { ...persisted.get(event.sequence), ...event, id: persisted.get(event.sequence)?.id || `active:${event.sequence}` });
      for (const event of persisted.values()) {
        eventStore.delete(event.id);
        eventStore.put({ ...event, id: `${walkId}:${event.sequence}`, sessionId: walkId });
      }
    };
  });

  return { readDraft, readWalks, readDiagnostics, writeDiagnosticSession, writeDiagnosticEvent, deleteDiagnostics, deleteWalk, createDraft, writeDraft, deleteDraft, completeWalk, completeDiagnostics };
});
