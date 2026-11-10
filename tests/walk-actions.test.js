const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Actions = require("../walk-actions.js");
const Tracking = require("../tracking-core.js");

class Button extends EventTarget {
  click() { this.dispatchEvent(new Event("click")); }
}

test("Finish and Retreat button dispatch call their actions without passing the event", () => {
  const appSource = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(appSource, /Actions\.bindClick\(\$\("finish"\), \(\) => finishWalk\(\)\);/);
  assert.match(appSource, /await finishWalk\(true\);/);
  assert.match(appSource, /const closed = walkMode === "territory" && !retreated && Tracking\.canCloseTrack\(finishedPoints\);/);
  assert.match(appSource, /status: "retreated"/);
  assert.match(appSource, /diagnosticSession\.walkStatus = retreated \? "retreated" : "completed"/);
  const finishImplementation = appSource.slice(appSource.indexOf("const finishWalk = async"), appSource.indexOf('$("start").addEventListener'));
  const captureGuard = finishImplementation.indexOf("!Tracking.evaluateTerritoryCapture(initialRouteBuffer.pending ? [] : points, capturePosition).eligible");
  assert.ok(captureGuard >= 0, "territory finish has a last-moment eligibility check");
  assert.ok(captureGuard < finishImplementation.indexOf("recordDiagnosticEvent"), "an ineligible capture returns before recording completion or stopping GPS");
  assert.match(finishImplementation, /if \(!retreated && walkMode === "territory"[\s\S]*?updateCaptureAvailability\(\);\s*return;/);
  assert.match(appSource, /const updateCaptureAvailability = \(\) => \{[\s\S]*?Tracking\.evaluateTerritoryCapture\(routePoints, capturePosition\)[\s\S]*?\$\("finish"\)\.disabled = !canCapture/);
  assert.match(appSource, /if \(recordingActive && activeMode === "territory"\) setCapturePosition\(null\);[\s\S]*?const processedAt = Date\.now\(\)/);
  assert.match(appSource, /if \(activeMode === "territory"\) setCapturePosition\(result\.point\);\s*rememberLocation\(result\.point\)/);
  const positionProcessing = appSource.slice(appSource.indexOf("const processPosition"), appSource.indexOf("const receivePosition"));
  assert.ok(positionProcessing.indexOf("if (!result.accepted) {") < positionProcessing.indexOf("setCapturePosition(result.point)"), "rejected measurements cannot update the finish distance");
  assert.match(appSource, /latestLocation = null;\s*if \(recordingActive && activeMode === "territory"\) setCapturePosition\(null\);\s*updateLocateButton\("error"\)/);
  assert.match(appSource, /points = draftPoints;\s*initialRouteBuffer\.restore\(draftInitialBuffer\);\s*setCapturePosition\(null\)/);

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

test("a successful capture focuses only its new polygon and caps the zoom", () => {
  const appSource = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(appSource, /const redrawSaved = async \(\{ focusWalkId = null \} = \{\}\)/);
  assert.match(appSource, /if \(walk\.id === focusWalkId && walk\.closed && !retreated\) focusedTerritory = layers\[0\] \|\| null;/);
  assert.match(appSource, /map\.fitBounds\(focusedTerritory\.getBounds\(\), \{ padding: \[16, 16\], maxZoom: 16 \}\);/);
  assert.match(appSource, /redrawSaved\(\{ focusWalkId: closed \? walk\.id : null \}\)/);
  assert.doesNotMatch(appSource, /fitAll|featureGroup\(savedLayers\)/);
  assert.match(appSource, /await redrawSaved\(\);/);
});
