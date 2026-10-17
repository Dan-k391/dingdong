(() => {
  'use strict';
  if (location.origin !== 'https://dan-k391.github.io' || window !== window.top) return;
  const mark = () => {
    if (!document.documentElement) return false;
    // Native layout consumes status/navigation bars, display cutouts and IME.
    // Set the marker before page styles paint so CSS does not add them again.
    document.documentElement.classList.add('android-client');
    return true;
  };
  if (!mark()) {
    const observer = new MutationObserver(() => { if (mark()) observer.disconnect(); });
    observer.observe(document, { childList: true });
    document.addEventListener('DOMContentLoaded', () => { mark(); observer.disconnect(); }, { once: true });
  }
  // The real capture adapter lives in the VDO publisher iframe. Advertise its
  // availability to the app's feature check without starting capture here.
  if (navigator.mediaDevices && !navigator.mediaDevices.getDisplayMedia) {
    navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Use the Screen button to share.', 'NotSupportedError'));
  }
})();
