(function (root) {
  "use strict";

  const bind = ({ menu, dialog, documentLike = document, onAction, onOpen }) => {
    const trigger = menu.querySelector("summary");
    const close = (restoreFocus = false) => {
      if (!menu.open) return;
      const focusWasInside = menu.contains(documentLike.activeElement);
      menu.open = false;
      if (restoreFocus && focusWasInside) trigger.focus();
    };
    const handleOutsideInteraction = (event) => {
      if (menu.open && !menu.contains(event.target)) close();
    };
    const handleMenuClick = (event) => {
      const item = event.target.closest?.("button");
      if (!item || !menu.contains(item)) return;
      close(true);
      if (!item.dataset.menuAction) return;
      try { Promise.resolve(onAction(item.dataset.menuAction, item)).catch(() => {}); }
      catch {}
    };
    const handleTriggerClick = () => { if (!menu.open) onOpen?.(); };
    const handleKeydown = (event) => {
      if (event.key !== "Escape") return;
      if (dialog?.open) {
        event.preventDefault();
        dialog.close();
      } else if (menu.open) {
        event.preventDefault();
        close(true);
      }
    };
    const handleDialogClick = (event) => {
      if (event.target === dialog) dialog.close();
    };

    menu.addEventListener("click", handleMenuClick);
    trigger.addEventListener("click", handleTriggerClick);
    documentLike.addEventListener("pointerdown", handleOutsideInteraction, true);
    documentLike.addEventListener("click", handleOutsideInteraction, true);
    documentLike.addEventListener("keydown", handleKeydown);
    dialog?.addEventListener("click", handleDialogClick);
    dialog?.addEventListener("close", () => trigger.focus());

    return { close };
  };

  const api = { bind };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WalkUtilityMenu = api;
})(globalThis);
