(function (root, factory) {
  const Expedition = factory();
  if (typeof module === "object" && module.exports) module.exports = Expedition;
  else root.WalkExpedition = Expedition;
})(globalThis, function () {
  "use strict";

  const EARTH_RADIUS_METERS = 6371000;
  const ARRIVAL_RADIUS_METERS = 30;
  const COMPASS_MIN_MOVEMENT_METERS = 8;
  const COMPASS_MOVEMENT_WINDOW_SIZE = 5;
  const COMPASS_MIN_MOVEMENT_POINTS = 3;

  const createRandomTarget = (origin, distanceMeters, random = Math.random) => {
    if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)
      || Math.abs(origin.lat) > 90 || Math.abs(origin.lng) > 180
      || !Number.isFinite(distanceMeters) || distanceMeters <= 0 || typeof random !== "function") return null;
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const toDegrees = (radians) => radians * 180 / Math.PI;
    const bearing = random() * Math.PI * 2;
    const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
    const latitude = toRadians(origin.lat);
    const longitude = toRadians(origin.lng);
    const targetLatitude = Math.asin(
      Math.sin(latitude) * Math.cos(angularDistance)
      + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const targetLongitude = longitude + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(targetLatitude)
    );
    const longitudeDegrees = (toDegrees(targetLongitude) + 540) % 360 - 180;
    return { lat: toDegrees(targetLatitude), lng: longitudeDegrees };
  };

  const hasReachedTarget = (point, target, distanceMeters) => Boolean(
    point && target && typeof distanceMeters === "function"
    && distanceMeters(point, target) <= ARRIVAL_RADIUS_METERS
  );

  const calculateBearing = (origin, target) => {
    if (!origin || !target || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)
      || !Number.isFinite(target.lat) || !Number.isFinite(target.lng)
      || Math.abs(origin.lat) > 90 || Math.abs(target.lat) > 90
      || Math.abs(origin.lng) > 180 || Math.abs(target.lng) > 180) return null;
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const latitude = toRadians(origin.lat), targetLatitude = toRadians(target.lat);
    const longitudeDifference = toRadians(target.lng - origin.lng);
    const y = Math.sin(longitudeDifference) * Math.cos(targetLatitude);
    const x = Math.cos(latitude) * Math.sin(targetLatitude)
      - Math.sin(latitude) * Math.cos(targetLatitude) * Math.cos(longitudeDifference);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };

  const createCompassState = (distanceMeters) => {
    let latest = null, positions = [], movementBearing = null;
    const snapshot = () => latest ? { ...latest } : null;
    return {
      update(point, target, targetDistanceMeters) {
        if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)
          || !Number.isFinite(point.timestamp) || !target || !Number.isFinite(targetDistanceMeters)
          || targetDistanceMeters < 0 || typeof distanceMeters !== "function") return snapshot();
        const previous = positions.at(-1);
        if (!previous || previous.timestamp !== point.timestamp) {
          positions.push({ lat: point.lat, lng: point.lng, timestamp: point.timestamp });
          positions = positions.slice(-COMPASS_MOVEMENT_WINDOW_SIZE);
        }
        const startOfWindow = positions[0];
        const movedMeters = positions.length >= COMPASS_MIN_MOVEMENT_POINTS
          ? distanceMeters(startOfWindow, point) : 0;
        const headingUpdated = movedMeters >= COMPASS_MIN_MOVEMENT_METERS;
        if (headingUpdated) {
          movementBearing = calculateBearing(startOfWindow, point);
          if (movementBearing !== null) positions = [{ lat: point.lat, lng: point.lng, timestamp: point.timestamp }];
        }
        const targetBearing = calculateBearing(point, target);
        if (headingUpdated && movementBearing !== null && targetBearing !== null) {
          const relativeBearing = (targetBearing - movementBearing + 360) % 360;
          latest = { relativeBearing, distanceMeters: targetDistanceMeters, stale: false, headingUpdated: true };
        } else if (latest) {
          latest = { ...latest, distanceMeters: targetDistanceMeters, stale: false, headingUpdated: false };
        } else {
          latest = { relativeBearing: null, distanceMeters: targetDistanceMeters, stale: false, headingUpdated: false };
        }
        return snapshot();
      },
      markStale() {
        if (latest) latest = { ...latest, stale: true };
        return snapshot();
      },
      reset() { latest = null; positions = []; movementBearing = null; }
    };
  };

  const nearestContinuousAngle = (previousAngle, nextAngle) => {
    if (!Number.isFinite(nextAngle)) return null;
    if (!Number.isFinite(previousAngle)) return nextAngle;
    const difference = ((nextAngle - previousAngle) % 360 + 360) % 360;
    return previousAngle + (difference > 180 ? difference - 360 : difference);
  };

  return {
    ARRIVAL_RADIUS_METERS, COMPASS_MIN_MOVEMENT_METERS, COMPASS_MOVEMENT_WINDOW_SIZE,
    createRandomTarget, hasReachedTarget, calculateBearing, createCompassState, nearestContinuousAngle
  };
});
