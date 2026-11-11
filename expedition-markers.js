(() => {
  "use strict";
  const COLORS = typeof module === "object" && module.exports ? require("./walk-colors.js") : window.WalkColors;

  const MARKER_STROKE_WIDTH = 1;
  const START_MARKER_RADIUS = 3.5;
  const GOAL_MARKER_RADIUS = 5.5;
  const hasCoordinates = (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng);
  const isCompletedExpedition = (walk) => walk?.mode === "expedition"
    && walk.expeditionStatus === "reached" && walk.status !== "retreated";
  const getActiveRouteColor = (mode) => mode === "expedition" ? COLORS.activeExpeditionRoute : COLORS.activeTerritoryRoute;
  const getHistoryRouteColor = (walk) => walk?.mode !== "expedition" ? COLORS.activeTerritoryRoute
    : isCompletedExpedition(walk) ? COLORS.completedExpeditionRoute : COLORS.retreatedExpeditionRoute;
  const getHistoryRouteStyle = (walk) => {
    const retreatedExpedition = walk?.mode === "expedition" && !isCompletedExpedition(walk);
    return {
      color: getHistoryRouteColor(walk),
      weight: 4,
      ...(retreatedExpedition ? { outlineColor: COLORS.retreatedExpeditionOutline, outlineWeight: 6 } : {})
    };
  };

  const createExpeditionMarkers = ({ map, leaflet }) => {
    let targetMarker = null;
    let startMarker = null;

    const createMarker = (point, fillColor, radius, fillOpacity = 1) => leaflet.circleMarker(
      [point.lat, point.lng],
      {
        radius,
        color: "#fff",
        weight: MARKER_STROKE_WIDTH,
        fillColor,
        fillOpacity,
        pane: "markerPane",
        interactive: false,
        bubblingMouseEvents: false
      }
    );

    const updateTarget = (target) => {
      if (!hasCoordinates(target)) {
        if (targetMarker) map.removeLayer(targetMarker);
        targetMarker = null;
        return;
      }
      if (targetMarker) targetMarker.setLatLng([target.lat, target.lng]);
      else targetMarker = createMarker(target, COLORS.expeditionGoal, GOAL_MARKER_RADIUS).addTo(map);
    };

    const updateStart = (point) => {
      if (!hasCoordinates(point)) return;
      if (startMarker) startMarker.setLatLng([point.lat, point.lng]);
      else startMarker = createMarker(point, COLORS.startMarker, START_MARKER_RADIUS).addTo(map);
    };

    const clearStart = () => {
      if (startMarker) map.removeLayer(startMarker);
      startMarker = null;
    };

    const createHistoryMarkers = (walk) => {
      if (walk?.mode !== "expedition") return [];
      const layers = [];
      const savedStart = hasCoordinates(walk.startPosition) ? walk.startPosition : walk.points?.[0];
      if (hasCoordinates(savedStart)) layers.push(createMarker(savedStart, COLORS.startMarker, START_MARKER_RADIUS, 0.75));
      if (isCompletedExpedition(walk) && hasCoordinates(walk.target)) {
        layers.push(createMarker(walk.target, COLORS.completedExpeditionGoal, GOAL_MARKER_RADIUS));
      }
      return layers;
    };

    return { updateTarget, updateStart, clearStart, createHistoryMarkers };
  };

  const ExpeditionMarkers = { createExpeditionMarkers, isCompletedExpedition, getActiveRouteColor, getHistoryRouteColor, getHistoryRouteStyle };
  if (typeof module === "object" && module.exports) module.exports = ExpeditionMarkers;
  else window.WalkExpeditionMarkers = ExpeditionMarkers;
})();
