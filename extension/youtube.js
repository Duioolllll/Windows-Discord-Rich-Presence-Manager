/* Runs only after the user explicitly grants YouTube access. No page text or URL is sent. */
(() => {
  if (globalThis.__autoPresenceMediaObserver) {
    globalThis.__autoPresenceMediaObserver();
    return;
  }
  const api = globalThis.browser || globalThis.chrome;
  const report = () => {
    const video = document.querySelector('video');
    if (!video) return;
    try { const result = api.runtime.sendMessage({ type: 'youtube-media', status: video.paused || video.ended ? 'paused' : 'playing' }); if (result?.catch) result.catch(() => {}); } catch { /* extension unloaded */ }
  };
  globalThis.__autoPresenceMediaObserver = report;
  for (const event of ['play', 'pause', 'ended', 'loadedmetadata']) document.addEventListener(event, report, true);
  report();
})();
