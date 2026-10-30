(function (root, factory) {
  const diagnostics = factory();
  if (typeof module === "object" && module.exports) module.exports = diagnostics;
  else root.WalkDiagnostics = diagnostics;
})(globalThis, function () {
  "use strict";

  const FORMAT_VERSION = 1;
  const MAX_EVENTS = 5000;

  const browserInfo = (userAgent = "") => {
    const match = userAgent.match(/(EdgiOS|CriOS|FxiOS|Edg|Chrome|Firefox|Version)\/([\d.]+)/);
    const name = match ? ({ Edg: "Edge", EdgiOS: "Edge", CriOS: "Chrome", FxiOS: "Firefox", Version: "Safari" }[match[1]] || match[1]) : "unknown";
    return { name, version: match?.[2] || "unknown" };
  };

  const platformInfo = (navigatorLike = {}) => {
    const source = `${navigatorLike.platform || ""} ${navigatorLike.userAgent || ""}`;
    if (/iPhone|iPad|iPod/i.test(source)) return "iOS";
    if (/Android/i.test(source)) return "Android";
    if (/Windows/i.test(source)) return "Windows";
    if (/Mac OS|MacIntel/i.test(source)) return "macOS";
    if (/Linux/i.test(source)) return "Linux";
    return "unknown";
  };

  const createSession = ({ id = "active", appVersion, navigatorLike = {}, startedAt = Date.now(), restored = false } = {}) => ({
    id, formatVersion: FORMAT_VERSION, appVersion, startedAt, state: "active",
    environment: { browser: browserInfo(navigatorLike.userAgent || ""), platform: platformInfo(navigatorLike) },
    events: [], nextSequence: 1, droppedEvents: 0, restored
  });

  const restoreSession = (record, events = []) => ({
    ...record,
    events: events.slice().sort((a, b) => a.sequence - b.sequence),
    nextSequence: events.reduce((next, event) => Math.max(next, event.sequence + 1), 1),
    droppedEvents: record.droppedEvents || 0
  });

  const addEvent = (session, event) => {
    if (!session) return null;
    if (session.events.length >= MAX_EVENTS) {
      session.droppedEvents += 1;
      return null;
    }
    const entry = { ...event, sequence: session.nextSequence++ };
    session.events.push(entry);
    return entry;
  };

  const createGpsMeasurement = ({ position, processedAt, phase, decision, reason, previous, thresholds = {}, distanceBetween, ...extra }) => {
    const rawMeasurement = {
      timestamp: Number.isFinite(position?.timestamp) ? position.timestamp : null,
      latitude: Number.isFinite(position?.coords?.latitude) ? position.coords.latitude : null,
      longitude: Number.isFinite(position?.coords?.longitude) ? position.coords.longitude : null,
      accuracyMeters: Number.isFinite(position?.coords?.accuracy) ? position.coords.accuracy : null
    };
    let comparison = null;
    if (previous && typeof distanceBetween === "function" && [previous.lat, previous.lng, previous.timestamp].every(Number.isFinite)
      && Number.isFinite(rawMeasurement.latitude) && Number.isFinite(rawMeasurement.longitude) && Number.isFinite(rawMeasurement.timestamp)) {
      const distanceMeters = distanceBetween(previous, { lat: rawMeasurement.latitude, lng: rawMeasurement.longitude });
      const elapsedMs = rawMeasurement.timestamp - previous.timestamp;
      comparison = { previousTimestamp: previous.timestamp, distanceMeters, elapsedMs, speedMetersPerSecond: elapsedMs > 0 ? distanceMeters / (elapsedMs / 1000) : null };
    }
    return {
      type: "gps-measurement", phase, processedAt, rawMeasurement, decision,
      filteringReason: reason || null, thresholds, comparison,
      includedInRoute: decision === "rejected" ? false : null,
      routeSegmentStart: Boolean(extra.segmentStart), ...extra
    };
  };

  const applyRouteDisposition = (session, route = []) => {
    if (!session) return [];
    const changed = [];
    const routeByMeasurement = new Map(route.map((point) => [`${point.timestamp}:${point.lat}:${point.lng}`, point]));
    for (const event of session.events) {
      if (event.type !== "gps-measurement") continue;
      const raw = event.rawMeasurement || {};
      const acceptedPoint = routeByMeasurement.get(`${raw.timestamp}:${raw.latitude}:${raw.longitude}`);
      const included = Boolean(acceptedPoint);
      if (event.includedInRoute !== included || event.routeSegmentStart !== (acceptedPoint?.segmentStart || false)) {
        event.includedInRoute = included;
        event.routeSegmentStart = acceptedPoint?.segmentStart || false;
        changed.push(event);
      }
      if (included || event.decision === "pending" || event.decision === "pending_confirmation" || event.pendingCandidate) {
        event.decision = included ? "accepted" : "rejected";
        if (!included && !event.filteringReason) event.filteringReason = "not-in-final-route";
        event.pendingCandidate = false;
        if (!changed.includes(event)) changed.push(event);
      }
    }
    return changed;
  };

  const buildReport = (session, route = [], events = session?.events || []) => ({
    metadata: {
      appVersion: session?.appVersion || "unknown",
      diagnosticFormatVersion: session?.formatVersion || FORMAT_VERSION,
      startedAt: session?.startedAt || null,
      environment: session?.environment || { browser: { name: "unknown", version: "unknown" }, platform: "unknown" },
      eventLimit: MAX_EVENTS,
      omittedEventCount: session?.droppedEvents || 0,
      restoredAfterReload: Boolean(session?.restored),
      diagnosticsPersistenceFailed: Boolean(session?.diagnosticsPersistenceFailed),
      eventCount: events.length,
      diagnosticsCaptured: events.some((event) => event.type === "gps-measurement"),
      routeStatus: session?.state || "active",
      walkStatus: session?.walkStatus || null,
      territoryCaptured: session?.territoryCaptured ?? null
    },
    events: events.map(({ id, sessionId, ...event }) => ({ ...event })),
    rawMeasurements: events.filter((event) => event.type === "gps-measurement").map((event) => ({
      sequence: event.sequence,
      phase: event.phase,
      measuredAt: event.rawMeasurement?.timestamp ?? null,
      processedAt: event.processedAt,
      rawPosition: { ...(event.rawMeasurement || {}) },
      decision: event.decision,
      filteringReason: event.filteringReason || null,
      comparison: event.comparison || null,
      thresholds: event.thresholds || {},
      includedInRoute: event.includedInRoute ?? null,
      routeSegmentStart: event.routeSegmentStart ?? false
    })),
    finalAcceptedRoute: route.map((point) => ({
      latitude: point.lat, longitude: point.lng, accuracyMeters: point.accuracy,
      timestamp: point.timestamp, segmentStart: Boolean(point.segmentStart)
    }))
  });

  const copyText = async (text, clipboard) => {
    if (typeof clipboard?.writeText !== "function") return { copied: false };
    try {
      await clipboard.writeText(text);
      return { copied: true };
    } catch { return { copied: false }; }
  };

  return { FORMAT_VERSION, MAX_EVENTS, createSession, restoreSession, addEvent, createGpsMeasurement, applyRouteDisposition, buildReport, copyText };
});
