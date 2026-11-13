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
  const GPS_WARMUP_DEFAULTS = Object.freeze({
    maxAccuracyMeters: 12,
    requiredPositions: 5,
    minDurationMs: 6000,
    maxGapMs: 8000,
    manualStartAfterMs: 15000
  });
  const FINISH_ZONE_RADIUS_METERS = 25;
  const MAX_SAFE_SEGMENT_GAP_METERS = 12;
  const ROUTE_RECOVERY_RADIUS_METERS = 15;
  const ROUTE_RECOVERY_ACCURACY_METERS = 12;
  const ROUTE_RECOVERY_CONFIRMATIONS = 3;

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
  const evaluateDisplayPosition = (position, now = Date.now()) => evaluatePosition(position, null, now, {
    ...DEFAULTS, maxAccuracyMeters: Number.MAX_VALUE, maxAgeMs: LOCATION_DEFAULTS.maxAgeMs
  });
  const shouldUpdateGpsMarker = (source, recordingActive) => source === "accepted" || (source === "preliminary" && !recordingActive);
  const isLocationFresh = (point, now = Date.now()) => Boolean(point
    && point.accuracy <= LOCATION_DEFAULTS.maxAccuracyMeters
    && now - point.timestamp >= -DEFAULTS.futureToleranceMs
    && now - point.timestamp <= LOCATION_DEFAULTS.maxAgeMs);
  const evaluateLocationUpdate = (position, previousPoint, now = Date.now()) => {
    const result = evaluateLocationPosition(position, now);
    const previousFresh = isLocationFresh(previousPoint, now);
    if (result.accepted && previousPoint && result.point.timestamp <= previousPoint.timestamp) {
      return { accepted: false, reason: "stale", point: previousFresh ? previousPoint : null, keepPrevious: previousFresh };
    }
    if (result.accepted && previousFresh) {
      const distance = distanceMeters(previousPoint, result.point);
      const movementThreshold = Math.min(8, Math.max(4, (previousPoint.accuracy + result.point.accuracy) / 2));
      if (distance <= movementThreshold) {
        return { accepted: false, reason: "drift", point: previousPoint, keepPrevious: true, distanceMeters: distance, movementThresholdMeters: movementThreshold };
      }
    }
    return { ...result, point: result.accepted ? result.point : previousFresh ? previousPoint : null, keepPrevious: !result.accepted && previousFresh };
  };

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

  const createRouteRecovery = () => {
    let recovery = null, previousFix = null, confirmations = 0;
    const start = (anchor, reason = "unsafe-gap", gap = {}) => {
      if (!anchor || !Number.isFinite(anchor.lat) || !Number.isFinite(anchor.lng)) return null;
      recovery = { anchor: { ...anchor }, reason, startedAt: Date.now(), gap: { ...gap } };
      previousFix = null;
      confirmations = 0;
      return snapshot();
    };
    const restore = (saved) => {
      if (!saved?.anchor || !Number.isFinite(saved.anchor.lat) || !Number.isFinite(saved.anchor.lng)) return false;
      recovery = {
        anchor: { ...saved.anchor }, reason: saved.reason || "unsafe-gap",
        startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt : Date.now(), gap: { ...(saved.gap || {}) }
      };
      previousFix = null;
      confirmations = 0;
      return true;
    };
    const evaluate = (position, now = Date.now()) => {
      if (!recovery) return { active: false };
      const validation = evaluatePosition(position, null, now, {
        ...DEFAULTS, maxAccuracyMeters: ROUTE_RECOVERY_ACCURACY_METERS,
        maxAgeMs: DEFAULTS.maxAgeMs
      });
      if (!validation.accepted) {
        previousFix = null;
        confirmations = 0;
        return { active: true, accepted: false, reason: validation.reason, anchor: { ...recovery.anchor }, confirmations };
      }

      const point = validation.point;
      const distanceToAnchorMeters = distanceMeters(recovery.anchor, point);
      if (distanceToAnchorMeters > ROUTE_RECOVERY_RADIUS_METERS) {
        previousFix = null;
        confirmations = 0;
        return { active: true, accepted: true, reached: false, point, anchor: { ...recovery.anchor }, distanceToAnchorMeters, confirmations };
      }

      if (previousFix) {
        const elapsedMs = point.timestamp - previousFix.timestamp;
        const movedMeters = distanceMeters(previousFix, point);
        if (elapsedMs <= 0 || elapsedMs > GPS_WARMUP_DEFAULTS.maxGapMs
          || movedMeters / (elapsedMs / 1000) > DEFAULTS.maxSpeedMetersPerSecond) confirmations = 1;
        else confirmations += 1;
      } else confirmations = 1;
      previousFix = point;
      if (confirmations >= ROUTE_RECOVERY_CONFIRMATIONS) return {
        active: false, accepted: true, completed: true, point,
        anchor: { ...recovery.anchor }, distanceToAnchorMeters, confirmations
      };
      return { active: true, accepted: true, reached: true, point, anchor: { ...recovery.anchor }, distanceToAnchorMeters, confirmations };
    };
    const snapshot = () => recovery ? {
      anchor: { ...recovery.anchor }, reason: recovery.reason,
      startedAt: recovery.startedAt, gap: { ...recovery.gap }
    } : null;
    const clear = () => { recovery = null; previousFix = null; confirmations = 0; };
    return { start, restore, evaluate, snapshot, clear, get active() { return recovery !== null; }, get anchor() { return recovery ? { ...recovery.anchor } : null; } };
  };

  const validateInitialRoute = (points = [], options = DEFAULTS) => {
    const accepted = [], filter = createPositionFilter();
    for (const candidate of points) {
      const position = { timestamp: candidate.timestamp, coords: { latitude: candidate.lat, longitude: candidate.lng, accuracy: candidate.accuracy } };
      if (!accepted.length || candidate.segmentStart) {
        filter.reset();
        const result = evaluatePosition(position, null, candidate.timestamp, options);
        if (result.accepted) accepted.push({
          ...result.point,
          ...(candidate.recoveryResume ? { recoveryResume: { ...candidate.recoveryResume } } : {}),
          segmentStart: true
        });
        continue;
      }
      const result = filter.evaluate(position, accepted.at(-1), candidate.timestamp, options);
      if (result.accepted) accepted.push(...(result.points || [result.point]));
    }
    return { points: accepted, distanceMeters: distanceForPoints(accepted), discardedCount: points.length - accepted.length };
  };

  const createInitialRouteBuffer = (durationMs = 18000, options = DEFAULTS) => {
    const config = { ...DEFAULTS, ...options };
    let points = [], filter = createPositionFilter();
    const snapshot = () => points.map((point) => ({ ...point }));
    const reset = () => { points = []; filter = createPositionFilter(); };
    const begin = (point) => {
      reset();
      const result = evaluatePosition({ timestamp: point.timestamp, coords: { latitude: point.lat, longitude: point.lng, accuracy: point.accuracy } }, null, point.timestamp, config);
      if (!result.accepted) return { accepted: false, reason: result.reason, ready: false, bufferedPoints: [] };
      points = [{ ...result.point, segmentStart: true }];
      return { accepted: true, ready: false, bufferedPoints: snapshot(), point: points[0] };
    };
    const add = (position, now = Date.now()) => {
      if (!points.length) return { accepted: false, reason: "empty", ready: false, bufferedPoints: [] };
      const result = filter.evaluate(position, points.at(-1), now, config);
      if (!result.accepted) return { ...result, ready: false, bufferedPoints: snapshot() };
      points.push(...(result.points || [result.point]));
      const validated = validateInitialRoute(points, config);
      const ready = points.at(-1).timestamp - points[0].timestamp >= durationMs;
      return { ...result, ready, bufferedPoints: snapshot(), validatedPoints: validated.points, distanceMeters: validated.distanceMeters };
    };
    const flush = () => validateInitialRoute(points, config);
    const restore = (savedPoints = []) => {
      points = Array.isArray(savedPoints) ? savedPoints.map((point) => ({ ...point })) : [];
      filter = createPositionFilter();
    };
    return { begin, add, flush, reset, restore, snapshot, get pending() { return points.length > 0; } };
  };

  const createGpsWarmup = (requiredPositions = GPS_WARMUP_DEFAULTS.requiredPositions, options = {}) => {
    const config = { ...DEFAULTS, ...GPS_WARMUP_DEFAULTS, ...options, requiredPositions };
    let positions = [], startedAt = null, lastManualStartPoint = null;
    const add = (position, now = Date.now()) => {
      const validation = evaluatePosition(position, null, now, config);
      const manualValidation = evaluatePosition(position, null, now, { ...config, maxAccuracyMeters: DEFAULTS.maxAccuracyMeters });
      if (manualValidation.accepted) lastManualStartPoint = manualValidation.point;
      if (!validation.accepted) {
        positions = []; startedAt = null;
        return { stable: false, count: 0, reason: validation.reason, requiredPositions: config.requiredPositions, requiredDurationMs: config.minDurationMs, accuracyThresholdMeters: config.maxAccuracyMeters };
      }

      const point = validation.point;
      const previous = positions.at(-1);
      let reason = "warming";
      if (previous) {
        const elapsedMs = point.timestamp - previous.timestamp;
        const movedFromStart = distanceMeters(positions[0], point);
        const stepDistance = distanceMeters(previous, point);
        const interrupted = elapsedMs <= 0 || elapsedMs > config.maxGapMs;
        const inconsistent = movedFromStart > config.maxDriftMeters || stepDistance / (elapsedMs / 1000) > config.maxSpeedMetersPerSecond;
        if (interrupted || inconsistent) {
          positions = []; startedAt = null;
          reason = interrupted ? "interrupted" : "inconsistent";
        }
      }

      if (!positions.length) startedAt = point.timestamp;
      positions.push(point);
      if (positions.length > 12) positions.splice(1, positions.length - 12);
      const elapsedMs = point.timestamp - startedAt;
      const stable = positions.length >= config.requiredPositions && elapsedMs >= config.minDurationMs;
      let estimate = null, bestSpread = Infinity;
      if (stable) {
        for (const candidate of positions) {
          const candidateSpread = positions.reduce((sum, other) => sum + distanceMeters(candidate, other), 0);
          if (candidateSpread < bestSpread || (candidateSpread === bestSpread && candidate.accuracy < estimate.accuracy)) {
            estimate = candidate; bestSpread = candidateSpread;
          }
        }
      }
      return {
        stable, count: positions.length, point: estimate,
        reason: stable ? "stable" : reason,
        elapsedMs, spreadMeters: Math.max(...positions.map((candidate) => distanceMeters(positions[0], candidate))),
        requiredPositions: config.requiredPositions, requiredDurationMs: config.minDurationMs,
        accuracyThresholdMeters: config.maxAccuracyMeters
      };
    };
    const manualStartPoint = (now = Date.now(), elapsedMs = 0) => {
      if (elapsedMs < config.manualStartAfterMs) return null;
      if (!lastManualStartPoint) return null;
      const validation = evaluatePosition({ timestamp: lastManualStartPoint.timestamp, coords: {
        latitude: lastManualStartPoint.lat, longitude: lastManualStartPoint.lng, accuracy: lastManualStartPoint.accuracy
      } }, null, now, { ...config, maxAccuracyMeters: DEFAULTS.maxAccuracyMeters });
      return validation.accepted ? validation.point : null;
    };
    return { add, manualStartPoint, reset: () => { positions = []; startedAt = null; lastManualStartPoint = null; } };
  };

  const splitSegments = (points = []) => {
    const segments = [];
    for (const point of points) {
      const previous = segments.at(-1)?.at(-1);
      const recoveredJoin = point.segmentStart && previous
        && evaluateSegmentContinuity(previous, point).reason === "recovered-gap";
      if (!segments.length || point.segmentStart && !recoveredJoin) segments.push([]);
      segments.at(-1).push(point);
    }
    return segments;
  };

  const distanceForPoints = (points = []) => points.slice(1).reduce((total, point, index) => {
    if (!point.segmentStart) return total + distanceMeters(points[index], point);
    const resumedDistance = point.recoveryResume?.segmentDistanceMeters;
    return Number.isFinite(resumedDistance) && resumedDistance > 0 ? total + resumedDistance : total;
  }, 0);

  const evaluateSegmentContinuity = (previous, current, options = DEFAULTS) => {
    if (![previous?.lat, previous?.lng, current?.lat, current?.lng].every(Number.isFinite)) {
      return { continuous: false, reason: "invalid-route-point", distanceMeters: null, maxGapMeters: 0 };
    }
    if (![previous?.accuracy, current?.accuracy].every((accuracy) => Number.isFinite(accuracy) && accuracy > 0 && accuracy <= options.maxAccuracyMeters)) {
      return { continuous: false, reason: "unsafe-gap", distanceMeters: distanceMeters(previous, current), maxGapMeters: 0 };
    }
    const accuracyLimit = Math.max(options.minMovementMeters, (previous.accuracy + current.accuracy) / 2);
    const maxGapMeters = Math.min(MAX_SAFE_SEGMENT_GAP_METERS, accuracyLimit);
    const gapMeters = distanceMeters(previous, current);
    const recovery = current.recoveryResume;
    if (recovery?.confirmed === true
      && recovery.confirmationCount >= ROUTE_RECOVERY_CONFIRMATIONS
      && Number.isFinite(recovery.returnAccuracyMeters) && recovery.returnAccuracyMeters <= ROUTE_RECOVERY_ACCURACY_METERS
      && Number.isFinite(recovery.checkpointDistanceMeters) && recovery.checkpointDistanceMeters <= ROUTE_RECOVERY_RADIUS_METERS
      && Number.isFinite(recovery.segmentDistanceMeters) && recovery.segmentDistanceMeters >= 0
      && recovery.checkpoint && distanceMeters(previous, recovery.checkpoint) <= 1
      && gapMeters <= recovery.checkpointDistanceMeters + recovery.segmentDistanceMeters + Math.max(2, current.accuracy)) {
      return { continuous: true, reason: "recovered-gap", distanceMeters: gapMeters, maxGapMeters };
    }
    return { continuous: gapMeters <= maxGapMeters, reason: gapMeters <= maxGapMeters ? "continuous" : "unsafe-gap", distanceMeters: gapMeters, maxGapMeters };
  };

  const evaluateTrackClosure = (points = [], options = DEFAULTS) => {
    if (points.length < options.minPolygonPoints) return { eligible: false, reason: "too-few-points" };
    if (points.some((point) => !Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)
      || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180)) {
      return { eligible: false, reason: "invalid-route-point" };
    }
    const distinctGeometryPoints = [];
    for (const point of points) {
      if (distinctGeometryPoints.every((known) => distanceMeters(known, point) >= 1)) distinctGeometryPoints.push(point);
      if (distinctGeometryPoints.length === 3) break;
    }
    if (distinctGeometryPoints.length < 3) return { eligible: false, reason: "invalid-geometry" };
    for (let index = 1; index < points.length; index += 1) {
      if (!points[index].segmentStart) continue;
      const previous = points[index - 1], current = points[index];
      if (!evaluateSegmentContinuity(previous, current, options).continuous) return { eligible: false, reason: "unsafe-gap" };
    }
    if (distanceMeters(points[0], points.at(-1)) > options.closeMeters) return { eligible: false, reason: "not-closed" };
    return { eligible: true, reason: "closed" };
  };

  const canCloseTrack = (points = [], options = DEFAULTS) => evaluateTrackClosure(points, options).eligible;

  const createFinishPositionFilter = () => {
    const options = { ...DEFAULTS, maxAgeMs: LOCATION_DEFAULTS.maxAgeMs };
    let previousPoint = null, pendingGapPoint = null;
    return {
      evaluate(position, now = Date.now()) {
        const result = evaluatePosition(position, previousPoint, now, options, pendingGapPoint);
        if (result.accepted) {
          previousPoint = result.point;
          pendingGapPoint = null;
          return result;
        }
        if (result.candidate) pendingGapPoint = result.candidate;
        if (result.reason === "drift") {
          const freshPoint = evaluatePosition(position, null, now, options);
          if (freshPoint.accepted) {
            previousPoint = freshPoint.point;
            pendingGapPoint = null;
            return { ...freshPoint, reason: "drift", distanceMeters: result.distanceMeters, newSegment: false };
          }
        }
        return result;
      },
      reset(point = null) {
        previousPoint = point;
        pendingGapPoint = null;
      }
    };
  };

  const evaluateTerritoryCapture = (points = [], position, now = Date.now(), finishRadiusMeters = FINISH_ZONE_RADIUS_METERS) => {
    const start = points[0];
    const validStart = Number.isFinite(start?.lat) && Number.isFinite(start?.lng)
      && Math.abs(start.lat) <= 90 && Math.abs(start.lng) <= 180;
    const validPosition = Number.isFinite(position?.lat) && Number.isFinite(position?.lng)
      && Math.abs(position.lat) <= 90 && Math.abs(position.lng) <= 180;
    const positionFresh = validPosition && Number.isFinite(position.accuracy) && position.accuracy > 0
      && position.accuracy <= DEFAULTS.maxAccuracyMeters && isLocationFresh(position, now);
    const distanceToStartMeters = validStart && positionFresh ? distanceMeters(start, position) : null;
    const routeClosure = evaluateTrackClosure(points);
    const routeValid = routeClosure.eligible;
    const reason = !validStart ? "missing-start"
      : routeClosure.reason === "unsafe-gap" ? "unsafe-gap"
        : !positionFresh ? "waiting-for-gps"
          : distanceToStartMeters > finishRadiusMeters + 0.001 ? "too-far"
            : !routeValid ? routeClosure.reason : "finish-reached";
    return {
      eligible: routeValid && positionFresh && distanceToStartMeters <= finishRadiusMeters + 0.001,
      routeValid,
      positionFresh,
      distanceToStartMeters,
      reason
    };
  };

  const shouldDisplayWalkOnMap = (walk) => walk.status !== "retreated" && (walk.closed || walk.showOnMap !== false);

  const createGpsServices = ({ geolocation, onPosition, onError, onAutosave, schedule = setInterval, cancel = clearInterval, intervalMs = 5000, watchOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 } }) => {
    let watchId = null, timerId = null;
    const stopAutosave = () => {
      const activeTimerId = timerId;
      timerId = null;
      if (activeTimerId !== null) {
        try { cancel(activeTimerId); } catch {}
      }
    };
    const stopWatch = () => {
      const activeWatchId = watchId;
      watchId = null;
      if (activeWatchId !== null) {
        try { geolocation.clearWatch(activeWatchId); } catch {}
      }
    };
    const stop = () => { stopAutosave(); stopWatch(); };
    const startWatch = () => {
      if (watchId === null) watchId = geolocation.watchPosition(onPosition, onError, watchOptions);
    };
    const startAutosave = () => {
      if (timerId === null) timerId = schedule(onAutosave, intervalMs);
    };
    const start = () => {
      try {
        startWatch();
        startAutosave();
      } catch (error) {
        stop();
        throw error;
      }
    };
    return { start, startWatch, stopAutosave, stop };
  };

  return { DEFAULTS, LOCATION_DEFAULTS, GPS_WARMUP_DEFAULTS, FINISH_ZONE_RADIUS_METERS, ROUTE_RECOVERY_RADIUS_METERS, ROUTE_RECOVERY_ACCURACY_METERS, ROUTE_RECOVERY_CONFIRMATIONS, distanceMeters, evaluatePosition, evaluateDisplayPosition, shouldUpdateGpsMarker, evaluateLocationPosition, isLocationFresh, evaluateLocationUpdate, createPositionFilter, createRouteRecovery, createFinishPositionFilter, validateInitialRoute, createInitialRouteBuffer, createGpsWarmup, splitSegments, distanceForPoints, evaluateSegmentContinuity, evaluateTrackClosure, canCloseTrack, evaluateTerritoryCapture, shouldDisplayWalkOnMap, createGpsServices };
});
