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
  { name: "territory recovery required", state: { active: true, recovery: true }, buttons: ["abandonWalk"] },
  { name: "expedition recovery required", state: { active: true, expedition: true, recovery: true }, buttons: ["abandonWalk"] },
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
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
      return result.result.value;
    };
    const appSource = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
    const htmlSource = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
    const recoveryCheckpointSvg = appSource.match(/const recoveryCheckpointIcon = L\.divIcon\(\{[\s\S]*?html: '(<svg[\s\S]*?<\/svg>)'/)?.[1];
    assert.ok(recoveryCheckpointSvg, "browser check uses the production recovery checkpoint SVG");
    const routeStartSvg = appSource.match(/const updateRouteStartMarker = \(point\) => \{[\s\S]*?html: '(<svg class="route-start-flag"[\s\S]*?<\/svg>)'/)?.[1];
    assert.ok(routeStartSvg, "browser check uses the production territory start flag SVG");
    assert.match(await evaluate("navigator.userAgent"), /Android 14.*Chrome\/130/, "mobile browser test runs with an Android Chrome user agent");
    assert.match(htmlSource, /<meta name="app-version" content="0\.2\.50">/);
    assert.match(appSource, /\$\("appVersion"\)\.textContent = `v\$\{appVersion\}`/);
    assert.equal((htmlSource.match(/id="appVersion"/g) || []).length, 1, "only the header has a version element");
    await evaluate(`(() => { const version = document.getElementById("appVersion"); const value = document.querySelector('meta[name="app-version"]').content; version.textContent = "v" + value; version.setAttribute("aria-label", "Версия " + value); return true; })()`);
    await evaluate(fs.readFileSync(path.join(projectRoot, "assets", "vendor", "polygon-clipping.umd.min.js"), "utf8"));
    await evaluate(fs.readFileSync(path.join(projectRoot, "city-coverage.js"), "utf8"));
    const browserBoundaryGeometry = await evaluate("WalkCityCoverage.loadBoundary()");
    assert.ok(browserBoundaryGeometry && ["Polygon", "MultiPolygon"].includes(browserBoundaryGeometry.type), "browser loads the local city boundary geometry for display");
    const browserCityCoverage = await evaluate("WalkCityCoverage.calculate([], window.polygonClipping)");
    assert.ok(browserCityCoverage && browserCityCoverage.cityArea > 70_400_000 && browserCityCoverage.cityArea < 70_600_000, "browser loads the local OSM boundary and calculates its area without a remote API");
    const initialCityLabel = await evaluate("WalkCityCoverage.calculate([], window.polygonClipping).then((coverage) => { const label = document.getElementById('cityCoverage'); document.getElementById('cityCoverageValue').textContent = WalkCityCoverage.formatPercentage(coverage); return label.textContent.replace(/\\s+/g, ' ').trim(); })");
    assert.equal(initialCityLabel, "Прешов: 0,00%", "browser renders zero captured city area with the required label, locale and precision");
    await evaluate(fs.readFileSync(path.join(projectRoot, "map-zoom-control.js"), "utf8"));
    await evaluate(fs.readFileSync(path.join(projectRoot, "map-layer-panes.js"), "utf8"));
    await evaluate(fs.readFileSync(path.join(projectRoot, "map-follow.js"), "utf8"));
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await evaluate(`(() => {
      const styles = document.createElement("style");
      styles.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}.leaflet-control-container{position:absolute;inset:0;z-index:800;pointer-events:none}.leaflet-top,.leaflet-bottom{position:absolute;z-index:800;pointer-events:none}.leaflet-top{top:0}.leaflet-right{right:0}.leaflet-bottom{bottom:0}.leaflet-control{float:left;clear:both;margin:10px;pointer-events:auto}.leaflet-bar{border:2px solid #bbb;border-radius:4px;background:#fff;box-shadow:0 1px 5px #0006}.leaflet-bar a{width:26px;height:26px;line-height:26px;border-bottom:1px solid #bbb;text-align:center;color:#000;text-decoration:none}.leaflet-control-zoom a{display:block;box-sizing:border-box;text-align:center;background:#fff;border:1px solid #bbb;color:#333;text-decoration:none}.leaflet-control-rotate{background:var(--lrc-control-bg)}.leaflet-control-rotate a{display:flex;align-items:center;justify-content:center;width:var(--lrc-control-size);height:var(--lrc-control-size);box-sizing:border-box;background:#fff;border:1px solid #bbb;color:#333;text-decoration:none}";
      document.head.append(styles);
      const container = document.createElement("div");
      container.className = "leaflet-control-container";
      const topRight = document.createElement("div");
      topRight.className = "leaflet-top leaflet-right";
      const rotate = document.createElement("div");
      rotate.className = "leaflet-control leaflet-control-rotate leaflet-bar";
      const compass = document.createElement("a");
      compass.href = "#north";
      compass.setAttribute("aria-label", "Повернуть карту на север");
      compass.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 6 20l6-4 6 4z" fill="#315b3b"/></svg>';
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
        zoom.append(button);
      }
      window.WalkMapZoomControl.configure(zoom);
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
    const initialStatus = await evaluate(`(() => ({ title: document.getElementById("statusTitle").textContent, text: document.getElementById("statusText").textContent, hidden: document.getElementById("statusCopy").hidden }))()`);
    assert.deepEqual(initialStatus, { title: "", text: "", hidden: true }, "initial document has no redundant idle status copy");
    const stateScript = (state) => `(() => {
      const s = ${JSON.stringify(state)};
      const hide = (id, value) => { document.getElementById(id).hidden = value; };
      document.body.classList.toggle("expedition-mode", Boolean(s.expedition));
      document.querySelector(".status").classList.toggle("recording", Boolean(s.active));
      const statusTitle = s.warmup ? "Стабилизация GPS" : s.active ? (s.expedition ? "Идёт экспедиция" : "Идёт захват территории") : "";
      document.getElementById("statusTitle").textContent = statusTitle;
      const statusText = s.warmup ? "Стабилизация GPS. Подождите перед началом движения…" : s.active ? (s.expedition ? "Записываем путь к цели" : s.recovery ? "До точки восстановления: 24 м" : "Точки сохраняются на устройстве") : "";
      document.getElementById("statusText").textContent = statusText;
      document.getElementById("statusCopy").hidden = !statusTitle && !statusText;
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
      if (s.recovery) {
        document.getElementById("finish").disabled = true;
        document.getElementById("message").classList.add("is-route-recovery");
        document.getElementById("message").textContent = s.expedition
          ? "Маршрут прерван. Вернитесь к отмеченной точке, чтобы продолжить экспедицию"
          : "Маршрут прерван. Вернитесь к отмеченной точке, чтобы продолжить захват территории";
      } else {
        document.getElementById("message").classList.remove("is-route-recovery");
        document.getElementById("message").textContent = "";
      }
      return true;
    })()`;

    for (const [width, height] of viewports) {
      const initial = await setViewport(width, height);
      assert.equal(initial.width, width, `viewport width ${width}`);
      assert.equal(initial.height, height, `viewport height ${height}`);
      assert.ok(initial.mapHeight > 0, `${width}x${height}: map has a visible box`);
      assert.ok(Math.abs(initial.mapHeight - initial.tileMapHeight) < 1, `${width}x${height}: map tiles fill the full map container`);
      await evaluate(stateScript({}));
      const idleStatus = await evaluate(`(() => ({ title: document.getElementById("statusTitle").textContent, text: document.getElementById("statusText").textContent, hidden: document.getElementById("statusCopy").hidden, startVisible: !document.getElementById("start").hidden }))()`);
      assert.deepEqual(idleStatus, { title: "", text: "", hidden: true, startVisible: true }, `${width}x${height}: idle state omits redundant copy and keeps the start action`);
      const startMarker = await evaluate(`(() => {
        const map = document.getElementById("map"), mapRect = map.getBoundingClientRect();
        const marker = document.createElement("div");
        marker.className = "route-start-marker";
        marker.title = "Старт маршрута";
        marker.style.cssText = "position:absolute;left:85px;top:90px;width:24px;height:32px";
        marker.innerHTML = ${JSON.stringify(routeStartSvg)};
        map.append(marker);
        const svg = marker.querySelector("svg"), markerRect = marker.getBoundingClientRect(), flagRect = svg.getBoundingClientRect();
        const result = {
          markerWidth: markerRect.width, markerHeight: markerRect.height,
          flagWidth: flagRect.width, flagHeight: flagRect.height,
          title: marker.title, role: svg.getAttribute("role"), label: svg.getAttribute("aria-label"),
          visibleText: marker.textContent.trim(), hasFlag: Boolean(svg.querySelector(".route-start-cloth")),
          borderWidth: getComputedStyle(marker).borderWidth, background: getComputedStyle(marker).backgroundColor,
          insideMap: markerRect.left >= mapRect.left && markerRect.right <= mapRect.right && markerRect.top >= mapRect.top && markerRect.bottom <= mapRect.bottom
        };
        marker.remove();
        return result;
      })()`);
      assert.deepEqual(startMarker, {
        markerWidth: 24, markerHeight: 32, flagWidth: 24, flagHeight: 32,
        title: "Старт маршрута", role: "img", label: "Старт маршрута", visibleText: "", hasFlag: true,
        borderWidth: "0px", background: "rgba(0, 0, 0, 0)", insideMap: true
      }, `${width}x${height}: start flag has no label plate or reserved space and keeps its accessible name`);
      const layerStack = await evaluate(`(() => {
        const mapElement = document.getElementById("map");
        const mapRect = mapElement.getBoundingClientRect();
        const boundaryGeometry = ${JSON.stringify(browserBoundaryGeometry)};
        const startup = document.getElementById("locationStartupScreen");
        const startupWasHidden = startup.hidden;
        startup.hidden = true;
        const panes = window.WalkMapLayerPanes.createMapPanes({
          createPane(name) {
            const pane = document.createElement("div");
            pane.dataset.testPane = name;
            Object.assign(pane.style, { position: "absolute", inset: "0" });
            mapElement.append(pane);
            return pane;
          }
        });
        const outerRings = boundaryGeometry.type === "Polygon"
          ? [boundaryGeometry.coordinates[0]]
          : boundaryGeometry.coordinates.map((polygon) => polygon[0]);
        const allCoordinates = outerRings.flat();
        const longitudes = allCoordinates.map(([lng]) => lng);
        const latitudes = allCoordinates.map(([, lat]) => lat);
        const west = Math.min(...longitudes), east = Math.max(...longitudes);
        const south = Math.min(...latitudes), north = Math.max(...latitudes);
        const boundarySvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        boundarySvg.setAttribute("viewBox", "0 0 " + mapRect.width + " " + mapRect.height);
        Object.assign(boundarySvg.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
        const boundaryPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const toMapPoint = ([lng, lat]) => [
          8 + (lng - west) / (east - west) * Math.max(0, mapRect.width - 16),
          8 + (north - lat) / (north - south) * Math.max(0, mapRect.height - 16)
        ];
        boundaryPath.setAttribute("d", outerRings.map((ring) => ring.map((coordinate, index) => {
          const [pointX, pointY] = toMapPoint(coordinate);
          return (index ? "L" : "M") + pointX + "," + pointY;
        }).join(" ") + " Z").join(" "));
        boundaryPath.setAttribute("fill", "none");
        boundaryPath.setAttribute("fill-opacity", "0");
        boundaryPath.setAttribute("stroke", "#e64b45");
        boundaryPath.setAttribute("stroke-width", "2");
        boundaryPath.setAttribute("stroke-dasharray", "6 4");
        boundaryPath.setAttribute("stroke-opacity", "0.8");
        boundarySvg.append(boundaryPath);
        mapElement.querySelector('[data-test-pane="' + panes.cityBoundary + '"]').append(boundarySvg);
        const x = mapRect.left + 60, y = mapRect.top + 70;
        const markers = [
          [panes.territory, "territory", 70, 70, "#2f874d"],
          [panes.route, "route", 70, 5, "#e78248"],
          [panes.gameOverlay, "checkpoint", 64, 64, "#2877df33"],
          [panes.gameMarker, "game-marker", 32, 32, "transparent"],
          [panes.accuracy, "accuracy", 56, 56, "#2877df22"],
          [panes.currentLocation, "current-location", 18, 18, "#2877df"]
        ];
        const elements = [];
        for (const [paneName, kind, width, height, color] of markers) {
          const pane = mapElement.querySelector('[data-test-pane="' + paneName + '"]');
          const element = document.createElement("div");
          element.dataset.layerKind = kind;
          if (kind === "game-marker") {
            element.className = "recovery-checkpoint-icon";
            element.innerHTML = ${JSON.stringify(recoveryCheckpointSvg)};
          }
          Object.assign(element.style, {
            position: "absolute", left: (x - mapRect.left - width / 2) + "px", top: (y - mapRect.top - height / 2) + "px",
            width: width + "px", height: height + "px", boxSizing: "border-box", borderRadius: "50%",
            background: color, border: kind === "current-location" ? "3px solid white" : kind === "game-marker" ? "0" : "1px solid #172019", pointerEvents: "auto"
          });
          pane.append(element); elements.push(element);
        }
        const mapHit = document.elementFromPoint(x, y)?.dataset.layerKind;
        const boundaryPane = mapElement.querySelector('[data-test-pane="' + panes.cityBoundary + '"]');
        const renderedBoundary = boundaryPane.querySelector("path");
        const checkpoint = mapElement.querySelector(".recovery-checkpoint-icon");
        const checkpointRect = checkpoint.getBoundingClientRect();
        const checkpointCircle = checkpoint.querySelector("circle");
        const checkpointFlag = checkpoint.querySelector("path");
        const header = document.querySelector("header"), headerRect = header.getBoundingClientRect();
        const headerHit = document.elementFromPoint(headerRect.left + headerRect.width / 2, headerRect.top + headerRect.height / 2);
        const panel = document.querySelector(".panel"), panelRect = panel.getBoundingClientRect();
        const panelHit = document.elementFromPoint(panelRect.left + panelRect.width / 2, panelRect.top + Math.min(20, panelRect.height / 2));
        document.body.classList.add("walks-open");
        const drawer = document.getElementById("walksDrawer"), drawerRect = drawer.getBoundingClientRect();
        const drawerHit = document.elementFromPoint(drawerRect.left + drawerRect.width / 2, drawerRect.top + Math.min(70, drawerRect.height / 2));
        const drawerOwnsHit = drawer === drawerHit || drawer.contains(drawerHit);
        document.body.classList.remove("walks-open");
        elements.forEach((element) => element.closest("[data-test-pane]").remove());
        startup.hidden = startupWasHidden;
        return {
          mapHit,
          boundary: {
            paneZIndex: Number(boundaryPane.style.zIndex),
            pointerEvents: getComputedStyle(boundaryPane).pointerEvents,
            pathLength: renderedBoundary.getAttribute("d").length,
            fill: renderedBoundary.getAttribute("fill"),
            fillOpacity: renderedBoundary.getAttribute("fill-opacity"),
            dashArray: renderedBoundary.getAttribute("stroke-dasharray"),
            strokeOpacity: renderedBoundary.getAttribute("stroke-opacity"),
            stroke: renderedBoundary.getAttribute("stroke"),
            strokeWidth: renderedBoundary.getAttribute("stroke-width")
          },
          checkpoint: { width: checkpointRect.width, height: checkpointRect.height, fill: checkpointCircle.getAttribute("fill"), stroke: checkpointCircle.getAttribute("stroke"), hasFlag: Boolean(checkpointFlag) },
          headerOwnsHit: header === headerHit || header.contains(headerHit), panelOwnsHit: panel === panelHit || panel.contains(panelHit), drawerOwnsHit
        };
      })()`);
      assert.equal(layerStack.boundary.paneZIndex, 250, `${width}x${height}: city boundary is between basemap and game layers`);
      assert.equal(layerStack.boundary.pointerEvents, "none", `${width}x${height}: boundary cannot intercept map controls or game hit-testing`);
      assert.ok(layerStack.boundary.pathLength > 1000, `${width}x${height}: the local administrative outline is rendered`);
      assert.equal(layerStack.boundary.fill, "none", `${width}x${height}: boundary has no fill`);
      assert.equal(layerStack.boundary.fillOpacity, "0", `${width}x${height}: boundary fill opacity is zero`);
      assert.equal(layerStack.boundary.stroke, "#e64b45", `${width}x${height}: boundary has a red outline`);
      assert.equal(layerStack.boundary.dashArray, "6 4", `${width}x${height}: boundary uses a 6 px / 4 px dash pattern`);
      assert.equal(layerStack.boundary.strokeOpacity, "0.8", `${width}x${height}: boundary line opacity is 0.8`);
      assert.equal(layerStack.boundary.strokeWidth, "2", `${width}x${height}: boundary outline is 2 px`);
      assert.equal(layerStack.mapHit, "current-location", `${width}x${height}: current GPS dot wins hit-testing over territory, route, checkpoint, game marker and accuracy circle`);
      assert.equal(layerStack.checkpoint.width, 32, `${width}x${height}: recovery checkpoint uses the intended marker size`);
      assert.equal(layerStack.checkpoint.height, 32, `${width}x${height}: recovery checkpoint remains circular and centered`);
      assert.equal(layerStack.checkpoint.fill, "#f7fbff", `${width}x${height}: recovery checkpoint has a light center`);
      assert.equal(layerStack.checkpoint.stroke, "#1769d2", `${width}x${height}: recovery checkpoint uses a blue outline`);
      assert.equal(layerStack.checkpoint.hasFlag, true, `${width}x${height}: recovery checkpoint includes its return flag`);
      assert.equal(layerStack.headerOwnsHit, true, `${width}x${height}: GPS map pane cannot cover the header`);
      assert.equal(layerStack.panelOwnsHit, true, `${width}x${height}: GPS map pane cannot cover the action panel`);
      assert.equal(layerStack.drawerOwnsHit, true, `${width}x${height}: GPS map pane stays below the open history drawer`);
      await evaluate(stateScript({ warmup: true, manual: true }));
      const enlargedStatus = await evaluate(`(() => {
        const style = document.createElement("style");
        style.textContent = ".statusCopy b,.statusCopy small{font-size:200%!important;line-height:1.3!important;white-space:normal!important;overflow:visible!important;text-overflow:clip!important}";
        document.head.append(style);
        const copy = document.getElementById("statusCopy"), stopwatch = document.querySelector(".stopwatch"), panel = document.querySelector(".panel"), action = document.getElementById("manualWarmupStart");
        const copyRect = copy.getBoundingClientRect(), stopwatchRect = stopwatch.getBoundingClientRect(), panelRect = panel.getBoundingClientRect(), actionRect = action.getBoundingClientRect();
        return { visible: !copy.hidden, title: document.getElementById("statusTitle").textContent, text: document.getElementById("statusText").textContent, separated: copyRect.right <= stopwatchRect.left, noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth, actionVisible: !action.hidden && actionRect.width > 0 && actionRect.top >= panelRect.top && actionRect.bottom <= panelRect.bottom };
      })()`);
      assert.equal(enlargedStatus.visible, true, `${width}x${height}: warm-up status remains visible at enlarged text size`);
      assert.equal(enlargedStatus.separated, true, `${width}x${height}: enlarged status does not overlap timer and distance`);
      assert.equal(enlargedStatus.noHorizontalOverflow, true, `${width}x${height}: enlarged text does not create horizontal page scrolling`);
      assert.equal(enlargedStatus.actionVisible, true, `${width}x${height}: enlarged text leaves the manual start action visible in the panel`);
      const baselineMapHeight = initial.mapHeight;
      for (const scenario of scenarios) {
        await evaluate(stateScript(scenario.state));
        await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const result = await evaluate(`(() => {
          const panel = document.querySelector(".panel").getBoundingClientRect();
          const startupScreen = document.getElementById("locationStartupScreen");
          const recoveryMessage = document.getElementById("message");
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
            const gate = document.getElementById("locationStartupScreen"), gateWasHidden = gate.hidden;
            gate.hidden = true;
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            gate.hidden = gateWasHidden;
            return { label: element.getAttribute("aria-label"), text: element.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, displayed: getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden", hit: Boolean(hit && (hit === element || element.contains(hit))), hitTarget: hit?.className || hit?.tagName };
          });
          const compassRect = document.querySelector(".leaflet-control-rotate a").getBoundingClientRect();
          const modeButtons = [...document.querySelectorAll(".mode-selector button, .expeditionMethods button")].map((element) => {
            const rect = element.getBoundingClientRect();
            const group = element.closest(".mode-selector, .expeditionMethods");
            return { id: element.id, hidden: element.hidden || group.hidden, displayed: getComputedStyle(element).display !== "none", top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
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
          const menuButton = document.querySelector("#utilityMenu > summary");
          const menuButtonRect = menuButton.getBoundingClientRect();
          const menuVisual = menuButton.querySelector(".utility-menu-visual");
          const menuVisualRect = menuVisual.getBoundingClientRect();
          const menuIcon = menuButton.querySelector("svg");
          const menuIconRect = menuIcon.getBoundingClientRect();
          const version = document.getElementById("appVersion");
          const versionRect = version.getBoundingClientRect();
          return { mapHeight: map.height, viewportHeight: innerHeight, scrollHeight: document.scrollingElement.scrollHeight, buttons, modeButtons, recoveryMessage: { text: recoveryMessage.textContent, visible: getComputedStyle(recoveryMessage).display !== "none" && recoveryMessage.getBoundingClientRect().height > 0, height: recoveryMessage.getBoundingClientRect().height, fullText: getComputedStyle(recoveryMessage).whiteSpace === "normal" }, captureDisabled: document.getElementById("finish").disabled, header: { brand: { left: brand.left, right: brand.right }, title: { left: brandTitle.left, right: brandTitle.right }, actions: { left: headerActions.left, right: headerActions.right }, menuButton: { left: menuButtonRect.left, right: menuButtonRect.right, width: menuButtonRect.width, height: menuButtonRect.height, background: getComputedStyle(menuButton).backgroundColor, borderWidth: getComputedStyle(menuButton).borderWidth, label: menuButton.getAttribute("aria-label"), visualWidth: menuVisualRect.width, visualHeight: menuVisualRect.height, iconWidth: menuIconRect.width, iconHeight: menuIconRect.height, iconColor: getComputedStyle(menuIcon).color, iconStrokeWidth: getComputedStyle(menuIcon).strokeWidth, lineCount: menuIcon.querySelectorAll("path").length, iconCenterX: menuIconRect.left + menuIconRect.width / 2, iconCenterY: menuIconRect.top + menuIconRect.height / 2, buttonCenterX: menuButtonRect.left + menuButtonRect.width / 2, buttonCenterY: menuButtonRect.top + menuButtonRect.height / 2 }, version: { text: version.textContent, label: version.getAttribute("aria-label"), left: versionRect.left, right: versionRect.right, width: versionRect.width, height: versionRect.height, visible: getComputedStyle(version).display !== "none" && getComputedStyle(version).visibility !== "hidden" }, menuVersionCount: document.querySelectorAll(".utility-menu-panel .appVersion").length }, locate: { top: mapLocate.top, bottom: mapLocate.bottom, height: mapLocate.height, left: mapLocate.left, right: mapLocate.right }, zoomButtons, compass: { top: compassRect.top, bottom: compassRect.bottom, left: compassRect.left, right: compassRect.right }, panel: { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right }, startup: { hidden: startupScreen.hidden, top: startupRect.top, left: startupRect.left, right: startupRect.right, bottom: startupRect.bottom, background: getComputedStyle(startupScreen).backgroundColor, stackingLevel: getStackingLevel(startupScreen), mapStackingLevel: getStackingLevel(mapElement), probeIsBlocked: Boolean(mapProbe && startupScreen.contains(mapProbe)), probeReachesMap: Boolean(mapProbe && mapElement.contains(mapProbe)), underlyingProbeReachesMap: Boolean(underlyingProbe && mapElement.contains(underlyingProbe)) } };
        })()`);
        const mapControlStyles = await evaluate(`(() => {
          const startupGate = document.getElementById("locationStartupScreen");
          const startupGateWasHidden = startupGate.hidden;
          startupGate.hidden = true;
          const map = document.getElementById("map").getBoundingClientRect();
          const header = document.querySelector("header").getBoundingClientRect();
          const locate = document.getElementById("locate");
          const compass = document.querySelector(".leaflet-control-rotate a");
          const zoom = [...document.querySelectorAll(".leaflet-control-zoom a")];
          const zoomGroup = document.querySelector(".leaflet-control-zoom");
          const pseudoRect = (element, pseudo) => {
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element, pseudo);
            return { left: rect.left + parseFloat(style.left), right: rect.right - parseFloat(style.right), top: rect.top + parseFloat(style.top), bottom: rect.bottom - parseFloat(style.bottom) };
          };
          const describe = (element, pseudo = "") => {
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            const visual = pseudo ? getComputedStyle(element, pseudo) : style;
            const svg = element.querySelector("svg");
            const iconPath = svg?.querySelector("path");
            const pathBox = iconPath?.getBBox();
            const iconPathStyle = iconPath && getComputedStyle(iconPath);
            const range = document.createRange(); range.selectNodeContents(element);
            const icon = svg ? svg.getBoundingClientRect() : range.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            const visualBorderX = parseFloat(visual.borderLeftWidth) + parseFloat(visual.borderRightWidth);
            const visualBorderY = parseFloat(visual.borderTopWidth) + parseFloat(visual.borderBottomWidth);
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, borderWidth: style.borderWidth, background: style.backgroundColor, backgroundImage: style.backgroundImage, shadow: style.boxShadow, margin: style.margin, padding: style.padding, display: style.display, justifyItems: style.justifyItems, alignItems: style.alignItems, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, textIndent: style.textIndent, hit: Boolean(hit && (hit === element || element.contains(hit))), icon: { left: icon.left, right: icon.right, top: icon.top, bottom: icon.bottom }, surface: pseudo ? pseudoRect(element, pseudo) : null, svgIcon: svg && { viewBox: svg.getAttribute("viewBox"), width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height, ariaHidden: svg.getAttribute("aria-hidden"), focusable: svg.getAttribute("focusable") }, path: pathBox && { d: iconPath.getAttribute("d"), stroke: iconPathStyle.stroke, strokeWidth: iconPathStyle.strokeWidth, linecap: iconPathStyle.strokeLinecap, linejoin: iconPathStyle.strokeLinejoin, centerX: pathBox.x + pathBox.width / 2, centerY: pathBox.y + pathBox.height / 2, width: pathBox.width, height: pathBox.height }, visual: { width: parseFloat(visual.width) + visualBorderX, height: parseFloat(visual.height) + visualBorderY, radius: visual.borderRadius, borderWidth: visual.borderWidth, borderColor: visual.borderColor, background: visual.backgroundColor, shadow: visual.boxShadow } };
          };
          const originalClass = locate.className;
          const locationStates = ["", "is-locating", "is-ready", "is-error", "is-following"].map((state) => {
            locate.className = "mapLocate" + (state ? " " + state : "");
            const style = getComputedStyle(locate), spinner = getComputedStyle(locate, "::after");
            const visual = getComputedStyle(locate, "::before");
            return { state: state || "normal", borderColor: visual.borderColor, color: style.color, background: visual.backgroundColor, outerBorder: style.borderWidth, outerBackground: style.backgroundColor, outerShadow: style.boxShadow, spinnerWidth: spinner.width, spinnerBorder: spinner.borderTopColor };
          });
          locate.className = originalClass;
          const rotateContainer = compass.parentElement;
          const zoomGroupStyle = getComputedStyle(zoomGroup), zoomGroupVisual = getComputedStyle(zoomGroup, "::before");
          const zoomBorderX = parseFloat(zoomGroupVisual.borderLeftWidth) + parseFloat(zoomGroupVisual.borderRightWidth);
          const zoomBorderY = parseFloat(zoomGroupVisual.borderTopWidth) + parseFloat(zoomGroupVisual.borderBottomWidth);
          const zoomDivider = getComputedStyle(zoom[1], "::before");
          const result = { map: { left: map.left, right: map.right, top: map.top }, headerBottom: header.bottom, locate: describe(locate, "::before"), compass: describe(compass, "::before"), rotateContainer: { borderWidth: getComputedStyle(rotateContainer).borderWidth, background: getComputedStyle(rotateContainer).backgroundColor, shadow: getComputedStyle(rotateContainer).boxShadow }, zoom: zoom.map(describe), zoomDivider: { top: zoomDivider.top, height: zoomDivider.height, left: zoomDivider.left, right: zoomDivider.right, background: zoomDivider.backgroundColor }, zoomGroup: { width: zoomGroup.getBoundingClientRect().width, height: zoomGroup.getBoundingClientRect().height, borderWidth: zoomGroupStyle.borderWidth, background: zoomGroupStyle.backgroundColor, backgroundImage: zoomGroupStyle.backgroundImage, shadow: zoomGroupStyle.boxShadow, visual: { width: parseFloat(zoomGroupVisual.width) + zoomBorderX, height: parseFloat(zoomGroupVisual.height) + zoomBorderY, radius: zoomGroupVisual.borderRadius, borderWidth: zoomGroupVisual.borderWidth, borderColor: zoomGroupVisual.borderColor, background: zoomGroupVisual.backgroundColor, shadow: zoomGroupVisual.boxShadow } }, locationStates };
          result.zoomGroup.surface = pseudoRect(zoomGroup, "::before");
          result.zoomDivider.screenTop = zoom[1].getBoundingClientRect().top + parseFloat(zoomDivider.top);
          startupGate.hidden = startupGateWasHidden;
          return result;
        })()`);
        assert.ok(Math.abs(result.mapHeight - baselineMapHeight) < 1, `${width}x${height} ${scenario.name}: controls changed map height`);
        assert.ok(result.scrollHeight <= result.viewportHeight + 1, `${width}x${height} ${scenario.name}: page gained vertical scroll`);
        const controls = [mapControlStyles.locate, mapControlStyles.compass, ...mapControlStyles.zoom];
        for (const [index, control] of controls.entries()) {
          const name = ["geolocation", "compass", "zoom in", "zoom out"][index];
          assert.equal(control.width, 44, `${width}x${height} ${scenario.name}: ${name} is 44px wide`);
          assert.equal(control.height, 44, `${width}x${height} ${scenario.name}: ${name} is 44px tall`);
          assert.equal(control.hit, true, `${width}x${height} ${scenario.name}: ${name} receives hit testing in its tap area`);
          assert.equal(control.display, "grid", `${width}x${height} ${scenario.name}: ${name} uses centered grid layout`);
          assert.equal(control.justifyItems, "center", `${width}x${height} ${scenario.name}: ${name} is centered horizontally`);
          assert.equal(control.alignItems, "center", `${width}x${height} ${scenario.name}: ${name} is centered vertically`);
          assert.equal(control.fontSize, index < 2 ? "22px" : "0px", `${width}x${height} ${scenario.name}: ${name} uses the expected native-icon or SVG-only styling`);
          if (index >= 2) assert.equal(control.fontWeight, "400", `${width}x${height} ${scenario.name}: ${name} symbol uses a light stroke weight`);
          assert.ok(Math.abs((control.icon.left + control.icon.right) / 2 - (control.left + control.right) / 2) <= 3, `${width}x${height} ${scenario.name}: ${name} icon is centered horizontally`);
          assert.ok(Math.abs((control.icon.top + control.icon.bottom) / 2 - (control.top + control.bottom) / 2) <= 3, `${width}x${height} ${scenario.name}: ${name} icon is centered vertically`);
        }
        for (const [name, control] of [["geolocation", mapControlStyles.locate], ["compass", mapControlStyles.compass]]) {
          const centerX = (control.icon.left + control.icon.right) / 2;
          const centerY = (control.icon.top + control.icon.bottom) / 2;
          assert.ok(Math.abs(centerX - (control.surface.left + control.surface.right) / 2) < 0.75, `${width}x${height}: ${name} icon is centered within its visible surface`);
          assert.ok(Math.abs(centerY - (control.surface.top + control.surface.bottom) / 2) < 0.75, `${width}x${height}: ${name} icon is centered within its visible surface`);
        }
        const surfaces = [mapControlStyles.locate.visual, mapControlStyles.compass.visual, mapControlStyles.zoomGroup.visual];
        for (const [index, surface] of surfaces.entries()) {
          const name = ["geolocation", "compass", "zoom group"][index];
          assert.equal(surface.width, 40, `${width}x${height}: ${name} visible surface is 40px wide`);
          assert.equal(surface.height, index === 2 ? 80 : 40, `${width}x${height}: ${name} visible surface has the intended compact height`);
          assert.equal(surface.radius, "10px", `${width}x${height}: ${name} visual surface has a 10px radius`);
          assert.equal(surface.borderWidth, "1px", `${width}x${height}: ${name} has one 1px border`);
          assert.equal(surface.borderColor, "rgb(216, 225, 213)", `${width}x${height}: ${name} uses the shared gray-green border`);
          assert.equal(surface.background, "rgb(255, 255, 255)", `${width}x${height}: ${name} has a single white surface`);
          assert.equal(surface.shadow, mapControlStyles.locate.visual.shadow, `${width}x${height}: ${name} shares the light shadow`);
        }
        for (const [index, element] of [mapControlStyles.locate, mapControlStyles.compass, ...mapControlStyles.zoom].entries()) {
          const name = ["geolocation", "compass", "zoom in", "zoom out"][index];
          assert.equal(element.borderWidth, "0px", `${width}x${height}: ${name} tap area has no duplicate frame`);
          assert.equal(element.background, "rgba(0, 0, 0, 0)", `${width}x${height}: ${name} tap area has no duplicate background`);
          assert.equal(element.shadow, "none", `${width}x${height}: ${name} tap area has no duplicate shadow`);
        }
        assert.equal(mapControlStyles.rotateContainer.borderWidth, "0px", `${width}x${height}: compass Leaflet wrapper has no second border`);
        assert.equal(mapControlStyles.rotateContainer.background, "rgba(0, 0, 0, 0)", `${width}x${height}: compass Leaflet wrapper has no background surface`);
        assert.equal(mapControlStyles.rotateContainer.shadow, "none", `${width}x${height}: compass Leaflet wrapper has no second shadow`);
        assert.equal(mapControlStyles.zoomGroup.width, 44, `${width}x${height}: zoom group retains a 44px touch width`);
        assert.equal(mapControlStyles.zoomGroup.height, 88, `${width}x${height}: zoom group is two contiguous 44px touch rows`);
        assert.equal(mapControlStyles.zoomGroup.borderWidth, "0px", `${width}x${height}: zoom Leaflet wrapper adds no second border`);
        assert.equal(mapControlStyles.zoomGroup.background, "rgba(0, 0, 0, 0)", `${width}x${height}: zoom Leaflet wrapper adds no second background`);
        assert.equal(mapControlStyles.zoomGroup.backgroundImage, "none", `${width}x${height}: zoom Leaflet wrapper adds no image surface`);
        assert.equal(mapControlStyles.zoomGroup.shadow, "none", `${width}x${height}: zoom Leaflet wrapper adds no second shadow`);
        const zoomSurface = mapControlStyles.zoomGroup.surface;
        assert.equal(zoomSurface.left - mapControlStyles.zoom[0].left, 2, `${width}x${height}: zoom surface has a symmetric 2px horizontal inset`);
        assert.equal(mapControlStyles.zoom[0].right - zoomSurface.right, 2, `${width}x${height}: zoom surface has a symmetric 2px horizontal inset`);
        assert.equal(zoomSurface.top - mapControlStyles.zoom[0].top, 4, `${width}x${height}: zoom surface has a 4px top inset`);
        assert.equal(mapControlStyles.zoom[1].bottom - zoomSurface.bottom, 4, `${width}x${height}: zoom surface has a matching 4px bottom inset`);
        assert.equal(zoomSurface.right - zoomSurface.left, 40, `${width}x${height}: measured zoom surface is 40px wide`);
        assert.equal(zoomSurface.bottom - zoomSurface.top, 80, `${width}x${height}: measured zoom surface is 80px tall`);
        assert.equal(mapControlStyles.zoomDivider.screenTop - zoomSurface.top, 40, `${width}x${height}: divider bisects the visible surface`);
        assert.equal(zoomSurface.bottom - mapControlStyles.zoomDivider.screenTop, 40, `${width}x${height}: both visible zoom halves are equally tall`);
        for (const [index, button] of mapControlStyles.zoom.entries()) {
          assert.equal(button.fontSize, "0px", `${width}x${height}: zoom uses only the SVG glyph, not a text symbol`);
          assert.equal(button.fontWeight, "400", `${width}x${height}: zoom ${index ? "out" : "in"} symbol uses a light weight`);
          assert.equal(button.backgroundImage, "none", `${width}x${height}: zoom ${index ? "out" : "in"} has no Leaflet image`);
          assert.equal(button.padding, "0px", `${width}x${height}: zoom ${index ? "out" : "in"} has no extra padding`);
          assert.equal(button.margin, "0px", `${width}x${height}: zoom ${index ? "out" : "in"} has no extra margin`);
          assert.equal(button.lineHeight, "0px", `${width}x${height}: Leaflet's text line-height cannot offset the SVG`);
          assert.equal(button.textIndent, "0px", `${width}x${height}: Leaflet's text indent cannot offset the SVG`);
          assert.deepEqual(button.svgIcon, { viewBox: "0 0 18 18", width: 18, height: 18, ariaHidden: "true", focusable: "false" }, `${width}x${height}: zoom ${index ? "out" : "in"} uses the centered 18px decorative SVG`);
          assert.equal(button.path.stroke, "rgb(49, 91, 59)", `${width}x${height}: zoom SVG uses the app's dark green`);
          assert.equal(button.path.strokeWidth, "2.5px", `${width}x${height}: zoom strokes have the agreed weight`);
          assert.equal(button.path.linecap, "round", `${width}x${height}: zoom stroke endings are rounded`);
          assert.equal(button.path.linejoin, "round", `${width}x${height}: zoom joins are rounded`);
          assert.equal(button.path.centerX, 9, `${width}x${height}: zoom path is horizontally centered in the SVG viewBox`);
          assert.equal(button.path.centerY, 9, `${width}x${height}: zoom path is vertically centered in the SVG viewBox`);
          assert.ok(Math.abs((button.icon.left + button.icon.right) / 2 - (button.left + button.right) / 2) < 0.5, `${width}x${height}: zoom SVG is optically centered horizontally in its hit area`);
          const visibleHalfTop = index === 0 ? zoomSurface.top : mapControlStyles.zoomDivider.screenTop;
          const visibleHalfBottom = index === 0 ? mapControlStyles.zoomDivider.screenTop : zoomSurface.bottom;
          const visibleCenterX = (zoomSurface.left + zoomSurface.right) / 2;
          const visibleCenterY = (visibleHalfTop + visibleHalfBottom) / 2;
          assert.ok(Math.abs((button.icon.left + button.icon.right) / 2 - visibleCenterX) < 0.5, `${width}x${height}: zoom ${index ? "minus" : "plus"} is centered horizontally in its visible half`);
          assert.ok(Math.abs((button.icon.top + button.icon.bottom) / 2 - visibleCenterY) < 0.5, `${width}x${height}: zoom ${index ? "minus" : "plus"} is centered vertically in its visible half, not the taller hit row`);
        }
        assert.equal(mapControlStyles.zoomDivider.top, "0px", `${width}x${height}: zoom divider aligns to the row boundary`);
        assert.equal(mapControlStyles.zoomDivider.height, "1px", `${width}x${height}: zoom divider is thin`);
        assert.equal(mapControlStyles.zoomDivider.background, "rgb(216, 225, 213)", `${width}x${height}: zoom divider matches the group frame`);
        assert.equal(mapControlStyles.locate.left - mapControlStyles.map.left, 10, `${width}x${height}: geolocation control is inset 10px from the map's left edge`);
        assert.equal(mapControlStyles.locate.top - mapControlStyles.map.top, 10, `${width}x${height}: geolocation control is inset 10px from the map's top edge`);
        assert.equal(mapControlStyles.compass.right, mapControlStyles.map.right - 10, `${width}x${height}: compass is inset 10px from the map's right edge`);
        assert.equal(mapControlStyles.compass.top - mapControlStyles.map.top, 10, `${width}x${height}: compass is inset 10px from the map's top edge`);
        assert.equal(mapControlStyles.zoom[0].right, mapControlStyles.map.right - 10, `${width}x${height}: zoom group is inset 10px from the map's right edge`);
        assert.equal(mapControlStyles.zoom[1].top - mapControlStyles.zoom[0].bottom, 0, `${width}x${height}: zoom buttons form a continuous vertical group`);
        assert.ok(mapControlStyles.headerBottom <= mapControlStyles.locate.top && mapControlStyles.headerBottom <= mapControlStyles.compass.top, `${width}x${height}: top map controls do not overlap the header`);
        assert.ok(mapControlStyles.locate.right <= mapControlStyles.compass.left || mapControlStyles.compass.right <= mapControlStyles.locate.left, `${width}x${height}: geolocation and compass controls do not overlap`);
        const locationStates = mapControlStyles.locationStates;
        assert.ok(new Set([locationStates[0].borderColor, locationStates[2].borderColor, locationStates[3].borderColor, locationStates[4].borderColor]).size === 4, `${width}x${height}: ready, error and following states remain visually distinct`);
        assert.equal(locationStates[1].spinnerWidth, "20px", `${width}x${height}: GPS waiting state keeps its spinner`);
        assert.ok(locationStates.every((state) => state.background === "rgb(255, 255, 255)"), `${width}x${height}: GPS states preserve the common white button background`);
        assert.equal(locationStates[4].borderColor, "rgb(40, 119, 223)", `${width}x${height}: GPS follow uses the blue visual border without an outer ring`);
        assert.ok(locationStates.every((state) => state.outerBorder === "0px" && state.outerBackground === "rgba(0, 0, 0, 0)" && state.outerShadow === "none"), `${width}x${height}: GPS states do not add an outer outline or surface`);
        if (scenario.state.recovery) {
          const recoveryMessage = scenario.state.expedition
            ? "Маршрут прерван. Вернитесь к отмеченной точке, чтобы продолжить экспедицию"
            : "Маршрут прерван. Вернитесь к отмеченной точке, чтобы продолжить захват территории";
          assert.equal(result.recoveryMessage.text, recoveryMessage, `${width}x${height}: recovery instructions remain complete`);
          assert.equal(result.recoveryMessage.visible, true, `${width}x${height}: recovery instructions are visible`);
          assert.equal(result.recoveryMessage.fullText, true, `${width}x${height}: recovery instructions wrap without clipping`);
          assert.equal(result.captureDisabled, true, `${width}x${height}: capture remains disabled during recovery`);
        }
        assert.equal(result.header.version.text, `v${htmlSource.match(/name="app-version" content="([^"]+)"/)[1]}`, `${width}x${height}: header version comes from app-version meta`);
        assert.equal(result.header.version.visible, true, `${width}x${height}: version remains visible`);
        assert.equal(result.header.menuVersionCount, 0, `${width}x${height}: menu has no duplicate version`);
        assert.ok(result.header.version.width > 0 && result.header.version.height > 0, `${width}x${height}: version has a visible box`);
        assert.equal(result.header.menuButton.width, 44, `${width}x${height}: menu hit area is 44px wide`);
        assert.equal(result.header.menuButton.height, 44, `${width}x${height}: menu hit area is 44px tall`);
        assert.equal(result.header.menuButton.visualWidth, 36, `${width}x${height}: visible button is 36px wide`);
        assert.equal(result.header.menuButton.visualHeight, 36, `${width}x${height}: visible button is 36px tall`);
        assert.equal(result.header.menuButton.background, "rgba(0, 0, 0, 0)", `${width}x${height}: menu hit area has no filled plate`);
        assert.equal(result.header.menuButton.borderWidth, "0px", `${width}x${height}: menu hit area has no visible border`);
        assert.equal(result.header.menuButton.label, "Меню", `${width}x${height}: menu button has an accessible name`);
        assert.equal(result.header.menuButton.iconColor, "rgb(49, 91, 59)", `${width}x${height}: hamburger icon uses the specified green`);
        assert.equal(result.header.menuButton.iconStrokeWidth, "2px", `${width}x${height}: hamburger lines are 2px thick`);
        assert.equal(result.header.menuButton.lineCount, 3, `${width}x${height}: hamburger icon has three lines`);
        assert.equal(result.header.menuButton.iconWidth, 22, `${width}x${height}: sliders icon is 22px wide`);
        assert.equal(result.header.menuButton.iconHeight, 22, `${width}x${height}: sliders icon is 22px tall`);
        assert.ok(Math.abs(result.header.menuButton.iconCenterX - result.header.menuButton.buttonCenterX) < 0.5 && Math.abs(result.header.menuButton.iconCenterY - result.header.menuButton.buttonCenterY) < 0.5, `${width}x${height}: icon is centered in the button`);
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
      for (const [width, height] of viewports) {
        await setViewport(width, height);
        const coverage = await evaluate(`(() => {
          const box = (selector) => { const rect = document.querySelector(selector).getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; };
          const coverage = box("#cityCoverage");
          const map = box(".mapFrame");
          return { coverage, map, locate: box("#locate"), compass: box(".leaflet-control-rotate a"), zoom: box(".leaflet-control-zoom"), panel: box(".panel"), label: document.getElementById("cityCoverage").getAttribute("aria-label") };
        })()`);
        assert.equal(coverage.label, "Процент захваченной территории Прешова", `${width}x${height}: city coverage exposes its accessible label`);
        assert.ok(coverage.coverage.width > 0 && coverage.coverage.height <= 40, `${width}x${height}: city coverage remains compact`);
        assert.ok(coverage.coverage.left >= coverage.map.left && coverage.coverage.right <= coverage.map.right, `${width}x${height}: city coverage stays inside the map`);
        assert.ok(Math.abs((coverage.coverage.left + coverage.coverage.right) / 2 - (coverage.map.left + coverage.map.right) / 2) < 1, `${width}x${height}: city coverage is centered horizontally`);
        const overlaps = (first, second) => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
        assert.ok(!overlaps(coverage.coverage, coverage.locate) && !overlaps(coverage.coverage, coverage.compass), `${width}x${height}: city coverage does not obscure GPS or compass controls`);
        assert.ok(!overlaps(coverage.coverage, coverage.zoom) && !overlaps(coverage.coverage, coverage.panel), `${width}x${height}: city coverage does not obscure zoom or walk controls`);
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
            const exportButton = document.createElement("button"); exportButton.className = "diagnosticsExport"; exportButton.textContent = "Экспорт диагностики";
            const copy = document.createElement("button"); copy.className = "diagnosticsCopy"; copy.textContent = "Копировать диагностику";
            const remove = document.createElement("button"); remove.className = "routeDelete"; remove.textContent = "Удалить";
            actions.append(exportButton, copy, remove); row.append(icon, details, actions); list.append(row);
          }
          list.scrollTop = 180;
          const copy = list.querySelector(".diagnosticsCopy"); copy.focus();
          const box = (element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; };
          const exportBox = box(list.querySelector(".diagnosticsExport"));
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
          return { drawerVisible: getComputedStyle(drawer).visibility === "visible", drawerOpen: document.body.classList.contains("walks-open"), panelBox, backdropColor, panelColor, titleColor, outsideHitIsBackdrop: outsideTarget === backdrop, panelHitStaysInDrawer: drawer.contains(panelTarget), exportBox, copyBox, deleteBox, scrollBefore: beforeScroll, scrollAfter: list.scrollTop, reportPreserved, overlayClosed: !document.querySelector(".diagnosticsFallback"), focusRestored: document.activeElement === copy, horizontalOverflow: drawer.scrollWidth > drawer.clientWidth || list.scrollWidth > list.clientWidth };
        })()`);
        assert.equal(history.drawerVisible, true, `${width}x${height}: history drawer is visible`);
        assert.equal(history.drawerOpen, true, `${width}x${height}: copy does not close history`);
        assert.equal(history.backdropColor, "rgba(0, 0, 0, 0)", `${width}x${height}: backdrop remains transparent`);
        assert.equal(history.outsideHitIsBackdrop, true, `${width}x${height}: outside taps still reach the closing backdrop`);
        assert.equal(history.panelHitStaysInDrawer, true, `${width}x${height}: drawer stays above the backdrop for interaction`);
        assert.equal(history.panelColor, "rgb(255, 255, 255)", `${width}x${height}: history panel stays opaque`);
        assert.ok(history.titleColor && history.panelBox.width <= width, `${width}x${height}: history panel fits the viewport`);
        assert.ok(history.exportBox.height >= 44 && history.copyBox.height >= 44 && history.deleteBox.height >= 44, `${width}x${height}: export, copy and delete controls meet 44px touch target`);
        assert.ok(history.exportBox.left >= 0 && history.exportBox.right <= width && history.copyBox.left >= 0 && history.copyBox.right <= width && history.deleteBox.left >= 0 && history.deleteBox.right <= width, `${width}x${height}: history actions stay inside the screen`);
        assert.ok(history.copyBox.top >= history.exportBox.bottom + 7, `${width}x${height}: export and copy actions have clear spacing`);
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
        const handlers = new Map();
        const map = {
          zoom: 15,
          bearing: 37,
          on(name, handler) { handlers.set(name, handler); },
          off(name) { handlers.delete(name); },
          fire(name) { handlers.get(name)?.(); },
          getZoom() { return map.zoom; }, getMinZoom() { return 2; }, getMaxZoom() { return 19; },
          setZoomAround(position, zoom) { map.fire("zoomstart"); map.zoom = zoom; map.fire("zoomend"); },
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
        const zoomControl = document.createElement("div");
        zoomControl.innerHTML = '<a href="#zoom-in" class="leaflet-control-zoom-in"></a><a href="#zoom-out" class="leaflet-control-zoom-out"></a>';
        window.WalkMapZoomControl.configure(zoomControl);
        document.body.append(zoomControl);
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
        follow.bindZoomControl(zoomControl);
        follow.setEnabled(true);
        const checks = [];
        for (const expedition of [false, true]) {
          document.body.classList.toggle("expedition-mode", expedition);
          for (const panelHeight of [Math.max(140, Math.round(innerHeight * .28)), Math.max(170, Math.round(innerHeight * .4))]) {
            panel.style.height = panelHeight + "px";
            map.zoom = 15;
            const position = { lat: 48.9, lng: 21.2, timestamp: Date.now() };
            follow.centerOn(position);
            const mapRect = mapElement.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();
            const markerRect = marker.getBoundingClientRect();
            const expected = { x: mapRect.left + mapRect.width / 2, y: (mapRect.top + Math.min(mapRect.bottom, Math.max(mapRect.top, panelRect.top))) / 2 };
            const actual = { x: markerRect.left + markerRect.width / 2, y: markerRect.top + markerRect.height / 2 };
            const markerPosition = () => { const rect = marker.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; };
            const controlButton = (direction) => zoomControl.querySelector(".leaflet-control-zoom-" + direction);
            const zoomResults = [];
            for (const direction of ["in", "in", "out"]) {
              const allowedByBrowser = controlButton(direction).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
              zoomResults.push({ direction, allowedByBrowser, point: markerPosition(), zoom: map.zoom });
            }
            map.fire("zoomstart");
            markerX += 24; markerY -= 17; map.zoom -= 1; setMarkerPoint();
            map.fire("zoomend");
            const afterPinch = markerPosition();
            follow.setEnabled(false);
            const disabledFollowClickAllowed = controlButton("in").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            if (disabledFollowClickAllowed) { map.zoom += 1; markerX += 9; markerY -= 6; setMarkerPoint(); }
            const disabledFollowPoint = markerPosition();
            follow.setEnabled(true);
            follow.centerOn(position);
            const resumedPoint = markerPosition();
            checks.push({ mode: expedition ? "expedition" : "territory", panelHeight: Math.round(panelRect.height), actual, expected, zoom: map.zoom, bearing: map.bearing, zoomResults, afterPinch, disabledFollowClickAllowed, disabledFollowPoint, resumedPoint });
          }
        }
        panel.style.removeProperty("height");
        zoomControl.remove();
        marker.remove();
        follow.dispose();
        return checks;
      })()`);
      for (const check of markerChecks) {
        assert.ok(Math.abs(check.actual.x - check.expected.x) <= 1, `${width}x${height} ${check.mode}: GPS marker x=${check.actual.x.toFixed(1)} expected ${check.expected.x.toFixed(1)}`);
        assert.ok(Math.abs(check.actual.y - check.expected.y) <= 1, `${width}x${height} ${check.mode} with ${check.panelHeight}px panel: GPS marker y=${check.actual.y.toFixed(1)} expected ${check.expected.y.toFixed(1)}`);
        assert.equal(check.zoom, 16, `${width}x${height} ${check.mode}: zoom controls and pinch completed at the expected level`);
        assert.equal(check.bearing, 37, `${width}x${height} ${check.mode}: bearing is preserved`);
        for (const zoom of check.zoomResults) {
          assert.equal(zoom.allowedByBrowser, false, `${width}x${height} ${check.mode}: follow zoom ${zoom.direction} uses the GPS anchor`);
          assert.ok(Math.abs(zoom.point.x - check.expected.x) <= 1 && Math.abs(zoom.point.y - check.expected.y) <= 1, `${width}x${height} ${check.mode}: GPS stays fixed through sequential ${zoom.direction} zoom`);
        }
        assert.ok(Math.abs(check.afterPinch.x - check.expected.x) <= 1 && Math.abs(check.afterPinch.y - check.expected.y) <= 1, `${width}x${height} ${check.mode}: pinch zoom preserves GPS screen position`);
        assert.equal(check.disabledFollowClickAllowed, true, `${width}x${height} ${check.mode}: disabled follow leaves Leaflet zoom click untouched`);
        assert.ok(check.disabledFollowPoint.x !== check.expected.x || check.disabledFollowPoint.y !== check.expected.y, `${width}x${height} ${check.mode}: disabled follow does not recenter during zoom`);
        assert.ok(Math.abs(check.resumedPoint.x - check.expected.x) <= 1 && Math.abs(check.resumedPoint.y - check.expected.y) <= 1, `${width}x${height} ${check.mode}: follow resumes at the current visible-area center`);
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
      t.diagnostic(`${width}x${height}: map ${baselineMapHeight}px; ${scenarios.length} UI states; zoom SVGs centered in measured 40x40 surface halves; GPS/compass centered; city coverage and controls avoid overlaps; territory fits above two panel heights`);
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
