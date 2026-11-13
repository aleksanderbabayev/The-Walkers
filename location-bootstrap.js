(() => {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const $ = (id) => document.getElementById(id);
  const appScripts = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://unpkg.com/@tomickigrzegorz/leaflet-rotate@0.3.0/dist/leaflet-rotate.umd.min.js",
    "walk-colors.js?v=0.2.25",
    "utility-menu.js?v=0.1.0",
    "walk-diagnostics.js?v=0.1.45", "walk-actions.js?v=0.1.48", "tracking-core.js?v=0.2.11",
    "walk-storage.js?v=0.1.44", "location-ui.js?v=0.2.8", "music-control.js?v=0.1.62", "map-follow.js?v=0.1.74",
    "expedition-core.js?v=0.2.3", "expedition-line.js?v=0.2.4", "expedition-markers.js?v=0.2.7", "app.js?v=0.2.29"
  ];

  const loadScript = (source) => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Unable to load ${source}`));
    document.body.append(script);
  });

  const startApp = async () => {
    try {
      for (const source of appScripts) await loadScript(source);
      $("locationStartupScreen").hidden = false;
    } catch {
      $("locationStartupTitle").textContent = "Не удалось запустить The Walkers";
      $("locationStartupMessage").textContent = "Проверьте подключение к интернету и перезагрузите страницу.";
      $("locationStartupScreen").hidden = false;
    }
  };

  startApp();
})();
