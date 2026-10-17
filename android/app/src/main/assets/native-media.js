(() => {
  'use strict';
  if (location.origin !== 'https://vdo.ninja' || window === window.top || !window.DischordNative || !navigator.mediaDevices?.getUserMedia) return;
  const scope = crypto.randomUUID();
  const tracks = new Set();
  const update = () => {
    for (const track of tracks) if (track.readyState === 'ended') tracks.delete(track);
    DischordNative.postMessage(JSON.stringify({ type: 'media-state', scope,
      audio: [...tracks].some(t => t.kind === 'audio'), video: [...tracks].some(t => t.kind === 'video') }));
  };
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await original(...args);
    for (const track of stream.getTracks()) {
      tracks.add(track);
      track.addEventListener('ended', update, { once: true });
      const stop = track.stop.bind(track);
      track.stop = () => { stop(); update(); };
    }
    update();
    return stream;
  };
  window.addEventListener('pagehide', () => {
    tracks.clear(); update();
  }, { once: true });
})();
