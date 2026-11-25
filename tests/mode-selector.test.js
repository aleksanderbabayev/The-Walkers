const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const app = fs.readFileSync(require.resolve("../app.js"), "utf8");

test("one UI update hides mode selection throughout startup, recording, restore, and retreat", () => {
  const updateModeSelection = app.slice(
    app.indexOf("const updateModeSelection = () =>"),
    app.indexOf("const stopStopwatch =")
  );
  assert.match(updateModeSelection, /recordingActive\s*\|\|\s*warmingUp\s*\|\|\s*starting\s*\|\|\s*cancelling/);
  assert.match(updateModeSelection, /\$\("modeSelector"\)\.hidden\s*=\s*inProgress/);

  const setRecording = app.slice(app.indexOf("const setRecording = (active) =>"), app.indexOf("const refreshManualWarmupStart"));
  assert.match(setRecording, /updateModeSelection\(\)/);

  const restoreDraft = app.slice(app.indexOf("starting = true;", app.indexOf("const draft = await WalkStorage.readDraft")), app.indexOf("let restoredDiagnostics = null;"));
  assert.match(restoreDraft, /updateModeSelection\(\)/);
  assert.doesNotMatch(restoreDraft, /await\s/, "restoration hides the selector before its next asynchronous wait");
  assert.match(app, /finishing\s*=\s*false;\s*setRecording\(false\)/,
    "finishing returns through the common UI state updater");
});
