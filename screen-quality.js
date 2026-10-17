/* Live screen-publisher quality controls for the VDO.Ninja iframe API. */
(() => {
  'use strict';

  // This function deliberately has no outer dependencies: app.js serializes it
  // through VDO's eval API along with a JSON object of numeric preferences.
  function bridge(config) {
    const reply = (result) => {
      try { window.parent.postMessage({ dischordScreenQuality: { requestId: config && config.requestId, ...result } }, '*'); } catch (_) { }
    };
    if (typeof session === 'undefined' || !session) {
      reply({ ok: false, active: false, needsRestart: false, error: 'The screen publisher is not ready.' });
      return;
    }
    const s = session;
    let state = window.__dischordScreenQualityV1;
    if (!state || state.closed) {
      state = { closed: false, queue: Promise.resolve(), target: null, senders: new WeakMap(), polling: false };
      state.source = () => {
        // A separate screen-only publisher owns this stream. Never inspect or
        // change incoming peers, microphone streams or the camera publisher.
        const streams = [s.streamSrc, s.videoElement && s.videoElement.srcObject];
        for (const stream of streams) {
          if (!stream || typeof stream.getVideoTracks !== 'function') continue;
          const track = stream.getVideoTracks().find((t) => t.readyState === 'live');
          if (track) return track;
        }
        return null;
      };
      state.connections = () => {
        const found = [], seen = new Set();
        for (const [uuid, pc] of Object.entries(s.pcs || {})) {
          if (!pc || typeof pc.getSenders !== 'function' || seen.has(pc)) continue;
          seen.add(pc); found.push({ uuid, pc });
        }
        if (s.whipOut && typeof s.whipOut.getSenders === 'function' && !seen.has(s.whipOut)) {
          found.push({ uuid: null, pc: s.whipOut });
        }
        return found;
      };
      state.fields = ['quality', 'quality_ss', 'screensharequality', 'screensharefps', 'frameRate', 'maxframeRate',
        'outboundVideoBitrate', 'outboundVideoBitrate_userSet', 'maxvideobitrate', 'screenShareBitrate', 'screenshareContentHint', 'contentHint'];
      state.setDefaults = (target) => {
        const q = { source: -1, '2160': -2, '1440': -3, '1080': 0, '720': 1 }[target.ssQ];
        s.quality = q; s.quality_ss = q; s.screensharequality = q;
        s.screensharefps = target.ssFps; s.frameRate = target.ssFps; s.maxframeRate = target.ssFps;
        s.outboundVideoBitrate = target.ssBr; s.outboundVideoBitrate_userSet = true;
        s.maxvideobitrate = target.ssBr; s.screenShareBitrate = target.ssBr;
        s.screenshareContentHint = target.ssHint; s.contentHint = target.ssHint;
      };
      state.constraints = (target) => {
        const dims = { '2160': [3840, 2160], '1440': [2560, 1440], '1080': [1920, 1080], '720': [1280, 720] }[target.ssQ];
        const constraints = { frameRate: { ideal: target.ssFps, max: target.ssFps }, bitrate: target.ssBr, contentHint: target.ssHint };
        if (dims) {
          constraints.width = { ideal: dims[0], max: dims[0] };
          constraints.height = { ideal: dims[1], max: dims[1] };
        } else {
          // Empty constraints release a previous resolution cap and survive
          // JSON transport to the Android adapter as source resolution.
          constraints.width = {}; constraints.height = {};
        }
        return constraints;
      };
      state.snapshotSender = (sender, transaction) => {
        if (!transaction || transaction.senders.has(sender)) return;
        let parameters;
        try { parameters = sender.getParameters(); } catch (_) { }
        transaction.senders.set(sender, { parameters, record: state.senders.get(sender) });
        const track = sender.track;
        if (track && !transaction.hints.has(track)) transaction.hints.set(track, track.contentHint);
      };
      state.applySenders = async (target, force = false, transaction = null) => {
        let count = 0;
        const failures = [];
        for (const { pc } of state.connections()) {
          if (pc.connectionState === 'closed' || pc.signalingState === 'closed') continue;
          let senders;
          try { senders = pc.getSenders(); } catch (_) { continue; }
          for (const sender of senders) {
            const track = sender && sender.track;
            if (!track || track.kind !== 'video' || track.readyState !== 'live') continue;
            count++;
            try {
              state.snapshotSender(sender, transaction);
              track.contentHint = target.ssHint;
              if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') throw new Error('Live encoder controls are unavailable.');
              const parameters = sender.getParameters();
              // Negotiating senders may not have encodings yet. The maintenance
              // pass installs the selected target as soon as negotiation finishes.
              if (!parameters.encodings || !parameters.encodings.length) continue;
              const previous = state.senders.get(sender);
              let settings = {};
              try { settings = track.getSettings(); } catch (_) { }
              const dims = { '2160': [3840, 2160], '1440': [2560, 1440], '1080': [1920, 1080], '720': [1280, 720] }[target.ssQ];
              const captureScale = dims ? Math.max(1, (+settings.width || dims[0]) / dims[0], (+settings.height || dims[1]) / dims[1]) : 1;
              let changed = false;
              parameters.encodings.forEach((encoding, index) => {
                const oldScale = previous && previous.scales[index];
                const currentScale = Number(encoding.scaleResolutionDownBy) || 1;
                // Preserve VDO's per-viewer downscaling, including the low own
                // preview. Only remove the scale previously added by this adapter.
                const viewerScale = oldScale && Math.abs(currentScale - oldScale.result) < 0.0001 ? oldScale.viewer : currentScale;
                const scale = Math.max(1, viewerScale * captureScale);
                if (encoding.maxFramerate !== target.ssFps) { encoding.maxFramerate = target.ssFps; changed = true; }
                if (Math.abs(currentScale - scale) > 0.0001) { encoding.scaleResolutionDownBy = scale; changed = true; }
                // A viewer may deliberately request less bandwidth or become
                // hidden. Respect that lower rate on maintenance passes.
                const cap = target.ssBr * 1024;
                const priorCap = (previous ? previous.target : state.previousBitrate) * 1024;
                const current = Number(encoding.maxBitrate);
                const wasOurCap = current === priorCap;
                const bitrate = force && (!current || wasOurCap) ? cap : current > 0 ? Math.min(current, cap) : cap;
                if (encoding.active !== false && encoding.maxBitrate !== bitrate) { encoding.maxBitrate = bitrate; changed = true; }
              });
              const degradation = target.ssHint === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
              if (parameters.degradationPreference !== degradation) { parameters.degradationPreference = degradation; changed = true; }
              if (changed) await sender.setParameters(parameters);
              state.senders.set(sender, { target: target.ssBr, scales: parameters.encodings.map((encoding, index) => {
                const old = previous && previous.scales[index];
                const result = Number(encoding.scaleResolutionDownBy) || 1;
                const viewer = old && Math.abs(result - old.result) < 0.0001 ? old.viewer : result / captureScale;
                return { viewer, result };
              }) });
            } catch (error) { failures.push(error); }
          }
        }
        return { count, failures };
      };
      state.close = () => {
        state.closed = true;
        clearInterval(state.timer);
        if (state.armed) clearTimeout(state.armed.timer);
        state.armed = null;
        if (window.__dischordScreenQualityV1 === state) delete window.__dischordScreenQualityV1;
      };
      state.runArmedRestart = (requestId) => {
        const armed = state.armed;
        if (state.closed || !armed || armed.requestId !== requestId) return false;
        state.armed = null;
        clearTimeout(armed.timer);
        state.polling = true;
        // Called by the desktop host in this exact frame with userGesture:true.
        // Call directly so getDisplayMedia starts before the first async boundary.
        const promise = armed.run().catch(armed.fail);
        state.queue = promise.catch(() => {}).finally(() => { state.polling = false; });
        return promise;
      };
      state.timer = setInterval(() => {
        if (state.closed || state.polling || !state.target) return;
        if (!state.source()) { state.close(); return; }
        state.polling = true;
        state.queue = state.queue.then(() => state.closed ? null : state.applySenders(state.target)).catch(() => {}).finally(() => { state.polling = false; });
      }, 1000);
      window.addEventListener('pagehide', state.close, { once: true });
      window.__dischordScreenQualityV1 = state;
    }
    const run = async (operation = config.operation) => {
      if (state.closed) throw new Error('Screen sharing has ended.');
      const source = state.source();
      if (!source || !s.screenShareState) {
        reply({ ok: false, active: false, needsRestart: false, error: 'Screen sharing is not active.' });
        return;
      }
      if (operation === 'prepareRestart') {
        if (state.armed) clearTimeout(state.armed.timer);
        const armed = { requestId: config.requestId, run: () => run('restart'),
          fail: (error) => reply({ ok: false, active: !!state.source(), needsRestart: false, error: error && error.message || 'The screen restart could not start.' }) };
        armed.timer = setTimeout(() => {
          if (state.armed !== armed) return;
          state.armed = null;
          reply({ ok: false, active: !!state.source(), needsRestart: false, error: 'The screen restart expired. Change the quality again to retry.' });
        }, 15000);
        state.armed = armed;
        reply({ ok: true, mode: 'prepared', prepared: true, active: true });
        return;
      }
      if (state.armed) { clearTimeout(state.armed.timer); state.armed = null; }
      const target = {
        ssQ: ['source', '2160', '1440', '1080', '720'].includes(String(config.ssQ)) ? String(config.ssQ) : '1080',
        ssFps: Math.max(1, Math.min(60, Number(config.ssFps) || 60)),
        ssBr: Math.max(300, Math.min(40000, Math.round(Number(config.ssBr) || 12000))),
        ssHint: config.ssHint === 'detail' ? 'detail' : 'motion'
      };
      const oldFields = Object.fromEntries(state.fields.map((name) => [name, s[name]]));
      const oldTarget = state.target || {
        ssQ: ({ '-1': 'source', '-2': '2160', '-3': '1440', '0': '1080', '1': '720' })[String(s.screensharequality !== false && s.screensharequality !== undefined ? s.screensharequality : s.quality)] || '1080',
        ssFps: Number(s.screensharefps) || Number(s.maxframeRate) || 60,
        ssBr: Number(s.outboundVideoBitrate) || Number(s.maxvideobitrate) || 12000,
        ssHint: (s.screenshareContentHint || s.contentHint) === 'detail' ? 'detail' : 'motion'
      };
      let oldConstraints = {};
      try { oldConstraints = source.getConstraints(); } catch (_) { }
      let current = source, replacement = null;
      const replacements = [];
      const replacementStreams = [];
      const transaction = { senders: new Map(), hints: new Map([[source, source.contentHint]]) };
      // Snapshot before replacing any tracks or setting contentHint. Sender
      // snapshots store values only; rollback reads fresh transaction IDs.
      for (const { pc } of state.connections()) {
        for (const sender of pc.getSenders()) {
          if (sender.track && sender.track.kind === 'video') state.snapshotSender(sender, transaction);
        }
      }
      state.previousBitrate = oldTarget ? oldTarget.ssBr : Number(oldFields.outboundVideoBitrate) || Number(oldFields.maxvideobitrate);
      state.setDefaults(target);
      try {
        if (operation === 'restart') {
          // Only the native desktop host invokes this operation after arming a
          // one-use reuse of the selected source. Ordinary browser updates stay
          // on their existing capture; a web page cannot bypass capture consent.
          if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') throw new Error('The selected screen cannot be captured again here.');
          const constraints = state.constraints(target);
          // getDisplayMedia forbids max/min capture dimensions. Apply the strict
          // limits after the native host returns the same selected source.
          const video = { frameRate: { ideal: target.ssFps }, bitrate: target.ssBr, contentHint: target.ssHint };
          if (constraints.width && constraints.width.ideal) video.width = { ideal: constraints.width.ideal };
          if (constraints.height && constraints.height.ideal) video.height = { ideal: constraints.height.ideal };
          replacement = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
          current = replacement.getVideoTracks().find((track) => track.readyState === 'live');
          if (!current) throw new Error('The previous screen or window is no longer available.');
          try { await current.applyConstraints(constraints); } catch (_) { /* Sender limits can still control a new native capture. */ }
          current.contentHint = target.ssHint;
          if (source.readyState !== 'live' || state.closed) throw new Error('Screen sharing has ended.');
          // Replace first and retain the old capture until every sender accepts
          // the replacement. Failure rolls all changed senders back to it.
          for (const { pc } of state.connections()) {
            for (const sender of pc.getSenders()) {
              if (!sender.track || sender.track.kind !== 'video') continue;
              const old = sender.track;
              await sender.replaceTrack(current);
              replacements.push({ sender, old });
            }
          }
          const seen = new Set();
          for (const stream of [s.streamSrc, s.streamSrcClone, s.videoElement && s.videoElement.srcObject]) {
            if (!stream || seen.has(stream) || typeof stream.getVideoTracks !== 'function') continue;
            seen.add(stream);
            const old = stream.getVideoTracks();
            old.forEach((track) => stream.removeTrack(track));
            stream.addTrack(current);
            replacementStreams.push({ stream, old });
          }
          current.onended = source.onended;
        } else {
          try { await source.applyConstraints(state.constraints(target)); }
          catch (error) {
            // A lower encode resolution/FPS does not need a new capture. Increasing
            // beyond a capped source does; leave it alive for a native restart.
            const settings = source.getSettings ? source.getSettings() : {};
            const capabilities = source.getCapabilities ? source.getCapabilities() : {};
            const constraints = state.constraints(target);
            const wantsWidth = constraints.width && constraints.width.ideal || Number(capabilities.width && capabilities.width.max) || Number(settings.width);
            const wantsHeight = constraints.height && constraints.height.ideal || Number(capabilities.height && capabilities.height.max) || Number(settings.height);
            const roomToGrow = Number(capabilities.width && capabilities.width.max) > Number(settings.width) || Number(capabilities.height && capabilities.height.max) > Number(settings.height);
            if ((roomToGrow && (wantsWidth > Number(settings.width) || wantsHeight > Number(settings.height))) ||
              (Number(settings.frameRate) < target.ssFps && Number(capabilities.frameRate && capabilities.frameRate.max) > Number(settings.frameRate))) throw error;
          }
          source.contentHint = target.ssHint;
        }
        const result = await state.applySenders(target, true, transaction);
        if (result.failures.length) throw result.failures[0];
        // Update VDO's remembered negotiated cap too, so later viewer requests
        // and new connections do not restore the initial URL's old ceiling.
        for (const { pc } of state.connections()) {
          if (pc.setBitrate !== false && pc.setBitrate !== undefined) pc.setBitrate = target.ssBr;
          if (pc.savedBitrate === state.previousBitrate) pc.savedBitrate = target.ssBr;
        }
        state.target = target;
        if (replacement) {
          // stop() never emits ended in browser WebRTC, but Android's wrapper
          // does. Detach VDO's ended callback before releasing the old capture.
          const oldTracks = new Set([source, ...replacementStreams.flatMap((entry) => entry.old), ...replacements.map((entry) => entry.old)]);
          oldTracks.delete(current);
          for (const track of oldTracks) {
            try { track.onended = null; track.stop(); } catch (_) { }
          }
        }
        let actual = {};
        try { const settings = current.getSettings(); actual = { width: settings.width, height: settings.height, frameRate: settings.frameRate, displaySurface: settings.displaySurface }; } catch (_) { }
        reply({ ok: true, active: true, mode: replacement ? 'restart' : 'hot', settings: target, actual, senders: result.count });
      } catch (error) {
        for (const entry of replacementStreams.reverse()) {
          try { entry.stream.removeTrack(current); entry.old.forEach((track) => entry.stream.addTrack(track)); } catch (_) { }
        }
        for (const entry of replacements.reverse()) {
          try { await entry.sender.replaceTrack(entry.old); } catch (_) { }
        }
        if (replacement) replacement.getTracks().forEach((track) => { try { track.onended = null; track.stop(); } catch (_) { } });
        Object.assign(s, oldFields);
        if (source.readyState === 'live') {
          try { await source.applyConstraints(oldConstraints); } catch (_) { }
        }
        for (const [track, hint] of transaction.hints) { try { track.contentHint = hint; } catch (_) { } }
        for (const [sender, snapshot] of transaction.senders) {
          try {
            if (snapshot.parameters) {
              const fresh = sender.getParameters();
              const saved = snapshot.parameters;
              if (fresh.encodings && saved.encodings && fresh.encodings.length === saved.encodings.length) {
                fresh.encodings.forEach((encoding, index) => {
                  for (const field of ['maxBitrate', 'maxFramerate', 'scaleResolutionDownBy']) {
                    if (Object.prototype.hasOwnProperty.call(saved.encodings[index], field)) encoding[field] = saved.encodings[index][field];
                    else delete encoding[field];
                  }
                });
                if (Object.prototype.hasOwnProperty.call(saved, 'degradationPreference')) fresh.degradationPreference = saved.degradationPreference;
                else delete fresh.degradationPreference;
                await sender.setParameters(fresh);
              }
            }
          } catch (_) { }
          if (snapshot.record) state.senders.set(sender, snapshot.record);
          else state.senders.delete(sender);
        }
        reply({ ok: false, active: source.readyState === 'live' && !state.closed, needsRestart: operation !== 'restart' && source.readyState === 'live',
          error: error && error.message || 'The stream quality could not be changed.', settings: oldTarget || undefined });
      }
    };
    state.queue = state.queue.then(() => run()).catch((error) => reply({ ok: false, active: !!state.source(), needsRestart: false, error: error && error.message || 'Screen sharing has ended.' }));
  }

  window.DischordScreenQuality = Object.freeze({ bridge });
})();
