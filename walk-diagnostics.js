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

  const buildReport = (session, route = [], events = session?.events || []) => {
    const metadata = {
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
    };
    if (session?.diagnosticsAvailable === false) Object.assign(metadata, {
      diagnosticsAvailable: false,
      diagnosticsUnavailableReason: session.diagnosticsUnavailableReason || "not-found",
      walkSummary: session.walkSummary || null
    });
    return {
      metadata,
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
    };
  };

  const copyText = async (text, clipboard) => {
    if (typeof clipboard?.writeText !== "function") return { copied: false };
    try {
      await clipboard.writeText(text);
      return { copied: true };
    } catch { return { copied: false }; }
  };

  const copyTextOrFallback = async (text, clipboard, showFallback) => {
    let result = { copied: false };
    try { result = await copyText(text, clipboard); } catch {}
    if (!result.copied) showFallback(text);
    return result;
  };

  const createCompletedReportData = (walk, stored, readError = null) => {
    const events = Array.isArray(stored?.events) ? stored.events : [];
    const diagnosticsAvailable = events.length > 0;
    const diagnosticsUnavailableReason = diagnosticsAvailable ? null : readError ? "read-error" : stored ? "events-not-found" : "not-found";
    const walkSummary = diagnosticsAvailable ? null : {
      id: walk.id,
      mode: walk.mode || null,
      status: walk.status || walk.expeditionStatus || null,
      startedAt: walk.startedAt || null,
      finishedAt: walk.finishedAt || null,
      durationMs: Number.isFinite(walk.durationMs) ? walk.durationMs : null,
      distanceMeters: Number.isFinite(walk.distanceMeters) ? walk.distanceMeters : null,
      pointCount: Array.isArray(walk.points) ? walk.points.length : 0,
      closed: Boolean(walk.closed),
      target: walk.target || null
    };
    const session = {
      ...(stored || { id: walk.id, appVersion: "not recorded", startedAt: walk.startedAt, state: "completed" }),
      diagnosticsAvailable, diagnosticsUnavailableReason, walkSummary
    };
    const route = stored?.finalRoute?.length ? stored.finalRoute : walk.points || [];
    return { session, route, events };
  };

  const createCompletedCopyController = ({ load, copy, setStatus = () => {}, setBusy = () => {} }) => {
    const inFlight = new Map();
    return (walk, button) => {
      if (inFlight.has(walk.id)) return inFlight.get(walk.id);
      setBusy(button, true);
      setStatus("Загружаем диагностику прогулки…");
      const operation = (async () => {
        let stored = null, readError = null;
        try { stored = await load(walk.id); } catch (error) { readError = error; }
        try { await copy(walk, stored, readError); }
        catch { setStatus("Не удалось подготовить диагностику для копирования."); }
      })().finally(() => {
        inFlight.delete(walk.id);
        setBusy(button, false);
      });
      inFlight.set(walk.id, operation);
      return operation;
    };
  };

  const diagnosticFileName = (walkNumber) => {
    const safeNumber = String(walkNumber ?? "walk").trim().replace(/[^a-z0-9_-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "walk";
    return `the-walkers-diagnostics-${safeNumber}.json`;
  };

  const createDiagnosticFileExporter = ({ navigatorLike, documentLike, urlLike, BlobConstructor, FileConstructor, schedule = setTimeout }) => async (text, fileName) => {
    let canShareFile = false;
    try {
      if (typeof FileConstructor === "function" && typeof navigatorLike?.share === "function" && typeof navigatorLike.canShare === "function") {
        const file = new FileConstructor([text], fileName, { type: "application/json" });
        canShareFile = navigatorLike.canShare({ files: [file] });
        if (canShareFile) await navigatorLike.share({ files: [file] });
      }
    } catch (error) {
      if (error?.name === "AbortError") return { cancelled: true };
      canShareFile = false;
    }
    if (canShareFile) {
      return { shared: true };
    }

    const objectUrl = urlLike.createObjectURL(new BlobConstructor([text], { type: "application/json" }));
    const link = documentLike.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    link.hidden = true;
    documentLike.body.append(link);
    try { link.click(); }
    finally {
      link.remove();
      schedule(() => urlLike.revokeObjectURL(objectUrl), 0);
    }
    return { downloaded: true };
  };

  const createCompletedExportController = ({ load, exportFile, setStatus = () => {}, setBusy = () => {} }) => {
    const inFlight = new Map();
    return (walk, walkNumber, button) => {
      if (inFlight.has(walk.id)) return inFlight.get(walk.id);
      setBusy(button, true);
      setStatus("Подготавливаем файл диагностики прогулки…");
      const operation = (async () => {
        let stored = null, readError = null;
        try { stored = await load(walk.id); } catch (error) { readError = error; }
        try {
          const reportData = createCompletedReportData(walk, stored, readError);
          const report = buildReport(reportData.session, reportData.route, reportData.events);
          const text = JSON.stringify(report, null, 2);
          const result = await exportFile(text, diagnosticFileName(walkNumber));
          if (result?.cancelled) { setStatus(""); return; }
          if (readError) setStatus("Не удалось прочитать диагностику; экспортированы доступные данные прогулки.");
          else if (!reportData.events.length) setStatus("Диагностические события не найдены; экспортирован доступный маршрут.");
          else setStatus(result?.shared ? "Отчёт передан в меню «Поделиться»." : "JSON-файл скачан.");
        } catch {
          setStatus("Не удалось подготовить или экспортировать JSON-отчёт.");
        }
      })().finally(() => {
        inFlight.delete(walk.id);
        setBusy(button, false);
      });
      inFlight.set(walk.id, operation);
      return operation;
    };
  };

  return { FORMAT_VERSION, MAX_EVENTS, createSession, restoreSession, addEvent, createGpsMeasurement, applyRouteDisposition, buildReport, copyText, copyTextOrFallback, createCompletedReportData, createCompletedCopyController, diagnosticFileName, createDiagnosticFileExporter, createCompletedExportController };
});
