(() => {
  "use strict";

  const PANES = Object.freeze({
    territory: { name: "territoryPane", zIndex: 300 },
    route: { name: "routePane", zIndex: 400 },
    gameOverlay: { name: "gameOverlayPane", zIndex: 520 },
    gameMarker: { name: "gameMarkerPane", zIndex: 600 },
    accuracy: { name: "accuracyPane", zIndex: 660 },
    currentLocation: { name: "currentLocationPane", zIndex: 680 }
  });
  const names = Object.freeze(Object.fromEntries(Object.entries(PANES).map(([key, pane]) => [key, pane.name])));

  const createMapPanes = (map) => {
    Object.values(PANES).forEach(({ name, zIndex }) => {
      map.createPane(name).style.zIndex = String(zIndex);
    });
    return names;
  };

  const MapLayerPanes = { PANES, createMapPanes };
  if (typeof module === "object" && module.exports) module.exports = MapLayerPanes;
  else window.WalkMapLayerPanes = MapLayerPanes;
})();
