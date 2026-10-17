/* Android downloads use only a destination chosen after an explicit Download click. */
(() => {
  'use strict';
  if (window.top !== window || !window.DischordNative ||
      typeof window.DischordNative.postMessage !== 'function') return;

  const bridge = window.DischordNative;
  const CHUNK_BYTES = 64 * 1024;
  const pending = new Map();
  const prefix = 'file_' + crypto.getRandomValues(new Uint32Array(2)).join('_') + '_';
  let sequence = 0;
  let pageClosed = false;

  function failure(name, message) { return new DOMException(message, name); }
  function request(type, details = {}, timeout = 30000) {
    if (pageClosed) return Promise.reject(failure('AbortError', 'The download page is closed.'));
    const id = prefix + (++sequence).toString(36);
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        pending.delete(id);
        reject(failure('TimeoutError', 'The device did not finish this file operation.'));
      }, timeout) : null;
      pending.set(id, { resolve, reject, timer });
      try { bridge.postMessage(JSON.stringify({ ...details, type, id })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }

  bridge.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const operation = message && pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    clearTimeout(operation.timer);
    if (message.ok === true) operation.resolve(message.result || {});
    else operation.reject(failure(message.error?.name || 'UnknownError',
      message.error?.message || 'The device could not save this file.'));
  });

  function mimeFor(options) {
    const types = Array.isArray(options.types) ? options.types : [];
    for (const type of types) {
      if (!type || !type.accept || typeof type.accept !== 'object') continue;
      for (const mime of Object.keys(type.accept)) {
        if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime)) return mime;
      }
    }
    return 'application/octet-stream';
  }

  function encode(bytes) {
    // Sub-arrays avoid argument-count limits on Android WebView versions.
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(start, start + 8192));
    }
    return btoa(binary);
  }

  function writerFor(token) {
    let position = 0;
    let state = 'open';
    let queue = Promise.resolve();
    function enqueue(operation) {
      if (state !== 'open') return Promise.reject(failure('InvalidStateError', 'The destination is closed.'));
      const next = queue.then(() => {
        if (state === 'aborted' || state === 'failed') throw failure('AbortError', 'Download cancelled.');
        return operation();
      });
      queue = next.catch(() => {});
      return next.catch(async (error) => {
        if (state !== 'aborted' && state !== 'closed') {
          state = 'failed';
          await request('file-abort', { token }).catch(() => {});
        }
        throw error;
      });
    }
    async function writeBytes(bytes) {
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        if (state === 'aborted' || state === 'failed') throw failure('AbortError', 'Download cancelled.');
        const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + CHUNK_BYTES));
        const accepted = await request('file-write', { token, position, data: encode(chunk) });
        if (accepted.position !== position + chunk.byteLength) throw failure('DataError', 'Invalid download acknowledgement.');
        position = accepted.position;
      }
    }
    async function writeValue(value) {
      if (value instanceof Blob) {
        // Read one slice at a time, including multi-gigabyte Files owned by the sender.
        for (let offset = 0; offset < value.size; offset += CHUNK_BYTES) {
          await writeBytes(new Uint8Array(await value.slice(offset, offset + CHUNK_BYTES).arrayBuffer()));
        }
      } else if (value instanceof ArrayBuffer) await writeBytes(new Uint8Array(value));
      else if (ArrayBuffer.isView(value)) await writeBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      else if (typeof value === 'string') await writeBytes(new TextEncoder().encode(value));
      else if (value && value.type === 'write') {
        if (value.position !== undefined && value.position !== position) {
          throw failure('NotSupportedError', 'Downloads are written sequentially.');
        }
        await writeValue(value.data);
      } else throw new TypeError('Use a Blob, string, ArrayBuffer, or typed array for a download write.');
    }
    return Object.freeze({
      write(value) { return enqueue(() => writeValue(value)); },
      close() {
        if (state === 'closed') return Promise.resolve();
        if (state !== 'open') return Promise.reject(failure('InvalidStateError', 'The destination is closed.'));
        state = 'closing';
        return queue.then(async () => {
          if (state !== 'closing') throw failure('AbortError', 'Download cancelled.');
          await request('file-close', { token, position });
          state = 'closed';
        }).catch(async (error) => {
          state = 'failed';
          await request('file-abort', { token }).catch(() => {});
          throw error;
        });
      },
      abort() {
        if (state === 'closed' || state === 'aborted') return Promise.resolve();
        state = 'aborted';
        return request('file-abort', { token });
      },
    });
  }

  async function showSaveFilePicker(options = {}) {
    if (!options || typeof options !== 'object') throw new TypeError('Invalid save options.');
    const selected = await request('file-pick', {
      name: typeof options.suggestedName === 'string' ? options.suggestedName : 'download',
      mime: mimeFor(options),
    }, 0); // Destination selection has no artificial user-response timeout.
    let opened = false;
    return Object.freeze({
      kind: 'file', name: selected.name,
      async createWritable(options = {}) {
        if (opened) throw failure('InvalidStateError', 'This download destination is already open.');
        if (options.keepExistingData === true) throw failure('NotSupportedError', 'Choose a new destination for this download.');
        opened = true;
        try {
          await request('file-open', { token: selected.token });
          return writerFor(selected.token);
        } catch (error) {
          await request('file-abort', { token: selected.token }).catch(() => {});
          throw error;
        }
      },
    });
  }
  Object.defineProperty(window, 'showSaveFilePicker', { value: showSaveFilePicker, configurable: true });

  async function saveBlob(url, name) {
    const selected = showSaveFilePicker({ suggestedName: name || 'download' });
    // Retain the in-memory Blob before the app revokes its object URL. No file is
    // opened on disk and no original is requested until the Download action.
    const contents = fetch(url).then((response) => {
      if (!response.ok) throw failure('NotReadableError', 'This download is no longer available.');
      return response.blob();
    });
    contents.catch(() => {});
    const handle = await selected;
    const writer = await handle.createWritable({ keepExistingData: false });
    try {
      await writer.write(await contents);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
  }

  function showError(error) {
    if (error?.name === 'AbortError' || pageClosed) return;
    const notice = document.createElement('div');
    notice.setAttribute('role', 'alert');
    notice.textContent = error?.message || 'The file could not be saved. Try Download again.';
    Object.assign(notice.style, { position: 'fixed', bottom: 'calc(24px + env(safe-area-inset-bottom))',
      left: '16px', right: '16px', zIndex: '2147483647', padding: '14px 16px', borderRadius: '10px',
      background: '#2b2d31', color: '#f2f3f5', boxShadow: '0 4px 20px #0008', font: '14px system-ui' });
    (document.body || document.documentElement).appendChild(notice);
    setTimeout(() => notice.remove(), 6000);
  }

  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[download]') : null;
    if (!anchor || !anchor.href.startsWith('blob:')) return;
    let url;
    try { url = new URL(anchor.href); } catch { return; }
    if (url.origin !== location.origin) return;
    event.preventDefault();
    saveBlob(anchor.href, anchor.download).catch(showError);
  }, true);

  window.addEventListener('pagehide', () => {
    pageClosed = true;
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(failure('AbortError', 'The download page is closed.'));
    }
    pending.clear();
  });
  window.addEventListener('pageshow', () => { pageClosed = false; });
})();
