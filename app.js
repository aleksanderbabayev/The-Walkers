(() => {
  "use strict";
  const DB_NAME = "the-walkers", DB_VERSION = 1;
  const AUTOSAVE_MS = 5000;
  const Tracking = window.WalkTracking, WalkStorage = window.WalkStorage;
  const $ = (id) => document.getElementById(id);
  const appVersion = document.querySelector('meta[name="app-version"]').content;
  $("appVersion").textContent = `Версия ${appVersion}`;
  const MUSIC_PREFERENCE_KEY = "the-walkers-music-muted";
  const backgroundMusic = $("backgroundMusic");
  let musicMuted = false;
  try { musicMuted = localStorage.getItem(MUSIC_PREFERENCE_KEY) === "true"; } catch {}
  backgroundMusic.volume = 0.18;
  const updateMusicButton = () => {
    const button = $("musicToggle");
    const isPlaying = !musicMuted && !backgroundMusic.paused;
    const label = musicMuted ? "Включить фоновую музыку" : isPlaying ? "Выключить фоновую музыку" : "Запустить фоновую музыку";
    button.textContent = musicMuted ? "🔇" : isPlaying ? "🔊" : "▶️";
    button.setAttribute("aria-pressed", String(isPlaying));
    button.setAttribute("aria-label", label);
    button.title = label;
  };
  const startBackgroundMusic = async () => {
    if (musicMuted) return;
    try { await backgroundMusic.play(); } catch {}
    updateMusicButton();
  };
  const unlockBackgroundMusic = (event) => {
    if (event.target.closest?.("#musicToggle")) return;
    if (!musicMuted) startBackgroundMusic().catch(() => {});
    document.removeEventListener("pointerdown", unlockBackgroundMusic, true);
    document.removeEventListener("keydown", unlockBackgroundMusic, true);
  };
  updateMusicButton();
  backgroundMusic.addEventListener("play", updateMusicButton);
  backgroundMusic.addEventListener("pause", updateMusicButton);
  startBackgroundMusic().catch(() => {});
  document.addEventListener("pointerdown", unlockBackgroundMusic, true);
  document.addEventListener("keydown", unlockBackgroundMusic, true);
  ["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
    document.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
  });
  $("musicToggle").addEventListener("click", async () => {
    if (!musicMuted && backgroundMusic.paused) {
      await startBackgroundMusic().catch(() => {});
      updateMusicButton();
      return;
    }
    musicMuted = !musicMuted;
    try { localStorage.setItem(MUSIC_PREFERENCE_KEY, String(musicMuted)); } catch {}
    if (musicMuted) backgroundMusic.pause();
    else await startBackgroundMusic().catch(() => {});
    updateMusicButton();
  });
  const isMobileViewport = () => window.matchMedia("(max-width: 760px)").matches;
  const syncMobileViewportHeight = () => {
    if (!isMobileViewport()) {
      document.documentElement.style.removeProperty("--visible-viewport-height");
      return;
    }
    const visibleHeight = Math.round(window.visualViewport?.height || window.innerHeight);
    document.documentElement.style.setProperty("--visible-viewport-height", `${visibleHeight}px`);
  };
  syncMobileViewportHeight();
  window.visualViewport?.addEventListener("resize", syncMobileViewportHeight);
  window.visualViewport?.addEventListener("scroll", syncMobileViewportHeight);
  window.addEventListener("resize", syncMobileViewportHeight);
  let previousMobileViewport = isMobileViewport();
  const setWalksDrawerOpen = (open, returnFocus = false) => {
    const drawerOpen = open && isMobileViewport();
    document.body.classList.toggle("walks-open", drawerOpen);
    $("walksToggle").setAttribute("aria-expanded", String(drawerOpen));
    $("walksDrawer").setAttribute("aria-hidden", String(isMobileViewport() && !drawerOpen));
    $("walksBackdrop").hidden = !drawerOpen;
    if (drawerOpen) $("walksClose").focus();
    else if (returnFocus) $("walksToggle").focus();
  };
  setWalksDrawerOpen(false);
  $("walksToggle").addEventListener("click", () => setWalksDrawerOpen(!document.body.classList.contains("walks-open")));
  $("walksClose").addEventListener("click", () => setWalksDrawerOpen(false, true));
  $("walksBackdrop").addEventListener("click", () => setWalksDrawerOpen(false, true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("walks-open")) setWalksDrawerOpen(false, true);
  });
  window.addEventListener("resize", () => {
    const mobileViewport = isMobileViewport();
    if (mobileViewport !== previousMobileViewport) {
      previousMobileViewport = mobileViewport;
      setWalksDrawerOpen(false);
    }
    syncMobileViewportHeight();
  });
  const map = L.map("map", { zoomControl: false }).setView([48.998, 21.239], 14);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  let db, storageReady = false, draftResolved = false, starting = false, finishing = false, cancelling = false;
  let recordingActive = false, warmingUp = false, points = [], distanceMetersTotal = 0, currentLines = [], savedLayers = [], stopwatchTimer = null, startedAt = null;
  let trackingQueue = Promise.resolve();
  const positionFilter = Tracking.createPositionFilter();
  const gpsWarmup = Tracking.createGpsWarmup();
  const initialRouteBuffer = Tracking.createInitialRouteBuffer();
  let currentLocationMarker = null;
  let locationState = "loading", latestLocation = null, locationRequestPending = false;
  let locationWaitStartedAt = Date.now(), locationRequestToken = 0, locationTimeoutTimer = null;
  const LOCATION_WAIT_TIMEOUT_MS = 20000;
  const LOCATION_REFRESH_INTERVAL_MS = 5000;
  const mapDiagnosticsEnabled = new URLSearchParams(window.location.search).get("mapDebug") === "1";
  const updateLocationMarker = (point) => {
    const latlng = [point.lat, point.lng];
    if (currentLocationMarker) currentLocationMarker.setLatLng(latlng);
    else currentLocationMarker = L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 3, fillColor: "#2877df", fillOpacity: 1 }).addTo(map);
  };
  const clearLocationMarker = () => {
    if (currentLocationMarker) map.removeLayer(currentLocationMarker);
    currentLocationMarker = null;
  };
  const reportMapDiagnostics = (reason, point) => {
    if (!mapDiagnosticsEnabled) return;
    const center = map.getCenter(), size = map.getSize(), rect = map.getContainer().getBoundingClientRect();
    console.info("[The Walkers map]", {
      reason,
      requestedCenterErrorMeters: point ? Math.round(Tracking.distanceMeters(point, { lat: center.lat, lng: center.lng })) : null,
      leafletSize: { width: size.x, height: size.y },
      containerSize: { width: Math.round(rect.width), height: Math.round(rect.height) },
      visualViewport: { width: window.visualViewport?.width, height: window.visualViewport?.height }
    });
  };
  const refreshMapLayout = () => {
    if (document.visibilityState === "hidden") return;
    syncMobileViewportHeight();
    requestAnimationFrame(() => {
      map.invalidateSize({ pan: false });
      reportMapDiagnostics("layout-refresh", null);
    });
  };
  document.addEventListener("visibilitychange", refreshMapLayout);
  window.addEventListener("pageshow", refreshMapLayout);
  window.addEventListener("focus", refreshMapLayout);
  window.visualViewport?.addEventListener("resize", refreshMapLayout);
  const mapResizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refreshMapLayout);
  mapResizeObserver?.observe(map.getContainer());
  const centerMapOnPosition = (point, requestId) => {
    syncMobileViewportHeight();
    requestAnimationFrame(() => {
      if (requestId !== locateRequestId) return;
      map.invalidateSize({ pan: false });
      map.setView([point.lat, point.lng], map.getZoom(), { animate: false });
      updateLocationMarker(point);
      reportMapDiagnostics("locate", point);
    });
  };
  const openDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("walks")) database.createObjectStore("walks", { keyPath: "id" });
      if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const distanceForPoints = Tracking.distanceForPoints;
  const formatKilometers = (meters) => `${(Math.max(0, meters) / 1000).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} км`;
  const durationOfWalk = (walk) => Number.isFinite(walk.durationMs) ? Math.max(0, walk.durationMs) : Math.max(0, (walk.finishedAt || 0) - (walk.startedAt || 0));
  const say = (message) => { $("message").textContent = message; };
  const updateLocateButton = (state) => {
    const previousState = locationState;
    locationState = state;
    const button = $("locate");
    button.classList.toggle("is-locating", state === "loading");
    button.classList.toggle("is-ready", state === "ready");
    button.classList.toggle("is-error", state === "error");
    button.textContent = state === "error" ? "↻" : "◎";
    button.setAttribute("aria-busy", String(state === "loading"));
    const label = state === "ready" ? "Центрировать карту на вашем местоположении"
      : state === "error" ? "Повторить определение местоположения" : "Определяем ваше местоположение";
    button.setAttribute("aria-label", label);
    button.title = label;
    if (state === "loading" && previousState !== "loading") locationWaitStartedAt = Date.now();
  };
  const cancelPendingLocationRequest = () => {
    locationRequestToken += 1;
    if (locationTimeoutTimer !== null) clearTimeout(locationTimeoutTimer);
    locationTimeoutTimer = null; locationRequestPending = false;
  };
  const currentLocationErrorMessage = (error) => {
    if (error?.code === 1) return "Нет доступа к геолокации. Разрешите её в настройках браузера и нажмите кнопку для повтора.";
    if (error?.code === 3) return "Не удалось определить местоположение вовремя. Нажмите кнопку, чтобы попробовать ещё раз.";
    return "GPS временно недоступен. Проверьте геолокацию и нажмите кнопку для повтора.";
  };
  const requestCurrentLocation = () => {
    if (!navigator.geolocation) {
      locationRequestPending = false; latestLocation = null; updateLocateButton("error");
      say("Геолокация недоступна в этом браузере. Проверьте разрешения или используйте другой браузер.");
      return;
    }
    if (locationRequestPending) return;
    locationRequestPending = true;
    updateLocateButton("loading");
    const token = ++locationRequestToken;
    const finishRequest = () => {
      if (locationTimeoutTimer !== null) clearTimeout(locationTimeoutTimer);
      locationTimeoutTimer = null; locationRequestPending = false;
    };
    locationTimeoutTimer = setTimeout(() => {
      if (token !== locationRequestToken) return;
      locationRequestToken += 1;
      finishRequest(); latestLocation = null; updateLocateButton("error");
      say("Не удалось определить местоположение вовремя. Нажмите кнопку, чтобы попробовать ещё раз.");
    }, LOCATION_WAIT_TIMEOUT_MS);
    try { navigator.geolocation.getCurrentPosition((position) => {
      if (token !== locationRequestToken) return;
      finishRequest();
      if (recordingActive || warmingUp || starting) return;
      const result = Tracking.evaluateLocationPosition(position, Date.now());
      if (!result.accepted) {
        latestLocation = null;
        updateLocateButton("error");
        say(result.reason === "accuracy"
          ? `Сигнал GPS пока неточный (±${Math.round(position.coords.accuracy)} м). Подождите и нажмите кнопку для повтора.`
          : "Получены устаревшие координаты. Нажмите кнопку, чтобы определить местоположение ещё раз.");
        return;
      }
      rememberLocation(result.point);
    }, (error) => {
      if (token !== locationRequestToken) return;
      finishRequest(); latestLocation = null; updateLocateButton("error");
      say(currentLocationErrorMessage(error));
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: LOCATION_WAIT_TIMEOUT_MS }); }
    catch {
      if (token !== locationRequestToken) return;
      finishRequest(); latestLocation = null; updateLocateButton("error");
      say("GPS временно недоступен. Проверьте настройки геолокации и попробуйте ещё раз.");
    }
  };
  const locationIsFresh = (point, now = Date.now()) => point && point.accuracy <= Tracking.LOCATION_DEFAULTS.maxAccuracyMeters
    && now - point.timestamp >= -Tracking.DEFAULTS.futureToleranceMs
    && now - point.timestamp <= Tracking.LOCATION_DEFAULTS.maxAgeMs;
  const rememberLocation = (point) => {
    if (locationRequestPending) {
      locationRequestToken += 1;
      if (locationTimeoutTimer !== null) clearTimeout(locationTimeoutTimer);
      locationTimeoutTimer = null; locationRequestPending = false;
    }
    latestLocation = point;
    updateLocateButton("ready");
    if ($("message").textContent.startsWith("📡 Определяем ваше местоположение.")) say("");
  };
  const refreshLocationReadiness = () => {
    if (locationState === "ready" && !locationIsFresh(latestLocation)) {
      latestLocation = null;
      updateLocateButton("loading");
      if (!recordingActive && !warmingUp) requestCurrentLocation();
    }
    if (locationState === "loading" && !locationRequestPending && Date.now() - locationWaitStartedAt >= LOCATION_WAIT_TIMEOUT_MS) {
      updateLocateButton("error");
      say("Не удалось получить свежий GPS-сигнал. Нажмите кнопку, чтобы попробовать ещё раз.");
    }
  };
  const handleLocationResume = () => {
    if (document.visibilityState === "hidden") return;
    refreshLocationReadiness();
    if (locationState === "loading" && !locationRequestPending && !recordingActive && !warmingUp) requestCurrentLocation();
  };
  document.addEventListener("visibilitychange", handleLocationResume);
  window.addEventListener("pageshow", handleLocationResume);
  updateLocateButton("loading");
  setInterval(refreshLocationReadiness, LOCATION_REFRESH_INTERVAL_MS);
  requestCurrentLocation();
  const formatElapsed = (milliseconds) => {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor(totalSeconds / 60) % 60).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  };
  const updateStopwatch = (at = Date.now()) => {
    if (startedAt !== null) $("elapsed").textContent = formatElapsed(at - startedAt);
  };
  const updateDistance = () => { $("distance").textContent = formatKilometers(distanceMetersTotal); };
  const startStopwatch = () => {
    clearInterval(stopwatchTimer);
    updateStopwatch();
    stopwatchTimer = setInterval(updateStopwatch, 1000);
  };
  const stopStopwatch = (at = Date.now()) => {
    updateStopwatch(at);
    clearInterval(stopwatchTimer);
    stopwatchTimer = null;
  };
  const setRecording = (active) => {
    recordingActive = active;
    const inProgress = active || warmingUp || cancelling;
    document.querySelector(".status").classList.toggle("recording", active);
    $("statusTitle").textContent = active ? "Идёт захват территории" : warmingUp ? "Стабилизация GPS" : cancelling ? "Отступление" : "Готовы к прогулке?";
    $("statusText").textContent = active ? "Точки сохраняются на устройстве" : warmingUp ? "Стабилизация GPS. Подождите перед началом движения…" : cancelling ? "Останавливаем GPS и удаляем черновик…" : "Нажмите «Начать захват территории», чтобы записать маршрут";
    $("start").disabled = inProgress || !storageReady || !draftResolved || starting || finishing;
    $("start").hidden = inProgress;
    $("abandonWalk").hidden = !(active || warmingUp);
    $("abandonLabel").textContent = warmingUp ? "Отмена" : "Отступить";
    $("abandonWalk").disabled = cancelling || finishing;
    $("finish").disabled = !active || finishing;
    $("finish").hidden = !active;
  };
  const draftSnapshot = (nextPoints = points, nextStartedAt = startedAt, nextInitialBuffer = initialRouteBuffer.snapshot()) => ({
    id: "active", points: nextPoints, startedAt: nextStartedAt, updatedAt: Date.now(),
    ...(nextInitialBuffer.length ? { initialBuffer: nextInitialBuffer } : {})
  });
  const saveDraftSnapshot = (nextPoints = points, nextStartedAt = startedAt, nextInitialBuffer = initialRouteBuffer.snapshot()) => WalkStorage.writeDraft(db, draftSnapshot(nextPoints, nextStartedAt, nextInitialBuffer));
  const enqueueTrackingTask = (task) => {
    const pending = trackingQueue.then(task);
    trackingQueue = pending.catch((error) => say(`Не удалось сохранить прогулку: ${error.message || "ошибка IndexedDB"}.`));
    return pending;
  };
  const drawCurrent = () => {
    currentLines.forEach((line) => map.removeLayer(line));
    currentLines = Tracking.splitSegments(points).filter((segment) => segment.length > 1).map((segment) => {
      return L.polyline(segment.map((point) => [point.lat, point.lng]), { color: "#e0765d", weight: 4 }).addTo(map);
    });
  };
  const redrawSaved = async () => {
    savedLayers.forEach((layer) => map.removeLayer(layer));
    savedLayers = [];
    const walks = await WalkStorage.readWalks(db);
    walks.sort((a, b) => b.finishedAt - a.finishedAt);
    const totalDistance = walks.reduce((total, walk) => total + (Number.isFinite(walk.distanceMeters) ? Math.max(0, walk.distanceMeters) : distanceForPoints(walk.points || [])), 0);
    const totalDuration = walks.reduce((total, walk) => total + durationOfWalk(walk), 0);
    $("totalDistance").textContent = formatKilometers(totalDistance);
    $("totalDuration").textContent = formatElapsed(totalDuration);
    $("count").textContent = walks.length;
    $("walkCountToggle").textContent = walks.length;
    const list = $("routes");
    list.replaceChildren();
    if (!walks.length) {
      const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Здесь появятся ваши маршруты и территории"; list.append(empty); return;
    }
    walks.forEach((walk, index) => {
      const segments = Tracking.splitSegments(walk.points || []);
      const layers = !Tracking.shouldDisplayWalkOnMap(walk) ? [] : walk.closed
        ? [L.polygon((walk.points || []).map((point) => [point.lat, point.lng]), { color: "#477b43", weight: 3, fillColor: "#8fbd70", fillOpacity: 0.35 })]
        : segments.filter((segment) => segment.length > 1).map((segment) => L.polyline(segment.map((point) => [point.lat, point.lng]), { color: "#e0765d", weight: 4 }));
      layers.forEach((layer) => { layer.addTo(map); savedLayers.push(layer); });
      const row = document.createElement("div"); row.className = "route";
      const icon = document.createElement("span"); icon.className = "routeIcon"; icon.textContent = walk.closed ? "⬟" : "↗";
      const details = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = `${walk.closed ? "Захваченная территория" : "Маршрут"} ${walks.length - index}`;
      const distance = Number.isFinite(walk.distanceMeters) ? Math.max(0, walk.distanceMeters) : distanceForPoints(walk.points || []);
      const meta = document.createElement("small"); meta.textContent = `${new Date(walk.finishedAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })} · ${formatElapsed(durationOfWalk(walk))} · ${formatKilometers(distance)} · ${walk.points.length} точек`;
      details.append(title, meta);
      const deleteButton = document.createElement("button"); deleteButton.className = "routeDelete"; deleteButton.type = "button";
      deleteButton.textContent = "Удалить"; deleteButton.dataset.walkId = walk.id;
      deleteButton.setAttribute("aria-label", `Удалить: ${title.textContent}`);
      row.append(icon, details, deleteButton); list.append(row);
    });
    if (!points.length) {
      const group = L.featureGroup(savedLayers);
      if (group.getBounds().isValid()) map.fitBounds(group.getBounds().pad(0.15), { maxZoom: 16 });
    }
  };
  $("routes").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-walk-id]");
    if (!button || !confirm("Удалить эту прогулку или территорию? Это действие нельзя отменить.")) return;
    button.disabled = true;
    try {
      await WalkStorage.deleteWalk(db, button.dataset.walkId);
    } catch {
      button.disabled = false;
      say("Не удалось удалить запись. Она сохранена.");
      return;
    }
    try { await redrawSaved(); say("Запись удалена."); }
    catch { say("Запись удалена, но список не удалось обновить."); }
  });
  const processPosition = async (position) => {
    if (finishing || cancelling) return;
    if (warmingUp) {
      const warmup = gpsWarmup.add(position, Date.now());
      if (!warmup.stable) {
        if (warmup.reason === "accuracy") say(`GPS неточный (±${Math.round(position.coords.accuracy)} м). Стабилизируем сигнал…`);
        else if (warmup.reason === "stale") say("GPS прислал устаревшую точку. Ждём свежий сигнал…");
        return;
      }

      const initialPoint = { ...warmup.point, segmentStart: true };
      gpsWarmup.reset();
      const recordingStartedAt = Date.now();
      initialRouteBuffer.begin(initialPoint);
      try { await saveDraftSnapshot([], recordingStartedAt, initialRouteBuffer.snapshot()); }
      catch { initialRouteBuffer.reset(); gpsWarmup.reset(); say("Не удалось сохранить начало прогулки. Продолжаем стабилизацию GPS…"); return; }
      if (!warmingUp || cancelling) return;

      points = []; startedAt = recordingStartedAt; distanceMetersTotal = 0;
      warmingUp = false; updateDistance(); rememberLocation(initialPoint); updateLocationMarker(initialPoint);
      $("gps").textContent = `±${Math.round(initialPoint.accuracy)} м`;
      setRecording(true); startStopwatch(); say("GPS готов. Можно идти!");
      return;
    }
    if (!recordingActive) return;
    const bufferingInitial = initialRouteBuffer.pending;
    const previousInitialBuffer = bufferingInitial ? initialRouteBuffer.snapshot() : [];
    const result = bufferingInitial
      ? initialRouteBuffer.add(position, Date.now())
      : positionFilter.evaluate(position, points.at(-1), Date.now());
    if (!result.accepted) {
      if (Number.isFinite(position.coords?.accuracy)) $("gps").textContent = `±${Math.round(position.coords.accuracy)} м`;
      if (result.reason === "accuracy") say(`GPS неточный (±${Math.round(position.coords.accuracy)} м). Ждём более точную позицию.`);
      else if (result.reason === "speed") say("GPS скачок отброшен. Ждём стабильную позицию.");
      else if (result.reason === "confirm") say("После перерыва проверяем новую GPS-позицию…");
      return;
    }

    if (bufferingInitial) {
      if (!result.ready) {
        try { await saveDraftSnapshot(points, startedAt, result.bufferedPoints); }
        catch {
          initialRouteBuffer.restore(previousInitialBuffer);
          say("Начальная GPS-точка не сохранена. Продолжаем проверку сигнала…");
          return;
        }
        const lastValidatedPoint = result.validatedPoints.at(-1);
        if (lastValidatedPoint) {
          rememberLocation(lastValidatedPoint);
          updateLocationMarker(lastValidatedPoint);
        }
        return;
      }
      const nextPoints = [...points, ...result.validatedPoints];
      try { await saveDraftSnapshot(nextPoints, startedAt, []); }
      catch {
        initialRouteBuffer.restore(previousInitialBuffer);
        say("Начальный участок не удалось сохранить. Продолжаем проверку сигнала…");
        return;
      }
      initialRouteBuffer.reset(); positionFilter.reset();
      points = nextPoints; distanceMetersTotal = distanceForPoints(points);
      const lastValidatedPoint = result.validatedPoints.at(-1);
      drawCurrent(); updateDistance();
      if (lastValidatedPoint) {
        rememberLocation(lastValidatedPoint);
        updateLocationMarker(lastValidatedPoint);
      }
      return;
    }

    const nextPoints = [...points, ...(result.points || [result.point])];
    try { await saveDraftSnapshot(nextPoints, startedAt); }
    catch { say("Точка не записана: не удалось сохранить черновик на устройстве."); return; }

    points = nextPoints;
    distanceMetersTotal += result.distanceMeters;
    rememberLocation(result.point);
    drawCurrent(); updateDistance(); updateLocationMarker(result.point);
    $("gps").textContent = `±${Math.round(result.point.accuracy)} м`;
    if (result.newSegment && points.length > 1) say("После перерыва начат новый участок маршрута.");
  };
  const receivePosition = (position) => enqueueTrackingTask(() => processPosition(position));
  const onLocationError = (error) => {
    cancelPendingLocationRequest();
    latestLocation = null;
    updateLocateButton("error");
    if (cancelling) return;
    if (warmingUp) {
      gpsWarmup.reset();
      say(error.code === 1
        ? "Разрешите доступ к геолокации. Незавершённая прогулка сохранена."
        : "GPS-сигнал прервался. Стабилизация начнётся заново…");
      return;
    }
    say(currentLocationErrorMessage(error));
  };
  const gpsServices = Tracking.createGpsServices({
    geolocation: navigator.geolocation,
    onPosition: receivePosition,
    onError: onLocationError,
    onAutosave: () => {
      if ((recordingActive || warmingUp) && !finishing) enqueueTrackingTask(() => saveDraftSnapshot()).catch(() => say("Не удалось сохранить черновик прогулки."));
    },
    intervalMs: AUTOSAVE_MS
  });
  const startTrackingServices = () => gpsServices.start();
  const stopTrackingServices = () => gpsServices.stop();
  const resumeAfterFinishFailure = (message) => {
    positionFilter.reset();
    gpsWarmup.reset();
    warmingUp = false;
    finishing = false;
    try {
      startTrackingServices();
      setRecording(true);
      say(message);
    } catch {
      draftResolved = false;
      setRecording(false);
      say("Черновик сохранён, но GPS не удалось возобновить. Перезагрузите страницу, чтобы восстановить прогулку.");
    }
  };
  const startWalk = async () => {
    if (!navigator.geolocation) { say("Этот браузер не поддерживает геолокацию."); return; }
    if (!storageReady || !draftResolved || starting || recordingActive || warmingUp || finishing || cancelling) return;
    positionFilter.reset(); gpsWarmup.reset(); initialRouteBuffer.reset();
    latestLocation = null; updateLocateButton("loading"); clearLocationMarker();
    starting = true; setRecording(false);
    cancelPendingLocationRequest();
    locateRequestId += 1;
    const newStartedAt = Date.now();
    try {
      await WalkStorage.createDraft(db, draftSnapshot([], newStartedAt));
    } catch {
      gpsWarmup.reset();
      starting = false; draftResolved = false; setRecording(false);
      say("Найдена незавершённая прогулка или хранилище недоступно. Перезагрузите страницу, чтобы восстановить черновик.");
      return;
    }
    points = []; distanceMetersTotal = 0; updateDistance(); startedAt = newStartedAt;
    warmingUp = true;
    try {
      startTrackingServices();
      starting = false; setRecording(false); say("");
    } catch {
      positionFilter.reset(); initialRouteBuffer.reset();
      gpsWarmup.reset(); warmingUp = false;
      stopTrackingServices();
      try { await WalkStorage.deleteDraft(db); draftResolved = true; }
      catch { draftResolved = false; }
      points = []; startedAt = null; starting = false; setRecording(false);
      say("Не удалось запустить GPS. Черновик сохранён, если его не удалось удалить.");
    }
  };
  const abandonWalk = async () => {
    if ((!warmingUp && !recordingActive) || cancelling || finishing) return;
    if (recordingActive && !confirm("Отступить и удалить текущую прогулку? Она не попадёт в историю.")) return;
    cancelling = true; warmingUp = false;
    positionFilter.reset(); gpsWarmup.reset(); stopTrackingServices();
    locateRequestId += 1;
    setRecording(false); clearActiveWalkView(); say("");
    try {
      await trackingQueue;
      await WalkStorage.deleteDraft(db);
      clearActiveWalkView();
      draftResolved = true; starting = false; cancelling = false;
      setRecording(false); say("");
    } catch {
      clearActiveWalkView();
      draftResolved = false; starting = false; cancelling = false;
      setRecording(false);
      say("Не удалось удалить черновик. Он сохранён; перезагрузите страницу, чтобы восстановить или удалить прогулку.");
    }
  };
  const clearActiveWalkView = () => {
    points = []; distanceMetersTotal = 0; startedAt = null;
    initialRouteBuffer.reset();
    clearInterval(stopwatchTimer); stopwatchTimer = null;
    $("elapsed").textContent = "00:00:00";
    $("gps").textContent = "GPS";
    updateDistance();
    currentLines.forEach((line) => map.removeLayer(line)); currentLines = [];
  };
  const finishWalk = async () => {
    if (!recordingActive || finishing || cancelling) return;
    positionFilter.reset(); gpsWarmup.reset();
    finishing = true; setRecording(true); stopTrackingServices();
    try {
      await trackingQueue;
      const bufferedPoints = initialRouteBuffer.pending ? initialRouteBuffer.flush().points : [];
      const finishedPoints = [...points, ...bufferedPoints];
      const finishedDistance = distanceForPoints(finishedPoints);
      if (finishedPoints.length < 2) {
        resumeAfterFinishFailure("Нужно ещё GPS-точек для сохранения. Продолжаем запись.");
        return;
      }
      const finishedAt = Date.now();
      const closed = Tracking.canCloseTrack(finishedPoints);
      const walk = { id: crypto.randomUUID(), points: finishedPoints, startedAt, finishedAt, durationMs: finishedAt - startedAt, distanceMeters: finishedDistance, closed, showOnMap: closed };
      await WalkStorage.completeWalk(db, walk);
      stopStopwatch(finishedAt);
      points = []; distanceMetersTotal = 0; startedAt = null; draftResolved = true; finishing = false; updateDistance();
      initialRouteBuffer.reset();
      currentLines.forEach((line) => map.removeLayer(line)); currentLines = [];
      say(closed ? "Маршрут замкнут, территория закрашена." : "Контур не замкнулся — захват не состоялся.");
      setRecording(false);
      try { await redrawSaved(); } catch { say("Прогулка сохранена, но список не удалось обновить."); }
    } catch { resumeAfterFinishFailure("Не удалось завершить прогулку. Черновик сохранён, запись продолжается."); }
  };
  $("start").addEventListener("click", startWalk);
  $("abandonWalk").addEventListener("click", abandonWalk);
  $("finish").addEventListener("click", finishWalk);
  let locateRequestId = 0;
  $("locate").addEventListener("click", () => {
    const requestId = ++locateRequestId;
    if (recordingActive || warmingUp || starting) {
      if (locationIsFresh(latestLocation)) centerMapOnPosition(latestLocation, requestId);
      else say("📡 Определяем ваше местоположение. Пожалуйста, подождите.");
      return;
    }
    if (locationState === "loading") {
      say("📡 Определяем ваше местоположение. Пожалуйста, подождите.");
      return;
    }
    if (locationState === "error") {
      say("📡 Определяем ваше местоположение. Пожалуйста, подождите.");
      requestCurrentLocation();
      return;
    }
    if (!locationIsFresh(latestLocation)) {
      latestLocation = null;
      updateLocateButton("loading");
      say("📡 Определяем ваше местоположение. Пожалуйста, подождите.");
      requestCurrentLocation();
      return;
    }
    centerMapOnPosition(latestLocation, requestId);
    say("");
  });
  (async () => {
    try {
      db = await openDb();
      const draft = await WalkStorage.readDraft(db);
      await redrawSaved();
      storageReady = true;
      if (draft) {
        positionFilter.reset(); gpsWarmup.reset();
        draftResolved = false;
        const draftPoints = Array.isArray(draft.points) ? draft.points : [];
        const draftInitialBuffer = Array.isArray(draft.initialBuffer) ? draft.initialBuffer : [];
        const wasWarmingUp = draftPoints.length === 0 && draftInitialBuffer.length === 0;
        const resume = confirm(wasWarmingUp
          ? "Найдена незавершённая стабилизация GPS. Продолжить?"
          : "Найдена незавершённая прогулка. Продолжить запись?");
        if (resume) {
          if (!navigator.geolocation) {
            say("Геолокация недоступна в этом браузере. Черновик сохранён для восстановления в другом браузере.");
            setRecording(false);
            return;
          }
          locateRequestId += 1;
          points = draftPoints;
          initialRouteBuffer.restore(draftInitialBuffer);
          latestLocation = null; updateLocateButton("loading"); clearLocationMarker();
          distanceMetersTotal = distanceForPoints(points);
          startedAt = Number.isFinite(draft.startedAt) ? draft.startedAt : Date.now();
          warmingUp = wasWarmingUp;
          updateDistance(); drawCurrent();
          const restoredValidatedPoints = points.length ? points : initialRouteBuffer.flush().points;
          if (restoredValidatedPoints.length) {
            rememberLocation(restoredValidatedPoints.at(-1));
            updateLocationMarker(restoredValidatedPoints.at(-1));
          }
          draftResolved = true;
          try {
            startTrackingServices();
            setRecording(!warmingUp);
            if (warmingUp) say("");
            else { startStopwatch(); say("Прогулка восстановлена. Ожидаем свежую GPS-точку…"); }
          } catch {
            positionFilter.reset(); gpsWarmup.reset(); initialRouteBuffer.reset(); warmingUp = false;
            stopTrackingServices(); draftResolved = false; setRecording(false);
            say("Черновик сохранён, но GPS не удалось запустить. Перезагрузите страницу, чтобы попробовать снова.");
          }
        } else {
          try { await WalkStorage.deleteDraft(db); draftResolved = true; }
          catch {
            draftResolved = false;
            say("Черновик не удалось удалить. Он сохранён, чтобы не потерять прогулку.");
          }
        }
      } else draftResolved = true;
      setRecording(recordingActive);
    } catch {
      positionFilter.reset(); gpsWarmup.reset(); initialRouteBuffer.reset(); warmingUp = false;
      storageReady = false; draftResolved = false; setRecording(false);
      say("IndexedDB недоступна. Попробуйте открыть приложение в современном браузере по HTTPS.");
    }
  })();
})();
