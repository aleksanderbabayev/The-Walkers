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
  assert.match(appSource, /const closed = !retreated && Tracking\.canCloseTrack\(finishedPoints\);/);
  assert.match(appSource, /status: "retreated"/);
  assert.match(appSource, /diagnosticSession\.walkStatus = retreated \? "retreated" : "completed"/);

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
