(function (root, factory) {
  const actions = factory();
  if (typeof module === "object" && module.exports) module.exports = actions;
  else root.WalkActions = actions;
})(globalThis, function () {
  "use strict";

  const bindClick = (button, action) => button.addEventListener("click", () => action());

  const commitIfReady = async ({ prepare, evaluate, commit, onReject }) => {
    const context = await prepare();
    const evaluation = evaluate(context);
    if (!evaluation?.eligible) {
      await onReject?.(context, evaluation);
      return { committed: false, context, evaluation };
    }
    await commit(context, evaluation);
    return { committed: true, context, evaluation };
  };

  return { bindClick, commitIfReady };
});
