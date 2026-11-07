(() => {
  "use strict";

  const MARKER_STROKE_WIDTH = 1;
  const START_MARKER_RADIUS = 3.5;
  const GOAL_MARKER_RADIUS = 5.5;
  const hasCoordinates = (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng);

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
      else targetMarker = createMarker(target, "#d89a32", GOAL_MARKER_RADIUS).addTo(map);
    };

    const updateStart = (point) => {
      if (!hasCoordinates(point)) return;
      if (startMarker) startMarker.setLatLng([point.lat, point.lng]);
      else startMarker = createMarker(point, "#111820", START_MARKER_RADIUS).addTo(map);
    };

    const clearStart = () => {
      if (startMarker) map.removeLayer(startMarker);
      startMarker = null;
    };

    const createHistoryMarkers = (walk) => {
      if (walk?.mode !== "expedition") return [];
      const layers = [];
      const savedStart = hasCoordinates(walk.startPosition) ? walk.startPosition : walk.points?.[0];
      if (hasCoordinates(savedStart)) layers.push(createMarker(savedStart, "#111820", START_MARKER_RADIUS, 0.75));
      if (walk.expeditionStatus === "reached" && hasCoordinates(walk.target)) {
        layers.push(createMarker(walk.target, "#388e3c", GOAL_MARKER_RADIUS));
      }
      return layers;
    };

    return { updateTarget, updateStart, clearStart, createHistoryMarkers };
  };

  if (typeof module === "object" && module.exports) module.exports = { createExpeditionMarkers };
  else window.WalkExpeditionMarkers = { createExpeditionMarkers };
})();
