(function (root, factory) {
  const MapFollow = factory();
  if (typeof module === "object" && module.exports) module.exports = MapFollow;
  else root.WalkMapFollow = MapFollow;
})(globalThis, function () {
  "use strict";

  const STORAGE_KEY = "the-walkers-follow-location";

  const getVisibleMapCenter = ({ mapElement, panelElement, mobile = false, createPoint }) => {
    const mapRect = mapElement.getBoundingClientRect();
    const mapWidth = mapElement.clientWidth;
    const mapHeight = mapElement.clientHeight;
    if (!mobile || !panelElement) return createPoint(mapWidth / 2, mapHeight / 2);

    const panelRect = panelElement.getBoundingClientRect();
    const visibleBottom = Math.min(mapRect.bottom, Math.max(mapRect.top, panelRect.top));
    const visibleHeight = visibleBottom - mapRect.top;
    if (visibleHeight <= 0) return createPoint(mapWidth / 2, mapHeight / 2);
    return createPoint(mapWidth / 2, visibleHeight / 2);
  };

  const getVisibleMapFitPadding = ({ mapElement, panelElement, mobile = false, padding = 16 }) => {
    const symmetricPadding = { paddingTopLeft: [padding, padding], paddingBottomRight: [padding, padding] };
    if (!mobile || !panelElement) return symmetricPadding;

    const mapRect = mapElement.getBoundingClientRect();
    const panelTop = panelElement.getBoundingClientRect().top;
    const visibleBottom = Math.min(mapRect.bottom, Math.max(mapRect.top, panelTop));
    const visibleHeight = visibleBottom - mapRect.top;
    if (visibleHeight <= padding * 2) return symmetricPadding;

    const coveredBottom = mapRect.bottom - visibleBottom;
    return {
      paddingTopLeft: [padding, padding],
      paddingBottomRight: [padding, coveredBottom + padding]
    };
  };

  const createMapFollow = ({ map, storage, onChange = () => {}, getTargetPoint = () => map.getSize().divideBy(2) }) => {
    let enabled = false;
    let programmaticMove = false;
    try { enabled = storage?.getItem(STORAGE_KEY) === "true"; } catch {}

    const setEnabled = (value) => {
      enabled = Boolean(value);
      try { storage?.setItem(STORAGE_KEY, String(enabled)); } catch {}
      onChange(enabled);
      return enabled;
    };
    const toggle = () => setEnabled(!enabled);
    const centerOn = (point, { force = false } = {}) => {
      if ((!enabled && !force) || !point) return false;
      programmaticMove = true;
      try {
        const currentPoint = map.latLngToContainerPoint([point.lat, point.lng]);
        const targetPoint = getTargetPoint();
        const currentLayerPoint = map.containerPointToLayerPoint(currentPoint);
        const targetLayerPoint = map.containerPointToLayerPoint(targetPoint);
        map.panBy(currentLayerPoint.subtract(targetLayerPoint), { animate: false });
      }
      finally { programmaticMove = false; }
      return true;
    };
    const handleManualDrag = () => {
      if (enabled && !programmaticMove) setEnabled(false);
    };

    map.on("dragstart", handleManualDrag);
    return {
      get enabled() { return enabled; },
      setEnabled,
      toggle,
      centerOn,
      dispose() { map.off("dragstart", handleManualDrag); }
    };
  };

  return { getVisibleMapCenter, getVisibleMapFitPadding, createMapFollow };
});
