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
    maxDriftMeters: 15,
    closeMeters: 50,
    minPolygonPoints: 4
  });

  const distanceMeters = (a, b) => {
    const radius = 6371000, rad = (value) => value * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };

  const evaluatePosition = (position, previousPoint, now = Date.now(), options = DEFAULTS) => {
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
      point.segmentStart = true;
      return { accepted: true, point, distanceMeters: 0, newSegment: true, reason: "gap" };
    }

    const movementThreshold = Math.max(config.minMovementMeters, Math.min(config.maxDriftMeters, (previousPoint.accuracy + accuracy) / 2));
    if (distance < movementThreshold) return { accepted: false, reason: "drift" };
    if (distance / (elapsedMs / 1000) > config.maxSpeedMetersPerSecond) return { accepted: false, reason: "speed" };
    return { accepted: true, point, distanceMeters: distance, newSegment: false };
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

  return { DEFAULTS, distanceMeters, evaluatePosition, splitSegments, distanceForPoints, canCloseTrack };
});
