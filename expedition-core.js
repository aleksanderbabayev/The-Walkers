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

  return { ARRIVAL_RADIUS_METERS, createRandomTarget, hasReachedTarget };
});
