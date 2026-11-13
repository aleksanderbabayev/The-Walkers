const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const browserPath = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find((candidate) => candidate && fs.existsSync(candidate));
assert.ok(browserPath, "Headless Chrome or Edge is required for mobile-layout-browser.test.js; set CHROME_PATH or install a supported browser.");

const waitFor = async (predicate, timeoutMs = 10000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for headless browser startup");
};

const createCdpClient = async (url) => {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method) {
      return new Promise((resolve) => {
        const methodListeners = listeners.get(method) || [];
        methodListeners.push((params) => {
          listeners.set(method, methodListeners.filter((listener) => listener !== methodListeners.at(-1)));
          resolve(params);
        });
        listeners.set(method, methodListeners);
      });
    },
    close() { socket.close(); }
  };
};

const scenarios = [
  { name: "waiting for GPS", state: { startup: true }, buttons: [] },
  { name: "startup GPS error", state: { startup: true, startupError: true }, buttons: ["locationStartupRetry"] },
  { name: "stabilizing GPS", state: { warmup: true }, buttons: ["abandonWalk"] },
  { name: "manual warm-up start", state: { warmup: true, manual: true }, buttons: ["manualWarmupStart", "abandonWalk"] },
  { name: "GPS retry after startup", state: { retry: true }, buttons: ["locationRetry"] },
  { name: "ready for territory capture", state: {}, buttons: ["start"] },
  { name: "expedition target selection", state: { expedition: true }, buttons: ["startExpedition"] },
  { name: "random expedition target selection", state: { expedition: true, random: true }, buttons: ["startExpedition", "generateTarget"] },
  { name: "active territory walk", state: { active: true }, buttons: ["finish", "abandonWalk"] },
  { name: "active expedition", state: { active: true, expedition: true }, buttons: ["abandonWalk"] },
  { name: "walk completed", state: {}, buttons: ["start"] }
];

test("mobile primary actions are actually visible over a full-height map at requested viewport sizes", async (t) => {
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "walkers-headless-"));
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const filePath = path.resolve(projectRoot, `.${pathname}`);
    if (!filePath.startsWith(`${projectRoot}${path.sep}`) || !fs.existsSync(filePath)) {
      response.writeHead(404).end();
      return;
    }
    const contentType = filePath.endsWith(".css") ? "text/css; charset=utf-8"
      : filePath.endsWith(".js") ? "text/javascript; charset=utf-8"
        : filePath.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    fs.createReadStream(filePath).pipe(response);
  });
  let chrome;
  let cdp;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const localPort = server.address().port;
    chrome = spawn(browserPath, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${profilePath}`, "about:blank"
    ], { stdio: "ignore", windowsHide: true });
    const activePortPath = path.join(profilePath, "DevToolsActivePort");
    const debugPort = await waitFor(() => fs.existsSync(activePortPath) && fs.readFileSync(activePortPath, "utf8").split(/\r?\n/)[0]);
    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
    const target = await targetResponse.json();
    cdp = await createCdpClient(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: ["https://*"] });
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv8l"
    });
    const loadComplete = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${localPort}/index.html` });
    await loadComplete;
    const setViewport = async (width, height) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: true
      });
      return evaluate(`({ width: innerWidth, height: innerHeight, mapHeight: document.querySelector(".mapFrame").getBoundingClientRect().height, tileMapHeight: document.getElementById("map").getBoundingClientRect().height, headerHeight: document.querySelector("header").getBoundingClientRect().height })`);
    };
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
      return result.result.value;
    };
    const appSource = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
    const htmlSource = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
    assert.match(await evaluate("navigator.userAgent"), /Android 14.*Chrome\/130/, "mobile browser test runs with an Android Chrome user agent");
    assert.match(htmlSource, /<meta name="app-version" content="0\.2\.29">/);
    assert.match(appSource, /\$\("appVersion"\)\.textContent = `v\$\{appVersion\}`/);
    assert.equal((htmlSource.match(/id="appVersion"/g) || []).length, 1, "only the header has a version element");
    await evaluate(`(() => { const version = document.getElementById("appVersion"); const value = document.querySelector('meta[name="app-version"]').content; version.textContent = "v" + value; version.setAttribute("aria-label", "Версия " + value); return true; })()`);
    await evaluate(fs.readFileSync(path.join(projectRoot, "map-follow.js"), "utf8"));
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await evaluate(`(() => {
      const styles = document.createElement("style");
      styles.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}.leaflet-control-container{position:absolute;inset:0;z-index:800;pointer-events:none}.leaflet-top,.leaflet-bottom{position:absolute;z-index:800;pointer-events:none}.leaflet-top{top:0}.leaflet-right{right:0}.leaflet-bottom{bottom:0}.leaflet-control{float:left;clear:both;margin:10px;pointer-events:auto}.leaflet-control-zoom a{display:block;box-sizing:border-box;text-align:center;background:#fff;border:1px solid #bbb;color:#333;text-decoration:none}.leaflet-control-rotate a{display:grid;place-items:center;box-sizing:border-box;background:#fff;border:1px solid #bbb;color:#333;text-decoration:none}";
      document.head.append(styles);
      const container = document.createElement("div");
      container.className = "leaflet-control-container";
      const topRight = document.createElement("div");
      topRight.className = "leaflet-top leaflet-right";
      const rotate = document.createElement("div");
      rotate.className = "leaflet-control leaflet-control-rotate";
      const compass = document.createElement("a");
      compass.href = "#north";
      compass.setAttribute("aria-label", "Повернуть карту на север");
      compass.textContent = "N";
      rotate.append(compass);
      topRight.append(rotate);
      const bottomRight = document.createElement("div");
      bottomRight.className = "leaflet-bottom leaflet-right";
      const zoom = document.createElement("div");
      zoom.className = "leaflet-control leaflet-control-zoom leaflet-bar";
      for (const [direction, label] of [["in", "Увеличить масштаб"], ["out", "Уменьшить масштаб"]]) {
        const button = document.createElement("a");
        button.href = "#zoom-" + direction;
        button.className = "leaflet-control-zoom-" + direction;
        button.setAttribute("role", "button");
        button.setAttribute("aria-label", label);
        button.textContent = direction === "in" ? "+" : "−";
        zoom.append(button);
      }
      bottomRight.append(zoom);
      container.append(topRight, bottomRight);
      document.getElementById("map").append(container);
      const zoomCorner = document.querySelector(".leaflet-bottom.leaflet-right");
      const zoomControl = document.querySelector(".leaflet-control-zoom");
      const walkPanel = document.querySelector(".panel");
      const updateZoomPosition = () => {
        const panelTop = walkPanel.getBoundingClientRect().top;
        const zoomBottom = zoomControl.getBoundingClientRect().bottom;
        const currentOffset = Number.parseFloat(getComputedStyle(zoomCorner).bottom) || 0;
        const targetBottom = panelTop - 8;
        zoomCorner.style.setProperty("--mobile-zoom-control-bottom", Math.max(0, currentOffset + zoomBottom - targetBottom) + "px");
      };
      new ResizeObserver(updateZoomPosition).observe(walkPanel);
      window.addEventListener("resize", updateZoomPosition);
      window.visualViewport?.addEventListener("resize", updateZoomPosition);
      updateZoomPosition();
      return true;
    })()`);

    const viewports = [[320, 568], [360, 640], [375, 667], [390, 844], [375, 500]];
    const stateScript = (state) => `(() => {
      const s = ${JSON.stringify(state)};
      const hide = (id, value) => { document.getElementById(id).hidden = value; };
      document.body.classList.toggle("expedition-mode", Boolean(s.expedition));
      document.querySelector(".status").classList.toggle("recording", Boolean(s.active));
      document.getElementById("statusTitle").textContent = s.warmup ? "Стабилизация GPS" : s.active ? (s.expedition ? "Идёт экспедиция" : "Идёт захват территории") : "Готовы к прогулке?";
      document.getElementById("locationStartupTitle").textContent = s.startupError ? "Геолокация недоступна" : "Определяем местоположение…";
      document.getElementById("locationStartupMessage").textContent = s.startupError ? "Проверьте GPS и повторите попытку." : "Получаем координаты GPS.";
      hide("locationStartupScreen", !s.startup);
      hide("locationStartupRetry", !s.startupError);
      hide("locationRetry", !s.retry || Boolean(s.startup));
      hide("modeSelector", Boolean(s.active || s.warmup));
      hide("expeditionSetup", !s.expedition || Boolean(s.active || s.warmup));
      hide("start", Boolean(s.expedition || s.active || s.warmup));
      hide("startExpedition", !s.expedition || Boolean(s.active || s.warmup));
      hide("finish", !s.active || Boolean(s.expedition));
      hide("abandonWalk", !s.active && !s.warmup);
      hide("manualWarmupStart", !s.manual);
      hide("randomTargetControls", !s.random);
      hide("generateTarget", !s.random);
      const notice = document.getElementById("locationNotice");
      notice.className = "location-notice is-" + (s.retry || s.startupError ? "unavailable" : s.startup || s.warmup ? "loading" : "ready");
      document.getElementById("locationNoticeTitle").textContent = s.retry || s.startupError ? "Геолокация недоступна" : s.startup || s.warmup ? "Определяем местоположение" : "Местоположение определено";
      document.getElementById("locationNoticeText").textContent = s.retry || s.startupError ? "GPS недоступен. Попробуйте снова." : "Ожидаем свежие координаты GPS.";
      for (const id of ["start", "startExpedition", "finish", "abandonWalk", "manualWarmupStart", "locationRetry", "locationStartupRetry"]) document.getElementById(id).disabled = false;
      return true;
    })()`;

    for (const [width, height] of viewports) {
      const initial = await setViewport(width, height);
      assert.equal(initial.width, width, `viewport width ${width}`);
      assert.equal(initial.height, height, `viewport height ${height}`);
      assert.ok(initial.mapHeight > 0, `${width}x${height}: map has a visible box`);
      assert.ok(Math.abs(initial.mapHeight - initial.tileMapHeight) < 1, `${width}x${height}: map tiles fill the full map container`);
      const baselineMapHeight = initial.mapHeight;
      for (const scenario of scenarios) {
        await evaluate(stateScript(scenario.state));
        await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const result = await evaluate(`(() => {
          const panel = document.querySelector(".panel").getBoundingClientRect();
          const startupScreen = document.getElementById("locationStartupScreen");
          const startupRect = startupScreen.getBoundingClientRect();
          const mapElement = document.querySelector(".mapFrame");
          const map = mapElement.getBoundingClientRect();
          const buttons = ${JSON.stringify(scenario.buttons)}.map((id) => {
            const element = document.getElementById(id);
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const host = element.closest(".location-access-card") || document.querySelector(".panel");
            const hostRect = host.getBoundingClientRect();
            return { id, hidden: element.hidden, displayed: style.display !== "none" && style.visibility !== "hidden", top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, hostTop: hostRect.top, hostBottom: hostRect.bottom };
          });
          const mapLocate = document.getElementById("locate").getBoundingClientRect();
          const zoomButtons = [...document.querySelectorAll(".leaflet-control-zoom a")].map((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return { label: element.getAttribute("aria-label"), text: element.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, displayed: getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden", hit: Boolean(hit && (hit === element || element.contains(hit))), hitTarget: hit?.className || hit?.tagName };
          });
          const compassRect = document.querySelector(".leaflet-control-rotate a").getBoundingClientRect();
          const modeButtons = [...document.querySelectorAll(".mode-selector button, .expeditionMethods button")].map((element) => {
            const rect = element.getBoundingClientRect();
            return { id: element.id, hidden: element.hidden, displayed: getComputedStyle(element).display !== "none", top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
          }).filter((button) => !button.hidden && button.displayed && button.width > 0 && button.height > 0);
          const probeX = 10;
          const probeY = document.querySelector("header").getBoundingClientRect().bottom + 10;
          const mapProbe = document.elementFromPoint(probeX, probeY);
          const startupWasHidden = startupScreen.hidden;
          startupScreen.hidden = true;
          const underlyingProbe = document.elementFromPoint(probeX, probeY);
          startupScreen.hidden = startupWasHidden;
          const getStackingLevel = (element) => {
            const zIndex = getComputedStyle(element).zIndex;
            return zIndex === "auto" ? 0 : Number(zIndex);
          };
          const brand = document.querySelector(".brand").getBoundingClientRect();
          const brandTitle = document.querySelector(".brandTitle").getBoundingClientRect();
          const headerActions = document.querySelector(".headerActions").getBoundingClientRect();
          const version = document.getElementById("appVersion");
          const versionRect = version.getBoundingClientRect();
          return { mapHeight: map.height, viewportHeight: innerHeight, scrollHeight: document.scrollingElement.scrollHeight, buttons, modeButtons, header: { brand: { left: brand.left, right: brand.right }, title: { left: brandTitle.left, right: brandTitle.right }, actions: { left: headerActions.left, right: headerActions.right }, version: { text: version.textContent, label: version.getAttribute("aria-label"), left: versionRect.left, right: versionRect.right, width: versionRect.width, height: versionRect.height, visible: getComputedStyle(version).display !== "none" && getComputedStyle(version).visibility !== "hidden" }, menuVersionCount: document.querySelectorAll(".utility-menu-panel .appVersion").length }, locate: { top: mapLocate.top, bottom: mapLocate.bottom, height: mapLocate.height, left: mapLocate.left, right: mapLocate.right }, zoomButtons, compass: { top: compassRect.top, bottom: compassRect.bottom, left: compassRect.left, right: compassRect.right }, panel: { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right }, startup: { hidden: startupScreen.hidden, top: startupRect.top, left: startupRect.left, right: startupRect.right, bottom: startupRect.bottom, background: getComputedStyle(startupScreen).backgroundColor, stackingLevel: getStackingLevel(startupScreen), mapStackingLevel: getStackingLevel(mapElement), probeIsBlocked: Boolean(mapProbe && startupScreen.contains(mapProbe)), probeReachesMap: Boolean(mapProbe && mapElement.contains(mapProbe)), underlyingProbeReachesMap: Boolean(underlyingProbe && mapElement.contains(underlyingProbe)) } };
        })()`);
        assert.ok(Math.abs(result.mapHeight - baselineMapHeight) < 1, `${width}x${height} ${scenario.name}: controls changed map height`);
        assert.ok(result.scrollHeight <= result.viewportHeight + 1, `${width}x${height} ${scenario.name}: page gained vertical scroll`);
        assert.equal(result.header.version.text, `v${htmlSource.match(/name="app-version" content="([^"]+)"/)[1]}`, `${width}x${height}: header version comes from app-version meta`);
        assert.equal(result.header.version.visible, true, `${width}x${height}: version remains visible`);
        assert.equal(result.header.menuVersionCount, 0, `${width}x${height}: menu has no duplicate version`);
        assert.ok(result.header.version.width > 0 && result.header.version.height > 0, `${width}x${height}: version has a visible box`);
        assert.ok(result.header.brand.right < result.header.actions.left, `${width}x${height}: brand and menu do not overlap`);
        assert.ok(result.header.version.left >= result.header.title.left && result.header.version.right <= result.header.title.right, `${width}x${height}: version stays inside the brand title`);
        if (scenario.state.startup) {
          assert.equal(result.startup.hidden, false, `${width}x${height} ${scenario.name}: startup gate is open`);
          assert.ok(result.startup.top <= 0 && result.startup.left <= 0 && result.startup.right >= width && result.startup.bottom >= height, `${width}x${height} ${scenario.name}: GPS gate covers the full screen`);
          assert.equal(result.startup.background, "rgb(247, 247, 242)", `${width}x${height} ${scenario.name}: GPS gate is opaque`);
          assert.ok(result.startup.stackingLevel > result.startup.mapStackingLevel, `${width}x${height} ${scenario.name}: GPS gate stacks above the map`);
          assert.equal(result.startup.probeIsBlocked, true, `${width}x${height} ${scenario.name}: hit-test lands on the GPS gate`);
          assert.equal(result.startup.underlyingProbeReachesMap, true, `${width}x${height} ${scenario.name}: the covered layer is the map`);
        } else {
          assert.equal(result.startup.hidden, true, `${width}x${height} ${scenario.name}: GPS gate closes after the first usable location`);
          assert.equal(result.startup.probeReachesMap, true, `${width}x${height} ${scenario.name}: map is visible after GPS gate closes`);
        }
        assert.ok(result.locate.top >= 0 && result.locate.bottom <= result.viewportHeight + 1 && result.locate.height >= 44, `${width}x${height} ${scenario.name}: map control is accessible`);
        if (!scenario.state.startup) {
          assert.equal(result.zoomButtons.length, 2, `${width}x${height} ${scenario.name}: both Leaflet zoom buttons are present`);
          assert.ok(Math.abs(result.zoomButtons.at(-1).bottom - (result.panel.top - 8)) < 1, `${width}x${height} ${scenario.name}: the zoom stack sits 8px above the current panel edge`);
          for (const zoomButton of result.zoomButtons) {
            assert.equal(zoomButton.displayed, true, `${width}x${height} ${scenario.name}: ${zoomButton.label} is displayed`);
            assert.equal(zoomButton.hit, true, `${width}x${height} ${scenario.name}: ${zoomButton.label} receives pointer hit-testing; target=${zoomButton.hitTarget}, rect=${zoomButton.left},${zoomButton.top},${zoomButton.width},${zoomButton.height}`);
            assert.ok(zoomButton.width >= 44 && zoomButton.height >= 44, `${width}x${height} ${scenario.name}: ${zoomButton.label} is at least 44x44 px`);
            assert.ok(zoomButton.left >= 0 && zoomButton.right <= width && zoomButton.top >= 0 && zoomButton.bottom <= height, `${width}x${height} ${scenario.name}: ${zoomButton.label} is inside the screen`);
            assert.ok(zoomButton.right >= width - 60, `${width}x${height} ${scenario.name}: ${zoomButton.label} is on the right side of the map`);
            assert.ok(zoomButton.bottom <= result.compass.top || zoomButton.top >= result.compass.bottom, `${width}x${height} ${scenario.name}: ${zoomButton.label} does not overlap the compass`);
            assert.ok(zoomButton.bottom <= result.locate.top || zoomButton.top >= result.locate.bottom || zoomButton.right <= result.locate.left || zoomButton.left >= result.locate.right, `${width}x${height} ${scenario.name}: ${zoomButton.label} does not overlap geolocation`);
            assert.ok(zoomButton.bottom <= result.panel.top || zoomButton.top >= result.panel.bottom || zoomButton.right <= result.panel.left || zoomButton.left >= result.panel.right, `${width}x${height} ${scenario.name}: ${zoomButton.label} does not overlap the walk panel`);
          }
        }
        for (const button of result.modeButtons) {
          assert.ok(button.height >= 44 && button.top >= 0 && button.bottom <= result.viewportHeight + 1, `${width}x${height} ${scenario.name}: #${button.id} mode control is visible and at least 44px high`);
        }
        for (const button of result.buttons) {
          assert.equal(button.hidden, false, `${width}x${height} ${scenario.name}: #${button.id} hidden attribute`);
          assert.equal(button.displayed, true, `${width}x${height} ${scenario.name}: #${button.id} display`);
          assert.ok(button.width > 0 && button.height >= 44, `${width}x${height} ${scenario.name}: #${button.id} touch target is ${button.width}x${button.height}`);
          assert.ok(button.top >= 0 && button.bottom <= result.viewportHeight + 1, `${width}x${height} ${scenario.name}: #${button.id} is outside the viewport`);
          assert.ok(button.top >= button.hostTop - 1 && button.bottom <= button.hostBottom + 1, `${width}x${height} ${scenario.name}: #${button.id} is clipped by its action container`);
        }
      }
      const fallbackStart = appSource.indexOf("const showDiagnosticsFallback = ") + "const showDiagnosticsFallback = ".length;
      const fallbackEnd = appSource.indexOf("\n  const copyDiagnosticReport", fallbackStart);
      const fallbackFactory = appSource.slice(fallbackStart, fallbackEnd).trim().replace(/;$/, "");
      assert.ok(fallbackFactory, "the browser check uses the production manual-copy fallback");
      for (const [width, height] of viewports) {
        await setViewport(width, height);
        const history = await evaluate(`(() => {
          const drawer = document.getElementById("walksDrawer");
          const backdrop = document.getElementById("walksBackdrop");
          const list = document.getElementById("routes");
          document.body.classList.add("walks-open");
          backdrop.hidden = false;
          list.replaceChildren();
          for (let index = 0; index < 12; index++) {
            const row = document.createElement("div"); row.className = "route";
            const icon = document.createElement("span"); icon.className = "routeIcon"; icon.textContent = "↗";
            const details = document.createElement("div");
            const title = document.createElement("strong"); title.textContent = "Маршрут " + index;
            const meta = document.createElement("small"); meta.textContent = "13 нояб. 2026 г. · 00:10:37 · 0,78 км · 80 точек";
            details.append(title, meta);
            const actions = document.createElement("div"); actions.className = "routeActions";
            const copy = document.createElement("button"); copy.className = "diagnosticsCopy"; copy.textContent = "Копировать диагностику";
            const remove = document.createElement("button"); remove.className = "routeDelete"; remove.textContent = "Удалить";
            actions.append(copy, remove); row.append(icon, details, actions); list.append(row);
          }
          list.scrollTop = 180;
          const copy = list.querySelector(".diagnosticsCopy"); copy.focus();
          const box = (element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; };
          const copyBox = box(copy), deleteBox = box(list.querySelector(".routeDelete"));
          const panelBox = box(drawer);
          const headerBox = box(document.querySelector("header"));
          const backdropColor = getComputedStyle(backdrop).backgroundColor;
          const panelColor = getComputedStyle(drawer).backgroundColor;
          const titleColor = getComputedStyle(drawer.querySelector(".savedHead")).color;
          const outsideTarget = document.elementFromPoint(8, headerBox.bottom + 8);
          const panelTarget = document.elementFromPoint(panelBox.left + panelBox.width / 2, panelBox.top + panelBox.height / 2);
          const beforeScroll = list.scrollTop;
          copy.addEventListener("click", () => { (${fallbackFactory})("Full diagnostics report"); });
          copy.click();
          const overlay = document.querySelector(".diagnosticsFallback");
          const reportPreserved = overlay?.querySelector("textarea").value === "Full diagnostics report";
          overlay?.querySelector("button:last-child").click();
          return { drawerVisible: getComputedStyle(drawer).visibility === "visible", drawerOpen: document.body.classList.contains("walks-open"), panelBox, backdropColor, panelColor, titleColor, outsideHitIsBackdrop: outsideTarget === backdrop, panelHitStaysInDrawer: drawer.contains(panelTarget), copyBox, deleteBox, scrollBefore: beforeScroll, scrollAfter: list.scrollTop, reportPreserved, overlayClosed: !document.querySelector(".diagnosticsFallback"), focusRestored: document.activeElement === copy, horizontalOverflow: drawer.scrollWidth > drawer.clientWidth || list.scrollWidth > list.clientWidth };
        })()`);
        assert.equal(history.drawerVisible, true, `${width}x${height}: history drawer is visible`);
        assert.equal(history.drawerOpen, true, `${width}x${height}: copy does not close history`);
        assert.equal(history.backdropColor, "rgba(0, 0, 0, 0)", `${width}x${height}: backdrop remains transparent`);
        assert.equal(history.outsideHitIsBackdrop, true, `${width}x${height}: outside taps still reach the closing backdrop`);
        assert.equal(history.panelHitStaysInDrawer, true, `${width}x${height}: drawer stays above the backdrop for interaction`);
        assert.equal(history.panelColor, "rgb(255, 255, 255)", `${width}x${height}: history panel stays opaque`);
        assert.ok(history.titleColor && history.panelBox.width <= width, `${width}x${height}: history panel fits the viewport`);
        assert.ok(history.copyBox.height >= 44 && history.deleteBox.height >= 44, `${width}x${height}: copy and delete controls meet 44px touch target`);
        assert.ok(history.copyBox.left >= 0 && history.copyBox.right <= width && history.deleteBox.left >= 0 && history.deleteBox.right <= width, `${width}x${height}: history actions stay inside the screen`);
        assert.ok(history.deleteBox.top >= history.copyBox.bottom + 7, `${width}x${height}: copy and delete controls have clear spacing`);
        assert.equal(history.horizontalOverflow, false, `${width}x${height}: history has no horizontal overflow`);
        assert.equal(history.scrollAfter, history.scrollBefore, `${width}x${height}: manual fallback preserves history scroll position`);
        assert.equal(history.reportPreserved, true, `${width}x${height}: full diagnostics remain available for manual copy`);
        assert.equal(history.overlayClosed, true, `${width}x${height}: manual-copy window closes`);
        assert.equal(history.focusRestored, true, `${width}x${height}: closing fallback returns focus to the copy action`);
        await evaluate(`(() => { document.body.classList.remove("walks-open"); document.getElementById("walksBackdrop").hidden = true; document.getElementById("routes").replaceChildren(); })()`);
      }
      const diagnosticText = JSON.stringify({ events: [], finalAcceptedRoute: Array.from({ length: 80 }, (_, index) => ({ latitude: 48 + index / 10000, longitude: 17, timestamp: index })) }, null, 2);
      for (const [width, height] of viewports) {
        await setViewport(width, height);
        const fallback = await evaluate(`(() => {
          (${fallbackFactory})(${JSON.stringify(diagnosticText)});
          const overlay = document.querySelector(".diagnosticsFallback");
          const card = overlay.querySelector(".diagnosticsFallbackCard");
          const textarea = overlay.querySelector("textarea");
          const selectButton = [...overlay.querySelectorAll("button")].find((button) => button.textContent === "Выделить весь текст");
          const closeButton = [...overlay.querySelectorAll("button")].find((button) => button.textContent === "Закрыть");
          const cardRect = card.getBoundingClientRect(), textareaRect = textarea.getBoundingClientRect();
          selectButton.click();
          const result = {
            textMatches: textarea.value === ${JSON.stringify(diagnosticText)},
            selectionCoversText: textarea.selectionStart === 0 && textarea.selectionEnd === textarea.value.length,
            card: { left: cardRect.left, right: cardRect.right, top: cardRect.top, bottom: cardRect.bottom },
            textarea: { width: textareaRect.width, height: textareaRect.height },
            buttons: [...overlay.querySelectorAll("button")].map((button) => ({ text: button.textContent, height: button.getBoundingClientRect().height }))
          };
          closeButton.click();
          return { ...result, removed: !document.querySelector(".diagnosticsFallback") };
        })()`);
        assert.equal(fallback.textMatches, true, `${width}x${height}: the complete report remains in the manual-copy field`);
        assert.equal(fallback.selectionCoversText, true, `${width}x${height}: the manual select-all action selects the full report`);
        assert.ok(fallback.card.left >= 0 && fallback.card.right <= width, `${width}x${height}: the fallback card fits the phone width`);
        assert.ok(fallback.card.top >= 0 && fallback.card.bottom <= height, `${width}x${height}: the fallback card fits the phone height`);
        assert.ok(fallback.textarea.width > 0 && fallback.textarea.height >= 180, `${width}x${height}: the report area remains visible`);
        assert.ok(fallback.buttons.every((button) => button.height >= 44), `${width}x${height}: manual-copy actions have touch-sized buttons`);
        assert.equal(fallback.removed, true, `${width}x${height}: the dialog can be dismissed`);
      }
      await setViewport(320, 568);
      await evaluate(fs.readFileSync(path.join(projectRoot, "location-diagnostics.js"), "utf8"));
      await evaluate(fs.readFileSync(path.join(projectRoot, "utility-menu.js"), "utf8"));
      await evaluate(`(() => {
        const report = { operatingSystem: { name: "Android", version: "14" }, browser: { name: "Chrome", version: "130" }, geolocationApi: "available", permissionsApi: "available", geolocationPermission: "granted", operatingSystemLocationPermission: "unknown", siteLocationPermission: "granted", lastRequest: { result: "success", checkedAt: Date.now() }, checkedAt: Date.now(), userAgent: navigator.userAgent };
        const ui = window.WalkLocationDiagnostics.createUi({ documentLike: document, navigatorLike: { clipboard: null }, getReport: () => report, fields: document.getElementById("locationDiagnosticsFields"), status: document.getElementById("locationDiagnosticsStatus"), fallback: document.getElementById("locationDiagnosticsFallback") });
        ui.render();
        document.getElementById("copyLocationDiagnostics").addEventListener("click", () => ui.copy());
        window.utilityMenuActions = [];
        window.utilityMenuController = window.WalkUtilityMenu.bind({
          menu: document.getElementById("utilityMenu"), dialog: document.getElementById("locationDiagnosticsView"),
          onOpen: () => { document.body.classList.remove("walks-open"); },
          onAction: (action) => {
            utilityMenuActions.push(action);
            if (action === "history") { document.body.classList.add("walks-open"); document.getElementById("walksClose").focus(); }
            if (action === "diagnostics") document.getElementById("locationDiagnosticsView").showModal();
          }
        });
        document.getElementById("locationDiagnosticsClose").addEventListener("click", () => document.getElementById("locationDiagnosticsView").close());
        document.getElementById("locationStartupScreen").hidden = true;
        return true;
      })()`);
      const touchOutside = async (selector) => evaluate(`(() => {
        const menu = document.getElementById("utilityMenu"); menu.open = true;
        const target = document.querySelector(${JSON.stringify(selector)});
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return menu.open;
      })()`);
      assert.equal(await touchOutside("#map"), false, "touching the map closes the menu");
      assert.equal(await touchOutside(".panel"), false, "touching the walk controls closes the menu");
      const musicSelection = await evaluate(`(() => {
        const menu = document.getElementById("utilityMenu"); menu.open = true;
        document.getElementById("musicToggle").click();
        return { open: menu.open, action: utilityMenuActions.at(-1) };
      })()`);
      assert.deepEqual(musicSelection, { open: false, action: "music" }, "music selection runs and closes the menu");
      const activeDiagnosticsSelection = await evaluate(`(() => {
        const menu = document.getElementById("utilityMenu"), button = document.getElementById("copyActiveDiagnostics");
        button.hidden = false; menu.open = true; button.click();
        return { open: menu.open, itemRemainsAvailable: button.hidden === false };
      })()`);
      assert.deepEqual(activeDiagnosticsSelection, { open: false, itemRemainsAvailable: true }, "copying active diagnostics also closes the main menu");
      const historySelection = await evaluate(`(() => {
        const menu = document.getElementById("utilityMenu"); menu.open = true;
        document.getElementById("walksToggle").click();
        return { open: menu.open, action: utilityMenuActions.at(-1), historyOpen: document.body.classList.contains("walks-open"), focus: document.activeElement.id };
      })()`);
      assert.deepEqual(historySelection, { open: false, action: "history", historyOpen: true, focus: "walksClose" }, "history opens and receives focus after the menu closes");
      await evaluate(`new Promise((resolve) => setTimeout(resolve, 0))`);
      const historyDismissed = await evaluate(`(() => {
        const menu = document.getElementById("utilityMenu"); menu.querySelector("summary").click();
        return { menuOpen: menu.open, historyOpen: document.body.classList.contains("walks-open") };
      })()`);
      assert.deepEqual(historyDismissed, { menuOpen: true, historyOpen: false }, "opening the menu dismisses the history drawer");
      const diagnosticSelection = await evaluate(`(() => {
        const menu = document.getElementById("utilityMenu"); menu.open = true;
        document.getElementById("openLocationDiagnostics").click();
        const dialog = document.getElementById("locationDiagnosticsView");
        return { menuOpen: menu.open, dialogOpen: dialog.open, action: utilityMenuActions.at(-1), focus: document.activeElement.id };
      })()`);
      assert.deepEqual(diagnosticSelection, { menuOpen: false, dialogOpen: true, action: "diagnostics", focus: "locationDiagnosticsClose" }, "diagnostics remain in a separate focused dialog");
      await evaluate(`document.getElementById("copyLocationDiagnostics").click()`);
      await evaluate(`new Promise((resolve) => setTimeout(resolve, 0))`);
      const copiedDiagnostics = await evaluate(`(() => ({ dialogOpen: document.getElementById("locationDiagnosticsView").open, fallbackVisible: !document.getElementById("locationDiagnosticsFallback").hidden, fallbackHasUserAgent: document.getElementById("locationDiagnosticsFallback").value.includes("Android") }))()`);
      assert.deepEqual(copiedDiagnostics, { dialogOpen: true, fallbackVisible: true, fallbackHasUserAgent: true }, "diagnostic copy still works after the main menu closes");
      const escapeDialog = await evaluate(`(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await new Promise((resolve) => setTimeout(resolve, 50)); return { open: document.getElementById("locationDiagnosticsView").open, focus: document.activeElement.tagName === "SUMMARY", activeId: document.activeElement.id, activeTag: document.activeElement.tagName }; })()`);
      assert.equal(escapeDialog.open, false, "Escape closes diagnostics");
      assert.equal(escapeDialog.focus, true, `Escape restores focus to the menu trigger (${escapeDialog.activeTag}#${escapeDialog.activeId})`);
      const escapeMenu = await evaluate(`(() => {
        const menu = document.getElementById("utilityMenu"); menu.open = true;
        document.getElementById("musicToggle").focus();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        return { open: menu.open, focus: document.activeElement.tagName === "SUMMARY" };
      })()`);
      assert.deepEqual(escapeMenu, { open: false, focus: true }, "Escape closes the menu and returns keyboard focus");
      const repeatedSummary = await evaluate(`(() => {
        const menu = document.getElementById("utilityMenu"), summary = menu.querySelector("summary");
        summary.click(); const opened = menu.open; summary.click();
        return { opened, closed: !menu.open };
      })()`);
      assert.deepEqual(repeatedSummary, { opened: true, closed: true }, "tapping the menu trigger again closes it");
      const markerChecks = await evaluate(`(() => {
        const mapElement = document.getElementById("map");
        const panel = document.querySelector(".panel");
        const marker = document.createElement("div");
        marker.setAttribute("aria-label", "Browser GPS marker position probe");
        marker.style.cssText = "position:absolute;width:16px;height:16px;border:3px solid white;border-radius:50%;background:#2877df;transform:translate(-50%,-50%);z-index:900;pointer-events:none";
        mapElement.append(marker);
        let markerX = mapElement.clientWidth / 2, markerY = mapElement.clientHeight / 2;
        const setMarkerPoint = () => { marker.style.left = markerX + "px"; marker.style.top = markerY + "px"; };
        setMarkerPoint();
        class Point {
          constructor(x, y) { this.x = x; this.y = y; }
          subtract(other) { return new Point(this.x - other.x, this.y - other.y); }
          divideBy(value) { return new Point(this.x / value, this.y / value); }
        }
        const map = {
          zoom: 15,
          bearing: 37,
          on() {}, off() {},
          getSize: () => new Point(mapElement.clientWidth, mapElement.clientHeight),
          latLngToContainerPoint: () => new Point(markerX, markerY),
          containerPointToLayerPoint(point) {
            const radians = -map.bearing * Math.PI / 180;
            const dx = point.x - mapElement.clientWidth / 2, dy = point.y - mapElement.clientHeight / 2;
            return new Point(dx * Math.cos(radians) - dy * Math.sin(radians), dx * Math.sin(radians) + dy * Math.cos(radians));
          },
          panBy(offset) {
            const radians = map.bearing * Math.PI / 180;
            const dx = offset.x * Math.cos(radians) - offset.y * Math.sin(radians);
            const dy = offset.x * Math.sin(radians) + offset.y * Math.cos(radians);
            markerX -= dx; markerY -= dy; setMarkerPoint();
          }
        };
        const follow = window.WalkMapFollow.createMapFollow({
          map,
          storage: null,
          getTargetPoint: () => window.WalkMapFollow.getVisibleMapCenter({
            mapElement,
            panelElement: panel,
            mobile: matchMedia("(max-width: 760px)").matches,
            createPoint: (x, y) => new Point(x, y)
          })
        });
        follow.setEnabled(true);
        const checks = [];
        for (const expedition of [false, true]) {
          document.body.classList.toggle("expedition-mode", expedition);
          for (const panelHeight of [Math.max(140, Math.round(innerHeight * .28)), Math.max(170, Math.round(innerHeight * .4))]) {
            panel.style.height = panelHeight + "px";
            follow.centerOn({ lat: 48.9, lng: 21.2 });
            const mapRect = mapElement.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();
            const markerRect = marker.getBoundingClientRect();
            const expected = { x: mapRect.left + mapRect.width / 2, y: (mapRect.top + Math.min(mapRect.bottom, Math.max(mapRect.top, panelRect.top))) / 2 };
            const actual = { x: markerRect.left + markerRect.width / 2, y: markerRect.top + markerRect.height / 2 };
            checks.push({ mode: expedition ? "expedition" : "territory", panelHeight: Math.round(panelRect.height), actual, expected, zoom: map.zoom, bearing: map.bearing });
          }
        }
        panel.style.removeProperty("height");
        marker.remove();
        follow.dispose();
        return checks;
      })()`);
      for (const check of markerChecks) {
        assert.ok(Math.abs(check.actual.x - check.expected.x) <= 1, `${width}x${height} ${check.mode}: GPS marker x=${check.actual.x.toFixed(1)} expected ${check.expected.x.toFixed(1)}`);
        assert.ok(Math.abs(check.actual.y - check.expected.y) <= 1, `${width}x${height} ${check.mode} with ${check.panelHeight}px panel: GPS marker y=${check.actual.y.toFixed(1)} expected ${check.expected.y.toFixed(1)}`);
        assert.equal(check.zoom, 15, `${width}x${height} ${check.mode}: zoom is preserved`);
        assert.equal(check.bearing, 37, `${width}x${height} ${check.mode}: bearing is preserved`);
      }
      await evaluate(stateScript({ active: true }));
      const territoryFitChecks = await evaluate(`(() => {
        const mapElement = document.getElementById("map");
        const panel = document.querySelector(".panel");
        const checks = [];
        for (const fraction of [.28, .4]) {
          panel.style.height = Math.round(innerHeight * fraction) + "px";
          const mapRect = mapElement.getBoundingClientRect();
          const panelRect = panel.getBoundingClientRect();
          const options = window.WalkMapFollow.getVisibleMapFitPadding({
            mapElement,
            panelElement: panel,
            mobile: matchMedia("(max-width: 760px)").matches,
            padding: 16
          });
          const width = mapElement.clientWidth, height = mapElement.clientHeight;
          const [leftPad, topPad] = options.paddingTopLeft;
          const [rightPad, bottomPad] = options.paddingBottomRight;
          const availableWidth = width - leftPad - rightPad;
          const availableHeight = height - topPad - bottomPad;
          const bounds = { width: 420, height: 240 };
          const scale = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
          const center = { x: (leftPad + width - rightPad) / 2, y: (topPad + height - bottomPad) / 2 };
          const polygon = {
            left: mapRect.left + center.x - bounds.width * scale / 2,
            right: mapRect.left + center.x + bounds.width * scale / 2,
            top: mapRect.top + center.y - bounds.height * scale / 2,
            bottom: mapRect.top + center.y + bounds.height * scale / 2
          };
          checks.push({
            panelHeight: panelRect.height,
            polygon,
            target: { x: mapRect.left + width / 2, y: mapRect.top + (Math.min(mapRect.bottom, panelRect.top) - mapRect.top) / 2 },
            visible: { left: mapRect.left + 16, right: mapRect.right - 16, top: mapRect.top + 16, bottom: panelRect.top - 16 },
            scale,
            maxZoom: 16
          });
        }
        panel.style.removeProperty("height");
        return checks;
      })()`);
      for (const check of territoryFitChecks) {
        const center = { x: (check.polygon.left + check.polygon.right) / 2, y: (check.polygon.top + check.polygon.bottom) / 2 };
        assert.ok(Math.abs(center.x - check.target.x) <= 1, `${width}x${height} territory x center ${center.x.toFixed(1)} matches available-area center ${check.target.x.toFixed(1)}`);
        assert.ok(Math.abs(center.y - check.target.y) <= 1, `${width}x${height} territory y center ${center.y.toFixed(1)} matches above-panel center ${check.target.y.toFixed(1)}`);
        assert.ok(check.polygon.left >= check.visible.left - 1 && check.polygon.right <= check.visible.right + 1, `${width}x${height} territory remains horizontally visible`);
        assert.ok(check.polygon.top >= check.visible.top - 1 && check.polygon.bottom <= check.visible.bottom + 1, `${width}x${height} territory remains above the panel`);
        assert.ok(check.scale > 0, `${width}x${height} territory receives a useful fit scale`);
        assert.equal(check.maxZoom, 16, `${width}x${height} existing maximum zoom is preserved`);
      }
      t.diagnostic(`${width}x${height}: map ${baselineMapHeight}px; ${scenarios.length} UI states; GPS marker centered above panel; captured territory fits and centers above two measured panel heights`);
    }
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      platform: "Win32"
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, screenWidth: 1280, screenHeight: 800, deviceScaleFactor: 1, mobile: false });
    const desktopOutsideClick = await evaluate(`(() => {
      const menu = document.getElementById("utilityMenu"); menu.open = true;
      const target = document.getElementById("map");
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return { open: menu.open, userAgent: navigator.userAgent };
    })()`);
    assert.equal(desktopOutsideClick.open, false, "desktop map clicks close the utility menu too");
    assert.match(desktopOutsideClick.userAgent, /Windows NT 10\.0.*Chrome\/130/);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill();
      await new Promise((resolve) => chrome.once("exit", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
});
