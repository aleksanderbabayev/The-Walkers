(() => {
  "use strict";
  const createMusicControl = ({ audio, isMuted, setMuted, onStateChange }) => {
    let locationAllowed = false;
    let permissionRevision = 0;
    let playRequest = null;
    const notify = () => onStateChange?.();

    const start = () => {
      if (!locationAllowed || isMuted() || !audio.paused) return playRequest || Promise.resolve();
      if (playRequest) return playRequest;

      const requestRevision = permissionRevision;
      let playResult;
      try { playResult = audio.play(); }
      catch { notify(); return Promise.resolve(); }

      let request;
      request = Promise.resolve(playResult).catch(() => {}).then(() => {
        if (!locationAllowed || isMuted() || requestRevision !== permissionRevision) audio.pause();
        notify();
      }).finally(() => {
        if (playRequest === request) playRequest = null;
        if (requestRevision !== permissionRevision && locationAllowed && !isMuted() && audio.paused) start();
      });
      playRequest = request;
      return request;
    };

    const setLocationAllowed = (allowed) => {
      const nextAllowed = Boolean(allowed);
      if (locationAllowed === nextAllowed) {
        if (!nextAllowed) audio.pause();
        notify();
        return;
      }
      locationAllowed = nextAllowed;
      permissionRevision += 1;
      if (locationAllowed) start();
      else audio.pause();
      notify();
    };

    const toggle = async () => {
      if (!isMuted() && audio.paused) {
        await start();
        return;
      }
      const nextMuted = !isMuted();
      setMuted(nextMuted);
      if (nextMuted) audio.pause();
      else await start();
      notify();
    };

    return { start, setLocationAllowed, isLocationAllowed: () => locationAllowed, toggle };
  };

  const api = { createMusicControl };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WalkMusicControl = api;
})();
