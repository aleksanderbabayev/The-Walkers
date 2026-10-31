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

  const api = { createReport, getPlatform, getBrowser };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WalkLocationDiagnostics = api;
})();
