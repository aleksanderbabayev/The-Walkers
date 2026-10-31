(() => {
  "use strict";

  const createLocationStartupGate = ({
    navigatorLike,
    onState = () => {},
    onPermissionState = () => {},
    onReady = () => {},
    timeoutMs = 20000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  }) => {
    let state = "idle", requestPending = false, ready = false, disposed = false, requestId = 0;
    let timeoutHandle = null, permissionStatus = null;

    const clearRequest = () => {
      if (timeoutHandle !== null) clearTimer(timeoutHandle);
      timeoutHandle = null;
      requestPending = false;
    };
    const complete = (nextState, result) => {
      if (ready) return;
      clearRequest();
      ready = true;
      state = nextState;
      onState(nextState, result);
      onReady(nextState, result);
    };
    const request = () => {
      if (ready || requestPending) return;
      const geolocation = navigatorLike?.geolocation;
      if (typeof geolocation?.getCurrentPosition !== "function") {
        complete("unavailable", { reason: "unsupported" });
        return;
      }

      requestPending = true;
      state = "checking";
      onState(state);
      const currentRequest = ++requestId;
      const finish = (nextState, result) => {
        if (currentRequest !== requestId || ready) return;
        if (nextState === "denied") {
          clearRequest();
          state = nextState;
          onState(nextState, result);
          return;
        }
        complete(nextState, result);
      };
      timeoutHandle = setTimer(() => finish("unavailable", { error: { code: 3 } }), timeoutMs + 1000);
      try {
        geolocation.getCurrentPosition(
          (position) => finish("ready", { position }),
          (error) => finish(error?.code === 1 ? "denied" : "unavailable", { error }),
          { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs }
        );
      } catch {
        finish("unavailable", { error: { code: 2 } });
      }
    };
    const handleResume = () => {
      if (state === "denied") request();
    };
    const handlePermissionChange = () => {
      onPermissionState(permissionStatus?.state || "unknown");
      if (permissionStatus?.state === "granted" && state === "denied") request();
    };
    const handleVisibility = () => {
      if (navigatorLike?.document?.visibilityState !== "hidden") handleResume();
    };
    const start = () => {
      if (state !== "idle") return;
      try {
        if (typeof navigatorLike?.permissions?.query === "function") {
          Promise.resolve(navigatorLike.permissions.query({ name: "geolocation" }))
            .then((permission) => {
              if (disposed) return;
              permissionStatus = permission;
              onPermissionState(permission.state);
              permission.addEventListener?.("change", handlePermissionChange);
              if (!permission.addEventListener) permission.onchange = handlePermissionChange;
              handlePermissionChange();
            })
            .catch(() => onPermissionState("unknown"));
        }
      } catch {
        onPermissionState("unknown");
      }
      navigatorLike?.window?.addEventListener("pageshow", handleResume);
      navigatorLike?.window?.addEventListener("focus", handleResume);
      navigatorLike?.document?.addEventListener("visibilitychange", handleVisibility);
      request();
    };
    const dispose = () => {
      disposed = true;
      requestId += 1;
      clearRequest();
      permissionStatus?.removeEventListener?.("change", handlePermissionChange);
      if (permissionStatus && !permissionStatus.removeEventListener) permissionStatus.onchange = null;
      navigatorLike?.window?.removeEventListener("pageshow", handleResume);
      navigatorLike?.window?.removeEventListener("focus", handleResume);
      navigatorLike?.document?.removeEventListener("visibilitychange", handleVisibility);
    };
    return { start, dispose, getState: () => state };
  };

  if (typeof module !== "undefined" && module.exports) module.exports = { createLocationStartupGate };
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const $ = (id) => document.getElementById(id);
  const appVersion = document.querySelector('meta[name="app-version"]').content;
  const permissionStates = { state: typeof navigator.permissions?.query === "function" ? "unknown" : "unsupported" };
  let lastRequest = { result: "none", checkedAt: null };
  const requestResult = (state, result) => {
    if (state === "checking") return "pending";
    if (state === "ready") return "success";
    if (state === "denied") return "PERMISSION_DENIED";
    if (result?.error?.code === 3) return "TIMEOUT";
    if (result?.error?.code === 2) return "POSITION_UNAVAILABLE";
    return "none";
  };
  const createReport = () => window.WalkLocationDiagnostics.createReport({
    navigatorLike: navigator,
    appVersion,
    permissionState: permissionStates.state,
    lastRequest,
    checkedAt: Date.now()
  });
  const diagnosticsUi = window.WalkLocationDiagnostics.createUi({
    documentLike: document, navigatorLike: navigator, getReport: createReport,
    fields: $("locationDiagnosticsFields"), status: $("locationDiagnosticsStatus"), fallback: $("locationDiagnosticsFallback")
  });
  const renderDiagnostics = () => diagnosticsUi.render();
  const loadScript = (source) => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Unable to load ${source}`));
    document.body.append(script);
  });
  const appScripts = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://unpkg.com/@tomickigrzegorz/leaflet-rotate@0.3.0/dist/leaflet-rotate.umd.min.js",
    "walk-diagnostics.js?v=0.1.44", "walk-actions.js?v=0.1.45", "tracking-core.js?v=0.1.47",
    "walk-storage.js?v=0.1.44", "location-ui.js?v=0.1.67", "music-control.js?v=0.1.62", "app.js?v=0.1.67"
  ];
  let appStarted = false;
  const startApp = async (state, result) => {
    if (appStarted) return;
    appStarted = true;
    window.WalkStartupResult = { state, ...result };
    gate.dispose();
    try {
      for (const source of appScripts) await loadScript(source);
      document.body.classList.remove("location-pending", "location-access-denied");
      $("locationStartupScreen").hidden = true;
      $("locationAccessScreen").hidden = true;
    } catch {
      document.body.classList.remove("location-access-denied");
      document.body.classList.add("location-pending");
      $("locationStartupTitle").textContent = "Не удалось запустить The Walkers";
      $("locationStartupMessage").textContent = "Проверьте подключение к интернету и перезагрузите страницу.";
      $("locationAccessScreen").hidden = true;
      $("locationStartupScreen").hidden = false;
    }
  };
  const gate = createLocationStartupGate({
    navigatorLike: { geolocation: navigator.geolocation, permissions: navigator.permissions, window, document },
    onState: (state, result) => {
      const outcome = requestResult(state, result);
      if (outcome !== "none") lastRequest = { result: outcome, checkedAt: Date.now() };
      if (state === "denied") {
        document.body.classList.remove("location-pending");
        document.body.classList.add("location-access-denied");
        $("locationStartupScreen").hidden = true;
        $("locationAccessScreen").hidden = false;
        $("locationAccessReload").focus({ preventScroll: true });
      }
      if ($("locationDiagnostics").open) renderDiagnostics();
    },
    onPermissionState: (state) => {
      permissionStates.state = state;
      if ($("locationDiagnostics").open) renderDiagnostics();
    },
    onReady: startApp
  });
  $("locationAccessReload").addEventListener("click", () => window.location.reload());
  $("locationDiagnostics").addEventListener("toggle", () => {
    if ($("locationDiagnostics").open) renderDiagnostics();
  });
  $("copyLocationDiagnostics").addEventListener("click", () => diagnosticsUi.copy());
  gate.start();
})();
