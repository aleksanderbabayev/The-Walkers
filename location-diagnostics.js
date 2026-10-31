(() => {
  "use strict";
  const permissionStates = new Set(["granted", "prompt", "denied", "unsupported", "unknown"]);
  const requestResults = new Set(["none", "pending", "success", "PERMISSION_DENIED", "POSITION_UNAVAILABLE", "TIMEOUT"]);
  const versionFrom = (userAgent, pattern) => userAgent.match(pattern)?.[1]?.replaceAll("_", ".") || null;

  const getPlatform = (userAgent = "", platform = "", maxTouchPoints = 0) => {
    if (platform === "MacIntel" && maxTouchPoints > 1) return { name: "iPadOS", version: null };
    const candidates = [
      ["Android", /Android\s([\d.]+)/i],
      ["iOS", /(?:iPhone OS|CPU OS)\s([\d_]+)/i],
      ["Windows", /Windows NT\s([\d.]+)/i],
      ["macOS", /Mac OS X\s([\d_]+)/i],
      ["ChromeOS", /CrOS\s[\w-]+\s([\d.]+)/i]
    ];
    for (const [name, pattern] of candidates) {
      const version = versionFrom(userAgent, pattern);
      if (version) return { name, version };
    }
    if (/Linux/i.test(userAgent)) return { name: "Linux", version: null };
    return { name: "Не определяется", version: null };
  };

  const getBrowser = (userAgent = "") => {
    const candidates = [
      ["Microsoft Edge", /(?:EdgiOS|EdgA?|Edge)\/([\d.]+)/i],
      ["Opera", /(?:OPR|Opera)\/([\d.]+)/i],
      ["Samsung Internet", /SamsungBrowser\/([\d.]+)/i],
      ["Chrome", /(?:CriOS|Chrome)\/([\d.]+)/i],
      ["Firefox", /(?:FxiOS|Firefox)\/([\d.]+)/i],
      ["Safari", /Version\/([\d.]+).*Safari/i]
    ];
    for (const [name, pattern] of candidates) {
      const version = versionFrom(userAgent, pattern);
      if (version) return { name, version };
    }
    return { name: "Не определяется", version: null };
  };

  const createReport = ({ navigatorLike = {}, appVersion = "unknown", permissionState = "unknown", lastRequest, checkedAt = Date.now() } = {}) => {
    const userAgent = typeof navigatorLike.userAgent === "string" ? navigatorLike.userAgent : "";
    const permissionsApiAvailable = typeof navigatorLike.permissions?.query === "function";
    const geolocationApiAvailable = typeof navigatorLike.geolocation?.getCurrentPosition === "function";
    const state = permissionsApiAvailable && permissionStates.has(permissionState)
      ? permissionState : permissionsApiAvailable ? "unknown" : "unsupported";
    return {
      formatVersion: 1,
      appVersion,
      checkedAt: new Date(checkedAt).toISOString(),
      operatingSystem: getPlatform(userAgent, navigatorLike.platform, navigatorLike.maxTouchPoints),
      browser: getBrowser(userAgent),
      geolocationApi: geolocationApiAvailable ? "available" : "unsupported",
      permissionsApi: permissionsApiAvailable ? "available" : "unsupported",
      geolocationPermission: state,
      operatingSystemLocationPermission: "Не определяется",
      siteLocationPermission: "Не определяется отдельно",
      lastRequest: lastRequest ? {
        result: requestResults.has(lastRequest.result) ? lastRequest.result : "unknown",
        checkedAt: Number.isFinite(lastRequest.checkedAt) ? new Date(lastRequest.checkedAt).toISOString() : null
      } : { result: "none", checkedAt: null },
      userAgent: userAgent || "Не определяется"
    };
  };

  const createUi = ({ documentLike, navigatorLike, getReport, fields, status, fallback }) => {
    const viewRows = (report) => {
      const permissionLabels = {
        granted: "Разрешено (granted)", prompt: "Неизвестно: ожидается решение (prompt)",
        denied: "Запрещено (denied)", unknown: "Неизвестно", unsupported: "Не поддерживается"
      };
      const requestLabels = {
        none: "Запросов не было", pending: "Запрос выполняется", success: "Успех",
        PERMISSION_DENIED: "PERMISSION_DENIED", POSITION_UNAVAILABLE: "POSITION_UNAVAILABLE", TIMEOUT: "TIMEOUT"
      };
      const dateLabel = (value) => value ? new Date(value).toLocaleString() : "—";
      const platformLabel = ({ name, version }) => version ? `${name} ${version}` : name;
      return [
        ["Операционная система", platformLabel(report.operatingSystem)],
        ["Браузер", platformLabel(report.browser)],
        ["Geolocation API", report.geolocationApi === "available" ? "Доступен" : "Не поддерживается"],
        ["Permissions API", report.permissionsApi === "available" ? "Доступен" : "Не поддерживается"],
        ["Разрешение geolocation", permissionLabels[report.geolocationPermission]],
        ["Разрешение ОС", report.operatingSystemLocationPermission],
        ["Разрешение сайта", report.siteLocationPermission],
        ["Последний запрос", requestLabels[report.lastRequest.result] || report.lastRequest.result],
        ["Время последней проверки", dateLabel(report.checkedAt)],
        ["Время запроса", dateLabel(report.lastRequest.checkedAt)],
        ["navigator.userAgent", report.userAgent]
      ];
    };
    const render = () => {
      const rows = [];
      viewRows(getReport()).forEach(([label, value]) => {
        const term = documentLike.createElement("dt"); term.textContent = label;
        const detail = documentLike.createElement("dd"); detail.textContent = value;
        rows.push(term, detail);
      });
      fields.replaceChildren(...rows);
    };
    const copy = async () => {
      const text = JSON.stringify(getReport());
      fallback.hidden = true;
      status.textContent = "";
      try {
        if (typeof navigatorLike.clipboard?.writeText !== "function") throw new Error("Clipboard API unavailable");
        await navigatorLike.clipboard.writeText(text);
        status.textContent = "Диагностика скопирована.";
      } catch {
        fallback.value = text;
        fallback.hidden = false;
        status.textContent = "Буфер обмена недоступен. Выделите текст и скопируйте его вручную.";
        fallback.focus(); fallback.select();
        fallback.setSelectionRange(0, fallback.value.length);
      }
    };
    return { render, copy };
  };

  const api = { createReport, createUi, getPlatform, getBrowser };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WalkLocationDiagnostics = api;
})();
