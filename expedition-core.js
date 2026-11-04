(function (root, factory) {
  const Expedition = factory();
  if (typeof module === "object" && module.exports) module.exports = Expedition;
  else root.WalkExpedition = Expedition;
})(globalThis, function () {
  "use strict";

  const EARTH_RADIUS_METERS = 6371000;
  const ARRIVAL_RADIUS_METERS = 30;

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

  const createCompassState = () => {
    let latest = null;
    const snapshot = () => latest ? { ...latest } : null;
    return {
      update(point, target, distanceMeters) {
        const bearing = calculateBearing(point, target);
        if (bearing === null || !Number.isFinite(distanceMeters) || distanceMeters < 0) return snapshot();
        latest = { bearing, distanceMeters, stale: false };
        return snapshot();
      },
      markStale() {
        if (latest) latest = { ...latest, stale: true };
        return snapshot();
      },
      reset() { latest = null; }
    };
  };

  return { ARRIVAL_RADIUS_METERS, createRandomTarget, hasReachedTarget, calculateBearing, createCompassState };
});
