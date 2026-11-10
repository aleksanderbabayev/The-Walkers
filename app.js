(() => {
  "use strict";
  const DB_NAME = "the-walkers", DB_VERSION = 2;
  const AUTOSAVE_MS = 5000;
  const Tracking = window.WalkTracking, WalkStorage = window.WalkStorage, Diagnostics = window.WalkDiagnostics, Actions = window.WalkActions, LocationUi = window.WalkLocationUi, LocationDiagnostics = window.WalkLocationDiagnostics, MusicControl = window.WalkMusicControl, MapFollow = window.WalkMapFollow, Expedition = window.WalkExpedition, ExpeditionLine = window.WalkExpeditionLine, ExpeditionMarkers = window.WalkExpeditionMarkers;
  const $ = (id) => document.getElementById(id);
  const appVersion = document.querySelector('meta[name="app-version"]').content;
  const expeditionCompassState = Expedition.createCompassState(Tracking.distanceMeters);
  let displayedCompassRotation = null;
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
  const musicControl = MusicControl.createMusicControl({
    audio: backgroundMusic,
    isMuted: () => musicMuted,
    setMuted: (muted) => {
      musicMuted = muted;
      try { localStorage.setItem(MUSIC_PREFERENCE_KEY, String(musicMuted)); } catch {}
    },
    onStateChange: updateMusicButton
  });
  const startBackgroundMusic = () => musicControl.start();
  const unlockBackgroundMusic = (event) => {
    if (event.target.closest?.("#musicToggle")) return;
    if (!musicMuted) startBackgroundMusic().catch(() => {});
  };
  updateMusicButton();
  backgroundMusic.addEventListener("play", updateMusicButton);
  backgroundMusic.addEventListener("pause", updateMusicButton);
  document.addEventListener("pointerdown", unlockBackgroundMusic, true);
  document.addEventListener("keydown", unlockBackgroundMusic, true);
  ["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
    document.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
  });
  $("musicToggle").addEventListener("click", () => { musicControl.toggle(); });
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
    if (drawerOpen) preloadWalkDiagnostics();
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
  const map = L.map("map", {
    zoomControl: false,
    rotate: true,
    touchRotate: true,
    dragRotate: true,
    shiftKeyRotate: true,
    rotateControl: { position: "topright", behavior: "reset", closeOnZeroBearing: false },
    preventPageGestures: true
  }).setView([0, 0], 2);
  let mapInitialPositionSet = false, mapViewInteracted = false;
  map.on("dragstart zoomstart click", () => { mapViewInteracted = true; });
  const compassButton = map.getContainer().querySelector(".leaflet-control-rotate a");
  if (compassButton) {
    compassButton.setAttribute("aria-label", "Повернуть карту на север");
    compassButton.title = "Повернуть карту на север";
  }
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const zoomControlCorner = map.getContainer().querySelector(".leaflet-bottom.leaflet-right");
  const zoomControl = map.getContainer().querySelector(".leaflet-control-zoom");
  const walkPanel = document.querySelector(".panel");
  const updateMobileZoomPosition = () => {
    if (!zoomControlCorner || !zoomControl || !isMobileViewport()) {
      zoomControlCorner?.style.removeProperty("--mobile-zoom-control-bottom");
      return;
    }
    const panelTop = walkPanel.getBoundingClientRect().top;
    const zoomBottom = zoomControl.getBoundingClientRect().bottom;
    const currentOffset = Number.parseFloat(getComputedStyle(zoomControlCorner).bottom) || 0;
    const targetBottom = panelTop - 8;
    const offset = Math.max(0, currentOffset + zoomBottom - targetBottom);
    zoomControlCorner.style.setProperty("--mobile-zoom-control-bottom", `${offset}px`);
  };
  updateMobileZoomPosition();
  if (typeof ResizeObserver === "function") new ResizeObserver(updateMobileZoomPosition).observe(walkPanel);
  window.visualViewport?.addEventListener("resize", updateMobileZoomPosition);
  window.visualViewport?.addEventListener("scroll", updateMobileZoomPosition);
  window.addEventListener("resize", updateMobileZoomPosition);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  let db, storageReady = false, draftResolved = false, starting = false, finishing = false, cancelling = false;
  let selectedMode = "territory", activeMode = "territory", expeditionTarget = null;
  let targetMethod = "manual", expeditionDistanceMeters = null, expeditionCompletionPending = false;
  let recordingActive = false, warmingUp = false, points = [], distanceMetersTotal = 0, currentLines = [], savedLayers = [], stopwatchTimer = null, warmupWaitTimer = null, warmupStartedAt = null, startedAt = null;
  let walksById = new Map();
  let trackingQueue = Promise.resolve();
  let diagnosticSession = null, diagnosticsQueue = Promise.resolve(), diagnosticsPersistenceFailed = false;
  let diagnosticsByWalkId = new Map();
  let warmupDiagnosticPrevious = null, pendingDiagnosticPrevious = null, pendingDiagnosticEvents = [];
  const positionFilter = Tracking.createPositionFilter();
  const gpsWarmup = Tracking.createGpsWarmup();
  const startupGpsStabilizer = Tracking.createGpsWarmup();
  const initialRouteBuffer = Tracking.createInitialRouteBuffer();
  let currentLocationMarker = null, accuracyCircle = null, startupPositionReady = false, accuracyCircleDismissed = false;
  let capturePosition = null, captureFreshnessTimer = null;
  let routeStartMarker = null;
  const expeditionMarkers = ExpeditionMarkers.createExpeditionMarkers({ map, leaflet: L });
  let locationState = "loading", latestLocation = null, locationRequestPending = false;
  let locationPermissionMonitored = false;
  let locationPermissionState = typeof navigator.permissions?.query === "function" ? "unknown" : "unsupported";
  let locationPermissionStatus = null;
  let lastLocationRequest = { result: "none", checkedAt: null };
  let locationWaitStartedAt = Date.now(), locationRequestToken = 0, locationTimeoutTimer = null;
  const LOCATION_WAIT_TIMEOUT_MS = 20000;
  const LOCATION_REFRESH_INTERVAL_MS = 5000;
  const EXPEDITION_RADII = new Set([500, 1000, 2000, 3000]);
  const mapDiagnosticsEnabled = new URLSearchParams(window.location.search).get("mapDebug") === "1";
  const updateLocationMarker = (point) => {
    const latlng = [point.lat, point.lng];
    if (currentLocationMarker) currentLocationMarker.setLatLng(latlng);
    else currentLocationMarker = L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 3, fillColor: "#2877df", fillOpacity: 1 }).addTo(map);
  };
  const clearLocationMarker = () => {
    if (currentLocationMarker) map.removeLayer(currentLocationMarker);
    currentLocationMarker = null;
    if (accuracyCircle) map.removeLayer(accuracyCircle);
    accuracyCircle = null;
  };
  const updateAccuracyCircle = (point) => {
    if (accuracyCircleDismissed) return;
    const latlng = [point.lat, point.lng];
    if (accuracyCircle) accuracyCircle.setLatLng(latlng).setRadius(point.accuracy);
    else accuracyCircle = L.circle(latlng, {
      radius: point.accuracy, color: "#2877df", weight: 1, fillColor: "#2877df", fillOpacity: 0.14, interactive: false
    }).addTo(map);
    const stable = startupGpsStabilizer.add({ timestamp: point.timestamp, coords: { latitude: point.lat, longitude: point.lng, accuracy: point.accuracy } }, Date.now()).stable;
    if (stable) {
      accuracyCircleDismissed = true;
      map.removeLayer(accuracyCircle);
      accuracyCircle = null;
    }
  };
  const updateAccuracyDisplay = (point) => {
    const latlng = [point.lat, point.lng];
    if (currentLocationMarker) currentLocationMarker.setLatLng(latlng);
    else currentLocationMarker = L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 3, fillColor: "#2877df", fillOpacity: 1 }).addTo(map);
    updateAccuracyCircle(point);
    currentLocationMarker.bringToFront();
  };
  const completeLocationStartup = (point) => {
    if (startupPositionReady) return;
    startupPositionReady = true;
    mapInitialPositionSet = true;
    map.setView([point.lat, point.lng], 15);
    map.invalidateSize();
    $("locationStartupScreen").hidden = true;
  };
  const showLocationStartupError = (details) => {
    if (startupPositionReady) return;
    $("locationStartupTitle").textContent = details.title;
    $("locationStartupMessage").textContent = details.message;
    const retry = $("locationStartupRetry");
    retry.hidden = !details.action;
    retry.textContent = details.action || "Попробовать снова";
    $("locationStartupScreen").hidden = false;
  };
  const updateRouteStartMarker = (point) => {
    if (!point) return;
    const icon = L.divIcon({
      className: "route-start-marker",
      iconSize: [82, 32],
      iconAnchor: [5, 30],
      html: '<span class="route-start-content"><svg viewBox="0 0 24 32" aria-hidden="true"><path d="M5 29V3"/><path d="M6 4h16v12H6z" class="route-start-cloth"/><path d="M6 4h5v4H6zM16 4h6v4h-6zM11 8h5v4h-5zM6 12h5v4H6zM16 12h6v4h-6z" class="route-start-checks"/></svg><span>Старт</span></span>'
    });
    if (routeStartMarker) routeStartMarker.setLatLng([point.lat, point.lng]).setIcon(icon);
    else routeStartMarker = L.marker([point.lat, point.lng], { icon, title: "Старт маршрута", keyboard: false, interactive: false, zIndexOffset: 1200 }).addTo(map);
  };
  const updateExpeditionStartMarker = (point) => expeditionMarkers.updateStart(point);
  const clearExpeditionStartMarker = () => expeditionMarkers.clearStart();
  const clearRouteStartMarker = () => {
    if (routeStartMarker) map.removeLayer(routeStartMarker);
    routeStartMarker = null;
  };
  const updateExpeditionTargetMarker = (target) => {
    expeditionMarkers.updateTarget(target);
  };
  const setExpeditionTarget = (target, source = targetMethod) => {
    if (!target || !Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return false;
    expeditionTarget = { lat: target.lat, lng: target.lng };
    targetMethod = source;
    updateExpeditionTargetMarker(expeditionTarget);
    $("expeditionTargetHint").textContent = source === "random"
      ? "Случайная цель отмечена на карте. Можно сгенерировать другую точку."
      : `Цель отмечена на карте: ${expeditionTarget.lat.toFixed(5)}, ${expeditionTarget.lng.toFixed(5)}.`;
    $("anotherTarget").hidden = source !== "random";
    $("generateTarget").hidden = source === "random";
    updateStartAvailability();
    return true;
  };
  const updateModeSelection = () => {
    const inProgress = recordingActive || warmingUp || starting || cancelling;
    document.body.classList.toggle("expedition-mode", selectedMode === "expedition");
    $("modeSelector").hidden = inProgress;
    $("expeditionSetup").hidden = inProgress || selectedMode !== "expedition";
    $("start").hidden = inProgress || selectedMode !== "territory";
    $("startExpedition").hidden = inProgress || selectedMode !== "expedition";
    $("territoryMode").setAttribute("aria-pressed", String(selectedMode === "territory"));
    $("expeditionMode").setAttribute("aria-pressed", String(selectedMode === "expedition"));
    $("manualTargetMode").setAttribute("aria-pressed", String(targetMethod === "manual"));
    $("randomTargetMode").setAttribute("aria-pressed", String(targetMethod === "random"));
    $("randomTargetControls").hidden = selectedMode !== "expedition" || targetMethod !== "random";
    $("startExpedition").disabled = !expeditionTarget
      || !storageReady || !draftResolved || starting || finishing || cancelling;
  };
  const hideExpeditionCompass = () => {
    const compass = $("expeditionCompass");
    expeditionCompassState.reset();
    displayedCompassRotation = null;
    compass.hidden = true;
    compass.classList.remove("is-stale");
    const needle = $("expeditionCompassNeedle");
    needle.classList.remove("is-ready");
    needle.style.visibility = "hidden";
    needle.style.transform = "rotate(0deg)";
    $("expeditionCompassDistance").textContent = "";
    $("expeditionCompassFreshness").textContent = "До цели";
    compass.setAttribute("aria-label", "Компас до цели");
  };
  const setExpeditionCompassStale = () => {
    const compass = $("expeditionCompass");
    if (compass.hidden) return;
    expeditionCompassState.markStale();
    const hasDirection = $("expeditionCompassNeedle").classList.contains("is-ready");
    compass.classList.add("is-stale");
    $("expeditionCompassFreshness").textContent = hasDirection
      ? "Последнее направление · GPS устарел" : "GPS устарел · начните движение";
    compass.setAttribute("aria-label", `Компас до цели. ${$("expeditionCompassFreshness").textContent}. ${$("expeditionCompassDistance").textContent}`);
  };
  const updateExpeditionCompass = (point, distanceMeters) => {
    if (!recordingActive || activeMode !== "expedition" || finishing || expeditionCompletionPending || !expeditionTarget) {
      hideExpeditionCompass();
      return;
    }
    if (!Tracking.isLocationFresh(point)) {
      setExpeditionCompassStale();
      return;
    }
    const reading = expeditionCompassState.update(
      point, expeditionTarget, distanceMeters
    );
    if (!reading) {
      setExpeditionCompassStale();
      return;
    }
    const compass = $("expeditionCompass");
    const distanceLabel = reading.distanceMeters < 1000 ? `${Math.round(reading.distanceMeters)} м` : formatKilometers(reading.distanceMeters);
    const needle = $("expeditionCompassNeedle");
    if (reading.relativeBearing === null) {
      needle.classList.remove("is-ready");
      needle.style.visibility = "hidden";
      $("expeditionCompassFreshness").textContent = "Начните движение";
    } else if (displayedCompassRotation === null) {
      displayedCompassRotation = reading.relativeBearing;
      needle.style.transform = `rotate(${displayedCompassRotation}deg)`;
      needle.style.visibility = "hidden";
      requestAnimationFrame(() => {
        if (!compass.hidden && displayedCompassRotation !== null) {
          needle.classList.add("is-ready");
          needle.style.visibility = "visible";
          if (compass.classList.contains("is-stale")) {
            $("expeditionCompassFreshness").textContent = "Последнее направление · GPS устарел";
          }
        }
      });
      $("expeditionCompassFreshness").textContent = reading.headingUpdated ? "Направление движения" : "Направление сохранено";
    } else {
      displayedCompassRotation = Expedition.nearestContinuousAngle(displayedCompassRotation, reading.relativeBearing);
      needle.style.transform = `rotate(${displayedCompassRotation}deg)`;
      needle.style.visibility = "visible";
      needle.classList.add("is-ready");
      $("expeditionCompassFreshness").textContent = reading.headingUpdated ? "Направление движения" : "Направление сохранено";
    }
    $("expeditionCompassDistance").textContent = distanceLabel;
    compass.classList.remove("is-stale");
    compass.hidden = false;
    compass.setAttribute("aria-label", reading.relativeBearing === null
      ? `Компас до цели. ${distanceLabel}. Начните движение, чтобы определить направление.`
      : `Направление до цели ${Math.round(reading.relativeBearing)} градусов относительно движения. Осталось ${distanceLabel}. ${reading.headingUpdated ? "Направление обновлено." : "Последнее определённое направление сохранено."}`);
  };
  const updateExpeditionProgress = (point) => {
    if (activeMode !== "expedition" || !expeditionTarget) return false;
    expeditionDistanceMeters = Tracking.distanceMeters(point, expeditionTarget);
    updateExpeditionCompass(point, expeditionDistanceMeters);
    const remaining = expeditionDistanceMeters < 1000
      ? `${Math.round(expeditionDistanceMeters)} м`
      : formatKilometers(expeditionDistanceMeters);
    $("statusText").textContent = `До цели: ${remaining}`;
    if (Expedition.hasReachedTarget(point, expeditionTarget, Tracking.distanceMeters)) {
      expeditionCompletionPending = true;
      hideExpeditionCompass();
      expeditionLine.hide();
      $("statusText").textContent = "Цель достигнута. Завершаем экспедицию…";
      return true;
    }
    expeditionLine.update(point, expeditionTarget, recordingActive && activeMode === "expedition" && !finishing && !cancelling);
    return false;
  };
  const generateExpeditionTarget = () => {
    if (!locationIsFresh(latestLocation)) {
      $("expeditionTargetHint").textContent = "Ожидаем достоверную GPS-позицию для случайной цели.";
      say("Для случайной цели сначала дождитесь достоверной GPS-позиции.");
      if (!locationRequestPending) requestCurrentLocation();
      return;
    }
    const radius = Number($("expeditionRadius").value);
    if (!EXPEDITION_RADII.has(radius)) return;
    const target = Expedition.createRandomTarget(latestLocation, radius);
    if (setExpeditionTarget(target, "random")) say("");
  };
  map.on("click", (event) => {
    if (selectedMode !== "expedition" || targetMethod !== "manual" || recordingActive || warmingUp || starting || cancelling) return;
    setExpeditionTarget(event.latlng, "manual");
    say("");
  });
  $("territoryMode").addEventListener("click", () => {
    if (recordingActive || warmingUp || starting || cancelling) return;
    selectedMode = "territory";
    expeditionTarget = null; expeditionDistanceMeters = null; expeditionCompletionPending = false;
    updateExpeditionTargetMarker(null); updateModeSelection();
  });
  $("expeditionMode").addEventListener("click", () => {
    if (recordingActive || warmingUp || starting || cancelling) return;
    selectedMode = "expedition";
    targetMethod = "manual";
    expeditionTarget = null; expeditionDistanceMeters = null;
    updateExpeditionTargetMarker(null);
    $("expeditionTargetHint").textContent = "Коснитесь карты, чтобы выбрать цель.";
    $("anotherTarget").hidden = true;
    updateModeSelection(); updateStartAvailability();
  });
  $("manualTargetMode").addEventListener("click", () => {
    if (recordingActive || warmingUp || starting) return;
    if (targetMethod === "manual") return;
    targetMethod = "manual";
    expeditionTarget = null;
    updateExpeditionTargetMarker(null);
    $("expeditionTargetHint").textContent = "Коснитесь карты, чтобы выбрать цель.";
    $("anotherTarget").hidden = true;
    $("generateTarget").hidden = true;
    updateModeSelection(); updateStartAvailability();
  });
  $("randomTargetMode").addEventListener("click", () => {
    if (recordingActive || warmingUp || starting) return;
    if (targetMethod === "random") return;
    targetMethod = "random";
    expeditionTarget = null;
    updateExpeditionTargetMarker(null);
    $("expeditionTargetHint").textContent = "Готовим случайную цель…";
    updateModeSelection();
    generateExpeditionTarget();
  });
  $("expeditionRadius").addEventListener("change", () => {
    if (targetMethod === "random" && selectedMode === "expedition") generateExpeditionTarget();
  });
  $("generateTarget").addEventListener("click", generateExpeditionTarget);
  $("anotherTarget").addEventListener("click", generateExpeditionTarget);
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
      if (requestId !== locateRequestId || !mapFollow.enabled) return;
      map.invalidateSize({ pan: false });
      mapFollow.centerOn(point);
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
      if (!database.objectStoreNames.contains("diagnostics")) database.createObjectStore("diagnostics", { keyPath: "id" });
      if (!database.objectStoreNames.contains("diagnosticEvents")) {
        const events = database.createObjectStore("diagnosticEvents", { keyPath: "id" });
        events.createIndex("bySessionId", "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const distanceForPoints = Tracking.distanceForPoints;
  const formatKilometers = (meters) => `${(Math.max(0, meters) / 1000).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} км`;
  const durationOfWalk = (walk) => Number.isFinite(walk.durationMs) ? Math.max(0, walk.durationMs) : Math.max(0, (walk.finishedAt || 0) - (walk.startedAt || 0));
  const say = (message) => { $("message").textContent = message; };
  const queueDiagnosticWrite = (operation) => {
    diagnosticsQueue = diagnosticsQueue.then(() => diagnosticsPersistenceFailed ? undefined : operation()).catch(() => { diagnosticsPersistenceFailed = true; });
    return diagnosticsQueue;
  };
  const persistDiagnosticSession = () => diagnosticSession && queueDiagnosticWrite(() => WalkStorage.writeDiagnosticSession(db, diagnosticSession));
  const persistDiagnosticEvent = (event) => {
    if (!event || !diagnosticSession) return;
    const sessionId = diagnosticSession.id;
    const snapshot = { ...event, rawMeasurement: event.rawMeasurement ? { ...event.rawMeasurement } : undefined };
    queueDiagnosticWrite(() => WalkStorage.writeDiagnosticEvent(db, sessionId, snapshot));
  };
  const addDiagnosticEvent = (event) => {
    if (!diagnosticSession) return null;
    const entry = Diagnostics.addEvent(diagnosticSession, { at: Date.now(), ...event });
    if (!entry && (diagnosticSession.droppedEvents === 1 || diagnosticSession.droppedEvents % 100 === 0)) {
      persistDiagnosticSession();
    }
    return entry;
  };
  const recordDiagnosticEvent = (event) => {
    const entry = addDiagnosticEvent(event);
    persistDiagnosticEvent(entry);
    return entry;
  };
  const recordDiagnosticVisibility = (source) => {
    if (!diagnosticSession) return;
    const hidden = source === "pagehide" || document.visibilityState === "hidden";
    recordDiagnosticEvent({ type: "visibility-change", source, visibilityState: hidden ? "hidden" : "visible", transition: hidden ? "background" : "foreground" });
  };
  document.addEventListener("visibilitychange", () => recordDiagnosticVisibility("visibilitychange"));
  window.addEventListener("pagehide", () => recordDiagnosticVisibility("pagehide"));
  window.addEventListener("pageshow", () => {
    if (diagnosticSession && document.visibilityState !== "hidden") recordDiagnosticVisibility("pageshow");
  });
  const persistDiagnosticUpdates = (events) => events.forEach(persistDiagnosticEvent);
  const diagnosticThresholds = (phase) => ({
    ...Tracking.DEFAULTS,
    ...(phase === "warm-up" ? Tracking.GPS_WARMUP_DEFAULTS : {}),
    ...(phase === "initial-buffer" ? { validationWindowMs: 18000 } : {})
  });
  const recordGpsDiagnostic = (position, processedAt, phase, decision, reason, previous, extra) => addDiagnosticEvent(
    Diagnostics.createGpsMeasurement({
      position, processedAt, phase, decision, reason, previous,
      thresholds: diagnosticThresholds(phase), distanceBetween: Tracking.distanceMeters, ...extra
    })
  );
  const resolveDiagnosticEvents = (route, phases = null, pendingOnly = false) => {
    if (!diagnosticSession) return [];
    const changed = [];
    const routeByMeasurement = new Map(route.map((point) => [`${point.timestamp}:${point.lat}:${point.lng}`, point]));
    const candidates = pendingOnly ? pendingDiagnosticEvents : diagnosticSession.events;
    for (const event of candidates) {
      if (event.type !== "gps-measurement") continue;
      if (phases && !phases.includes(event.phase)) continue;
      if (pendingOnly && !event.pendingCandidate) continue;
      const raw = event.rawMeasurement || {};
      const accepted = routeByMeasurement.get(`${raw.timestamp}:${raw.latitude}:${raw.longitude}`);
      const included = Boolean(accepted);
      if (event.includedInRoute !== included || event.routeSegmentStart !== (accepted?.segmentStart || false)) {
        event.includedInRoute = included;
        event.routeSegmentStart = accepted?.segmentStart || false;
        changed.push(event);
      }
      if (included || event.decision === "pending" || event.decision === "pending_confirmation" || event.pendingCandidate) {
        event.decision = included ? "accepted" : "rejected";
        if (!included && !event.filteringReason) event.filteringReason = "not-in-final-route";
        event.pendingCandidate = false;
        if (!changed.includes(event)) changed.push(event);
      }
    }
    if (pendingOnly) pendingDiagnosticEvents = [];
    return changed;
  };
  const createDiagnosticSession = (startedAt, restored = false) => Diagnostics.createSession({
    id: "active", appVersion,
    navigatorLike: { platform: navigator.platform, userAgent: navigator.userAgent },
    startedAt, restored
  });
  const showDiagnosticsFallback = (text) => {
    const overlay = document.createElement("div"); overlay.className = "diagnosticsFallback"; overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
    const card = document.createElement("div"); card.className = "diagnosticsFallbackCard";
    const instructions = document.createElement("p"); instructions.textContent = "Автокопирование недоступно. Выделите текст и выберите «Копировать».";
    const textarea = document.createElement("textarea"); textarea.readOnly = true; textarea.value = text; textarea.setAttribute("aria-label", "Диагностика для копирования");
    const close = document.createElement("button"); close.type = "button"; close.textContent = "Закрыть"; close.addEventListener("click", () => overlay.remove());
    card.append(instructions, textarea, close); overlay.append(card); document.body.append(overlay);
    textarea.focus(); textarea.select(); textarea.setSelectionRange(0, textarea.value.length);
  };
  const copyDiagnosticReport = async (session, route, events) => {
    const report = Diagnostics.buildReport({ ...session, diagnosticsPersistenceFailed: diagnosticsPersistenceFailed || session?.diagnosticsPersistenceFailed }, route, events);
    const text = JSON.stringify(report, null, 2);
    const result = await Diagnostics.copyText(text, navigator.clipboard);
    if (result.copied) say("Диагностика скопирована в буфер обмена.");
    else { say("Выделите и скопируйте диагностику в открывшемся окне."); showDiagnosticsFallback(text); }
  };
  const findDiagnosticsButton = (walkId) => [...document.querySelectorAll("button[data-copy-diagnostics]")]
    .find((button) => button.dataset.copyDiagnostics === walkId);
  const preloadWalkDiagnostics = () => {
    if (!walksById.size) return;
    const activeDiagnostics = WalkStorage.readDiagnostics(db, "active").catch(() => null);
    walksById.forEach((walk, walkId) => {
      if (diagnosticsByWalkId.has(walkId)) return;
      const button = findDiagnosticsButton(walkId);
      if (button) { button.disabled = true; button.title = "Загружаем диагностику"; }
      WalkStorage.readDiagnostics(db, walkId)
        .then((stored) => stored || activeDiagnostics.then((active) => active?.walkId === walkId ? active : null))
        .then((stored) => diagnosticsByWalkId.set(walkId, stored))
        .catch(() => diagnosticsByWalkId.set(walkId, null))
        .finally(() => {
          const readyButton = findDiagnosticsButton(walkId);
          if (readyButton) { readyButton.disabled = false; readyButton.removeAttribute("title"); }
        });
    });
  };
  const copyCompletedDiagnostics = (walk) => {
    if (!diagnosticsByWalkId.has(walk.id)) { say("Подготовка диагностики ещё не завершена. Подождите и нажмите снова."); return; }
    const stored = diagnosticsByWalkId.get(walk.id);
    const route = stored?.finalRoute || walk.points || [];
    const session = stored || Diagnostics.createSession({
      id: walk.id, appVersion: "not recorded", navigatorLike: {},
      startedAt: walk.startedAt
    });
    if (!stored) session.state = "completed";
    copyDiagnosticReport(session, route, stored?.events || []).catch(() => say("Не удалось подготовить диагностику для копирования."));
  };
  const copyActiveDiagnostics = () => {
    if (!diagnosticSession) { say("Диагностика ещё не готова."); return; }
    copyDiagnosticReport(diagnosticSession, points, diagnosticSession.events).catch(() => say("Не удалось подготовить диагностику для копирования."));
  };
  const updateLocateButton = (state) => {
    const previousState = locationState;
    locationState = state;
    const button = $("locate");
    button.classList.toggle("is-locating", state === "loading");
    button.classList.toggle("is-ready", state === "ready");
    button.classList.toggle("is-error", state === "error");
    button.classList.toggle("is-following", mapFollow?.enabled === true);
    button.textContent = state === "error" ? "↻" : "◎";
    button.setAttribute("aria-busy", String(state === "loading"));
    button.setAttribute("aria-pressed", String(mapFollow?.enabled === true));
    const label = mapFollow?.enabled ? "Отключить следование за вашим местоположением"
      : state === "ready" ? "Включить следование за вашим местоположением"
      : state === "error" ? "Повторить определение местоположения" : "Определяем ваше местоположение";
    button.setAttribute("aria-label", label);
    button.title = label;
    if (state === "loading" && previousState !== "loading") locationWaitStartedAt = Date.now();
  };
  let locationPermissionDenied = false;
  const updateLocationNotice = (details) => {
    const notice = $("locationNotice");
    notice.className = `location-notice is-${details.state}`;
    $("locationNoticeTitle").textContent = details.title;
    $("locationNoticeText").textContent = details.message;
    const retryButton = $("locationRetry");
    retryButton.hidden = !details.action;
    retryButton.textContent = details.action || "";
    retryButton.disabled = locationRequestPending;
    updateStartAvailability();
  };
  const showLocationState = (options) => {
    const details = LocationUi.getLocationState(options);
    updateLocationNotice(details);
  };
  const createLocationDiagnosticsReport = () => LocationDiagnostics.createReport({
    navigatorLike: navigator, appVersion, permissionState: locationPermissionState,
    lastRequest: lastLocationRequest, checkedAt: Date.now()
  });
  const diagnosticsUi = LocationDiagnostics.createUi({
    documentLike: document, navigatorLike: navigator, getReport: createLocationDiagnosticsReport,
    fields: $("locationDiagnosticsFields"), status: $("locationDiagnosticsStatus"), fallback: $("locationDiagnosticsFallback")
  });
  const renderLocationDiagnostics = () => diagnosticsUi.render();
  const noteLocationRequest = (result) => {
    lastLocationRequest = { result, checkedAt: Date.now() };
    if ($("locationDiagnostics").open) renderLocationDiagnostics();
  };
  $("locationDiagnostics").addEventListener("toggle", () => {
    if ($("locationDiagnostics").open) renderLocationDiagnostics();
  });
  $("copyLocationDiagnostics").addEventListener("click", () => diagnosticsUi.copy());
  const cancelPendingLocationRequest = () => {
    locationRequestToken += 1;
    if (locationTimeoutTimer !== null) clearTimeout(locationTimeoutTimer);
    locationTimeoutTimer = null; locationRequestPending = false;
  };
  const handleCurrentLocationSuccess = (position) => {
    noteLocationRequest("success");
    locationPermissionDenied = false;
    musicControl.setLocationAllowed(true);
    receivePosition(position);
  };
  const handleCurrentLocationError = (error, reason) => {
    if (!LocationUi.isPermissionDenied(error) && locationIsFresh(latestLocation)) return;
    latestLocation = null;
    clearLocationMarker();
    updateLocateButton("error");
    if (error?.code) noteLocationRequest(error.code === 1 ? "PERMISSION_DENIED" : error.code === 3 ? "TIMEOUT" : "POSITION_UNAVAILABLE");
    if (LocationUi.isPermissionDenied(error)) {
      locationPermissionDenied = true;
      musicControl.setLocationAllowed(false);
    }
    showLocationState({ error, reason });
  };
  const requestCurrentLocation = () => {
    if (typeof navigator.geolocation?.getCurrentPosition !== "function") {
      locationRequestPending = false;
      handleCurrentLocationError(null, "unsupported");
      return;
    }
    if (locationRequestPending) return;
    locationRequestPending = true;
    noteLocationRequest("pending");
    updateLocateButton("loading");
    showLocationState({});
    const token = ++locationRequestToken;
    const finishRequest = () => {
      if (locationTimeoutTimer !== null) clearTimeout(locationTimeoutTimer);
      locationTimeoutTimer = null; locationRequestPending = false;
    };
    locationTimeoutTimer = setTimeout(() => {
      if (token !== locationRequestToken) return;
      locationRequestToken += 1;
      finishRequest();
      handleCurrentLocationError({ code: 3 });
    }, LOCATION_WAIT_TIMEOUT_MS);
    try { navigator.geolocation.getCurrentPosition((position) => {
      if (token !== locationRequestToken) return;
      finishRequest();
      handleCurrentLocationSuccess(position);
    }, (error) => {
      if (token !== locationRequestToken) return;
      finishRequest();
      handleCurrentLocationError(error);
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: LOCATION_WAIT_TIMEOUT_MS }); }
    catch {
      if (token !== locationRequestToken) return;
      finishRequest();
      handleCurrentLocationError({ code: 2 });
    }
  };
  const locationIsFresh = Tracking.isLocationFresh;
  let mapFollowStorage = null;
  try { mapFollowStorage = window.localStorage; } catch {}
  const mapFollow = MapFollow.createMapFollow({ map, storage: mapFollowStorage, onChange: () => updateLocateButton(locationState) });
  const expeditionLine = ExpeditionLine.createExpeditionLine({ map, leaflet: L, isLocationFresh: Tracking.isLocationFresh });
  const updateCaptureAvailability = () => {
    const routePoints = initialRouteBuffer.pending ? [] : points;
    const readiness = Tracking.evaluateTerritoryCapture(routePoints, capturePosition);
    const canCapture = recordingActive && activeMode === "territory" && !finishing && !cancelling && readiness.eligible;
    $("finish").disabled = !canCapture;
    if (recordingActive && activeMode === "territory") {
      $("statusText").textContent = readiness.distanceToStartMeters === null
        ? "До финиша: ожидаем свежий GPS"
        : `До финиша: ${Math.round(readiness.distanceToStartMeters)} м${readiness.routeValid ? "" : " · завершите маршрут"}`;
    }
    return readiness;
  };
  const setCapturePosition = (point) => {
    clearTimeout(captureFreshnessTimer);
    captureFreshnessTimer = null;
    capturePosition = point;
    updateCaptureAvailability();
    if (point) {
      const expiresAt = point.timestamp + Tracking.LOCATION_DEFAULTS.maxAgeMs + 1;
      captureFreshnessTimer = setTimeout(() => {
        captureFreshnessTimer = null;
        updateCaptureAvailability();
      }, Math.max(0, expiresAt - Date.now()));
    }
  };
  function updateStartAvailability() {
    const inProgress = recordingActive || warmingUp || cancelling;
    $("start").disabled = !LocationUi.canStartWalk({
      storageReady, draftResolved,
      busy: starting || finishing || inProgress
    });
    $("startExpedition").disabled = !expeditionTarget || !LocationUi.canStartWalk({
      storageReady, draftResolved,
      busy: starting || finishing || inProgress
    });
    updateCaptureAvailability();
  }
  const rememberLocation = (point) => {
    if (latestLocation && point.timestamp < latestLocation.timestamp) return false;
    if (locationRequestPending) {
      locationRequestToken += 1;
      if (locationTimeoutTimer !== null) clearTimeout(locationTimeoutTimer);
      locationTimeoutTimer = null; locationRequestPending = false;
    }
    latestLocation = point;
    if (!mapInitialPositionSet) {
      mapInitialPositionSet = true;
      if (!mapViewInteracted) map.setView([point.lat, point.lng], 15);
    }
    updateLocateButton("ready");
    showLocationState({ reason: "ready" });
    if ($("message").textContent.startsWith("📡 Определяем ваше местоположение.")) say("");
    updateStartAvailability();
    return true;
  };
  const refreshLocationReadiness = () => {
    if (recordingActive && activeMode === "expedition" && !locationIsFresh(latestLocation)) {
      setExpeditionCompassStale();
      expeditionLine.hide();
    }
    if (locationState === "ready" && !locationIsFresh(latestLocation)) {
      latestLocation = null;
      clearLocationMarker();
      updateLocateButton("loading");
      showLocationState({});
      updateStartAvailability();
      if (!recordingActive && !warmingUp) requestCurrentLocation();
    }
    if (locationState === "loading" && !locationRequestPending && Date.now() - locationWaitStartedAt >= LOCATION_WAIT_TIMEOUT_MS) {
      updateLocateButton("error");
      showLocationState({ error: { code: 3 } });
      const details = LocationUi.getLocationState({ error: { code: 3 } });
      showLocationStartupError(details);
    }
  };
  const handleLocationResume = () => {
    if (document.visibilityState === "hidden") return;
    if (locationPermissionStatus) locationPermissionState = locationPermissionStatus.state;
    if ($("locationDiagnostics").open) renderLocationDiagnostics();
    if (locationPermissionState === "denied" && !locationPermissionDenied) {
      showLocationState({ error: { code: 1 } });
    }
    if (locationPermissionDenied) {
      requestCurrentLocation();
      return;
    }
    if (!recordingActive && !warmingUp && !locationPermissionMonitored) {
      requestCurrentLocation();
      return;
    }
    refreshLocationReadiness();
    if (locationState === "loading" && !locationRequestPending && !recordingActive && !warmingUp) requestCurrentLocation();
  };
  document.addEventListener("visibilitychange", handleLocationResume);
  window.addEventListener("pageshow", handleLocationResume);
  window.addEventListener("focus", handleLocationResume);
  const monitorLocationPermission = async () => {
    if (!navigator.permissions?.query) return;
    try {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      locationPermissionStatus = permission;
      locationPermissionMonitored = true;
      const updatePermission = () => {
        locationPermissionState = permission.state;
        if ($("locationDiagnostics").open) renderLocationDiagnostics();
        const wasAllowed = musicControl.isLocationAllowed();
        musicControl.setLocationAllowed(permission.state === "granted");
        if (permission.state === "denied") {
          locationPermissionDenied = true;
          latestLocation = null;
          updateLocateButton("error");
          showLocationState({ error: { code: 1 } });
          showLocationStartupError({
            title: "Геолокация недоступна",
            message: "Доступ запрещён. Разрешите геолокацию для этого сайта в настройках браузера, затем попробуйте снова.",
            action: "Проверить снова"
          });
        } else if (locationPermissionDenied || (permission.state === "granted" && !wasAllowed) || (wasAllowed && permission.state !== "granted")) requestCurrentLocation();
      };
      if (permission.addEventListener) permission.addEventListener("change", updatePermission);
      else permission.onchange = updatePermission;
      updatePermission();
    } catch {
      locationPermissionState = "unknown";
      if ($("locationDiagnostics").open) renderLocationDiagnostics();
    }
  };
  monitorLocationPermission();
  setInterval(refreshLocationReadiness, LOCATION_REFRESH_INTERVAL_MS);
  updateLocateButton("loading");
  $("locationRetry").addEventListener("click", () => {
    latestLocation = null;
    updateLocateButton("loading");
    showLocationState({});
    requestCurrentLocation();
  });
  $("locationStartupRetry").addEventListener("click", () => {
    locationPermissionDenied = false;
    latestLocation = null;
    updateLocateButton("loading");
    showLocationState({});
    showLocationStartupError({ title: "Определяем местоположение…", message: "Повторно запрашиваем свежие координаты GPS.", action: "" });
    requestCurrentLocation();
  });
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
    if (!active) expeditionLine.hide();
    if (!active || activeMode !== "expedition" || finishing || expeditionCompletionPending) hideExpeditionCompass();
    const inProgress = active || warmingUp || starting || cancelling;
    document.querySelector(".status").classList.toggle("recording", active);
    $("statusTitle").textContent = active ? activeMode === "expedition" ? "Идёт экспедиция" : "Идёт захват территории" : warmingUp ? "Стабилизация GPS" : cancelling ? "Отступление" : "Готовы к прогулке?";
    const manualStartAvailable = warmingUp && warmupStartedAt !== null && Date.now() - warmupStartedAt >= Tracking.GPS_WARMUP_DEFAULTS.manualStartAfterMs;
    $("statusText").textContent = active ? activeMode === "expedition" && Number.isFinite(expeditionDistanceMeters)
      ? `До цели: ${expeditionDistanceMeters < 1000 ? `${Math.round(expeditionDistanceMeters)} м` : formatKilometers(expeditionDistanceMeters)}` : activeMode === "expedition" ? "Записываем путь к цели" : "Точки сохраняются на устройстве" : warmingUp ? manualStartAvailable
      ? "GPS всё ещё стабилизируется. Можно начать с предупреждением, если доступна надёжная позиция."
      : "Стабилизация GPS. Подождите перед началом движения…" : cancelling ? "Останавливаем GPS и удаляем черновик…" : 'Нажмите "Начать прогулку", чтобы начать захват территории.';
    updateStartAvailability();
    $("start").hidden = inProgress || selectedMode !== "territory";
    $("startExpedition").hidden = inProgress || selectedMode !== "expedition";
    updateModeSelection();
    $("abandonWalk").hidden = !(active || warmingUp);
    $("abandonLabel").textContent = warmingUp ? "Отмена" : "Отступить";
    $("abandonWalk").disabled = cancelling || finishing;
    $("manualWarmupStart").hidden = !manualStartAvailable;
    $("manualWarmupStart").disabled = !manualStartAvailable || !gpsWarmup.manualStartPoint(Date.now(), Date.now() - warmupStartedAt);
    updateCaptureAvailability();
    $("finish").hidden = !active || activeMode === "expedition";
    $("copyActiveDiagnostics").hidden = !(active || warmingUp || diagnosticSession);
  };
  const refreshManualWarmupStart = () => {
    if (!warmingUp || warmupStartedAt === null) return;
    setRecording(false);
    if (Date.now() - warmupStartedAt >= Tracking.GPS_WARMUP_DEFAULTS.manualStartAfterMs && !gpsWarmup.manualStartPoint(Date.now(), Date.now() - warmupStartedAt)) {
      $("statusText").textContent = "Точность GPS пока недостаточна для безопасного старта. Ждём свежую позицию не хуже ±35 м.";
    }
  };
  const stopWarmupWaitTimer = () => {
    clearInterval(warmupWaitTimer);
    warmupWaitTimer = null;
  };
  const draftSnapshot = (nextPoints = points, nextStartedAt = startedAt, nextInitialBuffer = initialRouteBuffer.snapshot()) => ({
    id: "active", points: nextPoints, startedAt: nextStartedAt, updatedAt: Date.now(),
    ...(nextPoints[0] || nextInitialBuffer[0] ? { startPosition: { ...(nextPoints[0] || nextInitialBuffer[0]) } } : {}),
    mode: activeMode,
    ...(activeMode === "expedition" ? {
      targetMethod,
      ...(expeditionTarget ? { target: { ...expeditionTarget } } : {})
    } : {}),
    ...(nextInitialBuffer.length ? { initialBuffer: nextInitialBuffer } : {})
  });
  const saveDraftSnapshot = (nextPoints = points, nextStartedAt = startedAt, nextInitialBuffer = initialRouteBuffer.snapshot()) => WalkStorage.writeDraft(db, draftSnapshot(nextPoints, nextStartedAt, nextInitialBuffer));
  const enqueueTrackingTask = (task) => {
    const pending = trackingQueue.then(task);
    trackingQueue = pending.catch((error) => say(`Не удалось сохранить прогулку: ${error.message || "ошибка IndexedDB"}.`));
    pending.then(() => {
      if (expeditionCompletionPending && recordingActive && activeMode === "expedition") finishWalk(false).catch(() => {});
    }, () => {});
    return pending;
  };
  const drawCurrent = () => {
    currentLines.forEach((line) => map.removeLayer(line));
    currentLines = Tracking.splitSegments(points).filter((segment) => segment.length > 1).map((segment) => {
      return L.polyline(segment.map((point) => [point.lat, point.lng]), { color: "#e0765d", weight: 4 }).addTo(map);
    });
  };
  const redrawSaved = async ({ focusWalkId = null } = {}) => {
    savedLayers.forEach((layer) => map.removeLayer(layer));
    savedLayers = [];
    let focusedTerritory = null;
    const walks = await WalkStorage.readWalks(db);
    walksById = new Map(walks.map((walk) => [walk.id, walk]));
    diagnosticsByWalkId.clear();
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
      const retreated = walk.status === "retreated";
      const expedition = walk.mode === "expedition";
      const segments = Tracking.splitSegments(walk.points || []);
      const layers = !Tracking.shouldDisplayWalkOnMap(walk) ? [] : walk.closed
        ? [L.polygon((walk.points || []).map((point) => [point.lat, point.lng]), { color: "#477b43", weight: 3, fillColor: "#8fbd70", fillOpacity: 0.35 })]
        : segments.filter((segment) => segment.length > 1).map((segment) => L.polyline(segment.map((point) => [point.lat, point.lng]), { color: "#e0765d", weight: 4 }));
      if (Tracking.shouldDisplayWalkOnMap(walk) && expedition) layers.push(...expeditionMarkers.createHistoryMarkers(walk));
      if (walk.id === focusWalkId && walk.closed && !retreated) focusedTerritory = layers[0] || null;
      layers.forEach((layer) => { layer.addTo(map); savedLayers.push(layer); });
      const row = document.createElement("div"); row.className = retreated ? "route retreated" : "route";
      const icon = document.createElement("span"); icon.className = "routeIcon"; icon.textContent = expedition ? retreated ? "↗" : "⚑" : retreated ? "↩" : walk.closed ? "⬟" : "↗";
      const details = document.createElement("div");
      const title = document.createElement("strong");
      const walkLabel = expedition ? retreated ? "Экспедиция не завершена" : "Экспедиция завершена"
        : retreated ? "Отступление" : walk.closed ? "Захваченная территория" : "Маршрут";
      title.textContent = `${walkLabel} ${walks.length - index}`;
      const distance = Number.isFinite(walk.distanceMeters) ? Math.max(0, walk.distanceMeters) : distanceForPoints(walk.points || []);
      const targetSummary = expedition && walk.target ? ` · цель ${walk.target.lat.toFixed(4)}, ${walk.target.lng.toFixed(4)}` : "";
      const meta = document.createElement("small"); meta.textContent = `${new Date(walk.finishedAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })} · ${formatElapsed(durationOfWalk(walk))} · ${formatKilometers(distance)} · ${walk.points.length} точек${targetSummary}`;
      details.append(title, meta);
      const deleteButton = document.createElement("button"); deleteButton.className = "routeDelete"; deleteButton.type = "button";
      deleteButton.textContent = "Удалить"; deleteButton.dataset.walkId = walk.id;
      deleteButton.setAttribute("aria-label", `Удалить: ${title.textContent}`);
      const copyButton = document.createElement("button"); copyButton.className = "diagnosticsCopy"; copyButton.type = "button";
      copyButton.textContent = "Копировать диагностику"; copyButton.dataset.copyDiagnostics = walk.id;
      copyButton.setAttribute("aria-label", `Копировать диагностику: ${title.textContent}`);
      const actions = document.createElement("div"); actions.className = "routeActions"; actions.append(copyButton, deleteButton);
      row.append(icon, details, actions); list.append(row);
    });
    if (focusedTerritory) {
      map.fitBounds(focusedTerritory.getBounds(), { padding: [16, 16], maxZoom: 16 });
    }
    if (!isMobileViewport()) preloadWalkDiagnostics();
  };
  $("routes").addEventListener("click", async (event) => {
    const copyButton = event.target.closest("button[data-copy-diagnostics]");
    if (copyButton) {
      const walk = walksById.get(copyButton.dataset.copyDiagnostics);
      if (walk) await copyCompletedDiagnostics(walk);
      else say("Не удалось найти прогулку для копирования диагностики.");
      return;
    }
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
  const beginRecordingAt = async (startPoint, manual = false) => {
    const initialPoint = { ...startPoint, segmentStart: true };
    gpsWarmup.reset();
    const recordingStartedAt = Date.now();
    initialRouteBuffer.begin(initialPoint);
    try { await saveDraftSnapshot([], recordingStartedAt, initialRouteBuffer.snapshot()); }
    catch {
      initialRouteBuffer.reset(); gpsWarmup.reset();
      say("Не удалось сохранить начало прогулки. Продолжаем стабилизацию GPS…");
      return false;
    }
    if (!warmingUp || cancelling) return false;

    stopWarmupWaitTimer();
    const recordedStartPoint = initialRouteBuffer.snapshot()[0];
    points = []; startedAt = recordingStartedAt; distanceMetersTotal = 0;
    warmingUp = false; warmupStartedAt = null; updateDistance();
    rememberLocation(initialPoint); updateLocationMarker(initialPoint); mapFollow.centerOn(initialPoint);
    if (activeMode === "expedition") updateExpeditionStartMarker(recordedStartPoint);
    else updateRouteStartMarker(recordedStartPoint);
    $("gps").textContent = `±${Math.round(initialPoint.accuracy)} м`;
    setRecording(true); startStopwatch();
    say(manual ? "Прогулка начата с предупреждением: точность GPS ниже обычной. Продолжаем проверять каждую точку." : "GPS готов. Можно идти!");
    if (updateExpeditionProgress(initialPoint)) say("Цель достигнута. Завершаем экспедицию…");
    warmupDiagnosticPrevious = null;
    if (manual) recordDiagnosticEvent({ type: "manual-warmup-start", at: Date.now(), timestamp: initialPoint.timestamp, accuracyMeters: initialPoint.accuracy, maxAllowedAccuracyMeters: Tracking.DEFAULTS.maxAccuracyMeters });
    recordDiagnosticEvent({ type: "gps-ready", at: Date.now(), timestamp: initialPoint.timestamp, accuracyMeters: initialPoint.accuracy, manualStart: manual });
    recordDiagnosticEvent({ type: "recording-started", at: recordingStartedAt, timestamp: initialPoint.timestamp, manualStart: manual });
    return true;
  };
  const processPosition = async (position) => {
    if (finishing || cancelling) return;
    if (recordingActive && activeMode === "territory") setCapturePosition(null);
    const processedAt = Date.now();
    const displayResult = Tracking.evaluateDisplayPosition(position, processedAt);
    if (displayResult.accepted) {
      if (Tracking.shouldUpdateGpsMarker("preliminary", recordingActive)) updateAccuracyDisplay(displayResult.point);
      else updateAccuracyCircle(displayResult.point);
      completeLocationStartup(displayResult.point);
    } else if (!startupPositionReady) {
      const details = LocationUi.getLocationState({ reason: displayResult.reason, accuracy: position.coords?.accuracy });
      showLocationStartupError({ ...details, action: details.action || "" });
    }
    if (!warmingUp && !recordingActive) {
      const result = Tracking.evaluateLocationUpdate(position, latestLocation, processedAt);
      if (!result.accepted) {
        if (result.keepPrevious) {
          if (result.reason === "accuracy") showLocationState({ reason: "accuracy", accuracy: position.coords?.accuracy });
          return;
        }
        latestLocation = result.point;
        updateLocateButton(result.reason === "accuracy" ? "error" : "loading");
        showLocationState({ reason: result.reason, accuracy: position.coords?.accuracy });
        updateStartAvailability();
        return;
      }
      if (rememberLocation(result.point)) {
        updateLocationMarker(result.point);
        mapFollow.centerOn(result.point);
      }
      return;
    }
    if (warmingUp) {
      const warmup = gpsWarmup.add(position, Date.now());
      const warmupDecision = warmup.reason === "accuracy" || warmup.reason === "stale" ? "rejected" : warmup.stable ? "accepted" : "pending_confirmation";
      const warmupEvent = recordGpsDiagnostic(position, processedAt, "warm-up", warmupDecision, warmup.reason, warmupDiagnosticPrevious,
        {
          warmupCount: warmup.count,
          requiredConsecutivePositions: warmup.requiredPositions,
          requiredDurationMs: warmup.requiredDurationMs,
          warmupElapsedMs: warmup.elapsedMs ?? null,
          spatialSpreadMeters: warmup.spreadMeters ?? null
        });
      persistDiagnosticEvent(warmupEvent);
      warmupDiagnosticPrevious = warmup.count > 0 ? { lat: position.coords.latitude, lng: position.coords.longitude, timestamp: position.timestamp } : null;
      refreshManualWarmupStart();
      if (!warmup.stable) {
        if (warmup.reason === "accuracy") say(`GPS пока недостаточно точный (±${Math.round(position.coords.accuracy)} м; нужно ±${warmup.accuracyThresholdMeters} м или лучше). Оставайтесь на месте…`);
        else if (warmup.reason === "stale") say("GPS прислал устаревшую точку. Ждём свежий сигнал…");
        else if (warmup.reason === "inconsistent") say("GPS-позиции пока расходятся. Оставайтесь на месте, пока сигнал стабилизируется…");
        else if (warmup.reason === "interrupted") say("GPS-сигнал прерывался. Проверка устойчивой позиции началась заново…");
        else say(`Стабилизация GPS… ${warmup.count}/${warmup.requiredPositions}. Подождите перед началом движения.`);
        return;
      }

      await beginRecordingAt(warmup.point);
      return;
    }
    if (!recordingActive) return;
    const bufferingInitial = initialRouteBuffer.pending;
    const previousInitialBuffer = bufferingInitial ? initialRouteBuffer.snapshot() : [];
    const phase = bufferingInitial ? "initial-buffer" : "recording";
    const previous = pendingDiagnosticPrevious || (bufferingInitial ? previousInitialBuffer.at(-1) : points.at(-1));
    const result = bufferingInitial
      ? initialRouteBuffer.add(position, Date.now())
      : positionFilter.evaluate(position, points.at(-1), Date.now());
    const decision = result.candidate ? "pending_confirmation"
      : bufferingInitial && result.accepted ? "pending_confirmation"
        : result.accepted ? "accepted" : "rejected";
    const gpsEvent = recordGpsDiagnostic(position, processedAt, phase, decision, result.reason, previous, {
      pendingCandidate: Boolean(result.candidate),
      segmentStart: Boolean((result.points || [result.point]).some((point) => point?.segmentStart)),
      distanceMeters: result.distanceMeters ?? null
    });
    if (result.candidate) pendingDiagnosticPrevious = result.candidate;
    else if (result.accepted) pendingDiagnosticPrevious = null;
    if (result.candidate && phase === "recording") {
      pendingDiagnosticEvents.forEach((event) => { event.includedInRoute = false; event.pendingCandidate = false; });
      persistDiagnosticUpdates(pendingDiagnosticEvents);
      pendingDiagnosticEvents = gpsEvent ? [gpsEvent] : [];
      if (gpsEvent) gpsEvent.includedInRoute = null;
    }
    if (!result.accepted) {
      if (decision === "rejected" && gpsEvent) gpsEvent.includedInRoute = false;
      persistDiagnosticEvent(gpsEvent);
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
          pendingDiagnosticPrevious = null;
          if (gpsEvent) gpsEvent.includedInRoute = false;
          persistDiagnosticEvent(gpsEvent);
          say("Начальная GPS-точка не сохранена. Продолжаем проверку сигнала…");
          return;
        }
        persistDiagnosticEvent(gpsEvent);
        const lastValidatedPoint = result.validatedPoints.at(-1);
        if (lastValidatedPoint) {
          if (activeMode === "expedition") updateExpeditionStartMarker(result.validatedPoints[0]);
          rememberLocation(lastValidatedPoint);
          updateLocationMarker(lastValidatedPoint);
          mapFollow.centerOn(lastValidatedPoint);
          if (updateExpeditionProgress(lastValidatedPoint)) say("Цель достигнута. Завершаем экспедицию…");
        }
        return;
      }
      const nextPoints = [...points, ...result.validatedPoints];
      try { await saveDraftSnapshot(nextPoints, startedAt, []); }
      catch {
        initialRouteBuffer.restore(previousInitialBuffer);
        pendingDiagnosticPrevious = null;
        if (gpsEvent) gpsEvent.includedInRoute = false;
        persistDiagnosticEvent(gpsEvent);
        say("Начальный участок не удалось сохранить. Продолжаем проверку сигнала…");
        return;
      }
      const resolvedEvents = resolveDiagnosticEvents(nextPoints, ["warm-up", "initial-buffer"]);
      if (gpsEvent && !resolvedEvents.includes(gpsEvent)) persistDiagnosticEvent(gpsEvent);
      persistDiagnosticUpdates(resolvedEvents);
      recordDiagnosticEvent({
        type: "initial-buffer-validation", at: processedAt, result: "completed",
        bufferedPointCount: result.bufferedPoints.length, acceptedPointCount: result.validatedPoints.length,
        discardedPointCount: result.bufferedPoints.length - result.validatedPoints.length,
        distanceMeters: result.distanceMeters, acceptedTimestamps: result.validatedPoints.map((point) => point.timestamp)
      });
      initialRouteBuffer.reset(); positionFilter.reset();
      pendingDiagnosticPrevious = null;
      points = nextPoints; distanceMetersTotal = distanceForPoints(points);
      if (activeMode === "expedition" && points[0]) updateExpeditionStartMarker(points[0]);
      const lastValidatedPoint = result.validatedPoints.at(-1);
      drawCurrent(); updateDistance();
      if (lastValidatedPoint) {
        if (activeMode === "territory") setCapturePosition(lastValidatedPoint);
        rememberLocation(lastValidatedPoint);
        updateLocationMarker(lastValidatedPoint);
        mapFollow.centerOn(lastValidatedPoint);
        if (updateExpeditionProgress(lastValidatedPoint)) say("Цель достигнута. Завершаем экспедицию…");
      }
      return;
    }

    const nextPoints = [...points, ...(result.points || [result.point])];
    try { await saveDraftSnapshot(nextPoints, startedAt); }
    catch {
      if (gpsEvent) gpsEvent.includedInRoute = false;
      persistDiagnosticEvent(gpsEvent);
      pendingDiagnosticEvents.forEach((event) => { event.includedInRoute = false; event.pendingCandidate = false; });
      persistDiagnosticUpdates(pendingDiagnosticEvents);
      pendingDiagnosticEvents = [];
      say("Точка не записана: не удалось сохранить черновик на устройстве."); return;
    }

    points = nextPoints;
    distanceMetersTotal += result.distanceMeters;
    if (gpsEvent) gpsEvent.includedInRoute = true;
    persistDiagnosticEvent(gpsEvent);
    persistDiagnosticUpdates(resolveDiagnosticEvents(result.points || [result.point], ["recording"], true));
    if (activeMode === "territory") setCapturePosition(result.point);
    rememberLocation(result.point);
    drawCurrent(); updateDistance(); updateLocationMarker(result.point); mapFollow.centerOn(result.point);
    if (updateExpeditionProgress(result.point)) say("Цель достигнута. Завершаем экспедицию…");
    $("gps").textContent = `±${Math.round(result.point.accuracy)} м`;
    if (result.newSegment && points.length > 1) say("После перерыва начат новый участок маршрута.");
  };
  $("manualWarmupStart").addEventListener("click", () => {
    if (!warmingUp || warmupStartedAt === null || Date.now() - warmupStartedAt < Tracking.GPS_WARMUP_DEFAULTS.manualStartAfterMs) return;
    const candidate = gpsWarmup.manualStartPoint(Date.now(), Date.now() - warmupStartedAt);
    if (!candidate) { refreshManualWarmupStart(); return; }
    const modeNote = activeMode === "expedition" ? "Цель будет засчитана только по достоверной GPS-позиции." : "Захват территории будет использовать только точки, прошедшие обычную фильтрацию.";
    if (!confirm(`Точность GPS сейчас ±${Math.round(candidate.accuracy)} м. Начать прогулку с предупреждением? ${modeNote}`)) return;
    enqueueTrackingTask(async () => {
      if (!warmingUp || cancelling) return;
      const freshCandidate = gpsWarmup.manualStartPoint(Date.now(), Date.now() - warmupStartedAt);
      if (!freshCandidate) { refreshManualWarmupStart(); say("Координаты устарели. Ждём свежую надёжную GPS-позицию."); return; }
      await beginRecordingAt(freshCandidate, true);
    }).catch(() => {});
  });
  const receivePosition = (position) => enqueueTrackingTask(() => processPosition(position));
  const onLocationError = (error) => {
    recordDiagnosticEvent({ type: "gps-error", at: Date.now(), phase: warmingUp ? "warm-up" : recordingActive ? (initialRouteBuffer.pending ? "initial-buffer" : "recording") : "location", code: Number.isFinite(error?.code) ? error.code : null });
    noteLocationRequest(error?.code === 1 ? "PERMISSION_DENIED" : error?.code === 3 ? "TIMEOUT" : "POSITION_UNAVAILABLE");
    if (warmingUp || recordingActive) cancelPendingLocationRequest();
    if (recordingActive && activeMode === "expedition") setExpeditionCompassStale();
    expeditionLine.hide();
    if (accuracyCircle) {
      map.removeLayer(accuracyCircle);
      accuracyCircle = null;
    }
    latestLocation = null;
    if (recordingActive && activeMode === "territory") setCapturePosition(null);
    updateLocateButton("error");
    if (!warmingUp && !recordingActive) clearLocationMarker();
    updateStartAvailability();
    if (LocationUi.isPermissionDenied(error)) {
      locationPermissionDenied = true;
      musicControl.setLocationAllowed(false);
    }
    showLocationState({ error });
    const startupDetails = LocationUi.getLocationState({ error });
    showLocationStartupError({ ...startupDetails, message: LocationUi.isPermissionDenied(error)
      ? "Доступ запрещён. Разрешите геолокацию для этого сайта в настройках браузера, затем попробуйте снова."
      : startupDetails.message });
    if (cancelling) return;
    if (warmingUp) {
      gpsWarmup.reset();
      say(error.code === 1
        ? "Разрешите доступ к геолокации. Незавершённая прогулка сохранена."
        : "GPS-сигнал прервался. Стабилизация начнётся заново…");
      return;
    }
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
  const stopTrackingServices = () => gpsServices.stopAutosave();
  try { gpsServices.startWatch(); }
  catch { onLocationError({ code: 2 }); }
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
  const showExpeditionResult = (walk) => {
    $("expeditionResultDistance").textContent = formatKilometers(walk.distanceMeters);
    $("expeditionResultDuration").textContent = formatElapsed(walk.durationMs);
    $("expeditionResultTarget").textContent = `${walk.target.lat.toFixed(5)}, ${walk.target.lng.toFixed(5)}`;
    $("expeditionResult").hidden = false;
    $("expeditionResultClose").focus({ preventScroll: true });
  };
  const closeExpeditionResult = () => {
    $("expeditionResult").hidden = true;
    $("start").focus({ preventScroll: true });
  };
  $("expeditionResultClose").addEventListener("click", closeExpeditionResult);
  const showWalkInstructions = () => {
    $("walkInstructions").hidden = false;
    $("walkInstructionsClose").focus({ preventScroll: true });
  };
  const closeWalkInstructions = () => {
    $("walkInstructions").hidden = true;
    if (warmingUp) $("abandonWalk").focus({ preventScroll: true });
  };
  $("walkInstructionsClose").addEventListener("click", closeWalkInstructions);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("walkInstructions").hidden) closeWalkInstructions();
    if (event.key === "Escape" && !$("expeditionResult").hidden) closeExpeditionResult();
  });
  const startWalk = async (mode = selectedMode) => {
    if (!navigator.geolocation) { say("Этот браузер не поддерживает геолокацию."); return; }
    if (!storageReady || !draftResolved || starting || recordingActive || warmingUp || finishing || cancelling) return;
    if (mode === "expedition" && !expeditionTarget) {
      say("Сначала выберите цель экспедиции на карте или создайте случайную цель.");
      return;
    }
    selectedMode = mode;
    activeMode = mode;
    setCapturePosition(null);
    expeditionCompletionPending = false;
    expeditionDistanceMeters = mode === "expedition" && locationIsFresh(latestLocation) ? Tracking.distanceMeters(latestLocation, expeditionTarget) : null;
    positionFilter.reset(); gpsWarmup.reset(); initialRouteBuffer.reset();
    expeditionLine.hide();
    latestLocation = null; updateLocateButton("loading"); clearRouteStartMarker();
    showLocationState({});
    starting = true; setRecording(false);
    stopWarmupWaitTimer(); warmupStartedAt = null;
    cancelPendingLocationRequest();
    locateRequestId += 1;
    const newStartedAt = Date.now();
    const startPressedAt = newStartedAt;
    try {
      await WalkStorage.createDraft(db, draftSnapshot([], newStartedAt));
    } catch {
      gpsWarmup.reset();
      activeMode = "territory";
      starting = false; draftResolved = false; setRecording(false);
      say("Найдена незавершённая прогулка или хранилище недоступно. Перезагрузите страницу, чтобы восстановить черновик.");
      return;
    }
    diagnosticSession = createDiagnosticSession(newStartedAt);
    diagnosticsPersistenceFailed = false;
    warmupDiagnosticPrevious = null; pendingDiagnosticPrevious = null;
    persistDiagnosticSession();
    recordDiagnosticEvent({ type: "start", at: startPressedAt });
    points = []; distanceMetersTotal = 0; updateDistance(); startedAt = newStartedAt;
    warmingUp = true; warmupStartedAt = startPressedAt;
    try {
      startTrackingServices();
      starting = false; setRecording(false); say("");
      warmupWaitTimer = setInterval(refreshManualWarmupStart, 1000);
      if (mode === "territory") showWalkInstructions();
    } catch {
      positionFilter.reset(); initialRouteBuffer.reset();
      gpsWarmup.reset(); warmingUp = false;
      stopTrackingServices();
      recordDiagnosticEvent({ type: "gps-error", at: Date.now(), phase: "warm-up", source: "tracking-start" });
      try { await diagnosticsQueue; await WalkStorage.deleteDraft(db); diagnosticSession = null; draftResolved = true; }
      catch { draftResolved = false; }
      stopWarmupWaitTimer(); warmupStartedAt = null;
      points = []; startedAt = null; starting = false; setRecording(false);
      say("Не удалось запустить GPS. Черновик сохранён, если его не удалось удалить.");
    }
  };
  const abandonWalk = async () => {
    if ((!warmingUp && !recordingActive) || cancelling || finishing) return;
    if (recordingActive) {
      const confirmText = activeMode === "expedition"
        ? "Отступить и сохранить пройденный маршрут как незавершённую экспедицию?"
        : "Отступить и сохранить пройденный маршрут в истории? Территория захвачена не будет.";
      if (!confirm(confirmText)) return;
      await finishWalk(true);
      return;
    }
    cancelling = true; warmingUp = false;
    stopWarmupWaitTimer(); warmupStartedAt = null;
    positionFilter.reset(); gpsWarmup.reset(); stopTrackingServices();
    locateRequestId += 1;
    setRecording(false); clearActiveWalkView(); say("");
    try {
      await trackingQueue;
      await diagnosticsQueue;
      await WalkStorage.deleteDraft(db);
      clearActiveWalkView();
      diagnosticSession = null; diagnosticsPersistenceFailed = false;
      warmupDiagnosticPrevious = null; pendingDiagnosticPrevious = null; pendingDiagnosticEvents = [];
      draftResolved = true; starting = false; cancelling = false;
      setRecording(false); say("");
    } catch {
      recordDiagnosticEvent({ type: "retreat-delete-failed", at: Date.now() });
      await diagnosticsQueue;
      clearActiveWalkView();
      draftResolved = false; starting = false; cancelling = false;
      setRecording(false);
      say("Не удалось удалить черновик. Он сохранён; перезагрузите страницу, чтобы восстановить или удалить прогулку.");
    }
  };
  const clearActiveWalkView = () => {
    points = []; distanceMetersTotal = 0; startedAt = null;
    setCapturePosition(null);
    initialRouteBuffer.reset();
    expeditionTarget = null; expeditionDistanceMeters = null; expeditionCompletionPending = false;
    activeMode = "territory"; selectedMode = "territory"; targetMethod = "manual";
    hideExpeditionCompass();
    expeditionLine.hide();
    clearExpeditionStartMarker();
    updateExpeditionTargetMarker(null);
    $("expeditionTargetHint").textContent = "Коснитесь карты, чтобы выбрать цель.";
    $("anotherTarget").hidden = true; $("generateTarget").hidden = false;
    clearInterval(stopwatchTimer); stopwatchTimer = null;
    $("elapsed").textContent = "00:00:00";
    $("gps").textContent = "GPS";
    updateDistance();
    currentLines.forEach((line) => map.removeLayer(line)); currentLines = [];
    clearRouteStartMarker();
    updateModeSelection();
  };
  const finishWalk = async (retreated = false) => {
    if (!recordingActive || finishing || cancelling) return;
    const walkMode = activeMode;
    const expeditionReached = walkMode === "expedition" && !retreated && expeditionCompletionPending;
    if (walkMode === "expedition" && !retreated && !expeditionReached) return;
    if (!retreated && walkMode === "territory"
      && !Tracking.evaluateTerritoryCapture(initialRouteBuffer.pending ? [] : points, capturePosition).eligible) {
      updateCaptureAvailability();
      return;
    }
    recordDiagnosticEvent({ type: retreated ? "retreat" : expeditionReached ? "expedition-reached" : "finish", at: Date.now() });
    positionFilter.reset(); gpsWarmup.reset();
    finishing = true; expeditionLine.hide(); setRecording(true); stopTrackingServices();
    try {
      await trackingQueue;
      const bufferedPoints = initialRouteBuffer.pending ? initialRouteBuffer.flush().points : [];
      const finishedPoints = [...points, ...bufferedPoints];
      const finishedDistance = distanceForPoints(finishedPoints);
      if (!retreated && walkMode === "territory" && finishedPoints.length < 2) {
        recordDiagnosticEvent({ type: "finish-rejected", at: Date.now(), reason: "insufficient-route-points", pointCount: finishedPoints.length });
        resumeAfterFinishFailure("Нужно ещё GPS-точек для сохранения. Продолжаем запись.");
        return;
      }
      const finishedAt = Date.now();
      const closed = walkMode === "territory" && !retreated && Tracking.canCloseTrack(finishedPoints);
      const walk = {
        id: crypto.randomUUID(), points: finishedPoints, startedAt, finishedAt,
        durationMs: finishedAt - startedAt, distanceMeters: finishedDistance,
        ...(finishedPoints[0] ? { startPosition: { ...finishedPoints[0] } } : {}),
        mode: walkMode, closed, showOnMap: !retreated && (closed || walkMode === "expedition"),
        ...(walkMode === "expedition" ? {
          target: expeditionTarget ? { ...expeditionTarget } : null,
          expeditionStatus: retreated ? "incomplete" : "reached"
        } : {}),
        ...(retreated ? { status: "retreated" } : {})
      };
      if (initialRouteBuffer.pending) recordDiagnosticEvent({
        type: "initial-buffer-validation", at: finishedAt, result: "flushed-on-finish",
        bufferedPointCount: initialRouteBuffer.snapshot().length, acceptedPointCount: bufferedPoints.length,
        discardedPointCount: initialRouteBuffer.snapshot().length - bufferedPoints.length,
        distanceMeters: distanceForPoints(bufferedPoints), acceptedTimestamps: bufferedPoints.map((point) => point.timestamp)
      });
      persistDiagnosticUpdates(resolveDiagnosticEvents(finishedPoints));
      if (diagnosticSession) {
        diagnosticSession.finalRoute = finishedPoints.map((point) => ({ ...point }));
        diagnosticSession.finishedAt = finishedAt;
        diagnosticSession.territoryCaptured = closed;
        diagnosticSession.walkStatus = retreated ? "retreated" : "completed";
        diagnosticSession.state = "finalizing";
        diagnosticSession.walkId = walk.id;
      }
      await diagnosticsQueue;
      if (diagnosticSession) await persistDiagnosticSession();
      await diagnosticsQueue;
      await WalkStorage.completeWalk(db, walk);
      clearRouteStartMarker();
      clearExpeditionStartMarker();
      stopStopwatch(finishedAt);
      points = []; distanceMetersTotal = 0; startedAt = null; draftResolved = true; updateDistance();
      setCapturePosition(null);
      initialRouteBuffer.reset();
      expeditionCompletionPending = false;
      expeditionTarget = null; expeditionDistanceMeters = null;
      hideExpeditionCompass();
      expeditionLine.hide();
      activeMode = "territory"; selectedMode = "territory"; targetMethod = "manual";
      updateExpeditionTargetMarker(null);
      $("expeditionTargetHint").textContent = "Коснитесь карты, чтобы выбрать цель.";
      $("anotherTarget").hidden = true; $("generateTarget").hidden = false;
      setRecording(false);
      let diagnosticsSaved = true;
      try {
        await diagnosticsQueue;
        if (diagnosticSession) {
          diagnosticSession.diagnosticsPersistenceFailed = diagnosticsPersistenceFailed;
          await WalkStorage.completeDiagnostics(db, walk.id, diagnosticSession);
        }
      } catch {
        diagnosticsSaved = false;
        diagnosticsPersistenceFailed = true;
      }
      diagnosticSession = null; diagnosticsPersistenceFailed = false;
      warmupDiagnosticPrevious = null; pendingDiagnosticPrevious = null; pendingDiagnosticEvents = [];
      finishing = false; setRecording(false);
      currentLines.forEach((line) => map.removeLayer(line)); currentLines = [];
      say(diagnosticsSaved
        ? retreated ? "Вы отступили. Маршрут сохранён в истории, территория не захвачена."
          : walkMode === "expedition" ? "Экспедиция завершена. Цель достигнута."
            : closed ? "Маршрут замкнут, территория закрашена." : "Контур не замкнулся — захват не состоялся."
        : "Прогулка сохранена, но диагностику не удалось сохранить.");
      if (closed) mapFollow.setEnabled(false);
      try { await redrawSaved({ focusWalkId: closed ? walk.id : null }); } catch { say("Прогулка сохранена, но список не удалось обновить."); }
      updateModeSelection();
      if (walk.expeditionStatus === "reached") showExpeditionResult(walk);
    } catch {
      if (diagnosticSession?.state === "finalizing") {
        diagnosticSession.state = "active";
        delete diagnosticSession.walkId;
        delete diagnosticSession.walkStatus;
        delete diagnosticSession.finalRoute;
        delete diagnosticSession.finishedAt;
        delete diagnosticSession.territoryCaptured;
        persistDiagnosticSession();
        await diagnosticsQueue;
      }
      recordDiagnosticEvent({ type: "finish-failed", at: Date.now() });
      resumeAfterFinishFailure("Не удалось завершить прогулку. Черновик сохранён, запись продолжается.");
    }
  };
  $("start").addEventListener("click", () => startWalk("territory"));
  $("startExpedition").addEventListener("click", () => startWalk("expedition"));
  Actions.bindClick($("abandonWalk"), abandonWalk);
  Actions.bindClick($("finish"), () => finishWalk());
  $("copyActiveDiagnostics").addEventListener("click", copyActiveDiagnostics);
  let locateRequestId = 0;
  $("locate").addEventListener("click", () => {
    const requestId = ++locateRequestId;
    if (!mapFollow.toggle()) {
      say("Следование за местоположением отключено.");
      return;
    }
    if (locationIsFresh(latestLocation)) {
      centerMapOnPosition(latestLocation, requestId);
      say("");
    } else {
      say("📡 Следование включено. Определяем ваше местоположение.");
      if (!recordingActive && !warmingUp && locationState === "error") requestCurrentLocation();
    }
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
        starting = true;
        activeMode = draft.mode === "expedition" ? "expedition" : "territory";
        selectedMode = activeMode;
        targetMethod = draft.targetMethod === "random" ? "random" : "manual";
        expeditionTarget = activeMode === "expedition" && Number.isFinite(draft.target?.lat) && Number.isFinite(draft.target?.lng)
          ? { lat: draft.target.lat, lng: draft.target.lng } : null;
        expeditionDistanceMeters = null; expeditionCompletionPending = false;
        updateExpeditionTargetMarker(expeditionTarget);
        $("expeditionTargetHint").textContent = expeditionTarget
          ? targetMethod === "random" ? "Восстановлена случайная цель экспедиции." : "Восстановлена цель экспедиции."
          : "У черновика экспедиции нет сохранённой цели. Можно отступить и сохранить пройденный маршрут.";
        updateModeSelection();
        let restoredDiagnostics = null;
        let diagnosticsReadFailed = false;
        try { restoredDiagnostics = await WalkStorage.readDiagnostics(db, "active"); }
        catch { diagnosticsReadFailed = true; }
        diagnosticSession = restoredDiagnostics
          ? Diagnostics.restoreSession(restoredDiagnostics, restoredDiagnostics.events)
          : createDiagnosticSession(draft.startedAt || Date.now(), true);
        diagnosticSession.restored = true;
        diagnosticsPersistenceFailed = diagnosticsReadFailed;
        warmupDiagnosticPrevious = null; pendingDiagnosticPrevious = null; pendingDiagnosticEvents = [];
        diagnosticSession.events.forEach((event) => {
          if (event.pendingCandidate) {
            event.pendingCandidate = false;
            event.decision = "rejected";
            event.includedInRoute = false;
            event.filteringReason = event.filteringReason || "tracking-interrupted-by-reload";
          }
        });
        if (diagnosticSession.state === "finalizing") {
          diagnosticSession.state = "active";
          delete diagnosticSession.walkId;
          delete diagnosticSession.walkStatus;
          delete diagnosticSession.finalRoute;
          delete diagnosticSession.finishedAt;
          delete diagnosticSession.territoryCaptured;
        }
        persistDiagnosticSession();
        recordDiagnosticEvent({ type: "draft-restored", at: Date.now(), pointCount: (draft.points || []).length, bufferedPointCount: (draft.initialBuffer || []).length });
          locateRequestId += 1;
          points = draftPoints;
          initialRouteBuffer.restore(draftInitialBuffer);
          setCapturePosition(null);
          if (locationIsFresh(latestLocation)) updateLocationMarker(latestLocation);
          else { latestLocation = null; updateLocateButton("loading"); clearLocationMarker(); }
          distanceMetersTotal = distanceForPoints(points);
          startedAt = Number.isFinite(draft.startedAt) ? draft.startedAt : Date.now();
          warmingUp = wasWarmingUp;
          warmupStartedAt = wasWarmingUp ? (Number.isFinite(draft.startedAt) ? draft.startedAt : Date.now()) : null;
          updateDistance(); drawCurrent();
          const restoredValidatedPoints = points.length ? points : initialRouteBuffer.flush().points;
          if (restoredValidatedPoints.length) {
            if (!warmingUp) {
              if (activeMode === "expedition") updateExpeditionStartMarker(restoredValidatedPoints[0]);
              else updateRouteStartMarker(restoredValidatedPoints[0]);
            }
          }
          draftResolved = true;
          try {
            startTrackingServices();
            starting = false;
            setRecording(!warmingUp);
            if (warmingUp) { say(""); warmupWaitTimer = setInterval(refreshManualWarmupStart, 1000); }
            else { startStopwatch(); say("Прогулка восстановлена. Ожидаем свежую GPS-точку…"); }
          } catch {
            starting = false;
            positionFilter.reset(); gpsWarmup.reset(); initialRouteBuffer.reset(); warmingUp = false;
            stopWarmupWaitTimer(); warmupStartedAt = null;
            recordDiagnosticEvent({ type: "gps-error", at: Date.now(), phase: "draft-restoration", source: "tracking-start" });
            stopTrackingServices(); draftResolved = false; setRecording(false);
            say("Черновик сохранён, но GPS не удалось запустить. Перезагрузите страницу, чтобы попробовать снова.");
          }
        } else {
          try { await WalkStorage.deleteDraft(db); draftResolved = true; clearActiveWalkView(); }
          catch {
            draftResolved = false;
            say("Черновик не удалось удалить. Он сохранён, чтобы не потерять прогулку.");
          }
        }
      } else {
        draftResolved = true;
        try {
          const unfinishedDiagnostics = await WalkStorage.readDiagnostics(db, "active");
          if (unfinishedDiagnostics?.state === "finalizing" && unfinishedDiagnostics.walkId) {
            const walks = await WalkStorage.readWalks(db);
            if (walks.some((walk) => walk.id === unfinishedDiagnostics.walkId)) {
              await WalkStorage.completeDiagnostics(db, unfinishedDiagnostics.walkId, Diagnostics.restoreSession(unfinishedDiagnostics, unfinishedDiagnostics.events));
            } else await WalkStorage.deleteDiagnostics(db, "active");
          } else await WalkStorage.deleteDiagnostics(db, "active");
        } catch {}
      }
      setRecording(recordingActive);
    } catch {
      starting = false;
      positionFilter.reset(); gpsWarmup.reset(); initialRouteBuffer.reset(); warmingUp = false;
      stopWarmupWaitTimer(); warmupStartedAt = null;
      storageReady = false; draftResolved = false; setRecording(false);
      say("IndexedDB недоступна. Попробуйте открыть приложение в современном браузере по HTTPS.");
    }
  })();
})();
