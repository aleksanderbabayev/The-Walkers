const test = require("node:test");
const assert = require("node:assert/strict");
const Diagnostics = require("../location-diagnostics.js");

const iosSafariUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

test("diagnostics identifies available platform and browser versions from common mobile user agents", () => {
  const ios = Diagnostics.createReport({
    navigatorLike: { userAgent: iosSafariUa, geolocation: { getCurrentPosition() {} }, permissions: { query() {} } },
    permissionState: "prompt", checkedAt: 1_800_000_000_000
  });
  assert.deepEqual(ios.operatingSystem, { name: "iOS", version: "17.5" });
  assert.deepEqual(ios.browser, { name: "Safari", version: "17.5" });
  assert.equal(ios.geolocationApi, "available");
  assert.equal(ios.permissionsApi, "available");
  assert.equal(ios.geolocationPermission, "prompt");

  const android = Diagnostics.createReport({
    navigatorLike: { userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36" },
    permissionState: "unsupported"
  });
  assert.deepEqual(android.operatingSystem, { name: "Android", version: "14" });
  assert.deepEqual(android.browser, { name: "Chrome", version: "128.0.0.0" });

  assert.deepEqual(Diagnostics.getPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5), {
    name: "iPadOS", version: null
  });
});

test("unsupported and unknown permission APIs stay distinct from an explicit denial", () => {
  const unsupported = Diagnostics.createReport({
    navigatorLike: { userAgent: "Example/1.0" }, permissionState: "denied"
  });
  assert.equal(unsupported.geolocationApi, "unsupported");
  assert.equal(unsupported.permissionsApi, "unsupported");
  assert.equal(unsupported.geolocationPermission, "unsupported");

  const unknown = Diagnostics.createReport({
    navigatorLike: { userAgent: "Example/1.0", permissions: { query() {} } }, permissionState: "unknown"
  });
  assert.equal(unknown.geolocationPermission, "unknown");

  const denied = Diagnostics.createReport({
    navigatorLike: { userAgent: "Example/1.0", permissions: { query() {} } }, permissionState: "denied"
  });
  assert.equal(denied.geolocationPermission, "denied");
  assert.equal(denied.operatingSystemLocationPermission, "Не определяется");
  assert.equal(denied.siteLocationPermission, "Не определяется отдельно");
});

test("diagnostic request results are constrained to explicit geolocation outcomes", () => {
  const navigatorLike = { geolocation: { getCurrentPosition() {} } };
  const outcomes = ["success", "PERMISSION_DENIED", "POSITION_UNAVAILABLE", "TIMEOUT"];
  for (const result of outcomes) {
    assert.equal(Diagnostics.createReport({ navigatorLike, lastRequest: { result, checkedAt: 10 } }).lastRequest.result, result);
  }
  assert.equal(Diagnostics.createReport({ navigatorLike }).lastRequest.result, "none");
  assert.equal(Diagnostics.createReport({ navigatorLike, lastRequest: { result: "coordinates" } }).lastRequest.result, "unknown");
});

test("compact diagnostic JSON contains only technical fields and never includes coordinates", () => {
  const report = Diagnostics.createReport({
    appVersion: "0.1.64", permissionState: "granted", checkedAt: 1_800_000_000_000,
    lastRequest: { result: "success", checkedAt: 1_799_999_999_000 },
    navigatorLike: {
      userAgent: iosSafariUa, platform: "iPhone", geolocation: { getCurrentPosition() {} },
      permissions: { query() {} }, latitude: 48.9, longitude: 21.2
    }
  });
  const json = JSON.stringify(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.appVersion, "0.1.64");
  assert.equal(parsed.lastRequest.result, "success");
  assert.equal(parsed.lastRequest.checkedAt, new Date(1_799_999_999_000).toISOString());
  assert.equal(parsed.userAgent, iosSafariUa);
  assert.equal(parsed.operatingSystemLocationPermission, "Не определяется");
  assert.equal(parsed.siteLocationPermission, "Не определяется отдельно");
  assert.equal("latitude" in parsed, false);
  assert.equal("longitude" in parsed, false);
  assert.doesNotMatch(json, /48\.9|21\.2/);
});

test("shared diagnostics UI renders details and copies with a selectable fallback", async () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const bootstrap = fs.readFileSync(require.resolve("../location-bootstrap.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
  assert.match(html, /<details id="locationDiagnostics" class="location-diagnostics">/);
  assert.match(html, /id="locationDiagnosticsFallback"[^>]*readonly hidden/);
  assert.match(app, /\$\("copyLocationDiagnostics"\)\.addEventListener\("click", \(\) => diagnosticsUi\.copy\(\)\)/);
  assert.match(bootstrap, /\$\("copyLocationDiagnostics"\)\.addEventListener\("click", \(\) => diagnosticsUi\.copy\(\)\)/);
  assert.match(app, /\$\("locationDiagnostics"\)\.addEventListener\("toggle"/);

  const elements = () => ({
    hidden: true, value: "", textContent: "", children: [], focused: false, selected: false,
    replaceChildren(...children) { this.children = children; },
    focus() { this.focused = true; }, select() { this.selected = true; },
    setSelectionRange(start, end) { this.selection = [start, end]; }
  });
  const fields = elements(), status = elements(), fallback = elements();
  const view = Diagnostics.createUi({
    documentLike: { createElement: (tag) => ({ tag, textContent: "" }) },
    navigatorLike: { clipboard: { writeText: async () => {} } },
    getReport: () => Diagnostics.createReport({
      navigatorLike: { permissions: { query() {} } }, permissionState: "denied"
    }),
    fields, status, fallback
  });
  view.render();
  assert.equal(fields.children.length, 22);
  assert.ok(fields.children.some((item) => item.textContent === "Запрещено (denied)"));
  await view.copy();
  assert.equal(status.textContent, "Диагностика скопирована.");

  const fallbackFields = elements(), fallbackStatus = elements(), textArea = elements();
  const fallbackView = Diagnostics.createUi({
    documentLike: { createElement: (tag) => ({ tag, textContent: "" }) },
    navigatorLike: { clipboard: { writeText: async () => { throw new Error("clipboard unavailable"); } } },
    getReport: () => Diagnostics.createReport({
      navigatorLike: { permissions: { query() {} } }, permissionState: "prompt"
    }),
    fields: fallbackFields, status: fallbackStatus, fallback: textArea
  });
  await fallbackView.copy();
  assert.equal(textArea.hidden, false);
  assert.equal(textArea.focused, true);
  assert.equal(textArea.selected, true);
  assert.match(textArea.value, /"geolocationPermission":"prompt"/);
});
