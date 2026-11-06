(() => {
  "use strict";

  const hasCoordinates = (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng);

  const createExpeditionMarkers = ({ map, leaflet }) => {
    let targetMarker = null;
    let startMarker = null;

    const createMarker = (point, fillColor, radius, fillOpacity = 1) => leaflet.circleMarker(
      [point.lat, point.lng],
      {
        radius,
        color: "#fff",
        weight: 2,
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
      else targetMarker = createMarker(target, "#d89a32", 9).addTo(map);
    };

    const updateStart = (point) => {
      if (!hasCoordinates(point)) return;
      if (startMarker) startMarker.setLatLng([point.lat, point.lng]);
      else startMarker = createMarker(point, "#111820", 6).addTo(map);
    };

    const clearStart = () => {
      if (startMarker) map.removeLayer(startMarker);
      startMarker = null;
    };

    const createHistoryMarkers = (walk) => {
      if (walk?.mode !== "expedition") return [];
      const layers = [];
      const savedStart = hasCoordinates(walk.startPosition) ? walk.startPosition : walk.points?.[0];
      if (hasCoordinates(savedStart)) layers.push(createMarker(savedStart, "#111820", 6, 0.75));
      if (walk.expeditionStatus === "reached" && hasCoordinates(walk.target)) {
        layers.push(createMarker(walk.target, "#388e3c", 9));
      }
      return layers;
    };

    return { updateTarget, updateStart, clearStart, createHistoryMarkers };
  };

  if (typeof module === "object" && module.exports) module.exports = { createExpeditionMarkers };
  else window.WalkExpeditionMarkers = { createExpeditionMarkers };
})();
