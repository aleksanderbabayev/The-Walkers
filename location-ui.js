(() => {
  "use strict";
  const isPermissionDenied = (error) => error?.code === 1;
  const getLocationState = ({ error, reason, accuracy } = {}) => {
    if (isPermissionDenied(error)) return {
      state: "denied",
      title: "Геолокация недоступна",
      message: "Доступ к геолокации запрещён. Нажмите кнопку, чтобы проверить доступ ещё раз.",
      action: "Разрешить геолокацию"
    };
    if (reason === "accuracy") return {
      state: "weak",
      title: "Определяем местоположение",
      message: `GPS-сигнал пока слабый (±${Math.round(accuracy)} м). Перейдите на открытое место и подождите.`,
      action: "Проверить GPS снова"
    };
    if (reason === "stale") return {
      state: "unavailable",
      title: "Геолокация недоступна",
      message: "Получены устаревшие координаты. Попробуйте определить местоположение ещё раз.",
      action: "Попробовать снова"
    };
    if (error?.code === 3) return {
      state: "unavailable",
      title: "Геолокация недоступна",
      message: "Не удалось получить координаты вовремя. Проверьте сигнал GPS и попробуйте ещё раз.",
      action: "Попробовать снова"
    };
    if (error || reason === "unsupported") return {
      state: "unavailable",
      title: "Геолокация недоступна",
      message: reason === "unsupported"
        ? "Этот браузер не поддерживает геолокацию. Откройте приложение в другом браузере."
        : "Не удалось получить координаты. Проверьте сигнал GPS и попробуйте ещё раз.",
      action: reason === "unsupported" ? "" : "Попробовать снова"
    };
    if (reason === "ready") return {
      state: "ready", title: "Местоположение определено",
      message: "GPS готов для начала прогулки.", action: ""
    };
    return {
      state: "loading", title: "Определяем местоположение",
      message: "Получаем свежие координаты GPS…", action: ""
    };
  };
  const canStartWalk = ({ storageReady, draftResolved, locationFresh, busy }) =>
    Boolean(storageReady && draftResolved && locationFresh && !busy);
  const getAccessRetryState = (state) => {
    if (state === "checking") return {
      buttonText: "Проверяем доступ…", disabled: true,
      message: "Разрешите доступ к местоположению в настройках браузера."
    };
    if (state === "denied") return {
      buttonText: "Проверить доступ", disabled: false,
      message: "Геолокация всё ещё отключена. Разрешите доступ в настройках браузера."
    };
    if (state === "timeout") return {
      buttonText: "Проверить доступ", disabled: false,
      message: "Проверка заняла слишком много времени. Попробуйте ещё раз."
    };
    if (state === "error") return {
      buttonText: "Проверить доступ", disabled: false,
      message: "Не удалось проверить доступ. Попробуйте ещё раз."
    };
    return {
      buttonText: "Проверить доступ", disabled: false,
      message: "Разрешите доступ к местоположению в настройках браузера."
    };
  };
  const api = { getLocationState, canStartWalk, isPermissionDenied, getAccessRetryState };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WalkLocationUi = api;
})();
