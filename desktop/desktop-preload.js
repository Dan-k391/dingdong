'use strict';

const { ipcRenderer } = require('electron');

// Relay only the validated native picker cancellation for its stream. No Node
// APIs or general IPC bridge are exposed to the hosted page.
ipcRenderer.on('dischord:screen-share-cancelled', (_event, payload) => {
  if (typeof payload?.streamId !== 'string' || !payload.streamId || payload.streamId.length > 256) return;
  window.dispatchEvent(new CustomEvent('dischord-screen-share-cancelled', {
    detail: { streamId: payload.streamId }
  }));
});

function restartDetails(payload) {
  return typeof payload?.streamId === 'string' && payload.streamId.length > 0 && payload.streamId.length <= 256 &&
    typeof payload.requestId === 'string' && payload.requestId.length > 0 && payload.requestId.length <= 128;
}
window.addEventListener('dischord-screen-quality-restart', async (event) => {
  const detail = event.detail;
  if (!restartDetails(detail)) return;
  const payload = { streamId: detail.streamId, requestId: detail.requestId };
  let result;
  try { result = await ipcRenderer.invoke('dischord:screen-quality-restart', payload); }
  catch { result = { ok: false, error: 'The desktop sharing bridge is unavailable.' }; }
  window.dispatchEvent(new CustomEvent('dischord-screen-quality-restart-ready', {
    detail: { ...payload, ok: result?.ok === true, ...(typeof result?.error === 'string' ? { error: result.error } : {}) }
  }));
});
window.addEventListener('dischord-screen-quality-restart-cancel', (event) => {
  if (!restartDetails(event.detail)) return;
  ipcRenderer.send('dischord:screen-quality-restart-cancel', {
    streamId: event.detail.streamId, requestId: event.detail.requestId
  });
});
window.addEventListener('dischord-screen-quality-restart-run', async (event) => {
  if (!restartDetails(event.detail)) return;
  const payload = { streamId: event.detail.streamId, requestId: event.detail.requestId };
  let result;
  try { result = await ipcRenderer.invoke('dischord:screen-quality-restart-run', payload); }
  catch { result = { ok: false, error: 'The desktop sharing bridge is unavailable.' }; }
  window.dispatchEvent(new CustomEvent('dischord-screen-quality-restart-ran', {
    detail: { ...payload, ok: result?.ok === true, ...(typeof result?.error === 'string' ? { error: result.error } : {}) }
  }));
});
window.addEventListener('dischord-screen-share-stopped', (event) => {
  if (typeof event.detail?.streamId !== 'string' || !event.detail.streamId || event.detail.streamId.length > 256) return;
  ipcRenderer.send('dischord:screen-share-stopped', { streamId: event.detail.streamId });
});
ipcRenderer.on('dischord:screen-quality-restart-failed', (_event, payload) => {
  if (!restartDetails(payload)) return;
  window.dispatchEvent(new CustomEvent('dischord-screen-quality-restart-failed', {
    detail: { streamId: payload.streamId, requestId: payload.requestId,
      error: typeof payload.error === 'string' ? payload.error : 'The sharing source could not be restarted.' }
  }));
});

// Native window controls stay in Electron's title-bar overlay. The hosted app
// only needs a CSS marker to reserve space for its matching draggable bar.
function markDesktop() {
  document.documentElement.classList.add('desktop-client', 'desktop-' + process.platform);
  window.dispatchEvent(new Event('dischord-desktop-ready'));
}
window.addEventListener('DOMContentLoaded', markDesktop, { once: true });
