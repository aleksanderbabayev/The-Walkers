(() => {
  "use strict";
  const DB_NAME = "the-walkers", DB_VERSION = 1;
  const AUTOSAVE_MS = 5000, CLOSE_METERS = 50, MIN_POINTS = 4;
  const $ = (id) => document.getElementById(id);
  const appVersion = document.querySelector('meta[name="app-version"]').content;
  $("appVersion").textContent = `Версия ${appVersion}`;
  const MUSIC_PREFERENCE_KEY = "the-walkers-music-muted";
  let musicMuted = false, audioContext = null, musicGain = null;
  try { musicMuted = localStorage.getItem(MUSIC_PREFERENCE_KEY) === "true"; } catch {}
  const updateMusicButton = () => {
    const button = $("musicToggle");
    const isPlaying = !musicMuted && audioContext?.state === "running";
    const label = musicMuted ? "Включить фоновую музыку" : isPlaying ? "Выключить фоновую музыку" : "Запустить фоновую музыку";
    button.textContent = musicMuted ? "🔇" : isPlaying ? "🔊" : "▶️";
    button.setAttribute("aria-pressed", String(isPlaying));
    button.setAttribute("aria-label", label);
    button.title = label;
  };
  const startBackgroundMusic = async () => {
    if (musicMuted) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioContext) {
      audioContext = new AudioContextClass();
      musicGain = audioContext.createGain();
      musicGain.gain.value = 0.06;
      musicGain.connect(audioContext.destination);
      [261.63, 329.63, 392, 523.25].forEach((frequency, index) => {
        const tone = audioContext.createOscillator();
        const volume = audioContext.createGain();
        tone.type = "sine";
        tone.frequency.value = frequency;
        volume.gain.value = 0.2;
        tone.connect(volume);
        volume.connect(musicGain);
        tone.start();
        const swell = audioContext.createOscillator();
        const swellDepth = audioContext.createGain();
        swell.frequency.value = 0.06 + index * 0.015;
        swellDepth.gain.value = 0.03;
        swell.connect(swellDepth);
        swellDepth.connect(volume.gain);
        swell.start();
      });
      audioContext.addEventListener("statechange", updateMusicButton);
    }
    if (audioContext.state === "suspended") await audioContext.resume();
    updateMusicButton();
  };
  const unlockBackgroundMusic = (event) => {
    if (event.target.closest?.("#musicToggle")) return;
    if (!musicMuted) startBackgroundMusic().catch(() => {});
    document.removeEventListener("pointerdown", unlockBackgroundMusic, true);
    document.removeEventListener("keydown", unlockBackgroundMusic, true);
  };
  updateMusicButton();
  startBackgroundMusic().catch(() => {});
  document.addEventListener("pointerdown", unlockBackgroundMusic, true);
  document.addEventListener("keydown", unlockBackgroundMusic, true);
  $("musicToggle").addEventListener("click", async () => {
    if (!musicMuted && audioContext?.state !== "running") {
      await startBackgroundMusic().catch(() => {});
      updateMusicButton();
      return;
    }
    musicMuted = !musicMuted;
    try { localStorage.setItem(MUSIC_PREFERENCE_KEY, String(musicMuted)); } catch {}
    updateMusicButton();
    if (musicGain && audioContext) {
      const now = audioContext.currentTime;
      musicGain.gain.cancelScheduledValues(now);
      musicGain.gain.setTargetAtTime(musicMuted ? 0 : 0.06, now, 0.15);
    }
    if (!musicMuted) await startBackgroundMusic().catch(() => {});
  });
  const map = L.map("map", { zoomControl: false }).setView([48.998, 21.239], 14);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  let db, watchId = null, points = [], currentLine = null, savedLayers = [], saveTimer = null, stopwatchTimer = null, startedAt = null;
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
  const dbRequest = (storeName, mode, operation) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
  });
  const saveWalkAndDeleteDraft = (walk) => new Promise((resolve, reject) => {
    const transaction = db.transaction(["walks", "drafts"], "readwrite");
    transaction.objectStore("walks").put(walk);
    transaction.objectStore("drafts").delete("active");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
  });
  const distanceMeters = (a, b) => {
    const radius = 6371000, rad = (value) => value * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
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
    document.querySelector(".status").classList.toggle("recording", active);
    $("statusTitle").textContent = active ? "Идёт захват территории" : "Готовы к прогулке?";
    $("statusText").textContent = active ? "Точки сохраняются на устройстве" : "Нажмите «Начать захват территории», чтобы записать маршрут";
    $("start").disabled = active;
    $("start").hidden = active;
    $("finish").disabled = !active;
    $("finish").hidden = !active;
  };
  const saveDraft = () => dbRequest("drafts", "readwrite", (store) => store.put({ id: "active", points, startedAt, updatedAt: Date.now() }));
  const drawCurrent = () => {
    if (currentLine) map.removeLayer(currentLine);
    if (points.length > 1) currentLine = L.polyline(points.map((point) => [point.lat, point.lng]), { color: "#e0765d", weight: 4 }).addTo(map);
  };
  const redrawSaved = async () => {
    savedLayers.forEach((layer) => map.removeLayer(layer));
    savedLayers = [];
    const walks = await dbRequest("walks", "readonly", (store) => store.getAll());
    walks.sort((a, b) => b.finishedAt - a.finishedAt);
    $("count").textContent = walks.length;
    const list = $("routes");
    list.replaceChildren();
    if (!walks.length) {
      const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Здесь появятся ваши маршруты и территории"; list.append(empty); return;
    }
    walks.forEach((walk, index) => {
      const latlngs = walk.points.map((point) => [point.lat, point.lng]);
      const layer = walk.closed
        ? L.polygon(latlngs, { color: "#477b43", weight: 3, fillColor: "#8fbd70", fillOpacity: 0.35 })
        : L.polyline(latlngs, { color: "#e0765d", weight: 4 });
      layer.addTo(map); savedLayers.push(layer);
      const row = document.createElement("div"); row.className = "route";
      const icon = document.createElement("span"); icon.className = "routeIcon"; icon.textContent = walk.closed ? "⬟" : "↗";
      const details = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = `${walk.closed ? "Захваченная территория" : "Маршрут"} ${walks.length - index}`;
      const meta = document.createElement("small"); meta.textContent = `${new Date(walk.finishedAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })} · ${walk.points.length} точек`;
      details.append(title, meta); row.append(icon, details); list.append(row);
    });
    if (!points.length) {
      const group = L.featureGroup(savedLayers);
      if (group.getBounds().isValid()) map.fitBounds(group.getBounds().pad(0.15), { maxZoom: 16 });
    }
  };
  const receivePosition = async (position) => {
    const point = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: position.timestamp };
    if (points.length && distanceMeters(points.at(-1), point) < 4) return;
    points.push(point); drawCurrent(); map.panTo([point.lat, point.lng]);
    $("gps").textContent = `±${Math.round(point.accuracy)} м`;
    try { await saveDraft(); } catch { say("Не удалось сохранить точку локально."); }
  };
  const onLocationError = (error) => {
    const message = error.code === 1 ? "Разрешите доступ к геолокации в настройках браузера." : "Нет GPS-сигнала. Проверьте геолокацию и попробуйте выйти на открытое место.";
    say(message);
  };
  const startWalk = async () => {
    if (!navigator.geolocation) { say("Этот браузер не поддерживает геолокацию."); return; }
    points = []; startedAt = Date.now(); startStopwatch(); say("Ожидаем GPS-сигнал…"); setRecording(true);
    try {
      await saveDraft();
      watchId = navigator.geolocation.watchPosition(receivePosition, onLocationError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
      saveTimer = setInterval(() => saveDraft().catch(() => say("Не удалось сохранить черновик прогулки.")), AUTOSAVE_MS);
    } catch { stopStopwatch(); say("Не удалось открыть локальное хранилище."); setRecording(false); }
  };
  const finishWalk = async () => {
    const finishedAt = Date.now();
    stopStopwatch(finishedAt);
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    clearInterval(saveTimer); watchId = null; saveTimer = null;
    try {
      await saveDraft();
      if (points.length < 2) { say("Пока недостаточно GPS-точек. Черновик сохранён."); setRecording(false); return; }
      const gap = distanceMeters(points[0], points.at(-1));
      const closed = points.length >= MIN_POINTS && gap <= CLOSE_METERS;
      const walk = { id: crypto.randomUUID(), points, startedAt, finishedAt, durationMs: finishedAt - startedAt, closed };
      await saveWalkAndDeleteDraft(walk);
      points = [];
      if (currentLine) { map.removeLayer(currentLine); currentLine = null; }
      say(closed ? `Маршрут замкнут, территория закрашена (разрыв ${Math.round(gap)} м).` : `Маршрут сохранён как линия (разрыв ${Math.round(gap)} м).`);
      setRecording(false); await redrawSaved();
    } catch { say("Не удалось сохранить прогулку. Черновик оставлен на устройстве."); setRecording(false); }
  };
  $("start").addEventListener("click", startWalk);
  $("finish").addEventListener("click", finishWalk);
  $("locate").addEventListener("click", () => {
    if (!navigator.geolocation) return say("Геолокация недоступна в этом браузере.");
    navigator.geolocation.getCurrentPosition((position) => map.setView([position.coords.latitude, position.coords.longitude], 16), onLocationError, { enableHighAccuracy: true, timeout: 15000 });
  });
  (async () => {
    try {
      db = await openDb();
      const draft = await dbRequest("drafts", "readonly", (store) => store.get("active"));
      await redrawSaved();
      if (draft?.points?.length) {
        const resume = confirm("Найдена незавершённая прогулка. Продолжить запись?");
        if (resume) {
          if (!navigator.geolocation) {
            say("Геолокация недоступна в этом браузере. Черновик сохранён для восстановления в другом браузере.");
            return;
          }
          points = draft.points; startedAt = draft.startedAt; drawCurrent();
          map.setView([points.at(-1).lat, points.at(-1).lng], 16); setRecording(true);
          startStopwatch();
          watchId = navigator.geolocation.watchPosition(receivePosition, onLocationError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
          saveTimer = setInterval(() => saveDraft().catch(() => say("Не удалось сохранить черновик прогулки.")), AUTOSAVE_MS);
        } else await dbRequest("drafts", "readwrite", (store) => store.delete("active"));
      }
    } catch { say("IndexedDB недоступна. Попробуйте открыть приложение в современном браузере по HTTPS."); }
  })();
})();
