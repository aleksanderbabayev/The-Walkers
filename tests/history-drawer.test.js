const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("history drawer closes from its close button, outside tap, and Escape", () => {
  assert.match(app, /\$\("walksClose"\)\.addEventListener\("click", \(\) => setWalksDrawerOpen\(false, true\)\)/);
  assert.match(app, /\$\("walksBackdrop"\)\.addEventListener\("click", \(\) => setWalksDrawerOpen\(false, true\)\)/);
  assert.match(app, /document\.addEventListener\("pointerdown", \(event\) => \{/);
  assert.match(app, /\$\("walksDrawer"\)\.contains\(event\.target\)[\s\S]*?setWalksDrawerOpen\(false, true\);/);
  assert.match(app, /event\.target\.closest\("\.diagnosticsFallback"\)/, "fallback overlay interaction keeps history open");
  assert.match(app, /event\.key === "Escape" && document\.body\.classList\.contains\("walks-open"\)\) setWalksDrawerOpen\(false, true\)/);
});

test("copy diagnostics returns before delete handling and leaves drawer/list state alone", () => {
  const routesStart = app.indexOf('$("routes").addEventListener("click", async (event) => {');
  const handlerEnd = app.indexOf('\n  const beginRecordingAt', routesStart);
  assert.ok(routesStart >= 0 && handlerEnd > routesStart);
  const handler = app.slice(routesStart, handlerEnd);
  const copyBranchEnd = handler.indexOf('    const button = event.target.closest("button[data-walk-id]");');
  const copyBranch = handler.slice(0, copyBranchEnd);
  assert.ok(copyBranchEnd > 0);
  assert.match(copyBranch, /await copyCompletedDiagnostics\(walk, copyButton\)/);
  assert.match(copyBranch, /\n      return;/);
  assert.doesNotMatch(copyBranch, /setWalksDrawerOpen|redrawSaved|replaceChildren/);
});
