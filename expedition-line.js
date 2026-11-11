(() => {
  "use strict";
  const COLORS = typeof module === "object" && module.exports ? require("./walk-colors.js") : window.WalkColors;

  const createExpeditionLine = ({ map, leaflet, isLocationFresh }) => {
    let line = null;
    let visible = false;

    const hide = () => {
      if (visible) map.removeLayer(line);
      visible = false;
    };

    const update = (point, target, active) => {
      if (!active || !point || !target || !isLocationFresh(point)
        || ![point.lat, point.lng, target.lat, target.lng].every(Number.isFinite)) {
        hide();
        return false;
      }

      if (!line) {
        line = leaflet.polyline([], {
          color: COLORS.expeditionTargetLine,
          weight: 5,
          opacity: 0.95,
          dashArray: "8 10",
          lineCap: "round",
          interactive: false,
          bubblingMouseEvents: false
        });
      }
      line.setLatLngs([[point.lat, point.lng], [target.lat, target.lng]]);
      if (!visible) {
        map.addLayer(line);
        visible = true;
      }
      return true;
    };

    return { update, hide };
  };

  if (typeof module === "object" && module.exports) module.exports = { createExpeditionLine };
  else window.WalkExpeditionLine = { createExpeditionLine };
})();
