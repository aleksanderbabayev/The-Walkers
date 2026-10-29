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

  let db, storageReady = false, draftResolved = false, starting = false, finishing = false;
  let recordingActive = false, warmingUp = false, points = [], distanceMetersTotal = 0, currentLines = [], savedLayers = [], stopwatchTimer = null, startedAt = null;
  let trackingQueue = Promise.resolve(), pendingLocateRequestId = null;
  const positionFilter = Tracking.createPositionFilter();
  const gpsWarmup = Tracking.createGpsWarmup();
  let currentLocationMarker = null;
  const mapDiagnosticsEnabled = new URLSearchParams(window.location.search).get("mapDebug") === "1";
  const updateLocationMarker = (point) => {
    const latlng = [point.lat, point.lng];
    if (currentLocationMarker) currentLocationMarker.setLatLng(latlng);
    else currentLocationMarker = L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 3, fillColor: "#2877df", fillOpacity: 1 }).addTo(map);
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
    const inProgress = active || warmingUp;
    document.querySelector(".status").classList.toggle("recording", active);
    $("statusTitle").textContent = active ? "Идёт захват территории" : warmingUp ? "Стабилизация GPS" : "Готовы к прогулке?";
    $("statusText").textContent = active ? "Точки сохраняются на устройстве" : warmingUp ? "Стабилизация GPS. Подождите перед началом движения…" : "Нажмите «Начать захват территории», чтобы записать маршрут";
    $("start").disabled = inProgress || !storageReady || !draftResolved || starting || finishing;
    $("start").hidden = inProgress;
    $("finish").disabled = !active || finishing;
    $("finish").hidden = !active;
  };
  const draftSnapshot = (nextPoints = points, nextStartedAt = startedAt) => ({ id: "active", points: nextPoints, startedAt: nextStartedAt, updatedAt: Date.now() });
  const saveDraftSnapshot = (nextPoints = points, nextStartedAt = startedAt) => WalkStorage.writeDraft(db, draftSnapshot(nextPoints, nextStartedAt));
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
      const layers = walk.closed
        ? [L.polygon((walk.points || []).map((point) => [point.lat, point.lng]), { color: "#477b43", weight: 3, fillColor: "#8fbd70", fillOpacity: 0.35 })]
        : segments.filter((segment) => segment.length > 1).map((segment) => L.polyline(segment.map((point) => [point.lat, point.lng]), { color: "#e0765d", weight: 4 }));
      layers.forEach((layer) => { layer.addTo(map); savedLayers.push(layer); });
      const row = document.createElement("div"); row.className = "route";
      const icon = document.createElement("span"); icon.className = "routeIcon"; icon.textContent = walk.closed ? "⬟" : "↗";
      const details = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = `${walk.closed ? "Захваченная территория" : "Маршрут"} ${walks.length - index}`;
      const distance = Number.isFinite(walk.distanceMeters) ? Math.max(0, walk.distanceMeters) : distanceForPoints(walk.points || []);
      const meta = document.createElement("small"); meta.textContent = `${new Date(walk.finishedAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })} · ${formatElapsed(durationOfWalk(walk))} · ${formatKilometers(distance)} · ${walk.points.length} точек`;
      details.append(title, meta); row.append(icon, details); list.append(row);
    });
    if (!points.length) {
      const group = L.featureGroup(savedLayers);
      if (group.getBounds().isValid()) map.fitBounds(group.getBounds().pad(0.15), { maxZoom: 16 });
    }
  };
  const processPosition = async (position) => {
    if (finishing) return;
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
      try { await saveDraftSnapshot([initialPoint], recordingStartedAt); }
      catch { gpsWarmup.reset(); say("Не удалось сохранить начало прогулки. Продолжаем стабилизацию GPS…"); return; }

      points = [initialPoint]; startedAt = recordingStartedAt; distanceMetersTotal = 0;
      warmingUp = false; updateDistance(); updateLocationMarker(initialPoint);
      $("gps").textContent = `±${Math.round(initialPoint.accuracy)} м`;
      setRecording(true); startStopwatch(); say("GPS готов. Можно идти!");
      return;
    }
    if (!recordingActive) return;
    const result = positionFilter.evaluate(position, points.at(-1), Date.now());
    if (!result.accepted) {
      if (Number.isFinite(position.coords?.accuracy)) $("gps").textContent = `±${Math.round(position.coords.accuracy)} м`;
      if (result.reason === "accuracy") say(`GPS неточный (±${Math.round(position.coords.accuracy)} м). Ждём более точную позицию.`);
      else if (result.reason === "speed") say("GPS скачок отброшен. Ждём стабильную позицию.");
      else if (result.reason === "confirm") say("После перерыва проверяем новую GPS-позицию…");
      return;
    }

    const nextPoints = [...points, ...(result.points || [result.point])];
    try { await saveDraftSnapshot(nextPoints, startedAt); }
    catch { say("Точка не записана: не удалось сохранить черновик на устройстве."); return; }

    points = nextPoints;
    distanceMetersTotal += result.distanceMeters;
    drawCurrent(); updateDistance(); updateLocationMarker(result.point);
    $("gps").textContent = `±${Math.round(result.point.accuracy)} м`;
    if (result.newSegment && points.length > 1) say("После перерыва начат новый участок маршрута.");
    if (pendingLocateRequestId !== null) {
      const requestId = pendingLocateRequestId;
      pendingLocateRequestId = null;
      if (requestId === locateRequestId) centerMapOnPosition(result.point, requestId);
    }
  };
  const receivePosition = (position) => enqueueTrackingTask(() => processPosition(position));
  const onLocationError = (error) => {
    if (warmingUp) {
      gpsWarmup.reset();
      say(error.code === 1
        ? "Разрешите доступ к геолокации. Незавершённая прогулка сохранена."
        : "GPS-сигнал прервался. Стабилизация начнётся заново…");
      return;
    }
    const message = error.code === 1 ? "Разрешите доступ к геолокации в настройках браузера." : "Нет GPS-сигнала. Проверьте геолокацию и попробуйте выйти на открытое место.";
    say(message);
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
    if (!storageReady || !draftResolved || starting || recordingActive || finishing) return;
    positionFilter.reset(); gpsWarmup.reset();
    starting = true; setRecording(false);
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
      positionFilter.reset();
      gpsWarmup.reset(); warmingUp = false;
      stopTrackingServices();
      try { await WalkStorage.deleteDraft(db); draftResolved = true; }
      catch { draftResolved = false; }
      points = []; startedAt = null; starting = false; setRecording(false);
      say("Не удалось запустить GPS. Черновик сохранён, если его не удалось удалить.");
    }
  };
  const finishWalk = async () => {
    if (!recordingActive || finishing) return;
    positionFilter.reset(); gpsWarmup.reset();
    finishing = true; setRecording(true); stopTrackingServices();
    try {
      await trackingQueue;
      if (points.length < 2) {
        resumeAfterFinishFailure("Нужно ещё GPS-точек для сохранения. Продолжаем запись.");
        return;
      }
      const finishedAt = Date.now();
      const closed = Tracking.canCloseTrack(points);
      const walk = { id: crypto.randomUUID(), points, startedAt, finishedAt, durationMs: finishedAt - startedAt, distanceMeters: distanceMetersTotal, closed };
      await WalkStorage.completeWalk(db, walk);
      stopStopwatch(finishedAt);
      points = []; distanceMetersTotal = 0; startedAt = null; draftResolved = true; finishing = false; updateDistance();
      currentLines.forEach((line) => map.removeLayer(line)); currentLines = [];
      say(closed ? "Маршрут замкнут, территория закрашена." : "Маршрут сохранён как линия.");
      setRecording(false);
      try { await redrawSaved(); } catch { say("Прогулка сохранена, но список не удалось обновить."); }
    } catch { resumeAfterFinishFailure("Не удалось завершить прогулку. Черновик сохранён, запись продолжается."); }
  };
  $("start").addEventListener("click", startWalk);
  $("finish").addEventListener("click", finishWalk);
  let locateRequestId = 0;
  $("locate").addEventListener("click", () => {
    const requestId = ++locateRequestId;
    if (recordingActive) {
      const latestRoutePoint = points.at(-1);
      if (!latestRoutePoint) return say("Ожидаем первую GPS-точку маршрута.");
      if (latestRoutePoint.accuracy > Tracking.DEFAULTS.maxAccuracyMeters) return say(`Последняя GPS-точка неточная (±${Math.round(latestRoutePoint.accuracy)} м).`);
      if (!Number.isFinite(latestRoutePoint.timestamp) || Date.now() - latestRoutePoint.timestamp > Tracking.DEFAULTS.maxAgeMs) {
        pendingLocateRequestId = requestId;
        return say("Ожидаем свежую GPS-точку для центрирования карты…");
      }
      centerMapOnPosition(latestRoutePoint, requestId);
      return;
    }
    if (!navigator.geolocation) return say("Геолокация недоступна в этом браузере.");
    say("Определяем точное местоположение…");
    navigator.geolocation.getCurrentPosition((position) => {
      if (requestId !== locateRequestId) return;
      const result = Tracking.evaluatePosition(position, null, Date.now());
      if (!result.accepted) return say(result.reason === "accuracy"
        ? `GPS пока неточный (±${Math.round(position.coords.accuracy)} м). Карта не перемещена.`
        : "Не удалось получить свежую GPS-точку. Карта не перемещена.");
      centerMapOnPosition(result.point, requestId);
      say("");
    }, (error) => {
      if (requestId === locateRequestId) onLocationError(error);
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
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
        const wasWarmingUp = draftPoints.length === 0;
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
          distanceMetersTotal = distanceForPoints(points);
          startedAt = Number.isFinite(draft.startedAt) ? draft.startedAt : Date.now();
          warmingUp = wasWarmingUp;
          updateDistance(); drawCurrent();
          if (points.length) updateLocationMarker(points.at(-1));
          draftResolved = true;
          try {
            startTrackingServices();
            setRecording(!warmingUp);
            if (warmingUp) say("");
            else { startStopwatch(); say("Прогулка восстановлена. Ожидаем свежую GPS-точку…"); }
          } catch {
            positionFilter.reset(); gpsWarmup.reset(); warmingUp = false;
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
      positionFilter.reset(); gpsWarmup.reset(); warmingUp = false;
      storageReady = false; draftResolved = false; setRecording(false);
      say("IndexedDB недоступна. Попробуйте открыть приложение в современном браузере по HTTPS.");
    }
  })();
})();
