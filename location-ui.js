(() => {
  "use strict";
  const permissionRetryHelp = "Если браузер не показывает запрос доступа, откройте настройки сайта в браузере и разрешите геолокацию.";
  const deniedScreenText = "Чтобы записывать прогулки и захватывать территории, разрешите приложению определять ваше местоположение";
  const isPermissionDenied = (error) => error?.code === 1;
  const getPermissionHelp = (userAgent = "") => {
    const isIPhoneSafari = /iPhone|iPad|iPod/i.test(userAgent)
      && /Safari/i.test(userAgent) && !/(CriOS|FxiOS|EdgiOS|OPiOS)/i.test(userAgent);
    return isIPhoneSafari
      ? "Safari на iPhone: меню страницы у адреса → «Настройки веб-сайта» → «Геопозиция» → «Разрешить». Если пункта нет: Настройки → Приложения → Safari → «Геопозиция»."
      : "Откройте настройки браузера → разрешения сайта → геолокация и выберите «Разрешить». Затем вернитесь сюда и нажмите кнопку ещё раз.";
  };
  const getLocationState = ({ error, reason, accuracy, permissionRetryAttempted = false } = {}) => {
    if (isPermissionDenied(error)) return {
      state: "denied",
      title: "Геолокация недоступна",
      message: permissionRetryAttempted
        ? `${permissionRetryHelp} Затем нажмите «Разрешить геолокацию» ещё раз.`
        : "Доступ к геолокации запрещён. Нажмите кнопку, чтобы запросить доступ ещё раз.",
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
  const api = { getLocationState, canStartWalk, deniedScreenText, getPermissionHelp, isPermissionDenied };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WalkLocationUi = api;
})();
