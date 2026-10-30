(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  else root.WalkTracking = core;
})(globalThis, function () {
  "use strict";

  const DEFAULTS = Object.freeze({
    maxAccuracyMeters: 35,
    maxAgeMs: 15000,
    futureToleranceMs: 5000,
    maxSpeedMetersPerSecond: 3,
    maxGapMs: 30000,
    minMovementMeters: 4,
    maxDriftMeters: 8,
    closeMeters: 50,
    minPolygonPoints: 4
  });
  const LOCATION_DEFAULTS = Object.freeze({ maxAccuracyMeters: 50, maxAgeMs: 30000 });

  const distanceMeters = (a, b) => {
    const radius = 6371000, rad = (value) => value * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };

  const evaluatePosition = (position, previousPoint, now = Date.now(), options = DEFAULTS, pendingGapPoint = null) => {
    const config = { ...DEFAULTS, ...options };
    const { latitude, longitude, accuracy } = position?.coords || {};
    const timestamp = position?.timestamp;
    if (![latitude, longitude, accuracy, timestamp].every(Number.isFinite)) return { accepted: false, reason: "invalid" };
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return { accepted: false, reason: "invalid" };
    if (accuracy <= 0 || accuracy > config.maxAccuracyMeters) return { accepted: false, reason: "accuracy" };
    const age = now - timestamp;
    if (age > config.maxAgeMs || age < -config.futureToleranceMs) return { accepted: false, reason: "stale" };

    const point = { lat: latitude, lng: longitude, accuracy, timestamp, segmentStart: !previousPoint };
    if (!previousPoint) return { accepted: true, point, distanceMeters: 0, newSegment: true };

    const elapsedMs = timestamp - previousPoint.timestamp;
    if (elapsedMs <= 0) return { accepted: false, reason: "stale" };
    const distance = distanceMeters(previousPoint, point);
    if (elapsedMs > config.maxGapMs) {
      const confirmationElapsed = pendingGapPoint ? timestamp - pendingGapPoint.timestamp : 0;
      if (!pendingGapPoint || confirmationElapsed <= 0 || confirmationElapsed > config.maxAgeMs) {
        return { accepted: false, reason: "confirm", candidate: point };
      }

      const confirmationDistance = distanceMeters(pendingGapPoint, point);
      if (confirmationDistance / (confirmationElapsed / 1000) > config.maxSpeedMetersPerSecond) {
        return { accepted: false, reason: "speed", candidate: point };
      }

      const movementThreshold = Math.max(config.minMovementMeters, Math.min(config.maxDriftMeters, (pendingGapPoint.accuracy + accuracy) / 2));
      if (confirmationDistance >= movementThreshold) {
        const segmentStart = { ...pendingGapPoint, segmentStart: true };
        point.segmentStart = false;
        return { accepted: true, point, points: [segmentStart, point], distanceMeters: confirmationDistance, newSegment: true, reason: "confirmed-gap" };
      }

      point.segmentStart = true;
      return { accepted: true, point, points: [point], distanceMeters: 0, newSegment: true, reason: "confirmed-gap" };
    }

    const movementThreshold = Math.max(config.minMovementMeters, Math.min(config.maxDriftMeters, (previousPoint.accuracy + accuracy) / 2));
    if (distance < movementThreshold) return { accepted: false, reason: "drift" };
    if (distance / (elapsedMs / 1000) > config.maxSpeedMetersPerSecond) return { accepted: false, reason: "speed" };
    return { accepted: true, point, distanceMeters: distance, newSegment: false };
  };

  const evaluateLocationPosition = (position, now = Date.now()) => evaluatePosition(position, null, now, { ...DEFAULTS, ...LOCATION_DEFAULTS });

  const createPositionFilter = () => {
    let pendingGapPoint = null;
    return {
      evaluate(position, previousPoint, now = Date.now(), options = DEFAULTS) {
        const result = evaluatePosition(position, previousPoint, now, options, pendingGapPoint);
        if (result.accepted) pendingGapPoint = null;
        else if (result.candidate) pendingGapPoint = result.candidate;
        return result;
      },
      reset() { pendingGapPoint = null; }
    };
  };

  const createGpsWarmup = (requiredPositions = 3, options = DEFAULTS) => {
    const config = { ...DEFAULTS, ...options };
    let positions = [];
    const add = (position, now = Date.now()) => {
      const validation = evaluatePosition(position, null, now, config);
      if (!validation.accepted) {
        positions = [];
        return { stable: false, count: 0, reason: validation.reason };
      }

      const point = validation.point;
      const previous = positions.at(-1);
      if (previous) {
        const elapsedMs = point.timestamp - previous.timestamp;
        const movedFromStart = distanceMeters(positions[0], point);
        const stepDistance = distanceMeters(previous, point);
        const interrupted = elapsedMs <= 0 || elapsedMs > config.maxGapMs;
        const inconsistent = movedFromStart > config.maxDriftMeters || stepDistance / (elapsedMs / 1000) > config.maxSpeedMetersPerSecond;
        if (interrupted || inconsistent) positions = [];
      }

      positions.push(point);
      const stable = positions.length >= requiredPositions;
      return { stable, count: positions.length, point: stable ? point : null, reason: stable ? "stable" : "warming" };
    };
    return { add, reset: () => { positions = []; } };
  };

  const splitSegments = (points = []) => {
    const segments = [];
    for (const point of points) {
      if (!segments.length || point.segmentStart) segments.push([]);
      segments.at(-1).push(point);
    }
    return segments;
  };

  const distanceForPoints = (points = []) => points.slice(1).reduce((total, point, index) => {
    return point.segmentStart ? total : total + distanceMeters(points[index], point);
  }, 0);

  const canCloseTrack = (points = [], options = DEFAULTS) => {
    const segments = splitSegments(points);
    if (segments.length !== 1 || points.length < options.minPolygonPoints) return false;
    return distanceMeters(points[0], points.at(-1)) <= options.closeMeters;
  };

  const shouldDisplayWalkOnMap = (walk) => walk.closed || walk.showOnMap !== false;

  const createGpsServices = ({ geolocation, onPosition, onError, onAutosave, schedule = setInterval, cancel = clearInterval, intervalMs = 5000, watchOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 } }) => {
    let watchId = null, timerId = null;
    const stop = () => {
      const activeWatchId = watchId;
      const activeTimerId = timerId;
      watchId = null; timerId = null;
      if (activeWatchId !== null) {
        try { geolocation.clearWatch(activeWatchId); } catch {}
      }
      if (activeTimerId !== null) {
        try { cancel(activeTimerId); } catch {}
      }
    };
    const start = () => {
      stop();
      try {
        watchId = geolocation.watchPosition(onPosition, onError, watchOptions);
        timerId = schedule(onAutosave, intervalMs);
      } catch (error) {
        stop();
        throw error;
      }
    };
    return { start, stop };
  };

  return { DEFAULTS, LOCATION_DEFAULTS, distanceMeters, evaluatePosition, evaluateLocationPosition, createPositionFilter, createGpsWarmup, splitSegments, distanceForPoints, canCloseTrack, shouldDisplayWalkOnMap, createGpsServices };
});
