(function (root, factory) {
  const actions = factory();
  if (typeof module === "object" && module.exports) module.exports = actions;
  else root.WalkActions = actions;
})(globalThis, function () {
  "use strict";

  const bindClick = (button, action) => button.addEventListener("click", () => action());

  const commitIfReady = async ({ waitForPending, evaluate, commit, onReject }) => {
    await waitForPending();
    const evaluation = evaluate();
    if (!evaluation?.eligible) {
      await onReject?.(evaluation);
      return { committed: false, evaluation };
    }
    await commit(evaluation);
    return { committed: true, evaluation };
  };

  return { bindClick, commitIfReady };
});
