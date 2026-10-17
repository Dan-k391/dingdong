/* 叮咚 file offers: metadata travels with chat; bytes travel only after Download.
 * No file contents are persisted, previewed, broadcast, or fetched for history sync.
 * The sender retains the selected File reference until its message/server is removed
 * or the tab closes. Small/medium downloads use RAM; large downloads can stream
 * bounded batches to a destination chosen by the recipient after Download.
 * Cancellation, timeout, and errors release queued bytes and abort open sinks.
 */
(() => {
  'use strict';

  const CHUNK_BYTES = 12 * 1024;
  const MAX_WINDOW = 128;
  const TIMEOUT_MS = 15000;
  const MAX_SENDERS = 3;
  const MAX_RECEIVERS = 1;
  const MAX_OFFERS = 100;
  const MAX_STATES = 500;
  const ID = /^[a-z0-9]{1,64}$/i;
  const TOKEN = /^[a-z0-9_-]{1,96}$/i;
  const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

  function strategyFor(size) {
    if (size < 1024 * 1024) return { name: 'small', initialWindow: 8, maxWindow: 8, stream: false, ackEvery: 1 };
    if (size < 100 * 1024 * 1024) return { name: 'medium', initialWindow: 32, maxWindow: 32, stream: false, ackEvery: 4 };
    return { name: 'large', initialWindow: 32, maxWindow: MAX_WINDOW, stream: true, ackEvery: 8 };
  }

  function cleanMeta(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID.test(raw.id) ||
        !Number.isSafeInteger(raw.size) || raw.size < 0 ||
        typeof raw.name !== 'string' || !raw.name.trim()) return null;
    let name = raw.name.replace(/[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069:*?"<>|]/g, '_')
      .trim().slice(0, 255).replace(/[ .]+$/, '');
    if (!name || name === '.' || name === '..') return null;
    // Windows reserves these names even when they have extensions.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name.slice(0, 254);
    const type = typeof raw.type === 'string' && raw.type.length <= 127 && MIME.test(raw.type) ? raw.type : '';
    return { id: raw.id, name, size: raw.size, type };
  }

  function formatSize(n) {
    if (!Number.isFinite(n) || n < 0) return 'Unknown size';
    if (n < 1024) return n + (n === 1 ? ' byte' : ' bytes');
    const units = ['KB', 'MB', 'GB'];
    let value = n / 1024, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[index];
  }

  /**
   * Context: send(sid, payload, uuid), getMessage(sid, cid, mid),
   * resolvePeer(sid, userId, cid, mid) -> connected UUID or null, userId(), randomId(),
   * optional isPeer(sid, userId, uuid) -> true for that exact live connection,
   * onChange(sid, cid, mid), saveDownload(blob, safeName), optional maxWindow().
   * Optional openDownload(meta, strategy) is called synchronously from Download
   * for large remote files. Its promise returns a {write,close,abort} sink or null
   * when disk streaming is unsupported. Rejection cancels without requesting bytes.
   * register(sid,cid,mid,meta,file) retains a File/Blob without reading it.
   * download/cancel/status/release/hasLocal use (sid,cid,mid).
   * onPacket(sid,payload,uuid,senderUid) requires the app's validated sender identity.
   * status states: idle, preparing, receiving, saving, complete, error.
   */
  function create(context) {
    const offers = new Map(), receivers = new Map(), senders = new Map(), states = new Map();
    let closed = false, sequence = 0;
    const keyOf = (sid, cid, mid) => JSON.stringify([sid, cid, mid]);
    const senderKey = (sid, p, uuid) => JSON.stringify([sid, p.cid, p.mid, p.fid, p.token, uuid]);
    const validPeer = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/.test(v);
    const validLocation = (sid, cid, mid) => typeof sid === 'string' && ID.test(sid) &&
      typeof cid === 'string' && ID.test(cid) && typeof mid === 'string' && mid.length > 0 && mid.length <= 64;
    const validPacket = (sid, p, uuid, uid) => p && typeof p === 'object' &&
      validLocation(sid, p.cid, p.mid) && typeof p.fid === 'string' && ID.test(p.fid) &&
      typeof p.token === 'string' && TOKEN.test(p.token) && validPeer(uuid) && typeof uid === 'string' && ID.test(uid);
    const sameMeta = (a, b) => a && b && a.id === b.id && a.size === b.size && a.name === b.name && a.type === b.type;

    function messageFor(sid, cid, mid) {
      const m = context.getMessage(sid, cid, mid);
      if (!m || m.del || !m.a || typeof m.a.id !== 'string') return null;
      const meta = cleanMeta(m.file);
      return meta ? { author: m.a.id, meta } : null;
    }

    function change(sid, cid, mid, state, progress = 0, message = '') {
      const k = keyOf(sid, cid, mid);
      const previous = states.get(k);
      if (state === 'receiving' && previous && previous.state === state &&
          previous.progress === progress && previous.message === message) return;
      states.delete(k);
      states.set(k, { state, progress, message });
      // Status is disposable UI state; it must not grow with indefinite chat history.
      if (states.size > MAX_STATES) {
        for (const old of states.keys()) {
          if (!receivers.has(old)) { states.delete(old); break; }
        }
      }
      if (typeof context.onChange === 'function') context.onChange(sid, cid, mid);
    }

    function sendPacket(sid, p, uuid) {
      if (closed || !validPeer(uuid)) return false;
      try { return context.send(sid, p, uuid) !== false; } catch { return false; }
    }

    const envelope = (t, type, extra = {}) => ({ t: type, cid: t.cid, mid: t.mid, fid: t.meta.id, token: t.token, ...extra });
    // ---- fast path: when both sides have it (context.fast), the bytes travel over a dedicated binary data
    // channel instead of base64 chat packets. The packets still carry consent, errors and cancellation,
    // and remain the fallback: after any fast failure this tab goes back to them.
    const FAST_MIN = 256 * 1024;
    let fastBroken = false;
    const fastOk = (sid, uuid, size) => !fastBroken && size >= FAST_MIN && !!context.fast &&
      typeof context.fast.ready === 'function' && context.fast.ready(sid, uuid) === true;
    function stopFast(t) {
      const fast = t.fast;
      t.fast = null;
      if (fast) try { fast.stop(); } catch {}
    }

    function stopSender(t) {
      stopFast(t);
      clearTimeout(t.timer);
      if (senders.get(t.key) === t) senders.delete(t.key);
      t.file = null;
      t.sentAt.clear();
    }

    function abortSink(sink) {
      if (!sink || typeof sink.abort !== 'function') return;
      try { Promise.resolve(sink.abort()).catch(() => {}); } catch {}
    }

    function stopReceiver(t, state, message, tellPeer) {
      if (receivers.get(t.key) !== t) return;
      stopFast(t);
      clearTimeout(t.timer);
      receivers.delete(t.key);
      t.parts.length = 0;
      t.queue.length = 0;
      const sink = t.sink;
      t.sink = null;
      if (state !== 'complete') abortSink(sink);
      if (tellPeer && t.started) sendPacket(t.sid, envelope(t, 'f-cancel'), t.uuid);
      change(t.sid, t.cid, t.mid, state, state === 'complete' ? 100 : 0, message);
    }

    function aliveReceiver(t) {
      if (closed || receivers.get(t.key) !== t) return false;
      const message = messageFor(t.sid, t.cid, t.mid);
      if (!message || message.author !== t.uid || !sameMeta(message.meta, t.meta)) return false;
      const connected = typeof context.isPeer === 'function' ? context.isPeer(t.sid, t.uid, t.uuid) :
        context.resolvePeer(t.sid, t.uid, t.cid, t.mid) === t.uuid;
      return !!connected;
    }

    function aliveSender(t) {
      if (closed || senders.get(t.key) !== t || !t.file) return false;
      const message = messageFor(t.sid, t.cid, t.mid);
      const offer = offers.get(t.offerKey);
      const connected = typeof context.isPeer === 'function' ? context.isPeer(t.sid, t.uid, t.uuid) :
        context.resolvePeer(t.sid, t.uid) === t.uuid;
      return message && message.author === context.userId() && sameMeta(message.meta, t.meta) &&
        offer && offer.file === t.file && sameMeta(offer.meta, t.meta) && connected;
    }

    function armSender(t) {
      clearTimeout(t.timer);
      t.timer = setTimeout(() => {
        if (senders.get(t.key) !== t) return;
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'File transfer timed out. Try Download again.' }), t.uuid);
        stopSender(t);
      }, TIMEOUT_MS);
    }

    function armReceiver(t) {
      clearTimeout(t.timer);
      t.timer = setTimeout(() => stopReceiver(t, 'error', 'Download timed out. The sender may have disconnected.', true), TIMEOUT_MS);
    }

    function encode(bytes) {
      // Fixed 12 KiB chunks stay comfortably below browser argument-count limits.
      return btoa(String.fromCharCode.apply(null, bytes));
    }

    function mediaWindow(maximum) {
      try {
        const limit = typeof context.maxWindow === 'function' ? context.maxWindow() : maximum;
        return Number.isSafeInteger(limit) && limit > 0 ? Math.min(maximum, limit) : maximum;
      } catch { return maximum; }
    }

    function sendWindow(t) {
      // A full ACK batch must fit even if media activity lowers the window mid-transfer.
      return Math.max(t.ackEvery, Math.min(t.window, mediaWindow(t.maxWindow), t.peerWindow));
    }

    function acknowledgeSender(t, index) {
      const progress = index - t.acked;
      const sent = t.sentAt.get(index);
      t.acked = index;
      for (const i of t.sentAt.keys()) if (i <= index) t.sentAt.delete(i);
      if (!t.adaptive || sent === undefined) return;
      const sample = Math.max(0, Date.now() - sent);
      t.rtt = t.rtt === null ? sample : t.rtt * 0.875 + sample * 0.125;
      t.baseline = t.baseline === null ? t.rtt : Math.min(t.baseline, t.rtt);
      if (sample > t.baseline * 2 + 100) {
        t.window = Math.max(16, Math.floor(t.window / 2));
        t.growth = 0;
      } else if (t.rtt <= t.baseline * 2 + 100) {
        t.growth += progress;
        const window = sendWindow(t);
        if (t.growth >= window) {
          t.growth -= window;
          t.window = Math.min(t.maxWindow, t.window + 8);
        }
      }
    }

    async function pump(t) {
      // Keep one read in flight while filling a bounded window of unacknowledged chunks.
      if (t.pumping) return;
      if (!aliveSender(t)) { stopSender(t); return; }
      t.pumping = true;
      try {
        while (t.next < t.count && t.next - t.acked - 1 < sendWindow(t)) {
          if (!aliveSender(t)) { stopSender(t); return; }
          const index = t.next;
          const start = index * CHUNK_BYTES;
          const end = Math.min(start + CHUNK_BYTES, t.meta.size);
          const buffer = await t.file.slice(start, end).arrayBuffer();
          // Deletion, cancellation and disconnect can all happen while reading.
          if (!aliveSender(t) || t.next !== index) { stopSender(t); return; }
          const bytes = new Uint8Array(buffer);
          if (bytes.length !== end - start) throw new Error('Invalid file read.');
          const data = encode(bytes);
          // Mark it sent first so even a synchronous ACK cannot reserve this index twice.
          t.next++;
          t.sentAt.set(index, Date.now());
          if (!sendPacket(t.sid, envelope(t, 'f-chunk', { index, data, ackEvery: t.ackEvery }), t.uuid)) {
            stopSender(t);
            return;
          }
          if (senders.get(t.key) !== t) return;
        }
      } catch {
        if (senders.get(t.key) !== t) return;
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'The sender could not read this file.' }), t.uuid);
        stopSender(t);
      } finally {
        t.pumping = false;
      }
    }

    function register(sid, cid, mid, rawMeta, file) {
      const meta = cleanMeta(rawMeta);
      if (closed || !validLocation(sid, cid, mid) || !meta || !file ||
          file.size !== meta.size || typeof file.slice !== 'function') return false;
      const k = keyOf(sid, cid, mid);
      if (!offers.has(k) && offers.size >= MAX_OFFERS) return false;
      // Changing an existing offer invalidates any pending requests for it.
      if (offers.has(k)) release(sid, cid, mid);
      offers.set(k, { sid, cid, mid, meta, file });
      return true;
    }

    function beginReceiver(t, sink) {
      if (!aliveReceiver(t)) {
        abortSink(sink);
        stopReceiver(t, 'error', 'This file is no longer available or the sender disconnected.', false);
        return false;
      }
      t.sink = sink;
      t.ready = true;
      change(t.sid, t.cid, t.mid, 'receiving', 0);
      if (receivers.get(t.key) !== t) return false;
      armReceiver(t);
      t.started = true;
      const strategy = t.strategy;
      const window = mediaWindow(strategy.maxWindow);
      const fast = fastOk(t.sid, t.uuid, t.meta.size) && startFastReceiver(t);
      if (!sendPacket(t.sid, envelope(t, 'f-request', {
        window, initialWindow: Math.min(window, strategy.initialWindow),
        adaptive: strategy.name === 'large', ackEvery: strategy.ackEvery, ...(fast ? { fast: 1 } : {}),
      }), t.uuid)) {
        stopReceiver(t, 'error', 'Unable to contact the sender.', false);
        return false;
      }
      return true;
    }

    // The receiving end of the fast channel is opened before asking, so nothing the sender sends is missed.
    function startFastReceiver(t) {
      let chain = Promise.resolve();
      try {
        t.fast = context.fast.receive(t.sid, t.uuid, t.token, t.meta.size, {
          data: (bytes) => { chain = chain.then(() => acceptFast(t, bytes)); },
          error: () => {
            if (receivers.get(t.key) !== t || t.committing) return;
            fastBroken = true;
            stopReceiver(t, 'error', 'Download interrupted. Try Download again.', true);
          },
        }) || null;
      } catch { t.fast = null; }
      return !!t.fast;
    }

    async function acceptFast(t, bytes) {
      // An older sender ignores the fast request and sends ordinary chunks; whichever arrives first is used.
      if (receivers.get(t.key) !== t || !t.fast || t.committing || t.index > 0) return;
      if (!(bytes instanceof Uint8Array) || !bytes.length || t.bytes + bytes.length > t.meta.size) {
        stopReceiver(t, 'error', 'File transfer failed.', true);
        return;
      }
      if (!aliveReceiver(t)) {
        stopReceiver(t, 'error', 'This file was removed or the sender disconnected.', true);
        return;
      }
      t.fastUsed = true;
      try {
        if (t.sink) await t.sink.write(bytes); else t.parts.push(bytes);
      } catch {
        stopReceiver(t, 'error', 'The browser could not write or save this file.', true);
        return;
      }
      if (receivers.get(t.key) !== t || !t.fast) return;
      t.bytes += bytes.length;
      t.acceptedBytes = t.bytes;
      armReceiver(t);
      t.fast.credit(t.bytes); // lets the sender release more, and tells it when everything has arrived
      if (t.bytes < t.meta.size) {
        change(t.sid, t.cid, t.mid, 'receiving', Math.floor(t.bytes / t.meta.size * 100));
        return;
      }
      t.committing = true;
      clearTimeout(t.timer);
      try {
        if (t.sink) {
          change(t.sid, t.cid, t.mid, 'saving', 100, 'Saving file…');
          if (receivers.get(t.key) !== t) return;
          await t.sink.close();
          if (closed || receivers.get(t.key) !== t) return;
          t.sink = null;
          stopReceiver(t, 'complete', 'File saved to your chosen location.', false);
        } else {
          const blob = new Blob(t.parts, { type: t.meta.type || 'application/octet-stream' });
          if (blob.size !== t.meta.size) throw new Error('Incomplete file.');
          stopReceiver(t, 'complete', '', false);
          context.saveDownload(blob, t.meta.name, { sid: t.sid, cid: t.cid, mid: t.mid });
        }
      } catch {
        stopReceiver(t, 'error', 'The browser could not save this file.', true);
        change(t.sid, t.cid, t.mid, 'error', 0, 'The browser could not save this file.');
      }
    }

    function prepareReceiver(t) {
      change(t.sid, t.cid, t.mid, 'preparing', 0, 'Choose where to save this file.');
      if (receivers.get(t.key) !== t) return false;
      let opening;
      try {
        // Invoke the picker before yielding so the browser retains the Download click gesture.
        opening = context.openDownload({ ...t.meta }, { ...t.strategy }, { sid: t.sid, cid: t.cid, mid: t.mid });
      } catch (error) {
        stopReceiver(t, 'error', error && error.name === 'AbortError' ? 'Download cancelled.' : 'The browser could not open this destination.', false);
        return false;
      }
      Promise.resolve(opening).then((sink) => {
        if (receivers.get(t.key) !== t || closed) { abortSink(sink); return; }
        if (sink !== null && (!sink || typeof sink.write !== 'function' ||
            typeof sink.close !== 'function' || typeof sink.abort !== 'function')) {
          abortSink(sink);
          stopReceiver(t, 'error', 'The browser could not open this destination.', false);
          return;
        }
        beginReceiver(t, sink);
      }, (error) => {
        stopReceiver(t, 'error', error && error.name === 'AbortError' ? 'Download cancelled.' : 'The browser could not open this destination.', false);
      });
      return true;
    }

    function download(sid, cid, mid) {
      if (closed || !validLocation(sid, cid, mid)) return false;
      const k = keyOf(sid, cid, mid), message = messageFor(sid, cid, mid);
      if (!message) { change(sid, cid, mid, 'error', 0, 'This file is no longer available.'); return false; }
      if (receivers.has(k)) return false;
      if (message.author === context.userId()) {
        const offer = offers.get(k);
        if (!offer || !sameMeta(offer.meta, message.meta)) {
          change(sid, cid, mid, 'error', 0, 'This file is no longer available. Select and send it again.');
          return false;
        }
        try {
          // The owner also explicitly chooses Download; no file read is needed.
          context.saveDownload(offer.file, offer.meta.name, { sid, cid, mid });
          change(sid, cid, mid, 'complete', 100);
          return true;
        } catch {
          change(sid, cid, mid, 'error', 0, 'The browser could not save this file.');
          return false;
        }
      }
      if (receivers.size >= MAX_RECEIVERS) {
        change(sid, cid, mid, 'error', 0, 'Another download is in progress. Finish or cancel it first.');
        return false;
      }
      const uuid = context.resolvePeer(sid, message.author, cid, mid);
      if (!validPeer(uuid)) {
        change(sid, cid, mid, 'error', 0, 'The sender is offline. They need to keep this tab open.');
        return false;
      }
      const random = context.randomId();
      const token = String(random) + '_' + (++sequence).toString(36);
      if (!TOKEN.test(token)) { change(sid, cid, mid, 'error', 0, 'Unable to start this download.'); return false; }
      const t = { sid, cid, mid, key: k, meta: message.meta, token, uuid, uid: message.author,
        strategy: strategyFor(message.meta.size), index: 0, acceptedBytes: 0, bytes: 0,
        parts: [], queue: [], sink: null, writing: false, ready: false, started: false,
        committing: false, lastAck: -1, timer: null };
      receivers.set(k, t);
      return t.strategy.stream && typeof context.openDownload === 'function' ? prepareReceiver(t) : beginReceiver(t, null);
    }

    function onRequest(sid, p, uuid, uid) {
      const connected = typeof context.isPeer === 'function' ? context.isPeer(sid, uid, uuid) :
        context.resolvePeer(sid, uid) === uuid;
      if (uid === context.userId() || !connected) return;
      const key = senderKey(sid, p, uuid);
      if (senders.has(key)) return; // A repeated request cannot bypass ACK backpressure.
      const k = keyOf(sid, p.cid, p.mid), offer = offers.get(k), message = messageFor(sid, p.cid, p.mid);
      if (!message || message.author !== context.userId() || p.fid !== message.meta.id) return;
      const error = (text) => sendPacket(sid, {
        t: 'f-error', cid: p.cid, mid: p.mid, fid: p.fid, token: p.token, message: text,
      }, uuid);
      if (!offer || p.fid !== offer.meta.id || !sameMeta(offer.meta, message.meta)) {
        error('File unavailable. The sender needs to keep the original tab open.');
        return;
      }
      if (senders.size >= MAX_SENDERS) { error('The sender is busy. Try Download again shortly.'); return; }
      const strategy = strategyFor(offer.meta.size);
      // Older receivers request no window and retain their one-chunk pacing.
      const maximum = Number.isSafeInteger(p.window) && p.window >= 1 ? Math.min(p.window, MAX_WINDOW, strategy.maxWindow) : 1;
      const adaptive = p.adaptive === true && strategy.name === 'large' && maximum >= 16;
      const initial = Number.isSafeInteger(p.initialWindow) && p.initialWindow >= 1 ? p.initialWindow : strategy.initialWindow;
      const window = adaptive ? Math.min(maximum, Math.max(16, initial)) : maximum;
      const ackEvery = Number.isSafeInteger(p.ackEvery) && p.ackEvery >= 1 && p.ackEvery <= 8 ?
        Math.min(p.ackEvery, strategy.ackEvery, window, mediaWindow(maximum)) : 1;
      const t = { sid, cid: p.cid, mid: p.mid, key, offerKey: k, meta: offer.meta, file: offer.file,
        token: p.token, uuid, uid, next: 0, acked: -1, window, maxWindow: maximum, adaptive,
        peerWindow: maximum, ackEvery, sentAt: new Map(), rtt: null, baseline: null, growth: 0, pumping: false,
        count: Math.max(1, Math.ceil(offer.meta.size / CHUNK_BYTES)), timer: null };
      senders.set(key, t);
      // Only acknowledged progress extends this deadline; reads and queued sends do not.
      armSender(t);
      if (p.fast === 1 && fastOk(sid, uuid, offer.meta.size)) {
        try {
          t.fast = context.fast.send(sid, uuid, p.token, offer.file, {
            progress: () => { if (senders.get(t.key) === t) armSender(t); },
            done: () => { if (senders.get(t.key) === t) stopSender(t); },
            error: () => {
              if (senders.get(t.key) !== t) return;
              fastBroken = true;
              sendPacket(t.sid, envelope(t, 'f-error', { message: 'File transfer was interrupted. Try Download again.' }), t.uuid);
              stopSender(t);
            },
          }) || null;
        } catch { t.fast = null; }
        if (t.fast) return;
      }
      void pump(t);
    }

    function ackReceiver(t, index, every, final) {
      if (!final && index - t.lastAck < every) return true;
      t.lastAck = index;
      if (sendPacket(t.sid, envelope(t, 'f-ack', { index, window: mediaWindow(MAX_WINDOW) }), t.uuid)) return true;
      stopReceiver(t, 'error', 'Unable to contact the sender.', false);
      return false;
    }

    async function drainReceiver(t) {
      if (t.writing || !t.queue.length) return;
      t.writing = true;
      try {
        while (t.queue.length) {
          if (!aliveReceiver(t)) {
            stopReceiver(t, 'error', 'This file was removed or the sender disconnected.', true);
            return;
          }
          const every = t.queue[0].ackEvery;
          // Disk writes amortize IPC across an ACK batch, without timers or whole-file buffering.
          if (t.queue.length < every && t.acceptedBytes !== t.meta.size) return;
          const batch = t.queue.slice(0, Math.min(every, t.queue.length));
          const length = batch.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
          const bytes = batch.length === 1 ? batch[0].bytes : new Uint8Array(length);
          if (batch.length > 1) {
            let offset = 0;
            for (const chunk of batch) { bytes.set(chunk.bytes, offset); offset += chunk.bytes.length; }
          }
          await t.sink.write(bytes);
          // Consent, the message, or the peer can disappear while disk I/O is pending.
          if (!aliveReceiver(t)) {
            stopReceiver(t, 'error', 'This file was removed or the sender disconnected.', true);
            return;
          }
          t.queue.splice(0, batch.length);
          t.bytes += length;
          armReceiver(t);
          const final = t.bytes === t.meta.size;
          if (final) t.committing = true;
          if (!ackReceiver(t, batch[batch.length - 1].index, every, final) || receivers.get(t.key) !== t) return;
          if (final) {
            // Closing commits the destination; network inactivity no longer applies.
            clearTimeout(t.timer);
            change(t.sid, t.cid, t.mid, 'saving', 100, 'Saving file…');
            if (receivers.get(t.key) !== t) return;
            await t.sink.close();
            // The sender may leave after the final ACK; committed bytes no longer need its connection.
            if (closed || receivers.get(t.key) !== t) return;
            t.sink = null;
            stopReceiver(t, 'complete', 'File saved to your chosen location.', false);
            return;
          }
          change(t.sid, t.cid, t.mid, 'receiving', Math.floor(t.bytes / t.meta.size * 100));
        }
      } catch {
        stopReceiver(t, 'error', 'The browser could not write or save this file.', true);
      } finally {
        t.writing = false;
      }
    }

    function onChunk(sid, p, uuid, uid) {
      const t = receivers.get(keyOf(sid, p.cid, p.mid));
      if (!t || t.fastUsed || !t.ready || t.uuid !== uuid || t.uid !== uid || t.token !== p.token || t.meta.id !== p.fid ||
          !Number.isSafeInteger(p.index) || p.index !== t.index ||
          p.index >= Math.max(1, Math.ceil(t.meta.size / CHUNK_BYTES)) || typeof p.data !== 'string') return;
      if (!aliveReceiver(t)) {
        stopReceiver(t, 'error', 'This file was removed or the sender disconnected.', true);
        return;
      }
      if (t.sink && t.queue.length >= MAX_WINDOW) return;
      const expected = Math.min(CHUNK_BYTES, t.meta.size - t.acceptedBytes);
      const length = Math.ceil(expected / 3) * 4;
      if (p.data.length !== length || (length && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data))) return;
      let bytes;
      try {
        const binary = atob(p.data);
        // Canonical base64 and the exact expected size prevent ambiguous chunks.
        if (binary.length !== expected || btoa(binary) !== p.data) return;
        bytes = new Uint8Array(expected);
        for (let i = 0; i < expected; i++) bytes[i] = binary.charCodeAt(i);
      } catch { return; }
      const every = Number.isSafeInteger(p.ackEvery) && p.ackEvery >= 1 && p.ackEvery <= 8 ? p.ackEvery : 1;
      t.acceptedBytes += bytes.length;
      t.index++;
      if (t.sink) {
        t.queue.push({ index: p.index, bytes, ackEvery: every });
        void drainReceiver(t);
        return;
      }
      t.parts.push(bytes);
      t.bytes += bytes.length;
      armReceiver(t);
      if (!ackReceiver(t, p.index, every, t.bytes === t.meta.size)) return;
      // A synchronous transport callback can cancel this consent while acknowledging.
      if (receivers.get(t.key) !== t) return;
      if (t.bytes === t.meta.size) {
        try {
          const blob = new Blob(t.parts, { type: t.meta.type || 'application/octet-stream' });
          if (blob.size !== t.meta.size) throw new Error('Incomplete file.');
          // Only this explicit, authenticated download reaches the browser saver.
          stopReceiver(t, 'complete', '', false);
          context.saveDownload(blob, t.meta.name, { sid: t.sid, cid: t.cid, mid: t.mid });
        } catch {
          // stopReceiver may already have released the transfer before the saver throws.
          stopReceiver(t, 'error', 'The browser could not save this file.', true);
          change(t.sid, t.cid, t.mid, 'error', 0, 'The browser could not save this file.');
        }
      } else {
        change(sid, t.cid, t.mid, 'receiving', Math.floor(t.bytes / t.meta.size * 100));
      }
    }

    function onPacket(sid, p, uuid, senderUid) {
      if (!p || !['f-request', 'f-chunk', 'f-ack', 'f-error', 'f-cancel'].includes(p.t)) return false;
      if (closed || !validPacket(sid, p, uuid, senderUid)) return true;
      if (p.t === 'f-request') { onRequest(sid, p, uuid, senderUid); return true; }
      if (p.t === 'f-chunk') { onChunk(sid, p, uuid, senderUid); return true; }
      const t = senders.get(senderKey(sid, p, uuid));
      if (t && t.uid === senderUid) {
        if (p.t === 'f-cancel' || p.t === 'f-error') stopSender(t);
        else if (p.t === 'f-ack' && Number.isSafeInteger(p.index) && p.index > t.acked && p.index < t.next) {
          // Ordered receivers make ACKs cumulative. Duplicates and unsent indices add no capacity.
          if (Number.isSafeInteger(p.window) && p.window >= 1) t.peerWindow = Math.min(p.window, t.maxWindow);
          acknowledgeSender(t, p.index);
          if (t.acked + 1 >= t.count) stopSender(t);
          else {
            armSender(t);
            void pump(t);
          }
        }
      }
      if (p.t === 'f-error' || p.t === 'f-cancel') {
        const r = receivers.get(keyOf(sid, p.cid, p.mid));
        if (r && !r.committing && r.uid === senderUid && r.uuid === uuid && r.token === p.token && r.meta.id === p.fid) {
          const text = p.t === 'f-cancel' ? 'The sender cancelled this transfer.' :
            (typeof p.message === 'string' && p.message.length <= 200 ? p.message : 'File transfer failed.');
          stopReceiver(r, 'error', text, false);
        }
      }
      return true;
    }

    function cancel(sid, cid, mid) {
      const t = receivers.get(keyOf(sid, cid, mid));
      if (!t) return false;
      stopReceiver(t, 'error', 'Download cancelled.', true);
      return true;
    }

    function release(sid, cid, mid) {
      const k = keyOf(sid, cid, mid);
      cancel(sid, cid, mid);
      for (const t of [...senders.values()]) if (t.offerKey === k) {
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'This file is no longer available.' }), t.uuid);
        stopSender(t);
      }
      offers.delete(k);
      states.delete(k);
    }

    function closeServer(sid) {
      for (const r of [...receivers.values()]) if (r.sid === sid) stopReceiver(r, 'error', 'Disconnected from the server.', true);
      for (const t of [...senders.values()]) if (t.sid === sid) {
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'The sender disconnected.' }), t.uuid);
        stopSender(t);
      }
      for (const [k, o] of offers) if (o.sid === sid) offers.delete(k);
      for (const k of states.keys()) if (JSON.parse(k)[0] === sid) states.delete(k);
    }

    function close() {
      if (closed) return;
      for (const r of [...receivers.values()]) stopReceiver(r, 'error', 'Download stopped.', true);
      for (const t of [...senders.values()]) {
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'The sender disconnected.' }), t.uuid);
        stopSender(t);
      }
      closed = true;
      offers.clear();
      states.clear();
    }

    return {
      register, download, cancel, onPacket, release, closeServer, close,
      status(sid, cid, mid) { return { ...(states.get(keyOf(sid, cid, mid)) || { state: 'idle', progress: 0, message: '' }) }; },
      hasLocal(sid, cid, mid) {
        const o = offers.get(keyOf(sid, cid, mid)), m = messageFor(sid, cid, mid);
        return !!(o && m && m.author === context.userId() && sameMeta(o.meta, m.meta));
      },
    };
  }

  window.DischordFiles = Object.freeze({ cleanMeta, formatSize, strategyFor, create, CHUNK_BYTES, MAX_WINDOW, TIMEOUT_MS });
})();
