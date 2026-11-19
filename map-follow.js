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

  const createMapFollow = ({ map, storage, onChange = () => {}, getTargetPoint = () => map.getSize().divideBy(2), isPositionFresh = () => true }) => {
    let enabled = false;
    let programmaticMove = false;
    let zooming = false;
    let pendingRecenter = false;
    let lastPosition = null;
    let zoomAnchor = null;
    let requestedZoom = null;
    try { enabled = storage?.getItem(STORAGE_KEY) === "true"; } catch {}

    const setEnabled = (value) => {
      enabled = Boolean(value);
      try { storage?.setItem(STORAGE_KEY, String(enabled)); } catch {}
      onChange(enabled);
      return enabled;
    };
    const toggle = () => setEnabled(!enabled);
    const panPositionTo = (point, targetPoint) => {
      const currentPoint = map.latLngToContainerPoint([point.lat, point.lng]);
      const currentLayerPoint = map.containerPointToLayerPoint(currentPoint);
      const targetLayerPoint = map.containerPointToLayerPoint(targetPoint);
      programmaticMove = true;
      try { map.panBy(currentLayerPoint.subtract(targetLayerPoint), { animate: false }); }
      finally { programmaticMove = false; }
    };
    const centerOn = (point, { force = false } = {}) => {
      if (point) lastPosition = point;
      if ((!enabled && !force) || !point) return false;
      if (zooming) { pendingRecenter = true; return true; }
      panPositionTo(point, getTargetPoint());
      return true;
    };
    const handleManualDrag = () => {
      if (enabled && !programmaticMove && !zooming) setEnabled(false);
    };
    const handleZoomStart = () => {
      zooming = true;
      pendingRecenter = false;
      zoomAnchor = enabled && lastPosition && isPositionFresh(lastPosition)
        ? { position: lastPosition, containerPoint: map.latLngToContainerPoint([lastPosition.lat, lastPosition.lng]) }
        : null;
    };
    const handleZoomEnd = () => {
      zooming = false;
      if (enabled && zoomAnchor) {
        if (pendingRecenter && lastPosition && isPositionFresh(lastPosition)) panPositionTo(lastPosition, getTargetPoint());
        else if (isPositionFresh(zoomAnchor.position)) panPositionTo(zoomAnchor.position, zoomAnchor.containerPoint);
      }
      zoomAnchor = null;
      pendingRecenter = false;
      requestedZoom = null;
    };
    const bindZoomControl = (control) => {
      if (!control) return () => {};
      const handleZoomClick = (event) => {
        if (!enabled || !lastPosition || !isPositionFresh(lastPosition)) return;
        const button = event.target.closest?.(".leaflet-control-zoom-in, .leaflet-control-zoom-out");
        if (!button) return;
        const direction = button.classList.contains("leaflet-control-zoom-in") ? 1 : -1;
        const baseZoom = requestedZoom ?? map.getZoom();
        const targetZoom = Math.max(map.getMinZoom?.() ?? -Infinity, Math.min(map.getMaxZoom?.() ?? Infinity, baseZoom + direction));
        event.preventDefault();
        event.stopPropagation();
        if (targetZoom === baseZoom) return;
        requestedZoom = targetZoom;
        map.setZoomAround([lastPosition.lat, lastPosition.lng], targetZoom);
      };
      control.addEventListener("click", handleZoomClick, true);
      return () => control.removeEventListener("click", handleZoomClick, true);
    };

    map.on("dragstart", handleManualDrag);
    map.on("zoomstart", handleZoomStart);
    map.on("zoomend", handleZoomEnd);
    return {
      get enabled() { return enabled; },
      setEnabled,
      toggle,
      centerOn,
      bindZoomControl,
      dispose() {
        map.off("dragstart", handleManualDrag);
        map.off("zoomstart", handleZoomStart);
        map.off("zoomend", handleZoomEnd);
      }
    };
  };

  return { getVisibleMapCenter, getVisibleMapFitPadding, createMapFollow };
});
