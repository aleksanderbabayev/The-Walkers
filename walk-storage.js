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
  const createDraft = (db, draft) => transact(db, "drafts", "readwrite", (tx) => tx.objectStore("drafts").add(draft));
  const writeDraft = (db, draft) => transact(db, "drafts", "readwrite", (tx) => tx.objectStore("drafts").put(draft));
  const deleteDraft = (db) => transact(db, "drafts", "readwrite", (tx) => tx.objectStore("drafts").delete("active"));
  const completeWalk = (db, walk) => transact(db, ["walks", "drafts"], "readwrite", (tx) => {
    tx.objectStore("walks").add(walk);
    tx.objectStore("drafts").delete("active");
  });

  return { readDraft, readWalks, createDraft, writeDraft, deleteDraft, completeWalk };
});
