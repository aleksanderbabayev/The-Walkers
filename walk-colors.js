(function (root) {
  "use strict";

  const navigationBlue = "#2877DF";
  const expeditionSuccessGreen = "#2F874D";
  const colors = Object.freeze({
    currentLocation: navigationBlue,
    activeExpeditionRoute: navigationBlue,
    completedExpeditionRoute: expeditionSuccessGreen,
    retreatedExpeditionRoute: "#929A96",
    retreatedExpeditionOutline: "#34413A",
    activeTerritoryRoute: "#e0765d",
    capturedTerritoryOutline: "#477b43",
    capturedTerritoryFill: "#8fbd70",
    expeditionGoal: "#d89a32",
    completedExpeditionGoal: expeditionSuccessGreen,
    startMarker: "#111820",
    expeditionTargetLine: "#29b6e6"
  });

  if (typeof module === "object" && module.exports) module.exports = colors;
  else root.WalkColors = colors;
})(globalThis);
