(function (root, factory) {
  const MapFollow = factory();
  if (typeof module === "object" && module.exports) module.exports = MapFollow;
  else root.WalkMapFollow = MapFollow;
})(globalThis, function () {
  "use strict";

  const STORAGE_KEY = "the-walkers-follow-location";

  const createMapFollow = ({ map, storage, onChange = () => {} }) => {
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
    const centerOn = (point) => {
      if (!enabled || !point) return false;
      programmaticMove = true;
      try { map.panTo([point.lat, point.lng], { animate: false }); }
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

  return { createMapFollow };
});
