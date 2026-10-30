(function (root, factory) {
  const actions = factory();
  if (typeof module === "object" && module.exports) module.exports = actions;
  else root.WalkActions = actions;
})(globalThis, function () {
  "use strict";

  const bindClick = (button, action) => button.addEventListener("click", () => action());

  return { bindClick };
});
