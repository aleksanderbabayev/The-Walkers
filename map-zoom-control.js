(() => {
  "use strict";

  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const ZOOM_BUTTONS = [
    { selector: ".leaflet-control-zoom-in", label: "Увеличить масштаб", path: "M9 3v12M3 9h12" },
    { selector: ".leaflet-control-zoom-out", label: "Уменьшить масштаб", path: "M3 9h12" }
  ];

  const createIcon = (documentRef, pathData) => {
    const icon = documentRef.createElementNS(SVG_NAMESPACE, "svg");
    icon.setAttribute("class", "mapZoomIcon");
    icon.setAttribute("viewBox", "0 0 18 18");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const path = documentRef.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    icon.appendChild(path);
    return icon;
  };

  const configure = (control, documentRef = typeof document !== "undefined" ? document : null) => {
    if (!control || !documentRef?.createElementNS) return false;
    const buttons = ZOOM_BUTTONS.map((item) => ({ ...item, element: control.querySelector(item.selector) }));
    if (buttons.some((item) => !item.element)) return false;
    buttons.forEach(({ element, label, path }) => {
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", label);
      element.title = label;
      element.textContent = "";
      element.appendChild(createIcon(documentRef, path));
    });
    return true;
  };

  const api = { configure };
  if (typeof window !== "undefined") window.WalkMapZoomControl = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
