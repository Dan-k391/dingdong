(() => {
  'use strict';
  if (window === window.top || location.origin !== 'https://vdo.ninja' ||
      !window.DischordNative || !navigator.mediaDevices || !window.RTCPeerConnection) return;

  const bridge = window.DischordNative;
  let active = null;
  let sequence = 0;
  const exception = (message, name = 'AbortError') => new DOMException(message, name);
  const send = (session, type, data = {}) => {
    try { bridge.postMessage(JSON.stringify({ type, id: session.id, ...data })); } catch (_) { }
  };

  function end(session, notify = true, reason = null) {
    if (!session || session.stopped) return;
    session.stopped = true;
    if (active === session) active = null;
    clearTimeout(session.timer);
    clearTimeout(session.disconnectedTimer);
    if (notify) send(session, 'screen-stop');
    // VDO reports ordinary permission cancellation itself, but some startup errors do not
    // send a state event. Clear the app's pending indicator for every completed request.
    window.parent.postMessage({ action: 'screen-share-state', value: false }, 'https://dan-k391.github.io');
    for (const pending of session.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason || exception('Screen sharing has ended.'));
    }
    session.requests.clear();
    if (!session.resolved) session.reject(reason || exception('Screen sharing was cancelled.', 'NotAllowedError'));
    if (session.track) {
      session.originalStop();
      // Android's system Stop action must trigger VDO's normal capture-ended cleanup.
      session.track.dispatchEvent(new Event('ended'));
    }
    session.peer.ontrack = null;
    session.peer.onicecandidate = null;
    session.peer.onconnectionstatechange = null;
    session.peer.close();
  }

  function exposeTrack(session, track) {
    session.track = track;
    session.originalStop = track.stop.bind(track);
    const originalSettings = track.getSettings.bind(track);
    const originalCapabilities = track.getCapabilities ? track.getCapabilities.bind(track) : () => ({});
    Object.defineProperties(track, {
      stop: { configurable: true, value: () => end(session) },
      getSettings: {
        configurable: true,
        value: () => ({ ...originalSettings(), ...session.settings, displaySurface: 'monitor' })
      },
      getCapabilities: {
        configurable: true,
        value: () => ({
          ...originalCapabilities(), width: { min: 2, max: 8192 }, height: { min: 2, max: 8192 },
          frameRate: { min: 1, max: 60 }, displaySurface: 'monitor'
        })
      },
      getConstraints: { configurable: true, value: () => ({ ...session.video }) },
      applyConstraints: {
        configurable: true,
        value: constraints => {
          // VDO and the app can both change capture settings. Build each request from
          // the latest acknowledged configuration rather than overlapping stale copies.
          const requested = { ...(constraints || {}) };
          const result = session.constraintQueue.then(() => {
            if (session.stopped) throw exception('Screen sharing has ended.', 'InvalidStateError');
            const video = { ...session.video, ...requested };
            const requestId = String(++sequence);
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                session.requests.delete(requestId);
                reject(exception('The screen-capture setting could not be applied.'));
              }, 10000);
              session.requests.set(requestId, { resolve: () => { session.video = video; resolve(); }, reject, timer });
              send(session, 'screen-constraints', { video, requestId });
            });
          });
          session.constraintQueue = result.catch(() => {});
          return result;
        }
      }
    });
    track.addEventListener('ended', () => { if (!session.stopped) end(session); }, { once: true });
    maybeResolve(session);
  }

  function maybeResolve(session) {
    if (session.stopped || session.resolved || !session.track || session.peer.connectionState !== 'connected') return;
    session.resolved = true;
    clearTimeout(session.timer);
    session.resolve(new MediaStream([session.track]));
  }

  bridge.addEventListener('message', async event => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    const session = active;
    if (!session || session.stopped || message.id !== session.id || !String(message.type).startsWith('screen-')) return;
    try {
      if (message.type === 'screen-answer') {
        await session.peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        for (const candidate of session.candidates.splice(0)) await session.peer.addIceCandidate(candidate);
        maybeResolve(session);
      } else if (message.type === 'screen-ice') {
        if (session.peer.remoteDescription) await session.peer.addIceCandidate(message.candidate);
        else if (session.candidates.length < 128) session.candidates.push(message.candidate);
      } else if (message.type === 'screen-config') {
        const revision = Number(message.revision) || 0;
        // A display rotation or startup callback may precede an in-flight update.
        // Never let its delayed acknowledgment replace newer reported settings.
        if (revision >= session.configRevision) {
          session.configRevision = revision;
          session.settings = {
            width: message.width, height: message.height, frameRate: message.frameRate, displaySurface: 'monitor'
          };
        }
        const pending = session.requests.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          session.requests.delete(message.requestId);
          pending.resolve();
        }
      } else if (message.type === 'screen-constraints-error') {
        const pending = session.requests.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          session.requests.delete(message.requestId);
          pending.reject(exception(message.message, message.name));
        }
      } else if (message.type === 'screen-error') {
        end(session, false, exception(message.message || 'Screen sharing could not start.', message.name || 'NotReadableError'));
      } else if (message.type === 'screen-stopped') {
        end(session, false, exception(message.message || 'Screen sharing stopped.', 'NotAllowedError'));
      }
    } catch (_) {
      end(session, true, exception('The screen-capture connection could not be established.', 'OperationError'));
    }
  });

  async function getDisplayMedia(constraints = {}) {
    if (active && !active.stopped) throw exception('A screen-share request is already open.', 'InvalidStateError');
    if (constraints.video === false) throw new TypeError('Screen sharing requires a video track.');
    const peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
    // VP8 provides a consistent local bridge; VDO retains control of the outgoing room codec.
    if (transceiver.setCodecPreferences && window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities) {
      const codecs = (RTCRtpReceiver.getCapabilities('video') || {}).codecs || [];
      const vp8 = codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/vp8');
      if (vp8.length) transceiver.setCodecPreferences(vp8);
    }
    const video = typeof constraints.video === 'object' && constraints.video ? { ...constraints.video } : {};
    const query = new URLSearchParams(location.search);
    video.bitrate = Number(query.get('outboundvideobitrate')) || 12000;
    video.contentHint = query.get('screensharecontenthint') || query.get('contenthint') || 'motion';
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let resolve;
    let reject;
    const result = new Promise((success, failure) => { resolve = success; reject = failure; });
    const session = {
      id, peer, video, resolve, reject, stopped: false, resolved: false, track: null,
      originalStop: null, requests: new Map(), candidates: [], outboundCandidates: [], settings: {}, sentStart: false,
      configRevision: 0, constraintQueue: Promise.resolve()
    };
    active = session;
    session.timer = setTimeout(() => end(session, true, exception('Screen sharing timed out. Please try again.')), 120000);
    peer.onicecandidate = event => {
      if (!event.candidate || session.stopped) return;
      const candidate = event.candidate.toJSON();
      if (session.sentStart) send(session, 'screen-ice', { candidate });
      else if (session.outboundCandidates.length < 128) session.outboundCandidates.push(candidate);
    };
    peer.ontrack = event => {
      if (session.stopped) { event.track.stop(); return; }
      if (event.track.kind === 'video') exposeTrack(session, event.track);
    };
    peer.onconnectionstatechange = () => {
      if (session.stopped) return;
      if (peer.connectionState === 'connected') {
        clearTimeout(session.disconnectedTimer);
        maybeResolve(session);
      } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        end(session, true, exception('The local screen-capture connection failed.', 'NetworkError'));
      } else if (peer.connectionState === 'disconnected') {
        clearTimeout(session.disconnectedTimer);
        session.disconnectedTimer = setTimeout(() => end(session, true, exception('The screen-capture connection was interrupted.', 'NetworkError')), 10000);
      }
    };
    try {
      const offer = await peer.createOffer();
      if (session.stopped) return result;
      await peer.setLocalDescription(offer);
      if (!session.stopped) {
        send(session, 'screen-start', { sdp: peer.localDescription.sdp, video });
        session.sentStart = true;
        for (const candidate of session.outboundCandidates.splice(0)) send(session, 'screen-ice', { candidate });
      }
    } catch (_) {
      end(session, true, exception('Screen sharing could not initialize.', 'OperationError'));
    }
    return result;
  }

  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, writable: true, value: getDisplayMedia });
  window.addEventListener('pagehide', () => end(active), { capture: true });
})();
