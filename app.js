/* 叮咚 — a Discord-style app on top of VDO.Ninja. Fully peer-to-peer.
 *
 * How it works (no backend):
 *  - Each server has a random id + secret key. Everyone who has the invite has both.
 *  - For every server you're in, a hidden VDO.Ninja iframe joins a room as a guest with
 *    no camera or mic. That peer-to-peer mesh carries text messages, presence, typing,
 *    voice-channel occupancy, channel changes and history sync, via the VDO.Ninja
 *    IFRAME API (sendData / dataReceived).
 *  - Voice channels are separate, visible VDO.Ninja rooms (audio, camera, screen share).
 *    叮咚 draws its own controls and drives VDO.Ninja through postMessage.
 *  - Profiles, settings and chat metadata use localStorage. Image previews have a
 *    separate browser cache; original files transfer only after Download.
 *    History reaches people who join later as long as someone who has it is online.
 *
 * Testing tip: add ?as=alice to the URL to use a separate identity in the same browser.
 */
(() => {
  'use strict';

  // Point this at a self-hosted VDO.Ninja if you like (see README).
  const VDO = (window.DISCHORD_CONFIG && window.DISCHORD_CONFIG.vdoUrl) || 'https://vdo.ninja/';
  const PROTO = 2;
  // The release this page is running, read from the ?v= on its own script tag. Everyone reports theirs,
  // so the app can say when someone is too out of date for a feature, or when a newer release exists.
  const APP_VER = +(((typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '').match(/[?&]v=(\d+)/) || [0, 0])[1];
  const KICK_VER = 36, MOVE_VER = 35; // first releases that obey these requests
  const MAX_MSGS = 500;
  const HIST_SEND = 80;           // messages per channel sent during history sync
  const PING_MS = 8000;           // presence heartbeat
  const STALE_CONNECTED = 600000; // peer with a live connection: trust the connection; this is only a safety net if a disconnect event is ever missed
  const STALE_LOOSE = 60000;      // peer with no live connection considered gone after this
  const STALE_VOICE = 180000;     // same, for someone in a call
  const PEER_GRACE = 20000;       // a dropped mesh connection may just be reconnecting: wait this long for the next ping
  const COLORS = ['#5865f2', '#7b61ff', '#9b59b6', '#eb459e', '#ed4245', '#f47b67', '#e67e22', '#faa61a',
    '#f1c40f', '#57f287', '#3ba55c', '#1abc9c', '#00a8fc', '#3498db', '#607d8b', '#99aab5'];
  const EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😛', '😜', '🤪', '🤨',
    '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😫', '😩', '🥺', '😢', '😭',
    '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '🤗', '🤔', '🤭', '🤫',
    '😶', '😐', '😑', '😬', '🙄', '😯', '😮', '😲', '🥱', '😴', '🤤', '😵', '🤐', '🥴', '🤢', '🤮',
    '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤙', '👋', '👏', '🙌', '🙏', '💪', '👀', '🧠', '💀', '👻',
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💯', '🔥', '✨', '🎉', '🎮', '🎧', '✅', '❌'];
  const REACTS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '💯', '😎', '🙏', '🤔', '👏', '😡', '✅', '❌'];
  const IMG_CHUNK = 14000;        // chars per image chunk over the data channel
  const IMG_MAX = 4500000;        // max data-URL length (~3.3 MB image)

  const AV_DEFAULTS = { camQ: '720', camFps: 30, camBr: 2500, ssQ: '1080', ssFps: 60, ssBr: 12000, ssHint: 'motion', recvCap: 0, codec: 'h264', selfPreview: 'low', showStats: false, micGain: 100, outVol: 100, ssAudio: true, denoise: true };
  function audioPercent(value) {
    const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.max(0, Math.min(200, Math.round(n))) : 100;
  }
  const CAM_BRS = [300, 600, 1000, 1500, 2500, 4000, 6000, 8000];
  const SS_BRS = [1000, 2500, 4000, 6000, 8000, 12000, 16000, 20000, 30000, 40000];
  const VIEW_BRS = [300, 800, 1500, 2500, 4000, 6000, 8000, 12000, 20000, 30000, 40000];
  const mbps = (k) => (k >= 1000 ? (k / 1000).toFixed(k % 1000 ? 1 : 0) + ' Mbps' : k + ' kbps');
  const CAM_Q = { '360': 2, '720': 1, '1080': 0, '1440': -3, '2160': -2 };
  const SS_Q = { '720': 1, '1080': 0, '1440': -3, '2160': -2, source: -1 };
  const SHARE_KEYS = ['ssQ', 'ssFps', 'ssBr', 'ssHint'];
  const shareSettings = (settings) => Object.fromEntries(SHARE_KEYS.map((key) => [key, settings[key]]));
  const sameShareSettings = (a, b) => !!a && !!b && SHARE_KEYS.every((key) => String(a[key]) === String(b[key]));

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();

  // Optional ?as=name gives a separate identity/storage in the same browser (handy for testing).
  const PROFILE = (new URLSearchParams(location.search).get('as') || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 20);
  const PREFIX = 'dischord.' + (PROFILE ? 'p_' + PROFILE + '.' : '');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(PREFIX + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { } },
    del(k) { try { localStorage.removeItem(PREFIX + k); } catch { } },
  };

  function rid(n = 10) {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (const x of crypto.getRandomValues(new Uint8Array(n))) s += a[x % a.length];
    return s;
  }

  const b64e = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64d = (str) => JSON.parse(decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/')))));

  // ---------------------------------------------------------------- icons (inline SVG)
  const P = {
    mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>',
    micOff: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/><path class="slash" d="M4 4l16 16"/>',
    headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/>',
    deaf: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/><path class="slash" d="M4 4l16 16"/>',
    camera: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/>',
    cameraOff: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/><path class="slash" d="M3 3l18 18"/>',
    screen: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    hangup: '<path fill="currentColor" stroke="none" d="M12 9c-2.4 0-4.7.5-6.8 1.4-.7.3-1.2 1-1.2 1.8v2.3c0 .8.8 1.4 1.6 1.2l2.8-.7c.6-.2 1-.7 1-1.3v-1.6a11 11 0 0 1 5.2 0v1.6c0 .6.4 1.1 1 1.3l2.8.7c.8.2 1.6-.4 1.6-1.2v-2.3c0-.8-.5-1.5-1.2-1.8C16.7 9.5 14.4 9 12 9z"/>',
    speaker: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    hash: '<path d="M5 9h15M4 15h15M10 3L8 21M16 3l-2 18"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4.2a4 4 0 0 1 0 7.6M22 21a7 7 0 0 0-4-6.3"/>',
    userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    signal: '<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    plusCircle: '<circle cx="12" cy="12" r="9.5"/><path d="M12 8v8M8 12h8"/>',
    volume: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3.2 3.8M6.6 6.6A17 17 0 0 0 3 12s4 6 9 6a9 9 0 0 0 4.2-1"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    reply: '<path d="M9 4l-6 6 6 6M3 10h9a8 8 0 0 1 8 8"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    collapse: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    winfs: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 12V9h3M16.5 12v3h-3"/>',
    play: '<path fill="currentColor" stroke="none" d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>',
    pause: '<path fill="currentColor" stroke="none" d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
    prev: '<path fill="currentColor" stroke="none" d="M6 5h2v14H6zM20 5.5v13a.8.8 0 0 1-1.25.66L9.5 12.66a.8.8 0 0 1 0-1.32l9.25-6.5A.8.8 0 0 1 20 5.5z"/>',
    next: '<path fill="currentColor" stroke="none" d="M16 5h2v14h-2zM4 5.5v13a.8.8 0 0 0 1.25.66l9.25-6.5a.8.8 0 0 0 0-1.32L5.25 4.84A.8.8 0 0 0 4 5.5z"/>',
    loop: '<path d="M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4v-1"/>',
    pip: '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none"/>',
    volumeOff: '<path d="M11 5L6 9H3v6h3l5 4zM16 9.5l5 5M21 9.5l-5 5"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    flip: '<path d="M4 9a8 8 0 0 1 14.2-3.2L20 8M20 4v4h-4M20 15a8 8 0 0 1-14.2 3.2L4 16M4 20v-4h4"/><circle cx="12" cy="12" r="2.2"/>',
    chevUp: '<path d="M6 15l6-6 6 6"/>',
    chevDown: '<path d="M6 9l6 6 6-6"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17.5 14.5c2.5.2 4 1.8 4 4.5"/>',
    live: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><circle cx="12" cy="10.5" r="2" fill="currentColor"/>',
  };
  const icon = (name, cls = '') => `<svg class="ico-svg ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  function paintIcons(root = document) {
    root.querySelectorAll('i[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
  }
  function setIcon(btn, name) {
    const svg = btn.querySelector('svg');
    if (svg) svg.innerHTML = P[name] || '';
  }

  // Timers that keep their pace in a background tab. Browsers slow page timers there (to once a second,
  // later once a minute), which stalled image transfers and presence pings from anyone who had switched
  // to another window. A worker's timers are not slowed. Falls back to page timers without workers.
  const bgTimer = (() => {
    let worker = null, seq = 0;
    const waits = new Map(), loops = [];
    const fail = () => {
      if (!worker) return;
      try { worker.terminate(); } catch { }
      worker = null;
      waits.forEach((done) => done()); waits.clear();
      loops.forEach(([ms, fn]) => setInterval(fn, ms));
    };
    try {
      if (typeof Worker !== 'function') throw new Error('no workers');
      const src = 'onmessage=function(e){var d=e.data;if(d.every)setInterval(function(){postMessage({every:d.every})},d.every);else setTimeout(function(){postMessage({id:d.id})},d.ms)}';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = (e) => {
        const d = e.data || {};
        if (d.every) loops.forEach(([ms, fn]) => { if (ms === d.every) fn(); });
        else { const done = waits.get(d.id); waits.delete(d.id); if (done) done(); }
      };
      worker.onerror = fail;
    } catch { worker = null; }
    return {
      sleep: (ms) => new Promise((done) => { if (!worker) return setTimeout(done, ms); const id = ++seq; waits.set(id, done); worker.postMessage({ id, ms }); }),
      every(ms, fn) { loops.push([ms, fn]); if (worker) worker.postMessage({ every: ms }); else setInterval(fn, ms); },
    };
  })();

  // ---------------------------------------------------------------- state
  let me = store.get('me', null);
  let servers = store.get('servers', []);
  let reads = store.get('reads', {});
  let lastChan = store.get('lastChan', {});
  const savedAv = store.get('av', {}) || {};
  let av = { ...AV_DEFAULTS, ...savedAv };
  av.micGain = audioPercent(av.micGain);
  if (av.sendBr && !savedAv.camBr) av.camBr = av.sendBr; // migrate v4 settings
  delete av.sendBr; delete av.recvBr;
  // Keep explicit saved choices, including Auto codec. Fresh profiles use the FPS-oriented defaults.
  if (!av.v8 || !av.v9) { av.v8 = 1; av.v9 = 1; store.set('av', av); }
  if (!av.v48) { av.ssAudio = true; av.v48 = 1; store.set('av', av); } // v48: computer sound is shared again, guarded by the call filter
  const cur = { sid: store.get('lastSid', null), cid: null };
  const msgs = {};       // sid -> { cid: [msg] }
  const known = {};      // sid -> { userId: user }   (persisted)
  const members = {};    // sid -> { userId: { user, vc, vs, st, seen, uuids:Set } }
  const peers = {};      // sid -> Map(uuid -> { uid, rx, helloAt })
  const typing = {};     // sid/cid -> { userId: { name, until } }
  const meshes = {};     // sid -> { iframe }
  const speaking = {};   // userId -> until ts
  let voice = null;      // { sid, cid, iframe, cam, ss, vs }
  let micOn = store.get('micOn', true), deaf = store.get('deaf', false);
  let membersOpen = store.get('membersOpen', true);
  const userVol = store.get('vol', {});      // uid -> { v: 0-200 voice, sv: 0-200 stream, m: muted }
  const hiddenVid = store.get('hidevid', {}); // uid -> true (don't receive their camera)
  const imgCache = new Map();                // image id -> data URL
  const legacyImageKeys = new Set(); // saved legacy references allowed to read the old global cache
  let replyTarget = null;
  const composerDrafts = new Map(); // channel drafts, including local file references; never persisted
  const fileProviders = new Map(); // offer -> originating connection, never saved in chat history

  // Direct messages: a private conversation with one person. It is kept as a pretend server ('dm') whose
  // text channels are the people, so chat, replies, reactions, images and files all work the same way.
  // Its packets go only to that person's connections, through any server we both have open (sendDm, dmPacket).
  const DM = 'dm';
  let dms = [];          // people I have a conversation with: { id, name, color, hid?: closed at }
  const dmServer = { id: DM, name: 'Direct Messages', dm: true, v: 0, get channels() { return dms.filter((u) => !u.hid).map((u) => ({ id: u.id, name: u.name, type: 'text' })); } };
  const server = (sid) => (sid === DM ? dmServer : servers.find((s) => s.id === sid));
  const channel = (s, cid) => s && s.channels.find((c) => c.id === cid);
  const saveServers = () => store.set('servers', servers);

  function getMsgs(sid) {
    if (!msgs[sid]) {
      msgs[sid] = store.get('msgs.' + sid, {});
      for (const cid in msgs[sid]) for (const m of msgs[sid][cid] || []) {
        if (m.img && !m.file) legacyImageKeys.add(sid + '/' + cid + '/' + m.id + '/' + m.img.id);
      }
    }
    return msgs[sid];
  }
  const saveTimers = {};
  function saveMsgs(sid) {
    clearTimeout(saveTimers[sid]);
    saveTimers[sid] = setTimeout(() => store.set('msgs.' + sid, msgs[sid] || {}), 400);
  }
  function getKnown(sid) {
    if (sid === DM) return Object.fromEntries(dms.map((u) => [u.id, u]));
    if (!known[sid]) known[sid] = store.get('known.' + sid, {});
    return known[sid];
  }

  // ---------------------------------------------------------------- validation
  const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const isId = (v) => typeof v === 'string' && /^[a-z0-9]{1,24}$/i.test(v);

  function cleanUser(u) {
    if (!u || !isId(u.id) || !isStr(u.name, 32)) return null;
    const color = typeof u.color === 'string' && /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : COLORS[0];
    return { id: u.id, name: u.name.trim().slice(0, 32) || 'anon', color };
  }
  const clampInt = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : lo);
  function cleanImg(i) {
    if (!i || typeof i !== 'object' || !isStr(i.id, 64) || !/^[a-z0-9]+$/i.test(i.id)) return undefined;
    const preview = i.preview === 1;
    const maximum = preview ? window.DischordImages.MAX_PREVIEW : IMG_MAX;
    if (!Number.isInteger(i.n) || i.n < 1 || i.n > maximum) return undefined;
    const side = preview ? window.DischordImages.MAX_SIDE : 10000;
    return { id: i.id, w: clampInt(i.w, 1, side), h: clampInt(i.h, 1, side), n: i.n, ...(preview ? { preview: 1 } : {}) };
  }
  function cleanRe(re) {
    if (!re || typeof re !== 'object') return undefined;
    const out = {};
    for (const e of Object.keys(re).slice(0, 20)) {
      if (!e || e.length > 16 || !re[e] || typeof re[e] !== 'object') continue;
      const o = {};
      for (const u of Object.keys(re[e]).slice(0, 200)) if (isId(u) && Number.isFinite(+re[e][u])) o[u] = +re[e][u];
      if (Object.keys(o).length) out[e] = o;
    }
    return Object.keys(out).length ? out : undefined;
  }
  function cleanMsg(m) {
    if (!m || !isStr(m.id, 64) || !isId(m.cid) || typeof m.ts !== 'number') return null;
    const a = cleanUser(m.a);
    if (!a) return null;
    if (m.del) return { id: m.id, cid: m.cid, ts: m.ts, a, del: true, text: '' };
    const text = typeof m.text === 'string' ? m.text : '';
    const file = window.DischordFiles.cleanMeta(m.file);
    const parsedImg = cleanImg(m.img);
    const img = parsedImg && (file ? window.DischordImages.isImage(file) && parsedImg.preview === 1 : !parsedImg.preview) ? parsedImg : undefined;
    if ((!text && !img && !file) || text.length > 4000) return null;
    return { id: m.id, cid: m.cid, ts: Math.min(m.ts, now() + 60000), a, text, img, file, reply: cleanReply(m.reply), re: cleanRe(m.re), ed: m.ed ? 1 : undefined };
  }
  function cleanReply(r) {
    if (!r || !isStr(r.id, 64) || !/^[a-z0-9]+$/i.test(r.id)) return undefined;
    const a = cleanUser(r.a);
    if (!a || typeof r.text !== 'string' || r.text.length > 240) return undefined;
    return { id: r.id, a, text: r.text, attachment: isStr(r.attachment, 255) ? r.attachment : undefined };
  }
  function cleanServerDef(d) {
    if (!d || !isId(d.id) || !isStr(d.name, 64) || !Array.isArray(d.channels) || typeof d.v !== 'number') return null;
    const channels = d.channels.slice(0, 60).filter((c) => c && isId(c.id) && isStr(c.name, 40) && (c.type === 'text' || c.type === 'voice'))
      .map((c) => ({ id: c.id, name: c.name, type: c.type }));
    const jc = d.jc && typeof d.jc === 'object' && typeof d.jc.c === 'string' && /^[a-z0-9]{8}$/.test(d.jc.c) && Number.isFinite(d.jc.x)
      ? { c: d.jc.c, x: Math.min(d.jc.x, now() + 31 * 864e5) } : undefined;
    return { id: d.id, name: d.name, channels, v: d.v, ...(jc ? { jc } : {}) };
  }
  function cleanState(st) {
    st = st && typeof st === 'object' ? st : {};
    const br = (v) => (Number.isFinite(+v) && +v >= 100 && +v <= 50000 ? Math.round(+v) : 0);
    return { m: !!st.m, d: !!st.d, c: !!st.c, s: !!st.s, cb: br(st.cb), sb: br(st.sb) };
  }

  dms = (store.get('dms', []) || []).map((u) => { const c = cleanUser(u); return c && (u.hid > 0 ? { ...c, hid: +u.hid } : c); }).filter(Boolean);

  // ---------------------------------------------------------------- mesh (hidden VDO.Ninja rooms)
  const roomFor = (s, suffix = '') => 'dischord' + s.id + suffix;

  // ---- short join codes. A code cannot contain the server's address and key the way the long invite
  // link does, and there is no directory to look it up in. So while a server has a live code, every
  // member who is online also sits in a small "lobby" room named after the code; someone who types the
  // code enters that room and is handed the real invite by whoever is there.
  const JOIN_CODE_MS = 7 * 864e5;
  const cleanCode = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const showCode = (c) => (c.slice(0, 4) + '-' + c.slice(4)).toUpperCase();
  const liveCode = (s) => (s && s.jc && s.jc.x > now() ? s.jc.c : null);
  const serverDef = (s) => ({ id: s.id, name: s.name, channels: s.channels, v: s.v, ...(s.jc ? { jc: s.jc } : {}) });
  const lobbies = {};    // code -> { iframe, sid }: the lobby rooms I am sitting in for my servers
  let joining = null;    // { code, iframe, timer }: a code I typed and am waiting on
  function lobbyFrame(code) {
    const p = new URLSearchParams({ room: 'dischordjoin' + code, password: 'join' + code, label: 'lobby' });
    const f = document.createElement('iframe');
    f.src = VDO + '?' + p.toString() + '&videodevice=0&audiodevice=0&webcam&autostart&cleanoutput';
    f.title = 'lobby';
    $('meshHost').appendChild(f);
    return f;
  }
  function syncLobbies() {
    const want = {};
    if (me) for (const s of servers) { const c = liveCode(s); if (c) want[c] = s.id; }
    for (const c in lobbies) if (want[c] !== lobbies[c].sid) { lobbies[c].iframe.remove(); delete lobbies[c]; }
    for (const c in want) if (!lobbies[c]) lobbies[c] = { iframe: lobbyFrame(c), sid: want[c] };
  }
  // someone arrived in a lobby: hand them the invite (repeated, as the data channel can lag the event)
  function lobbyGreet(code, uuid) {
    for (const delay of [0, 800, 2500, 6000]) setTimeout(() => {
      const l = lobbies[code], s = l && server(l.sid);
      if (!s || liveCode(s) !== code || !l.iframe.contentWindow) return;
      l.iframe.contentWindow.postMessage({ sendData: { dischordJoin: inviteCode(s) }, UUID: uuid }, '*');
    }, delay);
  }
  function endJoining() {
    if (!joining) return;
    clearTimeout(joining.timer);
    joining.iframe.remove();
    joining = null;
  }
  function joinByCode(code) {
    if (!me) return false;
    const mine = servers.find((s) => liveCode(s) === code);
    if (mine) { selectServer(mine.id); return true; }
    endJoining();
    toast('Looking for that server…', 20000);
    joining = { code, iframe: lobbyFrame(code), timer: setTimeout(() => { endJoining(); toast('No server answered that code. It may be mistyped or expired, or nobody from the server is online right now.', 9000); }, 20000) };
    return true;
  }

  function meshUrl(s) {
    const p = new URLSearchParams({ room: roomFor(s), password: s.key, label: me.name });
    // &datamode discovers peers but never connects them in rooms; a no-camera/no-mic guest does.
    return VDO + '?' + p.toString() + '&videodevice=0&audiodevice=0&webcam&autostart&cleanoutput';
  }

  function connectMesh(s) {
    if (meshes[s.id] || !me) return;
    const f = document.createElement('iframe');
    f.src = meshUrl(s);
    f.title = 'mesh-' + s.id;
    $('meshHost').appendChild(f);
    meshes[s.id] = { iframe: f };
    peers[s.id] = peers[s.id] || new Map();
  }
  function disconnectMesh(sid) {
    const m = meshes[sid];
    if (!m) return;
    try { send(sid, { t: 'bye' }); } catch { }
    setTimeout(() => m.iframe.remove(), 200);
    delete meshes[sid];
    peers[sid] = new Map();
  }

  const myVoiceIn = (sid) => (voice && voice.sid === sid ? voice.cid : null);
  const myState = () => ({ m: !micOn || deaf, d: deaf, c: !!(voice && voice.cam), s: !!(voice && voice.ss), cb: av.camBr, sb: voice && voice.ssSettings ? voice.ssSettings.ssBr : av.ssBr });

  // When the call in a voice channel started. Nobody owns that fact, so everyone in the call keeps
  // repeating how long it has been running as far as they know, and each client keeps the longest.
  // Ages (not clock times) are exchanged, so computers with different clocks still agree.
  const callStarts = {}; // 'sid/cid' -> local timestamp
  const callStart = (sid, cid) => callStarts[sid + '/' + cid] || null;
  function noteCallStart(sid, cid, at) {
    const k = sid + '/' + cid;
    if (!callStarts[k] || at < callStarts[k] - 1500) callStarts[k] = at; // ignore network jitter
  }

  // Every payload carries who I am and my voice state, so presence is never stale.
  function send(sid, payload, uuid) {
    if (sid === DM) return sendDm(payload, uuid);
    const m = meshes[sid];
    if (!m || !m.iframe.contentWindow) return false;
    const inV = myVoiceIn(sid);
    const started = inV ? callStart(sid, inV) : null;
    const body = { v: PROTO, u: me, vc: inV, vs: inV ? voice.vs : null, vss: inV && voice.ss ? voice.ssVs : null, vt: started ? now() - started : null, ver: APP_VER, st: myState(), ...payload };
    const o = { sendData: { dischord: body } };
    if (uuid) o.UUID = uuid;
    m.iframe.contentWindow.postMessage(o, '*');
    return true;
  }
  const broadcastState = () => { for (const sid in meshes) send(sid, { t: 'ping', pt: now() }); };

  function hello(sid, uuid, want) {
    const s = server(sid);
    if (!s) return;
    send(sid, { t: 'hello', want: !!want, s: serverDef(s) }, uuid);
  }

  // Greet a newly connected peer, retrying until we hear back (the data channel can lag the event).
  function greet(sid, uuid) {
    const map = peers[sid];
    if (!map) return;
    const p = map.get(uuid) || { uid: null, rx: 0, helloAt: 0 };
    map.set(uuid, p);
    const delays = [0, 700, 1800, 4000, 8000, 15000];
    delays.forEach((d) => setTimeout(() => {
      const q = peers[sid] && peers[sid].get(uuid);
      if (q && !q.rx) hello(sid, uuid, true);
    }, d));
  }

  function peerGone(sid, uuid) {
    const map = peers[sid];
    if (!map) return;
    const p = map.get(uuid);
    map.delete(uuid);
    const m = p && p.uid && members[sid] && members[sid][p.uid];
    if (m) {
      m.uuids.delete(uuid);
      // Not offline at once: the connection may be reconnecting. The next ping revives it; silence expires it.
      const c = m.conns && m.conns.get(uuid);
      if (c) c.seen = Math.min(c.seen, now() - (c.vc ? STALE_VOICE : STALE_LOOSE) + PEER_GRACE);
      else if (!m.conns && !m.uuids.size) m.seen = Math.min(m.seen, now() - (m.vc ? STALE_VOICE : STALE_LOOSE) + PEER_GRACE);
    }
    if (sid === cur.sid) renderPresence();
  }

  function sendHistory(sid, uuid) {
    const all = getMsgs(sid);
    for (const cid in all) {
      const list = all[cid].slice(-HIST_SEND);
      for (let i = 0; i < list.length; i += 15) send(sid, { t: 'hist', ms: list.slice(i, i + 15) }, uuid);
    }
  }

  // A person can have several connections at once (two tabs, or the desktop window plus a browser tab).
  // Each reports its own state, so one idle tab must never overwrite or end the presence of the tab that
  // is in a call: keep state per connection and show the one that is in voice (else the most recent).
  function settle(m) {
    if (!m || !m.conns) return;
    const t = now();
    let best = null, seen = 0;
    for (const [key, c] of m.conns) {
      const limit = m.uuids.has(key) ? STALE_CONNECTED : c.vc ? STALE_VOICE : STALE_LOOSE;
      if (t - c.seen >= limit) { m.conns.delete(key); continue; }
      seen = Math.max(seen, c.seen);
      if (!best || (!!c.vc !== !!best.vc ? !!c.vc : c.seen > best.seen)) best = c;
    }
    m.seen = seen;
    if (best) { m.vc = best.vc; m.vs = best.vs; m.vss = best.vss; m.st = best.st; }
    else { m.vc = m.vs = m.vss = null; }
  }
  function isOnline(m) {
    if (!m) return false;
    if (m.conns) { settle(m); return m.conns.size > 0; }
    if (!m.seen) return false;
    return now() - m.seen < (m.uuids && m.uuids.size ? STALE_CONNECTED : m.vc ? STALE_VOICE : STALE_LOOSE);
  }

  // ---- direct messages: find the person in whichever shared server they are connected through
  function anyMember(uid) {
    let hit = null;
    for (const sid in members) { const m = members[sid][uid]; if (m && isOnline(m)) return m; if (m) hit = m; }
    return hit;
  }
  const dmOnline = (uid) => isOnline(anyMember(uid));
  const dmTopic = (uid) => (dmOnline(uid) ? 'Online' : 'Offline') + ' · only the two of you can see this';
  const connServer = (uuid) => Object.keys(meshes).find((sid) => peers[sid] && peers[sid].has(uuid)) || null;
  function sendDm(payload, uuid) {
    if (uuid) { const sid = connServer(uuid); return sid ? send(sid, { ...payload, dm: 1 }, uuid) : false; }
    const to = (payload.m && payload.m.cid) || payload.cid; // the conversation is named after the other person
    for (const sid in meshes) {
      const m = members[sid] && members[sid][to];
      if (!m || !isOnline(m) || !m.uuids.size) continue;
      for (const id of m.uuids) send(sid, { ...payload, dm: 1 }, id); // every tab they have open
      return true;
    }
    return false; // offline: it stays in my history and is handed over when we next connect (sendDmHistory)
  }
  function sendDmHistory(sid, uuid, uid) {
    const list = (getMsgs(DM)[uid] || []).slice(-HIST_SEND);
    for (let i = 0; i < list.length; i += 15) send(sid, { t: 'hist', dm: 1, ms: list.slice(i, i + 15) }, uuid);
  }
  // Put someone in the conversation list. A conversation I closed comes back only for something newer.
  function noteDm(user, ts, open) {
    let d = dms.find((x) => x.id === user.id);
    if (!d) { d = { id: user.id, name: user.name, color: user.color }; dms.unshift(d); }
    else if (d.hid && (open || ts > d.hid)) delete d.hid;
    else return;
    store.set('dms', dms);
    renderRail();
    if (cur.sid === DM) renderChannels();
  }
  function openDm(user) {
    if (!user || user.id === me.id) return;
    noteDm(user, now(), true);
    if (cur.sid !== DM) selectServer(DM);
    selectChannel(user.id);
  }
  function closeDm(uid) {
    const d = dms.find((x) => x.id === uid);
    if (!d) return;
    d.hid = now();
    store.set('dms', dms);
    markRead(DM, uid);
    if (cur.sid === DM && cur.cid === uid) selectServer(DM); else render();
  }
  // An incoming direct packet names the conversation after its receiver (me); here it is filed under its sender.
  const DM_TYPES = new Set(['msg', 'hist', 'del', 'edit', 'react', 'typing', 'imgc', 'imgreq', 'f-request', 'f-chunk', 'f-ack', 'f-error', 'f-cancel']);
  function dmPacket(p, from) {
    if (!DM_TYPES.has(p.t)) return null;
    const mine = (m) => (m && typeof m === 'object' && m.cid === me.id ? { ...m, cid: from.id } : null);
    const q = { ...p };
    if (p.t === 'hist') {
      q.ms = (Array.isArray(p.ms) ? p.ms.slice(0, 50) : []).map(mine).filter((m) => m && m.a && (m.a.id === from.id || m.a.id === me.id));
      if (!q.ms.length) return null;
      noteDm(from, Math.max(...q.ms.map((m) => +m.ts || 0)));
    } else if (p.m !== undefined) {
      q.m = mine(p.m);
      if (!q.m) return null;
      if (p.t === 'msg') noteDm(from, +q.m.ts || 0);
    } else if (p.cid === me.id) q.cid = from.id;
    else return null;
    return q;
  }

  // Take offline people out of a server's member list. Nobody owns the list, so everyone online is asked
  // to drop them too; whoever is offline right now keeps their own copy, and the person shows up again
  // if they come back (they still hold the invite).
  function forgetUsers(sid, ids, tell) {
    const k = getKnown(sid), ms = members[sid] || {};
    const gone = ids.filter((id) => id !== me.id && (k[id] || ms[id]) && !isOnline(ms[id]));
    if (!gone.length) return 0;
    for (const id of gone) { delete k[id]; delete ms[id]; }
    store.set('known.' + sid, k);
    if (tell) send(sid, { t: 'forget', ids: gone.slice(0, 200) });
    if (sid === cur.sid) renderMembers();
    return gone.length;
  }

  // The same person open twice in one call (two tabs, or the app plus a tab) would hear their own
  // microphone come back from the other copy. Remember those streams so they are played at zero volume.
  const ownStreams = new Map(); // connection -> { sid, vc, ids: [stream ids], seen }
  function noteOwnInstance(sid, body, uuid) {
    const vc = isId(body.vc) ? body.vc : null;
    const ids = vc ? [body.vs, body.vss].filter((x) => isId(x)) : [];
    const key = sid + '/' + (uuid || '_');
    if (ids.length) ownStreams.set(key, { sid, vc, ids, seen: now() }); else ownStreams.delete(key);
  }
  function ownStreamsHere() {
    const out = [];
    for (const [key, o] of ownStreams) {
      if (now() - o.seen > STALE_VOICE) { ownStreams.delete(key); continue; }
      if (voice && o.sid === voice.sid && o.vc === voice.cid) out.push(...o.ids.filter((id) => id !== voice.vs && id !== voice.ssVs));
    }
    return out;
  }

  // Someone changed their name or colour: update it where their messages already are, in place. Redrawing
  // the whole chat for this reloaded every picture in it and made the screen flash.
  function repaintAuthor(user) {
    const box = $('messages');
    if (!box || typeof box.querySelectorAll !== 'function') return;
    box.querySelectorAll('[data-uid]').forEach((el) => {
      if (el.dataset.uid !== user.id) return;
      if (el.classList.contains('author')) { el.textContent = user.name; el.style.color = user.color; }
      else if (el.classList.contains('gutter') && el.querySelector('.avatar')) el.innerHTML = avatar(user);
    });
  }
  function touch(sid, body, uuid) {
    const user = cleanUser(body.u);
    if (user && user.id === me.id) noteOwnInstance(sid, body, uuid);
    if (!user || user.id === me.id) return null;
    const ms = (members[sid] = members[sid] || {});
    const prev = ms[user.id];
    const wasOnline = isOnline(prev);
    const m = prev || { uuids: new Set() };
    m.user = user;
    m.ver = Number.isInteger(body.ver) && body.ver > 0 ? body.ver : 0; // 0 = a release from before versions were reported
    if (APP_VER && m.ver > APP_VER && !touch.toldNewer) {
      touch.toldNewer = true;
      toast('A newer version of 叮咚 is available. Reload the page to update.', 10000);
    }
    const vc = isId(body.vc) ? body.vc : null;
    if (vc) noteCallStart(sid, vc, Number.isFinite(body.vt) && body.vt >= 0 && body.vt < 30 * 864e5 ? now() - body.vt : now());
    if (!m.conns) m.conns = new Map();
    m.conns.set(uuid || '_', { vc, vs: vc && isId(body.vs) ? body.vs : null, vss: vc && isId(body.vss) ? body.vss : null, st: cleanState(body.st), seen: now() });
    if (uuid) m.uuids.add(uuid);
    settle(m);
    ms[user.id] = m;
    const k = getKnown(sid);
    if (!k[user.id] || k[user.id].name !== user.name || k[user.id].color !== user.color) {
      k[user.id] = user;
      store.set('known.' + sid, k);
      if (sid === cur.sid) repaintAuthor(user); // their old messages pick up the new name / colour
    }
    const d = dms.find((x) => x.id === user.id);
    if (d && (d.name !== user.name || d.color !== user.color)) {
      d.name = user.name; d.color = user.color; store.set('dms', dms);
      if (cur.sid === DM) {
        renderChannels(); repaintAuthor(user);
        if (cur.cid === user.id) { $('chanName').textContent = user.name; $('msgInput').placeholder = `Message @${user.name}`; }
      }
    }
    return { user, wasOnline };
  }

  function onPeerData(sid, p, uuid) {
    if (!p || typeof p !== 'object' || !p.u || typeof p.t !== 'string') return;
    const s = server(sid);
    if (!s) return;
    const t = touch(sid, p, uuid);
    if (!t) return;

    // first packet from this connection: make sure both sides know each other + have history
    if (uuid && peers[sid]) {
      const map = peers[sid];
      const pr = map.get(uuid) || { uid: null, rx: 0, helloAt: 0 };
      const first = !pr.rx;
      pr.rx = now(); pr.uid = t.user.id;
      map.set(uuid, pr);
      if (first) {
        sendHistory(sid, uuid);
        sendDmHistory(sid, uuid, t.user.id);
        retryImages(sid, uuid);
        if (p.t !== 'hello' || p.want) { hello(sid, uuid, false); pr.helloAt = now(); }
      } else if (p.t === 'hello' && p.want && now() - pr.helloAt > 1500) {
        hello(sid, uuid, false); pr.helloAt = now();
      }
    }

    const via = sid;
    if (p.dm) { p = dmPacket(p, t.user); if (!p) return; sid = DM; } // handled below as the 'dm' pretend server

    switch (p.t) {
      case 'hello':
      case 'server':
        mergeServer(sid, p.s);
        break;
      case 'msg': {
        const msg = cleanMsg(p.m);
        if (msg && msg.a.id === t.user.id) {
          const fresh = !(getMsgs(sid)[msg.cid] || []).some((m) => m.id === msg.id);
          if (addMsg(sid, msg)) {
            if (fresh && msg.file && uuid) fileProviders.set(sid + '/' + msg.cid + '/' + msg.id, uuid);
            onNewMsg(sid, msg);
          }
        }
        break;
      }
      case 'hist': {
        if (!Array.isArray(p.ms)) break;
        let changed = false;
        for (const raw of p.ms.slice(0, 50)) {
          const msg = cleanMsg(raw);
          if (msg && addMsg(sid, msg)) changed = true;
        }
        if (changed) { if (sid === cur.sid) renderMessages(); renderRail(); if (sid === cur.sid) renderChannels(); }
        break;
      }
      case 'del':
      case 'edit': {
        const msg = cleanMsg(p.m);
        if (msg && msg.a.id === t.user.id && addMsg(sid, msg)) renderIfCurrent(sid, msg.cid);
        break;
      }
      case 'react': {
        if (!isId(p.cid) || !isStr(p.mid, 64) || !isStr(p.e, 16) || !Number.isFinite(+p.v)) break;
        const m = (getMsgs(sid)[p.cid] || []).find((x) => x.id === p.mid);
        if (m && !m.del && mergeRe(m, { [p.e]: { [t.user.id]: +p.v } })) { saveMsgs(sid); renderIfCurrent(sid, p.cid); }
        break;
      }
      case 'imgc':
        onImgChunk(sid, p, uuid);
        break;
      case 'imgreq':
        if (isStr(p.id, 64)) pushImage(sid, p.id, uuid, p.cid, p.mid);
        break;
      case 'f-request':
      case 'f-chunk':
      case 'f-ack':
      case 'f-error':
      case 'f-cancel':
        fileTransfers.onPacket(sid, p, uuid, t.user.id);
        break;
      case 'creact':
        if (isStr(p.e, 16) && voice && voice.sid === sid && p.vc === voice.cid) floatReaction(t.user.id, p.e);
        break;
      case 'typing':
        if (isId(p.cid)) {
          const k = sid + '/' + p.cid;
          typing[k] = typing[k] || {};
          typing[k][t.user.id] = { name: t.user.name, until: now() + 6000 };
          renderTyping();
        }
        break;
      case 'kick':
        if (p.to === me.id && voice && voice.sid === sid) { leaveVoice(); toast(`${t.user.name} removed you from the call`, 6000); }
        break;
      case 'move': {
        const dest = channel(s, p.cid);
        if (p.to === me.id && dest && dest.type === 'voice' && voice && voice.sid === sid && voice.cid !== dest.id) {
          toast(`${t.user.name} moved you to ${dest.name}`, 5000);
          joinVoice(sid, dest.id, voice.cam);
        }
        break;
      }
      case 'forget':
        if (Array.isArray(p.ids)) forgetUsers(sid, p.ids.slice(0, 200).filter(isId), false);
        break;
      case 'bye': {
        const m = members[sid][t.user.id];
        // only this connection is leaving; the same person may still be here in another tab
        if (m) { if (m.conns) m.conns.delete(uuid || '_'); m.uuids.delete(uuid); settle(m); if (!m.conns || !m.conns.size) m.seen = 0; }
        break;
      }
      case 'ping':
        if (Number.isFinite(p.pt) && uuid) send(sid, { t: 'pong', pt: p.pt }, uuid);
        break;
      case 'pong': {
        const m = members[sid][t.user.id], rtt = now() - p.pt;
        if (m && Number.isFinite(rtt) && rtt >= 0 && rtt < 60000) { m.rtt = m.rtt ? m.rtt * 0.6 + rtt * 0.4 : rtt; m.rttAt = now(); }
        break;
      }
    }
    if ((via === cur.sid || cur.sid === DM) && p.t !== 'imgc' && !p.t?.startsWith('f-')) renderPresence();
  }

  function mergeServer(sid, def) {
    const d = cleanServerDef(def);
    const s = server(sid);
    if (!d || !s || d.id !== sid || d.v <= s.v) return;
    const removed = s.channels.filter((c) => !d.channels.some((next) => next.id === c.id && next.type === c.type));
    s.name = d.name; s.channels = d.channels; s.v = d.v;
    if (d.jc) s.jc = d.jc; else delete s.jc;
    removed.forEach((c) => releaseChannelFiles(sid, c.id));
    saveServers();
    syncLobbies();
    if (voice && voice.sid === sid && !channel(s, voice.cid)) leaveVoice();
    if (cur.sid === sid && (!channel(s, cur.cid) || removed.some((c) => c.id === cur.cid))) {
      selectChannel((s.channels.find((c) => c.type === 'text') || s.channels[0] || {}).id || null);
    }
    render();
  }

  function bumpServer(s) {
    s.v = now();
    saveServers();
    send(s.id, { t: 'server', s: serverDef(s) });
    render();
  }

  // ---------------------------------------------------------------- messages
  function addMsg(sid, m) {
    const all = getMsgs(sid);
    const list = (all[m.cid] = all[m.cid] || []);
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      const old = list[i];
      if (old.a.id !== m.a.id) return false;
      if (old.del) return false;
      if (m.del) { list[i] = m; fileTransfers.release(sid, m.cid, m.id); cancelImageRequests(sid, m.cid, m.id); fileProviders.delete(sid + '/' + m.cid + '/' + m.id); saveMsgs(sid); return true; }
      let changed = false;
      if (m.ed && m.text !== old.text) { list[i] = { ...old, text: m.text, ed: 1 }; changed = true; }
      if (!old.img && m.img && (!old.file || (m.file && m.file.id === old.file.id && window.DischordImages.isImage(old.file) && m.img.preview === 1))) {
        list[i] = { ...list[i], img: m.img };
        changed = true;
      }
      if (m.re && mergeRe(list[i], m.re)) changed = true;
      if (changed) saveMsgs(sid);
      return changed;
    }
    let j = list.length;
    while (j > 0 && list[j - 1].ts > m.ts) j--;
    list.splice(j, 0, m);
    if (list.length > MAX_MSGS) list.splice(0, list.length - MAX_MSGS).forEach((old) => {
      fileTransfers.release(sid, old.cid, old.id);
      cancelImageRequests(sid, old.cid, old.id);
      fileProviders.delete(sid + '/' + old.cid + '/' + old.id);
    });
    saveMsgs(sid);
    return true;
  }

  // reactions: per (emoji, user) last-writer-wins; value = +ts (on) / -ts (off)
  function mergeRe(target, re) {
    let changed = false;
    target.re = target.re || {};
    for (const e in re) {
      for (const u in re[e]) {
        const v = re[e][u], cv = (target.re[e] || {})[u];
        if (cv === undefined || Math.abs(v) > Math.abs(cv)) { (target.re[e] = target.re[e] || {})[u] = v; changed = true; }
      }
    }
    return changed;
  }
  function toggleReaction(mid, e) {
    const list = getMsgs(cur.sid)[cur.cid] || [];
    const m = list.find((x) => x.id === mid);
    if (!m || m.del) return;
    const on = !(((m.re || {})[e] || {})[me.id] > 0);
    const v = on ? now() : -now();
    mergeRe(m, { [e]: { [me.id]: v } });
    saveMsgs(cur.sid);
    send(cur.sid, { t: 'react', cid: cur.cid, mid, e, v });
    renderMessages();
  }

  function onNewMsg(sid, m) {
    const k = sid + '/' + m.cid;
    if (typing[k]) delete typing[k][m.a.id];
    const viewing = sid === cur.sid && m.cid === cur.cid;
    if (viewing && !document.hidden) markRead(sid, m.cid);
    if (!viewing || document.hidden) notify(sid, m);
    if (viewing) { renderMessages(); renderTyping(); }
    refreshSearch();
    renderRail();
    if (sid === cur.sid) renderChannels();
  }

  function sendMessage(text) {
    const s = server(cur.sid);
    const c = channel(s, cur.cid);
    if (!s || !c || c.type !== 'text') return false;
    text = text.replace(/\s+$/, '').replace(/^\n+/, '');
    if (!text && !pending.length) return false;
    if (text.length > 4000) { toast('Message is too long (4000 characters max).'); return false; }
    const attachments = [...pending];
    const reply = replyTarget && replyTarget.sid === cur.sid && replyTarget.cid === cur.cid ? replyTarget.reply : undefined;
    const parts = attachments.length ? attachments.map((att, i) => ({ att, text: i === attachments.length - 1 ? text : '' })) : [{ text }];
    let sent = 0;
    for (const part of parts) {
      const m = { id: me.id + rid(8), cid: cur.cid, ts: now(), a: me, text: part.text, reply };
      if (part.att) {
        m.file = part.att.meta;
        if (!fileTransfers.register(s.id, cur.cid, m.id, m.file, part.att.file)) {
          toast('Too many available files in this tab. Delete an older file message, then send again.');
          break;
        }
        pending.shift();
      }
      addMsg(s.id, m);
      if (!send(s.id, { t: 'msg', m }) && s.dm) toast(`${c.name} is offline. They will get this when you are both online.`, 5000);
      if (part.att && window.DischordImages.isImage(m.file)) prepareImagePreview(s.id, m.cid, m.id, part.att);
      sent++;
    }
    if (sent === parts.length) cancelReply();
    renderAttachBar();
    markRead(s.id, cur.cid);
    lastTypingSent = 0;
    renderMessages(true);
    return sent === parts.length;
  }

  function replyToMessage(mid) {
    const m = (getMsgs(cur.sid)[cur.cid] || []).find((x) => x.id === mid);
    if (!m || m.del) return;
    replyTarget = { sid: cur.sid, cid: cur.cid, reply: {
      id: m.id, a: { ...m.a }, text: m.text.replace(/\s+/g, ' ').slice(0, 240),
      attachment: m.file ? m.file.name : m.img ? 'Image' : undefined,
    } };
    renderReplyBar();
    $('msgInput').focus();
  }
  function cancelReply() { replyTarget = null; renderReplyBar(); }
  function renderReplyBar() {
    const r = replyTarget && replyTarget.sid === cur.sid && replyTarget.cid === cur.cid ? replyTarget.reply : null;
    const bar = $('replyBar');
    bar.classList.toggle('hidden', !r);
    bar.innerHTML = r ? `<span>Replying to <b>${esc(r.a.name)}</b></span><span class="reply-excerpt">${esc(r.text || r.attachment || 'Message')}</span><button type="button" class="icon-btn" id="cancelReplyBtn" title="Cancel reply">${icon('x')}</button>` : '';
  }

  function saveComposerDraft() {
    if (channel(server(cur.sid), cur.cid)?.type !== 'text') return;
    composerDrafts.set(cur.sid + '/' + cur.cid, { text: $('msgInput').value, pending: [...pending], replyTarget });
  }
  function restoreComposerDraft() {
    const key = cur.sid + '/' + cur.cid;
    const d = composerDrafts.get(key);
    composerDrafts.delete(key); // the active composer owns these references until navigation
    $('msgInput').value = d ? d.text : '';
    syncComposer(); closeMention();
    pending.splice(0, pending.length, ...(d ? d.pending : []));
    replyTarget = d ? d.replyTarget : null;
    renderReplyBar(); renderAttachBar();
  }
  function releaseChannelFiles(sid, cid) {
    cancelImageRequests(sid, cid);
    for (const m of getMsgs(sid)[cid] || []) fileTransfers.release(sid, cid, m.id);
    const prefix = sid + '/' + cid + '/';
    for (const key of fileProviders.keys()) if (key.startsWith(prefix)) fileProviders.delete(key);
    composerDrafts.delete(sid + '/' + cid);
    if (cur.sid === sid && cur.cid === cid) {
      $('msgInput').value = '';
      pending.splice(0, pending.length);
      replyTarget = null;
    }
  }

  function deleteMessage(id) {
    const list = getMsgs(cur.sid)[cur.cid] || [];
    const m = list.find((x) => x.id === id);
    if (!m || m.a.id !== me.id) return;
    const d = { id: m.id, cid: m.cid, ts: m.ts, a: me, del: true, text: '' };
    addMsg(cur.sid, d);
    fileTransfers.release(cur.sid, cur.cid, id);
    send(cur.sid, { t: 'del', m: d });
    renderMessages();
  }

  function editMessage(id) {
    const list = getMsgs(cur.sid)[cur.cid] || [];
    const m = list.find((x) => x.id === id);
    if (!m || m.a.id !== me.id) return;
    modal(`<h2>Edit message</h2>
      <textarea id="mEdit" rows="4" maxlength="4000">${esc(m.text)}</textarea>
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`, () => {
      const ta = $('mEdit');
      ta.focus();
      $('mOk').onclick = () => {
        const text = ta.value.trim();
        if (!text) return;
        const e = { ...m, text, ed: 1 };
        addMsg(cur.sid, e);
        send(cur.sid, { t: 'edit', m: e });
        closeModal();
        renderMessages();
      };
    });
  }

  function markRead(sid, cid) {
    const list = getMsgs(sid)[cid] || [];
    const last = list.length ? list[list.length - 1].ts : 0;
    const k = sid + '/' + cid;
    if ((reads[k] || 0) < last) { reads[k] = last; store.set('reads', reads); }
  }
  function unreadCount(sid, cid) {
    const r = reads[sid + '/' + cid] || 0;
    const list = getMsgs(sid)[cid] || [];
    let n = 0;
    for (let i = list.length - 1; i >= 0 && list[i].ts > r; i--) if (!list[i].del && me && list[i].a.id !== me.id) n++;
    return n;
  }
  const serverUnread = (s) => s.channels.some((c) => c.type === 'text' && unreadCount(s.id, c.id) > 0);

  let lastTypingSent = 0;
  function sendTyping() {
    if (now() - lastTypingSent < 2500) return;
    lastTypingSent = now();
    send(cur.sid, { t: 'typing', cid: cur.cid });
  }

  function notify(sid, m) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const s = server(sid), c = channel(s, m.cid);
    if (!s || !c) return;
    try {
      const n = new Notification(s.dm ? `${m.a.name} (direct message)` : `${m.a.name} (#${c.name}, ${s.name})`, { body: (m.text || (m.file ? '📎 ' + m.file.name : m.img ? '📷 Image' : '')).slice(0, 200), tag: sid + m.cid });
      n.onclick = () => { window.focus(); selectServer(sid); selectChannel(m.cid); };
    } catch { }
  }

  // ---------------------------------------------------------------- files (metadata offers; bytes move only on Download)
  // Hand a file to the device (the browser's own download, or the phone's save dialog in the Android app).
  function exportFile(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---- opening files inside the app. Downloads go to the device as they always have. On top of that, a
  // file the built-in viewer can show (video, audio, image, PDF, text) stays reachable for the rest of
  // the session, so its chat card opens it in the player instead of downloading it again. The app stores
  // nothing itself: closing the tab forgets them.
  const held = new Map(); // 'sid/cid/mid' -> { key, id, name, type, size, from, blob | handle }
  const HELD_MAX = 24;
  const dlKey = (sid, cid, mid) => sid + '/' + cid + '/' + mid;
  const FILE_KINDS = {
    video: { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mkv: '' },
    audio: { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', weba: 'audio/webm' },
    image: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' },
    pdf: { pdf: 'application/pdf' },
    text: Object.fromEntries('txt md json js ts css html htm xml csv log ini yml yaml py java c cpp h cs go rs sh bat toml sql srt vtt'.split(' ').map((e) => [e, 'text/plain'])),
  };
  const fileExt = (name) => (String(name).match(/\.([a-z0-9]{1,8})$/i) || ['', ''])[1].toLowerCase();
  function fileKind(name, type) {
    const ext = fileExt(name);
    for (const kind in FILE_KINDS) if (ext in FILE_KINDS[kind]) return kind;
    const t = String(type || '');
    return /^(video|audio|image|text)\//.test(t) ? t.split('/')[0] : t === 'application/pdf' ? 'pdf' : 'other';
  }
  const kindIcon = (kind) => ({ video: 'film', audio: 'music', image: 'image' })[kind] || 'file';
  const canView = (name, type) => fileKind(name, type) !== 'other';
  // the storage an earlier version kept downloads in is no longer used: free it once
  if (!store.get('dlPurged', 0)) {
    store.set('dlPurged', 1); store.del('downloads');
    try { navigator.storage.getDirectory().then((root) => root.removeEntry('downloads', { recursive: true })).catch(() => { }); } catch { }
  }
  function holdFile(where, meta, source) {
    const m = (getMsgs(where.sid)[where.cid] || []).find((x) => x.id === where.mid);
    const key = dlKey(where.sid, where.cid, where.mid);
    held.delete(key);
    held.set(key, { key, id: (m && m.file && m.file.id) || key, name: meta.name, type: meta.type || '', size: meta.size, from: m ? m.a.name : '', ...source });
    while (held.size > HELD_MAX) held.delete(held.keys().next().value);
    queueFileCardPaint(where.sid, where.cid, where.mid);
  }
  // A finished download that arrived in memory (anything under 100 MB).
  function saveFileDownload(blob, name, where) {
    const m = where && (getMsgs(where.sid)[where.cid] || []).find((x) => x.id === where.mid);
    const type = (m && m.file && m.file.type) || blob.type || '';
    if (m && m.a.id === me.id && canView(name, type)) return openViewer({ id: m.file.id, name, type, size: blob.size, from: '' }, blob); // my own file: just open it
    exportFile(blob, name);
    if (where && m && m.a.id !== me.id && canView(name, type)) holdFile(where, { name, type, size: blob.size }, { blob });
  }
  // A large download is written piece by piece to a place the person picks, never held in memory.
  function openFileDownload(meta, strategy, where) {
    if (!strategy.stream || typeof window.showSaveFilePicker !== 'function') return null;
    // Open within the Download click, before awaiting anything, to retain user activation.
    const selection = window.showSaveFilePicker({ suggestedName: meta.name, id: 'dischord-download' });
    return selection.then(async (handle) => {
      const writer = await handle.createWritable({ keepExistingData: false });
      return {
        write: (bytes) => writer.write(bytes),
        close: async () => {
          await writer.close();
          // the saved file can be read back, so it can be played without loading it into memory
          if (where && canView(meta.name, meta.type) && typeof handle.getFile === 'function') holdFile(where, meta, { handle });
        },
        abort: () => writer.abort(),
      };
    });
  }
  // Clicking a file: open it if it is still here from this session, otherwise download it.
  function startDownload(sid, cid, mid) {
    const h = held.get(dlKey(sid, cid, mid));
    return h ? openHeld(h) : fileTransfers.download(sid, cid, mid);
  }
  async function openHeld(h) {
    let blob = h.blob;
    if (!blob) try { blob = await h.handle.getFile(); } catch { blob = null; }
    if (blob) return openViewer(h, blob);
    held.delete(h.key);
    const [sid, cid, mid] = h.key.split('/');
    queueFileCardPaint(sid, cid, mid);
    toast('That file can no longer be read. Download it again.');
  }

  // A picture that can be zoomed where it is shown: pinch or scroll to zoom at that point, drag to move
  // around once zoomed, double-tap or double-click to zoom in and back out.
  function zoomable(box) {
    const img = box && box.querySelector('img');
    if (!img || box._zoomable) return;
    box._zoomable = true;
    box.classList.add('zoomable');
    let s = 1, x = 0, y = 0, pinch = null, drag = null, tap = 0, moved = false;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const apply = () => {
      const mx = Math.max(0, (img.offsetWidth * s - box.clientWidth) / 2), my = Math.max(0, (img.offsetHeight * s - box.clientHeight) / 2);
      x = clamp(x, -mx, mx); y = clamp(y, -my, my);
      img.style.transform = s > 1 ? `translate(${x}px, ${y}px) scale(${s})` : '';
      box.classList.toggle('zoomed', s > 1);
    };
    // zoom to `next` keeping the point at (cx, cy) on screen where it is
    const zoomAt = (next, cx, cy) => {
      next = clamp(next, 1, 8);
      const r = img.getBoundingClientRect(), ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2), k = next / s;
      x -= ox * (k - 1); y -= oy * (k - 1); s = next;
      if (s <= 1.01) { s = 1; x = y = 0; }
      apply();
    };
    const mid = (e) => ({ x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2, d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) || 1 });
    box.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(s * Math.pow(1.0018, -e.deltaY), e.clientX, e.clientY); }, { passive: false });
    box.addEventListener('dblclick', (e) => { e.preventDefault(); zoomAt(s > 1 ? 1 : 2.5, e.clientX, e.clientY); });
    box.addEventListener('touchstart', (e) => {
      moved = false;
      if (e.touches.length === 2) { pinch = { ...mid(e), s }; drag = null; e.preventDefault(); }
      else if (e.touches.length === 1 && s > 1) drag = { x: e.touches[0].clientX - x, y: e.touches[0].clientY - y };
    }, { passive: false });
    box.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const m = mid(e);
        x += m.x - pinch.x; y += m.y - pinch.y; pinch.x = m.x; pinch.y = m.y; // two fingers moving together pan
        zoomAt(pinch.s * m.d / pinch.d, m.x, m.y);
        moved = true;
      } else if (drag && e.touches.length === 1) {
        e.preventDefault();
        x = e.touches[0].clientX - drag.x; y = e.touches[0].clientY - drag.y; moved = true; apply();
      }
    }, { passive: false });
    box.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length) { if (s > 1) drag = { x: e.touches[0].clientX - x, y: e.touches[0].clientY - y }; return; }
      drag = null;
      const t = e.changedTouches[0];
      if (moved || !t) { tap = 0; return; }
      if (now() - tap < 320) { tap = 0; e.preventDefault(); zoomAt(s > 1 ? 1 : 2.5, t.clientX, t.clientY); } else tap = now();
    }, { passive: false });
    // mouse: drag to move around once zoomed
    box.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button || s <= 1) return;
      const from = { x: e.clientX - x, y: e.clientY - y };
      const move = (ev) => { x = ev.clientX - from.x; y = ev.clientY - from.y; apply(); };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); box.classList.remove('panning'); };
      box.classList.add('panning');
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      e.preventDefault();
    });
    img.addEventListener('load', () => { s = 1; x = y = 0; apply(); });
  }

  // ---- built-in viewer and player
  const playerPrefs = { vol: 1, rate: 1, ...store.get('player', {}) };
  const playerPos = store.get('playerPos', {}); // file id -> where playback stopped (seconds)
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const fmtClock = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), ss = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  function openViewer(d, source) {
    const kind = fileKind(d.name, d.type || source.type);
    const media = kind === 'video' || kind === 'audio';
    if (kind === 'other') return exportFile(source, d.name);
    const known = (FILE_KINDS[kind] || {})[fileExt(d.name)];
    // a type the browser can rely on, whatever the sender's computer called it
    const blob = kind === 'text' ? source : source.slice(0, source.size, known !== undefined ? known : (d.type || source.type || ''));
    const url = kind === 'text' ? null : URL.createObjectURL(blob);
    const queue = media ? [...held.values()].filter((x) => ['video', 'audio'].includes(fileKind(x.name, x.type))) : [];
    const at = queue.findIndex((x) => x.id === d.id);
    const pb = (act, ico, title, extra = '') => `<button type="button" class="pl-btn ${extra}" data-pl="${act}" title="${title}" aria-label="${title}">${icon(ico)}</button>`;
    const body = media ? `<div class="player ${kind}" id="player" tabindex="0">
        <div class="pl-stage">${kind === 'video' ? '<video playsinline></video>' : `<audio></audio><div class="pl-art"><div class="pl-disc">${icon('music')}</div><b>${esc(d.name)}</b></div>`}
          <button type="button" class="pl-big" data-pl="play" aria-label="Play">${icon('play')}</button><div class="pl-note hidden"></div></div>
        <div class="pl-ctl">
          <div class="pl-seekrow"><span class="pl-cur">0:00</span><input type="range" class="pl-seek" min="0" max="1000" step="1" value="0" aria-label="Seek"><span class="pl-dur">0:00</span></div>
          <div class="pl-row">
            <div class="pl-group">${queue.length > 1 ? pb('prev', 'prev', 'Previous', at > 0 ? '' : 'off') : ''}${pb('play', 'play', 'Play / pause (Space)', 'main')}${queue.length > 1 ? pb('next', 'next', 'Next', at >= 0 && at < queue.length - 1 ? '' : 'off') : ''}</div>
            <div class="pl-group pl-volume">${pb('mute', 'volume', 'Mute (M)')}<input type="range" class="pl-vol" min="0" max="100" step="1" aria-label="Volume"></div>
            <span class="spacer"></span>
            <div class="pl-group"><button type="button" class="pl-btn pl-rate" data-pl="rate" title="Speed (&lt; &gt;)" aria-label="Playback speed">1×</button>${pb('loop', 'loop', 'Repeat')}${kind === 'video' ? pb('pip', 'pip', 'Picture in picture') + pb('fs', 'expand', 'Fullscreen (F)') : ''}</div>
          </div>
        </div></div>`
      : kind === 'image' ? `<div class="vw-image"><img src="${url}" alt="${esc(d.name)}" draggable="false"></div>`
      : kind === 'pdf' ? `<iframe class="vw-doc" src="${url}" title="${esc(d.name)}"></iframe>`
      : '<pre class="vw-text" id="docText">Loading…</pre>';
    modal(`<header class="vw-head"><span class="vw-kind">${icon(kindIcon(kind))}</span>
        <div class="vw-title"><b title="${esc(d.name)}">${esc(d.name)}</b><span>${window.DischordFiles.formatSize(d.size)}${d.from ? ' · from ' + esc(d.from) : ''}</span></div>
        <button type="button" class="icon-btn" id="vwSave" title="Save to device" aria-label="Save to device">${icon('download')}</button>
        <button type="button" class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button></header>
      <div class="vw-body ${kind}">${body}</div>`, () => {
      $('vwSave').onclick = () => exportFile(source, d.name);
      if (kind === 'image') zoomable($('modal').querySelector('.vw-image'));
      if (kind === 'text') Promise.resolve().then(() => blob.slice(0, 2 * 1024 * 1024).text()).then(
        (text) => { if ($('docText')) $('docText').textContent = text + (blob.size > 2 * 1024 * 1024 ? '\n\n… (only the first 2 MB is shown)' : ''); },
        () => { if ($('docText')) $('docText').textContent = 'This file could not be read.'; });
      const stop = media ? mountPlayer($('player'), d, url, (step) => { const next = queue[at + step]; if (next) openHeld(next); }) : null;
      modalCleanup = () => { if (stop) stop(); if (url) URL.revokeObjectURL(url); };
    }, true, true);
    $('modal').classList.add('viewer');
  }
  // The player: seek bar, volume, speed, repeat, picture in picture, fullscreen, previous / next among the
  // media opened this session, keyboard shortcuts; it remembers volume, speed and where each file stopped.
  function mountPlayer(root, d, url, go) {
    const el = root.querySelector('video, audio'), q = (sel) => root.querySelector(sel), video = el.tagName === 'VIDEO';
    const seek = q('.pl-seek'), vol = q('.pl-vol'), rate = q('.pl-rate'), note = q('.pl-note');
    let seeking = false, idle = null, savedAt = 0, speed = RATES.includes(+playerPrefs.rate) ? +playerPrefs.rate : 1;
    const savePrefs = () => store.set('player', playerPrefs);
    const savePos = () => {
      if (!Number.isFinite(el.duration) || el.duration < 30) return;
      if (el.currentTime > 5 && el.currentTime < el.duration - 5) playerPos[d.id] = Math.floor(el.currentTime); else delete playerPos[d.id];
      const keys = Object.keys(playerPos);
      if (keys.length > 200) delete playerPos[keys[0]];
      store.set('playerPos', playerPos);
    };
    const flash = (text) => { note.textContent = text; note.classList.remove('hidden'); clearTimeout(flash.timer); flash.timer = setTimeout(() => note.classList.add('hidden'), 900); };
    const paint = () => {
      const dur = Number.isFinite(el.duration) ? el.duration : 0;
      const shown = seeking ? seek.value / 1000 * dur : el.currentTime;
      if (!seeking) seek.value = dur ? Math.round(el.currentTime / dur * 1000) : 0;
      seek.style.setProperty('--at', (dur ? shown / dur * 100 : 0) + '%');
      q('.pl-cur').textContent = fmtClock(shown);
      q('.pl-dur').textContent = fmtClock(dur);
      root.querySelectorAll('[data-pl="play"]').forEach((b) => setIcon(b, el.paused ? 'play' : 'pause'));
      setIcon(q('[data-pl="mute"]'), el.muted || !el.volume ? 'volumeOff' : 'volume');
      vol.value = el.muted ? 0 : Math.round(el.volume * 100);
      vol.style.setProperty('--at', vol.value + '%');
      rate.textContent = speed + '×';
      rate.classList.toggle('on', speed !== 1);
      q('[data-pl="loop"]').classList.toggle('on', el.loop);
      root.classList.toggle('playing', !el.paused);
    };
    const toggle = () => { if (el.paused) el.play().catch(() => { }); else el.pause(); };
    const jump = (by) => { el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + by)); flash((by > 0 ? '+' : '−') + Math.abs(by) + 's'); };
    const setVol = (v) => { el.muted = false; el.volume = Math.max(0, Math.min(1, v)); playerPrefs.vol = el.volume; savePrefs(); flash(Math.round(el.volume * 100) + '%'); };
    const setRate = (r) => { speed = r; el.playbackRate = r; playerPrefs.rate = r; savePrefs(); flash(r + '×'); paint(); };
    const fullscreen = () => { if (document.fullscreenElement === root) document.exitFullscreen(); else if (root.requestFullscreen) root.requestFullscreen().catch(() => { }); };
    // the controls of a playing video step aside until the pointer moves again
    const wake = () => { root.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => { if (video && !el.paused && !seeking) root.classList.add('idle'); }, 2200); };

    el.volume = Math.max(0, Math.min(1, +playerPrefs.vol || 1));
    el.src = url;
    el.onloadedmetadata = () => {
      el.playbackRate = speed; // set after loading: a new source resets it
      if (playerPos[d.id] && playerPos[d.id] < el.duration - 5) { el.currentTime = playerPos[d.id]; flash('Resumed at ' + fmtClock(playerPos[d.id])); }
      paint();
    };
    el.ontimeupdate = () => { paint(); if (now() - savedAt > 5000) { savedAt = now(); savePos(); } };
    el.onplay = el.onpause = el.onvolumechange = el.ondurationchange = () => { paint(); wake(); };
    el.onended = () => { delete playerPos[d.id]; store.set('playerPos', playerPos); paint(); if (!video && !el.loop) go(1); };
    el.onerror = () => { note.textContent = "This file's format can't be played here. Save it to your device to open it in another player."; note.classList.remove('hidden'); note.classList.add('error'); };
    seek.oninput = () => { seeking = true; paint(); };
    seek.onchange = () => { if (Number.isFinite(el.duration)) el.currentTime = seek.value / 1000 * el.duration; seeking = false; paint(); };
    vol.oninput = () => { el.muted = false; el.volume = vol.value / 100; playerPrefs.vol = el.volume; savePrefs(); };
    root.onclick = (e) => {
      const b = e.target.closest('[data-pl]');
      if (!b) { if (e.target.closest('.pl-stage')) toggle(); return; }
      if (b.classList.contains('off')) return;
      switch (b.dataset.pl) {
        case 'play': return toggle();
        case 'prev': return go(-1);
        case 'next': return go(1);
        case 'mute': el.muted = !el.muted; return;
        case 'rate': return setRate(RATES[(RATES.indexOf(speed) + 1) % RATES.length]);
        case 'loop': el.loop = !el.loop; return paint();
        case 'fs': return fullscreen();
        case 'pip': if (document.pictureInPictureElement) document.exitPictureInPicture(); else if (el.requestPictureInPicture) el.requestPictureInPicture().catch(() => toast('Picture in picture is not available here.')); return;
      }
    };
    root.ondblclick = (e) => { if (video && e.target.closest('.pl-stage') && !e.target.closest('[data-pl]')) fullscreen(); };
    root.onmousemove = root.ontouchstart = wake;
    root.onmouseleave = () => { if (video && !el.paused && !seeking) root.classList.add('idle'); };
    root.onkeydown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === ' ' || k === 'k') toggle();
      else if (k === 'ArrowLeft') jump(-5); else if (k === 'ArrowRight') jump(5);
      else if (k === 'j') jump(-10); else if (k === 'l') jump(10);
      else if (k === 'ArrowUp') setVol(el.volume + 0.05); else if (k === 'ArrowDown') setVol(el.volume - 0.05);
      else if (k === 'm') el.muted = !el.muted;
      else if (k === 'f' && video) fullscreen();
      else if (k === '>' || k === '.') setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(speed) + 1)]); else if (k === '<' || k === ',') setRate(RATES[Math.max(0, RATES.indexOf(speed) - 1)]);
      else if (k >= '0' && k <= '9' && Number.isFinite(el.duration)) el.currentTime = el.duration * (+k / 10);
      else return;
      e.preventDefault(); e.stopPropagation(); wake();
    };
    paint();
    root.focus({ preventScroll: true });
    el.play().catch(() => { }); // allowed here because opening the file was a click
    return () => { clearTimeout(idle); clearTimeout(flash.timer); savePos(); try { el.pause(); el.removeAttribute('src'); el.load(); } catch { } if (document.pictureInPictureElement === el) document.exitPictureInPicture().catch(() => { }); };
  }
  const filePaints = new Map();
  let filePaintTimer = null;
  function queueFileCardPaint(sid, cid, mid) {
    const key = sid + '/' + cid + '/' + mid;
    const status = fileTransfers.status(sid, cid, mid);
    if (status.state !== 'receiving' || status.progress === 0) {
      filePaints.delete(key);
      paintFileCards(mid, sid, cid); // also update an image lightbox after channel navigation
      return;
    }
    filePaints.set(key, { sid, cid, mid });
    if (filePaintTimer !== null) return;
    filePaintTimer = setTimeout(() => {
      filePaintTimer = null;
      const updates = [...filePaints.values()];
      filePaints.clear();
      for (const update of updates) paintFileCards(update.mid, update.sid, update.cid);
    }, 100);
  }
  // ---- fast file channel. File bytes do not go through chat packets (text, small, acknowledged one batch
  // at a time): each server's hidden connection frame opens one extra binary data channel per person on
  // the peer connection that is already there, and streams the file over it at whatever the link carries.
  // vdoFastFiles runs inside that frame; the page hands it the File and gets received bytes back in batches.
  function vdoFastFiles() {
    if (window.__dischordFast || typeof session === 'undefined' || !session) return;
    window.__dischordFast = true;
    var ID = 900, PIECE = 64 * 1024, READ = 1 << 20, HIGH = 8 << 20, LOW = 1 << 20, WINDOW = 48 << 20, BATCH = 2 << 20;
    var recv = {}, send = {}; // transfer id -> job, for the files I am receiving / sending
    var tell = function (m, transfer) { try { window.parent.postMessage({ dischordFast: m }, '*', transfer || []); } catch (_) { } };
    var each = function (map, ch, fn) { Object.keys(map).forEach(function (x) { if (map[x].ch === ch) fn(map[x], x); }); };
    function fail(ch) {
      [recv, send].forEach(function (map) { each(map, ch, function (j, x) { delete map[x]; j.stop = true; if (j.wake) j.wake(); tell({ ev: 'error', xid: x }); }); });
    }
    // Both ends create the channel with the same fixed number, so it needs no handshake of its own.
    function channel(pc) {
      if (!pc || typeof pc.createDataChannel !== 'function') return null;
      var ch = pc.__dischordFiles;
      if (ch && (ch.readyState === 'open' || ch.readyState === 'connecting')) return ch;
      try { ch = pc.createDataChannel('dischord-files', { negotiated: true, id: ID }); } catch (_) { return null; }
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = LOW;
      ch.onbufferedamountlow = function () { each(send, ch, function (j) { if (j.wake) j.wake(); }); };
      ch.onmessage = function (e) { incoming(ch, e.data); };
      ch.onclose = ch.onerror = function () { fail(ch); };
      pc.__dischordFiles = ch;
      return ch;
    }
    function incoming(ch, data) {
      if (typeof data === 'string') {
        var x = data.slice(1);
        if (data[0] === 'H') { ch.__file = x; if (recv[x] && recv[x].ch === ch) recv[x].on = true; } // the bytes that follow belong to this file
        else if (data[0] === 'A') { // the receiver has safely stored this many bytes
          var cut = x.lastIndexOf(':'), s = send[x.slice(0, cut)];
          if (s && s.ch === ch) { s.acked = Math.max(s.acked, +x.slice(cut + 1) || 0); if (s.wake) s.wake(); tell({ ev: 'progress', xid: x.slice(0, cut) }); }
        }
        return;
      }
      var r = recv[ch.__file];
      if (!r || !r.on || r.ch !== ch || !(data instanceof ArrayBuffer)) return;
      r.parts.push(data); r.held += data.byteLength; r.got += data.byteLength;
      if (r.held < BATCH && r.got < r.size) return;
      var out = new Uint8Array(r.held), at = 0;
      r.parts.forEach(function (part) { out.set(new Uint8Array(part), at); at += part.byteLength; });
      r.parts = []; r.held = 0;
      tell({ ev: 'data', xid: ch.__file, buf: out.buffer }, [out.buffer]);
    }
    function start(c) {
      var ch = channel(session.pcs && session.pcs[c.uuid]);
      if (!ch || !c.file || typeof c.file.slice !== 'function') return tell({ ev: 'error', xid: c.xid });
      var j = send[c.xid] = { ch: ch, acked: 0, stop: false, wake: null };
      var pause = function (ms) { return new Promise(function (done) { j.wake = done; setTimeout(done, ms); }); };
      (async function () {
        try {
          for (var n = 0; ch.readyState === 'connecting' && n < 50 && !j.stop; n++) await pause(100);
          if (j.stop) return;
          if (ch.readyState !== 'open') throw new Error('closed');
          ch.send('H' + c.xid);
          var size = c.file.size, sent = 0;
          while (sent < size) {
            var buf = await c.file.slice(sent, Math.min(size, sent + READ)).arrayBuffer();
            for (var o = 0; o < buf.byteLength; o += PIECE) {
              // wait while the channel's own queue is full, or the receiver is too far behind writing to disk
              while (!j.stop && ch.readyState === 'open' && (ch.bufferedAmount > HIGH || sent - j.acked > WINDOW)) await pause(1000);
              if (j.stop) return;
              if (ch.readyState !== 'open') throw new Error('closed');
              var piece = buf.slice(o, Math.min(buf.byteLength, o + PIECE));
              ch.send(piece);
              sent += piece.byteLength;
            }
          }
          while (!j.stop && j.acked < size) { if (ch.readyState !== 'open') throw new Error('closed'); await pause(1000); }
          if (!j.stop && send[c.xid] === j) { delete send[c.xid]; tell({ ev: 'sent', xid: c.xid }); }
        } catch (_) {
          if (send[c.xid] === j) { delete send[c.xid]; tell({ ev: 'error', xid: c.xid }); }
        }
      })();
    }
    window.addEventListener('message', function (e) {
      if (e.source !== window.parent) return;
      var c = e.data && e.data.dischordFastCmd;
      if (!c || typeof c.xid !== 'string') return;
      if (c.op === 'recv') {
        var ch = channel(session.rpcs && session.rpcs[c.uuid]);
        if (!ch) return tell({ ev: 'error', xid: c.xid });
        recv[c.xid] = { ch: ch, size: c.size, got: 0, held: 0, parts: [], on: ch.__file === c.xid };
      } else if (c.op === 'credit') {
        var r = recv[c.xid];
        if (r && r.ch.readyState === 'open') try { r.ch.send('A' + c.xid + ':' + c.bytes); } catch (_) { }
      } else if (c.op === 'send') start(c);
      else if (c.op === 'stop') [recv, send].forEach(function (map) { var j = map[c.xid]; if (j) { delete map[c.xid]; j.stop = true; if (j.wake) j.wake(); } });
    });
    tell({ ev: 'hello' });
  }
  const fastJobs = new Map(); // transfer id -> { mesh, handlers }
  const fastMesh = (sid, uuid) => { const m = meshes[sid === DM ? connServer(uuid) : sid]; return m && m.fast && m.iframe.contentWindow ? m : null; };
  const fastPost = (m, cmd) => { try { m.iframe.contentWindow.postMessage({ dischordFastCmd: cmd }, new URL(VDO, location.href).origin); return true; } catch { return false; } };
  function fastJob(sid, uuid, xid, cmd, handlers) {
    const m = fastMesh(sid, uuid);
    if (!m || !fastPost(m, { ...cmd, uuid, xid })) return null;
    fastJobs.set(xid, { m, handlers });
    return { credit: (bytes) => fastPost(m, { op: 'credit', xid, bytes }), stop: () => { fastJobs.delete(xid); fastPost(m, { op: 'stop', xid }); } };
  }
  const fastFiles = {
    ready: (sid, uuid) => !!fastMesh(sid, uuid),
    receive: (sid, uuid, xid, size, handlers) => fastJob(sid, uuid, xid, { op: 'recv', size }, handlers),
    send: (sid, uuid, xid, file, handlers) => fastJob(sid, uuid, xid, { op: 'send', file }, handlers),
  };
  function onFastEvent(m, d) {
    if (d.ev === 'hello') { m.fast = true; return; }
    const job = fastJobs.get(d.xid);
    if (!job || job.m !== m) return;
    if (d.ev === 'data') { if (d.buf instanceof ArrayBuffer) job.handlers.data(new Uint8Array(d.buf)); }
    else if (d.ev === 'progress') { if (job.handlers.progress) job.handlers.progress(); }
    else if (d.ev === 'sent') { fastJobs.delete(d.xid); if (job.handlers.done) job.handlers.done(); }
    else if (d.ev === 'error') { fastJobs.delete(d.xid); job.handlers.error(); }
  }
  // Install the channel code in a server's connection frame once that frame is talking to us.
  function armFast(m) {
    if (m.fast || now() - (m.fastAsked || 0) < 3000) return;
    m.fastAsked = now();
    try { m.iframe.contentWindow.postMessage({ function: 'eval', value: '(' + vdoFastFiles.toString() + ')();' }, '*'); } catch { }
  }

  const fileTransfers = window.DischordFiles.create({
    send,
    fast: fastFiles,
    getMessage: (sid, cid, mid) => channel(server(sid), cid)?.type === 'text' ? (getMsgs(sid)[cid] || []).find((m) => m.id === mid) : undefined,
    isPeer: (sid, uid, uuid) => { const via = sid === DM ? connServer(uuid) : sid; return !!(peers[via] && peers[via].get(uuid)?.uid === uid); },
    resolvePeer: (sid, uid, cid, mid) => {
      const origin = fileProviders.get(sid + '/' + cid + '/' + mid);
      const pools = sid === DM ? Object.keys(meshes) : [sid]; // a direct message travels through any shared server
      if (origin && pools.some((via) => peers[via]?.get(origin)?.uid === uid)) return origin;
      for (const via of pools) for (const [id, p] of peers[via] || []) if (p.uid === uid) return id;
      return null;
    },
    userId: () => me && me.id,
    randomId: () => rid(20),
    onChange: queueFileCardPaint,
    saveDownload: saveFileDownload,
    openDownload: openFileDownload,
    maxWindow: () => voice ? 32 : window.DischordFiles.MAX_WINDOW,
  });

  // Only image previews use this cache; original file offers remain opt-in downloads.
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('dischord-img' + (PROFILE ? '-' + PROFILE : ''), 1);
      r.onupgradeneeded = () => r.result.createObjectStore('i');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    return {
      async get(k) {
        try {
          const db = await open();
          return await new Promise((res) => { const q = db.transaction('i').objectStore('i').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
        } catch { return undefined; }
      },
      async put(k, url) {
        // Only image previews may be written here; file bytes never touch browser storage.
        if (typeof url !== 'string' || !url.startsWith('data:image/')) return false;
        try {
          const db = await open();
          return await new Promise((res) => {
            const tx = db.transaction('i', 'readwrite');
            tx.objectStore('i').put(url, k);
            tx.oncomplete = () => res(true);
            tx.onerror = tx.onabort = () => res(false);
          });
        } catch { return false; }
      },
      // Older versions (v12) stored whole files here: delete anything that is not an image.
      async purgeFiles() {
        try {
          const db = await open();
          return await new Promise((res) => {
            const tx = db.transaction('i', 'readwrite'), os = tx.objectStore('i');
            os.openCursor().onsuccess = (e) => {
              const c = e.target.result;
              if (!c) return;
              if (typeof c.value !== 'string' || !c.value.startsWith('data:image/')) c.delete();
              c.continue();
            };
            tx.oncomplete = () => res(true);
            tx.onerror = tx.onabort = () => res(false);
          });
        } catch { return false; }
      },
    };
  })();
  if (!store.get('filesPurged', false)) idb.purgeFiles().then((ok) => { if (ok) store.set('filesPurged', true); });

  const imageKey = (sid, m) => sid + '/' + m.cid + '/' + m.id + '/' + m.img.id;
  const imageMessageKey = (sid, cid, mid) => sid + '/' + cid + '/' + mid;
  const imagePreparing = new Set(), imageErrors = new Set(), imageRetryAfter = new Map();
  function cacheImage(key, url) {
    imgCache.delete(key);
    imgCache.set(key, url);
    let length = [...imgCache.values()].reduce((total, value) => total + value.length, 0);
    while (imgCache.size > 64 || length > 32000000) {
      const first = imgCache.keys().next().value;
      length -= imgCache.get(first).length;
      imgCache.delete(first);
    }
  }
  function findImageMessage(sid, id, cid, mid) {
    if (!server(sid)) return null;
    const all = getMsgs(sid);
    for (const channelId of cid ? [cid] : Object.keys(all)) {
      if (channel(server(sid), channelId)?.type !== 'text') continue;
      const m = (all[channelId] || []).find((m) => !m.del && m.img && m.img.id === id && (!mid || m.id === mid));
      if (m && (m.file ? window.DischordImages.isImage(m.file) && m.img.preview === 1 : !m.img.preview)) return m;
    }
    return null;
  }
  function validImageURL(url, descriptor) {
    if (typeof url !== 'string' || url.length !== descriptor.n) return false;
    if (descriptor.preview) return window.DischordImages.validURL(url);
    return url.length <= IMG_MAX && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url);
  }
  function imageStillLive(sid, m) {
    const current = findImageMessage(sid, m.img.id, m.cid, m.id);
    return current && current.img.n === m.img.n && current.img.preview === m.img.preview;
  }
  async function getImg(sid, m) {
    const key = imageKey(sid, m);
    if (imgCache.has(key)) return imgCache.get(key);
    let url = await idb.get(key);
    // Older versions stored images by global ID. Only existing saved legacy
    // associations may migrate one; a fresh packet in another server cannot.
    if (!url && !m.file && legacyImageKeys.has(key)) url = await idb.get(m.img.id);
    if (validImageURL(url, m.img)) cacheImage(key, url); else url = undefined;
    return url;
  }
  async function prepareImagePreview(sid, cid, mid, attachment) {
    const key = imageMessageKey(sid, cid, mid);
    const live = () => {
      if (!server(sid) || channel(server(sid), cid)?.type !== 'text') return null;
      const m = (getMsgs(sid)[cid] || []).find((m) => m.id === mid && !m.del);
      return m && m.file && m.file.id === attachment.meta.id && fileTransfers.hasLocal(sid, cid, mid) ? m : null;
    };
    imagePreparing.add(key);
    try {
      if (!live()) return;
      const preview = await window.DischordImages.createPreview(attachment.file);
      let current = live();
      if (!current) return;
      const img = cleanImg({ ...preview, id: rid(16) });
      if (!img || !img.preview || !validImageURL(preview.url, img)) throw new Error('Could not create the image preview.');
      const cacheKey = imageKey(sid, { ...current, img });
      cacheImage(cacheKey, preview.url);
      await idb.put(cacheKey, preview.url);
      current = live();
      if (!current) { imgCache.delete(cacheKey); return; }
      // Use the current caption/reply/edited state after asynchronous decoding.
      const updated = { ...current, img };
      if (addMsg(sid, updated)) {
        imageErrors.delete(key);
        send(sid, { t: 'edit', m: updated });
        renderIfCurrent(sid, cid);
      }
    } catch {
      if (live()) { imageErrors.add(key); renderIfCurrent(sid, cid); }
    } finally {
      imagePreparing.delete(key);
      if (live()) renderIfCurrent(sid, cid);
    }
  }

  const sleep = (ms) => bgTimer.sleep(ms);
  const pushing = new Map();   // id/uuid -> ts (avoid duplicate sends)
  async function pushImage(sid, id, uuid, cid, mid) {
    if (!uuid) return;
    const m = findImageMessage(sid, id, cid, mid);
    if (!m) return;
    const k = imageKey(sid, m) + '/' + uuid;
    if (pushing.has(k) && now() - pushing.get(k) < 20000) return;
    const url = await getImg(sid, m);
    if (!url || !imageStillLive(sid, m)) return;
    pushing.set(k, now());
    const n = Math.ceil(url.length / IMG_CHUNK);
    for (let i = 0; i < n; i++) {
      if (!imageStillLive(sid, m)) return;
      if (!send(sid, { t: 'imgc', id, cid: m.cid, mid: m.id, i, n, d: url.slice(i * IMG_CHUNK, (i + 1) * IMG_CHUNK) }, uuid)) return;
      if (i % 6 === 5) await sleep(15); // don't flood the data channel
    }
  }

  const incoming = {};         // scoped image key -> { n, parts, got }
  const requested = {};        // scoped image key -> preview request + optional download intent
  function onImgChunk(sid, p, uuid) {
    if (!isStr(p.id, 64) || !uuid) return;
    const candidates = Object.values(requested).filter((r) => r.sid === sid && r.id === p.id && (!p.cid || r.cid === p.cid) && (!p.mid || r.mid === p.mid));
    if (candidates.length !== 1) return;
    const request = candidates[0];
    const m = findImageMessage(sid, p.id, request.cid, request.mid);
    if (!m || m.img.n !== request.length || (request.uuid && request.uuid !== uuid)) return;
    if (m.img.preview && (p.cid !== request.cid || p.mid !== request.mid)) return;
    const count = Math.ceil(m.img.n / IMG_CHUNK);
    if (!Number.isInteger(p.i) || p.n !== count || p.i < 0 || p.i >= count || typeof p.d !== 'string' || p.d.length !== Math.min(IMG_CHUNK, m.img.n - p.i * IMG_CHUNK)) return;
    request.uuid = uuid;
    const b = (incoming[request.key] = incoming[request.key] || { n: p.n, parts: new Array(p.n), got: 0 });
    if (b.n !== p.n || b.parts[p.i] !== undefined) return;
    b.parts[p.i] = p.d; b.got++;
    armImageRequest(request, 20000); // data is flowing: only a stall ends the request, not the total time
    if (b.got < b.n) {
      if (b.got % 8 === 0) imageProgress(request, Math.round(b.got / b.n * 100));
      return;
    }
    const url = b.parts.join('');
    delete incoming[request.key];
    clearTimeout(request.timer); delete requested[request.key];
    if (!validImageURL(url, m.img)) return;
    cacheImage(request.key, url);
    idb.put(request.key, url);
    imageErrors.delete(imageMessageKey(sid, m.cid, m.id));
    imageRetryAfter.delete(imageMessageKey(sid, m.cid, m.id));
    paintImages();
  }
  function requestImg(sid, id, cid, mid, force = false) {
    const m = findImageMessage(sid, id, cid, mid);
    if (!m) return;
    const key = imageKey(sid, m);
    if (requested[key]) return;
    if (Object.keys(requested).length >= 4) return; // bound preview buffers and mesh traffic
    const messageKey = imageMessageKey(sid, m.cid, m.id);
    if (!force && (imageRetryAfter.get(messageKey) || 0) > now()) return;
    requested[key] = { key, sid, id, cid: m.cid, mid: m.id, length: m.img.n, messageKey, timer: null };
    armImageRequest(requested[key], 10000); // nobody who has it is online: free the slot quickly for other images
    send(sid, { t: 'imgreq', id, cid: m.cid, mid: m.id });
  }
  // A preview that could not be fetched was only tried again when the channel happened to be redrawn, so it
  // could stay "unavailable" with the sender sitting right there. Someone connecting is the moment a source
  // appears: ask them for anything still wanted, and give the failed ones another go.
  function retryImages(sid, uuid) {
    for (const r of Object.values(requested)) {
      if (r.sid !== sid && r.sid !== DM) continue;
      if (send(r.sid, { t: 'imgreq', id: r.id, cid: r.cid, mid: r.mid }, uuid)) armImageRequest(r, 10000);
    }
    let cleared = false;
    for (const place of [sid, DM]) {
      for (const key of [...imageRetryAfter.keys()]) if (key.startsWith(place + '/')) imageRetryAfter.delete(key);
      for (const key of [...imageErrors]) if (key.startsWith(place + '/')) { imageErrors.delete(key); cleared = true; }
    }
    if (cur.sid !== sid && cur.sid !== DM) return;
    if (cleared) renderMessages(); else paintImages();
  }
  function armImageRequest(request, ms) {
    clearTimeout(request.timer);
    request.timer = setTimeout(() => {
      if (requested[request.key] !== request) return;
      delete requested[request.key]; delete incoming[request.key];
      const already = imageErrors.has(request.messageKey);
      imageErrors.add(request.messageKey);
      imageRetryAfter.set(request.messageKey, now() + 15000);
      if (!already) renderIfCurrent(request.sid, request.cid); // a repeat failure changes nothing on screen
    }, ms);
  }
  function imageProgress(request, pct) {
    if (request.sid !== cur.sid || request.cid !== cur.cid) return;
    document.querySelectorAll('img[data-img]:not([src])').forEach((el) => {
      if (el.dataset.imgMid !== request.mid) return;
      const status = el.parentElement.querySelector('.image-preview-status');
      if (status) status.textContent = `Loading image… ${pct}%`;
    });
  }
  function cancelImageRequests(sid, cid, mid) {
    for (const [key, request] of Object.entries(requested)) {
      if ((sid && request.sid !== sid) || (cid && request.cid !== cid) || (mid && request.mid !== mid)) continue;
      clearTimeout(request.timer);
      delete requested[key]; delete incoming[key];
    }
    const prefix = sid ? sid + '/' + (cid ? cid + '/' + (mid ? mid + '/' : '') : '') : '';
    for (const key of imgCache.keys()) if (key.startsWith(prefix)) imgCache.delete(key);
    for (const key of imageErrors) if ((key + '/').startsWith(prefix)) imageErrors.delete(key);
    for (const key of imageRetryAfter.keys()) if ((key + '/').startsWith(prefix)) imageRetryAfter.delete(key);
  }
  function paintImages() {
    // newest first: the picture someone just sent must not wait behind old ones nobody online still has
    [...document.querySelectorAll('img[data-img]:not([src])')].reverse().forEach(async (el) => {
      const sid = el.dataset.imgSid, cid = el.dataset.imgCid, mid = el.dataset.imgMid;
      const m = findImageMessage(sid, el.dataset.img, cid, mid);
      if (!m) return;
      const url = await getImg(sid, m);
      if (!imageStillLive(sid, m)) return;
      if (url) {
        const status = el.parentElement.querySelector('.image-preview-status');
        el.onload = () => {
          // size the box from the real picture, so a wrong or outdated descriptor can never letterbox or crop it
          if (el.naturalWidth && el.naturalHeight && el.parentElement.classList.contains('msg-img')) {
            const k = Math.min(1, 550 / el.naturalWidth, 350 / el.naturalHeight);
            el.parentElement.style.aspectRatio = el.naturalWidth + ' / ' + el.naturalHeight;
            el.parentElement.style.width = `min(100%, ${Math.max(48, Math.round(el.naturalWidth * k))}px)`;
          }
          el.hidden = false;
          el.parentElement.classList.remove('loading');
          imageErrors.delete(imageMessageKey(sid, cid, mid));
          if (status) status.hidden = true;
        };
        el.onerror = () => {
          imageErrors.add(imageMessageKey(sid, cid, mid));
          el.hidden = true;
          el.parentElement.classList.remove('loading');
          if (status) { status.hidden = false; status.textContent = 'Image preview unavailable.'; }
        };
        el.src = url;
        // the load event can be held back while the page is hidden; decoding is not
        if (typeof el.decode === 'function') el.decode().then(() => { if (el.onload) el.onload(); }, () => {});
      } else requestImg(sid, m.img.id, cid, mid);
    });
  }

  const pending = [];          // selected File references; no reading, encoding or persistence
  function addAttachments(files) {
    const s = server(cur.sid), c = channel(s, cur.cid);
    if (!c || c.type !== 'text') return;
    for (const f of [...files].slice(0, 4)) {
      if (pending.length >= 4) { toast('Up to 4 files per message.'); break; }
      const meta = window.DischordFiles.cleanMeta({ id: rid(16), name: f.name, size: f.size, type: f.type });
      if (!meta) { toast('Could not attach that file. Its name or size is invalid.'); continue; }
      pending.push({ meta, file: f });
    }
    renderAttachBar();
    $('msgInput').focus();
  }
  function renderAttachBar() {
    const bar = $('attachBar');
    bar.classList.toggle('hidden', !pending.length);
    bar.innerHTML = pending.map((att, i) => `<div class="att file">${icon('file')}<span class="att-name" title="${esc(att.meta.name)}">${esc(att.meta.name)}</span><span class="att-size">${esc(window.DischordFiles.formatSize(att.meta.size))}</span><button type="button" class="att-x" data-rm="${i}" title="Remove">${icon('x')}</button></div>`).join('') +
      (pending.length ? '<span class="attachment-note">Images show previews automatically.<br>Files are shared on Download. Keep this tab open.</span>' : '');
  }
  function downloadImage(sid, cid, mid) {
    const m = (getMsgs(sid)[cid] || []).find((x) => x.id === mid && !x.del && (x.img || x.file && window.DischordImages.isImage(x.file)));
    if (!m) return;
    // Start within the click so large originals can open the native save picker.
    if (m.file) return startDownload(sid, cid, mid);
    return saveImagePreview(sid, cid, mid);
  }
  async function saveImagePreview(sid, cid, mid) {
    const m = (getMsgs(sid)[cid] || []).find((x) => x.id === mid && !x.del && x.img);
    if (!m) return;
    const url = await getImg(sid, m);
    if (!imageStillLive(sid, m)) return;
    if (!url) { requestImg(sid, m.img.id, cid, mid, true); toast('Image is still loading. Try again in a moment.'); return; }
    const type = (url.match(/^data:image\/(\w+)/) || [, 'png'])[1];
    const ext = type === 'jpeg' ? 'jpg' : type;
    const base = m.file ? m.file.name.replace(/\.[^.]*$/, '') : 'image';
    try {
      const bin = atob(url.slice(url.indexOf(',') + 1)), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      exportFile(new Blob([bytes], { type: 'image/' + type }), (base || 'image') + '.' + ext);
    } catch { toast('Could not save that image.'); }
  }
  async function copyImage(sid, cid, mid) {
    const m = (getMsgs(sid)[cid] || []).find((x) => x.id === mid && !x.del && x.img);
    const url = m && await getImg(sid, m);
    if (!url) return toast('Image is still loading. Try again in a moment.');
    try {
      // the clipboard only takes PNG, so redraw the shared image
      const im = new Image();
      im.src = url;
      await im.decode();
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Image copied');
    } catch { toast('Could not copy the image. Your browser may not allow it.'); }
  }
  async function openImage(sid, cid, mid) {
    const m = (getMsgs(sid)[cid] || []).find((m) => m.id === mid && !m.del && (m.img || m.file && window.DischordImages.isImage(m.file)));
    if (!m) return;
    const url = m.img ? await getImg(sid, m) : null;
    const live = (getMsgs(sid)[cid] || []).find((x) => x.id === mid && !x.del);
    if (!live || (m.img ? !imageStillLive(sid, m) : !live.file || live.file.id !== m.file.id)) return;
    if (!url && m.img) requestImg(sid, m.img.id, cid, mid, true);
    const preview = url ? `<img src="${esc(url)}" alt="${esc(m.file ? m.file.name : 'Shared image')}">` :
      (m.img ? `<img data-img="${esc(m.img.id)}" data-img-sid="${esc(sid)}" data-img-cid="${esc(cid)}" data-img-mid="${esc(mid)}" alt="${esc(m.file ? m.file.name : 'Shared image')}" hidden>` : '') +
      `<span class="image-preview-status" role="status">${m.file ? 'Preview unavailable. You can download the original image.' : 'Loading image preview…'}</span>`;
    modal(`<div class="lightbox">${preview}</div>
      <div class="actions">${m.file ? `<div class="image-download" id="imageDownload" data-image-download="${esc(mid)}" data-image-sid="${esc(sid)}" data-image-cid="${esc(cid)}">${imageDownloadContent(sid, m)}</div>${m.img ? '<button class="btn" id="saveImagePreview">Save preview</button>' : ''}` : '<button class="btn" id="saveOpenImage">Download</button>'}<button class="btn primary" data-close>Close</button></div>`, () => {
      if (m.file) $('imageDownload').onclick = (e) => {
        const button = e.target.closest('[data-file-download], [data-file-cancel]');
        if (!button || button.disabled) return;
        if (button.dataset.fileCancel) fileTransfers.cancel(sid, cid, mid);
        else downloadImage(sid, cid, mid);
      };
      if ($('saveImagePreview')) $('saveImagePreview').onclick = () => saveImagePreview(sid, cid, mid);
      if ($('saveOpenImage')) $('saveOpenImage').onclick = () => downloadImage(sid, cid, mid);
      zoomable($('modal').querySelector('.lightbox'));
    }, true, true);
    $('modal').classList.add('lb');
    if (!url && m.img) paintImages();
  }

  function imageDownloadContent(sid, m, compact = '') {
    const status = fileTransfers.status(sid, m.cid, m.id);
    const active = status.state === 'receiving' || status.state === 'preparing';
    const saving = status.state === 'saving';
    const unavailable = m.a.id === me.id && !fileTransfers.hasLocal(sid, m.cid, m.id);
    const label = active ? 'Cancel download' : saving ? 'Saving…' : status.state === 'error' ? 'Retry download' : 'Download';
    const note = status.state === 'preparing' ? 'Choose where to save this image…' : saving ? 'Saving image…' : active ? `Downloading ${Math.round(status.progress)}%`
      : status.state === 'error' ? status.message : status.state === 'complete' ? 'Saved' : unavailable ? 'Original unavailable after reload.' : '';
    const attrs = `data-file-${active ? 'cancel' : 'download'}="${esc(m.id)}" title="${esc(note || label)}" aria-label="${esc(label + ': ' + m.file.name)}"`;
    if (compact === 'overlay') return `<span class="img-save" ${attrs} role="button" tabindex="${saving || unavailable ? -1 : 0}" aria-disabled="${saving || unavailable}">${icon(active ? 'x' : 'download')}</span>`;
    const button = `<button type="button" class="${compact ? 'icon-btn' : 'btn'}" ${attrs} ${saving || unavailable ? 'disabled' : ''}>${compact ? icon(active ? 'x' : 'download') : esc(active ? 'Cancel' : label)}</button>`;
    return compact ? button : `${note ? `<small role="status">${esc(note)}</small>` : ''}${button}`;
  }

  function fileCardContent(sid, m) {
    const status = fileTransfers.status(sid, m.cid, m.id);
    const active = status.state === 'receiving' || status.state === 'preparing';
    const saving = status.state === 'saving';
    const unavailable = m.a.id === me.id && !fileTransfers.hasLocal(sid, m.cid, m.id);
    const mine = m.a.id === me.id, kind = fileKind(m.file.name, m.file.type), media = kind === 'video' || kind === 'audio';
    const opens = mine ? kind !== 'other' : held.has(dlKey(sid, m.cid, m.id)); // a click opens it in the viewer
    const large = window.DischordFiles.strategyFor(m.file.size).stream && !mine;
    const size = window.DischordFiles.formatSize(m.file.size) + (large ? (typeof window.showSaveFilePicker === 'function'
      ? ' · you choose a save location when downloading' : ' · large file: uses browser memory here') : '');
    const sub = status.state === 'preparing' ? 'Choose where to save this file…' : saving ? 'Saving file…'
      : active ? `Downloading ${Math.round(status.progress)}%` : status.state === 'error' ? status.message
      : unavailable ? 'Unavailable after reload. Attach it again.'
      : opens && !mine ? window.DischordFiles.formatSize(m.file.size) + ' · saved · click to ' + (media ? 'play' : 'open')
      : status.state === 'complete' ? status.message || 'Saved' : size;
    const btn = active ? `<button type="button" class="icon-btn" data-file-cancel="${esc(m.id)}" title="Cancel">${icon('x')}</button>`
      : `<button type="button" class="icon-btn" data-file-download="${esc(m.id)}" title="${opens ? (media ? 'Play' : 'Open') : status.state === 'error' ? 'Retry download' : 'Download'}" ${unavailable || saving ? 'disabled' : ''}>${icon(opens ? (media ? 'play' : 'expand') : 'download')}</button>`;
    return `${icon(kindIcon(kind))}<div class="mf-text"><button type="button" class="mf-name" data-file-download="${esc(m.id)}" title="${esc(m.file.name)}" aria-label="${esc((opens ? 'Open ' : 'Download ') + m.file.name)}" ${active || unavailable || saving ? 'disabled' : ''}>${esc(m.file.name)}</button><div class="mf-sub" role="status">${esc(sub)}</div></div>${btn}`;
  }
  function paintFileCards(mid, sid = cur.sid, cid = cur.cid) {
    document.querySelectorAll('[data-file-card]').forEach((el) => {
      if (el.dataset.fileCard !== mid || sid !== cur.sid || cid !== cur.cid) return;
      const m = (getMsgs(sid)[cid] || []).find((x) => x.id === el.dataset.fileCard);
      if (m && !m.del && m.file) {
        const html = fileCardContent(sid, m);
        if (el.dataset.raw !== html) { el.dataset.raw = html; el.innerHTML = html; }
      }
    });
    document.querySelectorAll('[data-image-download]').forEach((el) => {
      if (el.dataset.imageDownload !== mid || el.dataset.imageSid !== sid || el.dataset.imageCid !== cid) return;
      const m = (getMsgs(sid)[cid] || []).find((x) => x.id === mid);
      if (m && !m.del && m.file) {
        const html = imageDownloadContent(sid, m, el.dataset.imageCompact || '');
        if (el.dataset.raw !== html) { el.dataset.raw = html; el.innerHTML = html; }
      }
    });
  }

  // ---------------------------------------------------------------- voice
  // The publisher sends my mic/camera/screen and plays everyone's audio (&novideo: no video in).
  function voiceUrl(s, c, withCam, vs, ssVs = vs + 's') {
    const p = new URLSearchParams({ room: roomFor(s, 'v' + c.id), password: s.key, label: me.name, push: vs });
    let u = VDO + '?' + p.toString();
    u += '&autostart&webcam&novideo&nocontrolbar&hideheader&chatbutton=false&nohangupbutton';
    u += `&audiogain=${audioPercent(av.micGain)}`;
    if (store.get('micLabel', '')) u += '&audiodevice=' + encodeURIComponent(store.get('micLabel', '')); // remembered microphone; falls back to default if unplugged
    if (store.get('outLabel', '')) u += '&outputdevice=' + encodeURIComponent(store.get('outLabel', '')); // remembered speakers / headphones
    u += withCam ? `&quality=${CAM_Q[av.camQ] ?? 1}&maxframerate=${av.camFps}` + (store.get('camLabel', '') ? '&videodevice=' + encodeURIComponent(store.get('camLabel', '')) : '') : '&videodevice=0';
    u += `&screensharequality=${SS_Q[av.ssQ] ?? 0}&screensharefps=${av.ssFps}`;
    u += `&maxvideobitrate=${av.camBr}&exclude=${ssVs}`; // preserve exclusion when camera reconnects during a share
    if (!micOn || deaf) u += '&mute';
    if (deaf) u += '&mutespeaker';
    return u;
  }

  // Screen share is its own stream (so it never replaces the camera). It only sends; it plays nothing.
  function screenUrl(ssVs) {
    const s = server(voice.sid);
    const p = new URLSearchParams({ room: roomFor(s, 'v' + voice.cid), password: s.key, label: me.name + ' (screen)', push: ssVs });
    const q = SS_Q[av.ssQ] ?? 0, hint = av.ssHint === 'detail' ? 'detail' : 'motion';
    // Both primary and secondary capture parameters support older self-hosted VDO.Ninja versions.
    // The target bitrate is separate from the publisher cap; motion lets encoding favor the selected FPS.
    return VDO + '?' + p.toString() + `&screenshare&autostart&noaudio&novideo&nopreview&nocontrolbar&hideheader&chatbutton=false&nohangupbutton` +
      `&quality=${q}&screensharequality=${q}&maxframerate=${av.ssFps}&screensharefps=${av.ssFps}` +
      `&outboundvideobitrate=${av.ssBr}&maxvideobitrate=${av.ssBr}&screensharecontenthint=${hint}&contenthint=${hint}` +
      // With the switch off the browser does not offer computer sound at all.
      (av.ssAudio ? '' : '&systemaudio=exclude');
  }

  // Each video/screen on the stage is its own view-only connection, so we control layout + bitrate.
  function viewUrl(vs, br, scale) {
    const p = new URLSearchParams({ view: vs, room: roomFor(server(voice.sid), 'v' + voice.cid), password: server(voice.sid).key });
    // &scale=100: don't let VDO.Ninja downscale to the tile size (that was the blur)
    // a scale below 100 asks the sender to encode a smaller copy for this viewer (cheap self preview)
    return VDO + '?' + p.toString() + '&solo&noaudio&cleanoutput&nocontrolbar&hideheader' + (scale && scale < 100 ? `&scale=${scale}` : '&scale=100&sharperscreen') +
      (br ? `&bitrate=${br}` : '') + (av.codec ? `&codec=${av.codec}` : '');
  }

  function joinVoice(sid, cid, withCam) {
    const s = server(sid), c = channel(s, cid);
    if (!s || !c || c.type !== 'voice') return;
    const rejoin = voice && voice.sid === sid && voice.cid === cid;
    const keepShare = rejoin ? { ssFrame: voice.ssFrame, ss: voice.ss, ssVs: voice.ssVs, ssTimer: voice.ssTimer, ssSettings: voice.ssSettings, ssQuality: voice.ssQuality } : null;
    if (voice) { dropVoiceFrame(); if (!rejoin) stopShare(true); }
    const vs = 'dc' + me.id.slice(0, 10) + rid(5);
    const f = document.createElement('iframe');
    f.allow = 'autoplay; camera; microphone; display-capture; fullscreen; picture-in-picture; clipboard-write';
    f.title = 'Voice connection';
    if (!rejoin && !voiceOccupants(sid, cid).length) delete callStarts[sid + '/' + cid]; // nobody here: a new call begins now
    noteCallStart(sid, cid, now());
    const call = { sid, cid, iframe: f, cam: !!withCam, ss: false, vs, ssFrame: null, ssVs: vs + 's', timers: new Set(), since: rejoin && voice.since ? voice.since : now(), ...(keepShare || {}) };
    voice = call;
    for (const k in sentVol) delete sentVol[k];
    f.addEventListener('load', () => {
      if (voice !== call) return;
      // load can precede media setup; also replay on VDO.Ninja's media-ready events.
      for (const delay of [0, 1000, 2500, 5000]) scheduleVoice(call, () => {
        if (!call.loudnessReady) call.loudnessRequested = false;
        syncVoiceState(call);
      }, delay);
    });
    const load = () => { f.src = voiceUrl(s, c, withCam, vs, call.ssVs); };
    // Keep the first navigation in the join gesture. Rejoins let the old device close first.
    if (rejoin) scheduleVoice(call, load, 500); else load();
    $('pubHost').appendChild(f);
    broadcastState();
    if (!rejoin) playTone(true);
    render();
  }

  function dropVoiceFrame() {
    if (!voice) return;
    voice.timers.forEach(clearTimeout);
    voice.timers.clear();
    const f = voice.iframe;
    try { f.contentWindow.postMessage({ function: 'eval', value: 'if (window.__dischordAudioGainV1) window.__dischordAudioGainV1.close();' }, '*'); } catch { }
    try { f.contentWindow.postMessage({ close: true }, '*'); } catch { }
    setTimeout(() => f.remove(), 300);
  }

  function leaveVoice() {
    if (!voice) return;
    dropVoiceFrame();
    stopShare(true);
    voice = null;
    focusUid = null;
    for (const k in speaking) delete speaking[k];
    broadcastState();
    playTone(false);
    render();
  }

  function voicePost(o) { if (voice && voice.iframe.contentWindow) voice.iframe.contentWindow.postMessage(o, '*'); }

  // Executed through VDO.Ninja's documented iframe eval API. Only this fixed function
  // and a JSON object of clamped numeric preferences cross the iframe boundary.
  // Noise suppression: RNNoise (rnnoise/, a small neural network) runs as an audio worklet on my microphone
  // inside the call frame, between VDO's microphone source and its gain node. Called again every few
  // seconds with the volumes, so a rebuilt microphone pipeline (device change) gets the filter back.
  function vdoDenoiseBridge(config) {
    if (typeof session === 'undefined' || !session || !session.webAudios) return;
    var NAME = '@sapphi-red/web-noise-suppressor/rnnoise';
    var b = window.__dischordDenoise || (window.__dischordDenoise = { wasm: null, loading: false, failed: false });
    if (config.on && !b.wasm && !b.loading && !b.failed) {
      b.loading = true;
      var simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
      fetch(config.base + (simd ? 'rnnoise_simd.wasm' : 'rnnoise.wasm')).then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(function (buffer) { b.wasm = buffer; }).catch(function () { b.failed = true; }).then(function () { b.loading = false; });
    }
    Object.keys(session.webAudios).forEach(function (id) {
      var wa = session.webAudios[id];
      if (!wa || !wa.mediaStreamSource || !wa.gainNode || !wa.audioContext) return;
      var ctx = wa.audioContext;
      if (!config.on) {
        if (!wa.__denoise) return;
        try { wa.mediaStreamSource.disconnect(wa.__denoise); wa.__denoise.disconnect(); wa.mediaStreamSource.connect(wa.gainNode); wa.__denoise.port.postMessage('destroy'); } catch (_) { }
        wa.__denoise = null;
        return;
      }
      if (wa.__denoise || !b.wasm || ctx.sampleRate !== 48000 || !ctx.audioWorklet) return; // RNNoise is a 48 kHz model
      if (!ctx.__denoiseModule) ctx.__denoiseModule = ctx.audioWorklet.addModule(config.base + 'worklet.js').then(function () { ctx.__denoiseReady = true; }, function () { b.failed = true; });
      if (!ctx.__denoiseReady) return;
      try {
        var node = new AudioWorkletNode(ctx, NAME, { processorOptions: { wasmBinary: b.wasm, maxChannels: 2 } });
        wa.mediaStreamSource.disconnect(wa.gainNode);
        wa.mediaStreamSource.connect(node); node.connect(wa.gainNode);
        wa.__denoise = node;
      } catch (_) { try { wa.mediaStreamSource.connect(wa.gainNode); } catch (__) { } b.failed = true; }
    });
  }
  function vdoAudioGainBridge(config) {
    if (typeof session === 'undefined' || !session) return;
    const s = session;
    const limit = (n, maximum, fallback) => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(maximum, n)) : fallback;
    s.audioGain = limit(config.micGain, 200, 100);
    if (typeof changeMainGain === 'function') changeMainGain(s.audioGain);
    let bridge = window.__dischordAudioGainV1;
    if (!bridge) {
      if (typeof addAudioPipeline !== 'function') return;
      const original = addAudioPipeline;
      bridge = { streams: {}, deaf: false, records: new Map() };
      bridge.volume = (peer) => bridge.deaf ? 0 : limit(bridge.streams[peer.streamID], 2, 1);
      bridge.dispose = (record) => {
        if (!record) return;
        try { if (record.source) record.source.disconnect(); } catch { }
        try { if (record.gain) record.gain.disconnect(); } catch { }
        // These are our destination tracks, never VDO's original or processed inputs.
        try { if (record.track) record.track.stop(); } catch { }
      };
      const wrapped = function (uuid, track) {
        const processed = original.apply(this, arguments);
        const peer = s.rpcs && s.rpcs[uuid];
        if (!peer || !processed || processed.kind !== 'audio') return processed;
        bridge.dispose(bridge.records.get(uuid));
        bridge.records.delete(uuid);
        const volume = bridge.volume(peer);
        if (volume <= 1) return processed;
        const context = s.audioCtx;
        if (!context || typeof context.createMediaStreamSource !== 'function') return processed;
        const record = { peer, input: processed, source: null, gain: null, track: null };
        try {
          record.source = context.createMediaStreamSource(new MediaStream([processed]));
          record.gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          record.track = destination.stream.getAudioTracks()[0];
          if (!record.track) throw new Error('No destination audio track');
          record.gain.gain.setValueAtTime(volume, context.currentTime);
          record.source.connect(record.gain);
          record.gain.connect(destination);
          bridge.records.set(uuid, record);
          if (context.state === 'suspended') Promise.resolve(context.resume()).catch(() => {});
          // VDO attaches this to its existing media element, retaining mute and sinkId.
          return record.track;
        } catch {
          bridge.dispose(record);
          return processed;
        }
      };
      addAudioPipeline = wrapped;
      bridge.close = () => {
        if (addAudioPipeline === wrapped) addAudioPipeline = original;
        bridge.records.forEach(bridge.dispose);
        bridge.records.clear();
        delete window.__dischordAudioGainV1;
      };
      window.__dischordAudioGainV1 = bridge;
      window.addEventListener('pagehide', bridge.close, { once: true });
    }
    bridge.streams = config.streams || {};
    bridge.deaf = !!config.deaf;
    for (const [uuid, record] of bridge.records) {
      const peer = s.rpcs && s.rpcs[uuid];
      const tracks = peer && peer.videoElement && peer.videoElement.srcObject && peer.videoElement.srcObject.getAudioTracks();
      if (peer !== record.peer || record.input.readyState === 'ended' || !tracks || !tracks.some((track) => track.id === record.track.id)) {
        bridge.dispose(record);
        bridge.records.delete(uuid);
      }
    }
    for (const uuid in s.rpcs || {}) {
      const peer = s.rpcs[uuid];
      if (!peer || !peer.videoElement) continue;
      const volume = bridge.volume(peer);
      let record = bridge.records.get(uuid);
      if (!record && volume > 1 && typeof updateIncomingAudioElement === 'function') {
        // Some hosts install loudness later. Activate their native pipeline for this
        // synchronous rebuild, then restore the host's processing preference.
        const effects = s.audioEffects;
        try { s.audioEffects = true; updateIncomingAudioElement(uuid); } catch { }
        finally { s.audioEffects = effects; }
        record = bridge.records.get(uuid);
      }
      if (record) {
        try { record.gain.gain.setValueAtTime(volume === 0 ? 0 : Math.max(1, volume), s.audioCtx.currentTime); } catch { }
      }
      try { peer.videoElement.volume = Math.min(1, volume); } catch { }
    }
  }

  function scheduleVoice(call, fn, delay) {
    const timer = setTimeout(() => {
      call.timers.delete(timer);
      if (voice === call) fn();
    }, delay);
    call.timers.add(timer);
  }

  function syncVoiceState(call = voice) {
    if (!call || voice !== call) return;
    voicePost({ mic: micOn && !deaf });
    voicePost({ mute: deaf }); // speaker state is independent of the microphone
    applyVolumes(true); // install the audio hook before subscribing to native loudness
    if (!call.loudnessRequested) {
      call.loudnessRequested = true; // set before sending: older hosts can emit a media-ready event here
      voicePost({ getLoudness: true });
    }
  }

  function setMicGain(value) {
    av.micGain = audioPercent(value);
    store.set('av', av);
    applyVolumes(true);
  }
  function setOutVol(value) {
    av.outVol = audioPercent(value);
    store.set('av', av);
    applyVolumes();
  }

  function toggleMic() {
    if (deaf) { deaf = false; micOn = true; }
    else micOn = !micOn;
    syncVoiceState();
    store.set('micOn', micOn); store.set('deaf', deaf);
    broadcastState();
    renderControls(); renderPresence();
  }
  function toggleDeaf() {
    deaf = !deaf;
    syncVoiceState();
    store.set('deaf', deaf);
    broadcastState();
    renderControls(); renderPresence();
  }
  // Flip between the front and back camera without leaving the call. Runs inside the call frame, where
  // the live camera and the device list are: it looks at which way the current camera faces and swaps to
  // one facing the other way (or simply the next camera, when the labels do not say).
  function vdoFlipCamera() {
    (async function () {
      var tell = function (m) { try { window.parent.postMessage({ dischordFlip: m }, '*'); } catch (_) { } };
      try {
        var track = typeof session !== 'undefined' && session && session.streamSrc ? session.streamSrc.getVideoTracks()[0] : null;
        if (!track || typeof changeVideoDeviceById !== 'function') return tell({ ok: false, why: 'off' });
        var now = track.getSettings ? track.getSettings() : {};
        var cams = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === 'videoinput' && d.deviceId; });
        if (cams.length < 2) return tell({ ok: false, why: 'one' });
        var back = /back|rear|environment/i, front = /front|user|face(?!ing back)/i;
        var facingBack = now.facingMode ? now.facingMode === 'environment' : back.test(track.label || '');
        var others = cams.filter(function (d) { return d.deviceId !== now.deviceId; });
        var pick = others.filter(function (d) { return (facingBack ? front : back).test(d.label) && !(facingBack ? back : front).test(d.label); })[0];
        var known = !!pick;
        if (!pick) pick = cams[(Math.max(0, cams.findIndex(function (d) { return d.deviceId === now.deviceId; })) + 1) % cams.length]; // unlabelled: the next one
        changeVideoDeviceById(pick.deviceId);
        tell({ ok: true, label: pick.label || '', back: known ? !facingBack : null });
      } catch (e) { tell({ ok: false, why: String(e && e.message || e) }); }
    })();
  }
  function flipCamera() {
    if (!voice || !voice.cam) return toast('Turn your camera on first.');
    voicePost({ function: 'eval', value: '(' + vdoFlipCamera.toString() + ')();' });
  }
  function onCameraFlipped(r) {
    if (!r || !voice) return;
    if (!r.ok) return toast(r.why === 'one' ? 'This device has only one camera.' : r.why === 'off' ? 'The camera is not running yet. Try again in a moment.' : 'Could not switch camera.');
    if (r.label) store.set('camLabel', r.label); // rejoining keeps the camera you flipped to
    const call = voice;
    scheduleVoice(call, () => syncVoiceState(call), 1500); // re-apply mute after the swap, as for any device change
    toast(r.back === null || r.back === undefined ? 'Camera: ' + (r.label || 'switched') : r.back ? 'Back camera' : 'Front camera', 1500);
  }
  // phones and tablets: anything driven by touch
  const touchDevice = () => mobileLayout() || document.documentElement.classList.contains('android-client') || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
  function toggleCam() {
    if (!voice) return;
    joinVoice(voice.sid, voice.cid, !voice.cam); // rejoin so the camera is truly released when off
  }
  // Sharing a screen with system audio captures everything the computer plays, including the voices of
  // this call, and sends them back to the people speaking: that is the echo. Ask the browser to leave
  // this page's own audio out of the capture; game and video sound is still shared. Measured in Edge:
  // the filter only works when restrictOwnAudio and echoCancellation are both on (VDO turns the latter off).
  // The publisher frame is another origin, so the request is added through VDO's eval API, repeated
  // until the frame confirms it, which happens before it asks for the screen.
  function shareOwnAudioPatch() {
    if (window.__dischordOwnAudio) return;
    var media = navigator.mediaDevices;
    if (!media || typeof media.getDisplayMedia !== 'function') return;
    var original = media.getDisplayMedia.bind(media);
    media.getDisplayMedia = function (constraints) {
      try {
        if (constraints && constraints.audio) {
          var audio = constraints.audio === true ? {} : Object.assign({}, constraints.audio);
          audio.restrictOwnAudio = true; audio.echoCancellation = true;
          constraints = Object.assign({}, constraints, { audio: audio });
        }
      } catch (_) { }
      return original(constraints);
    };
    window.__dischordOwnAudio = true;
    try { window.parent.postMessage({ dischordOwnAudio: 'ready' }, '*'); } catch (_) { }
  }
  function protectShareAudio(frame, origin) {
    const code = '(' + shareOwnAudioPatch.toString() + ')();';
    let tries = 0;
    const timer = setInterval(() => {
      if (!voice || voice.ssFrame !== frame || frame.dataset.ownAudio === 'ready' || ++tries > 250) return clearInterval(timer);
      try { frame.contentWindow.postMessage({ function: 'eval', value: code }, origin); } catch { }
    }, 60);
  }

  function toggleShare() {
    if (!voice) return;
    if (voice.ssFrame) return stopShare();
    if (mobileLayout() && (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function')) {
      toast('Screen sharing is unavailable in this browser. You can still watch shared screens and use your camera.', 7000);
      return;
    }
    const ssVs = voice.ssVs;
    const f = document.createElement('iframe');
    f.allow = 'autoplay; display-capture; fullscreen';
    f.src = screenUrl(ssVs);
    $('pubHost').appendChild(f);
    voice.ssFrame = f; voice.ssVs = ssVs; voice.ss = false; voice.ssSettings = { ...av };
    voice.ssQuality = { frame: f, streamId: ssVs, origin: new URL(VDO, location.href).origin, desired: shareSettings(av), pending: null, closed: false };
    protectShareAudio(f, voice.ssQuality.origin);
    clearTimeout(voice.ssTimer);
    voice.ssTimer = setTimeout(() => { if (voice && voice.ssFrame === f && !voice.ss) stopShare(true); }, 120000);
    renderControls();
    showVoice();
  }
  function stopShare(silent) {
    if (!voice || !voice.ssFrame) return;
    const f = voice.ssFrame;
    const quality = voice.ssQuality;
    if (quality) {
      quality.closed = true;
      if (quality.pending) {
        clearTimeout(quality.pending.timer);
        cancelShareRestart(quality, quality.pending.requestId);
        quality.pending = null;
      }
    }
    window.dispatchEvent(new CustomEvent('dischord-screen-share-stopped', { detail: { streamId: voice.ssVs } }));
    clearTimeout(voice.ssTimer);
    voice.ssTimer = null;
    try { f.contentWindow.postMessage({ close: true }, '*'); } catch { }
    setTimeout(() => f.remove(), 300);
    voice.ssFrame = null; voice.ss = false; voice.ssSettings = null; voice.ssQuality = null;
    if (!silent) { broadcastState(); renderControls(); renderPresence(); }
  }
  window.addEventListener('dischord-screen-share-cancelled', (e) => {
    if (voice && voice.ssFrame && !voice.ss && e.detail?.streamId === voice.ssVs) stopShare();
  });
  window.addEventListener('dischord-android-call-stop', () => leaveVoice());

  function currentShareQuality(state) {
    return !state.closed && voice && voice.ssFrame === state.frame && voice.ssQuality === state;
  }
  function screenPublisherOrigin(origin) {
    try {
      const configured = new URL(VDO, location.href), candidate = new URL(origin);
      return candidate.origin === configured.origin || (configured.hostname === 'vdo.ninja' && candidate.protocol === 'https:' && candidate.hostname.endsWith('.vdo.ninja'));
    } catch { return false; }
  }
  function cancelShareRestart(state, requestId) {
    window.dispatchEvent(new CustomEvent('dischord-screen-quality-restart-cancel', { detail: { streamId: state.streamId, requestId } }));
  }
  function sendShareQuality(state, pending, operation) {
    if (!currentShareQuality(state) || state.pending !== pending) return;
    const bridge = window.DischordScreenQuality && window.DischordScreenQuality.bridge;
    if (typeof bridge !== 'function') return finishShareQuality(state, { ok: false, error: 'Refresh 叮咚 to load screen-share controls.' });
    pending.operation = operation;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (!currentShareQuality(state) || state.pending !== pending) return;
      finishShareQuality(state, { ok: false, error: 'The screen-share update did not finish. Your current share has been kept.' });
    }, 45000);
    const config = { ...pending.settings, requestId: pending.requestId, operation };
    try {
      state.frame.contentWindow.postMessage({ function: 'eval', value: '(' + bridge.toString() + ')(' + JSON.stringify(config) + ');' }, state.origin);
    } catch { finishShareQuality(state, { ok: false, error: 'Could not reach the active screen share.' }); }
  }
  function updateScreenShareQuality() {
    if (!voice || !voice.ssFrame || !voice.ssQuality) return;
    const state = voice.ssQuality;
    state.desired = shareSettings(av);
    if (!voice.ss || state.pending || state.closed || sameShareSettings(state.desired, voice.ssSettings)) return;
    const pending = { requestId: rid(16), settings: { ...state.desired }, operation: 'apply', timer: null, stoppedDuringRestart: false };
    state.pending = pending;
    sendShareQuality(state, pending, 'apply');
  }
  function finishShareQuality(state, result) {
    if (!currentShareQuality(state) || !state.pending) return;
    const pending = state.pending;
    if (result.prepared && result.ok && pending.operation === 'prepareRestart') {
      pending.operation = 'restart';
      window.dispatchEvent(new CustomEvent('dischord-screen-quality-restart-run', { detail: { streamId: state.streamId, requestId: pending.requestId } }));
      return;
    }
    clearTimeout(pending.timer);
    cancelShareRestart(state, pending.requestId);
    const superseded = !sameShareSettings(state.desired, pending.settings);
    if (!result.ok && result.needsRestart && pending.operation === 'apply' && !superseded && document.documentElement.classList.contains('desktop-client')) {
      pending.operation = 'arming';
      pending.timer = setTimeout(() => {
        if (currentShareQuality(state) && state.pending === pending) finishShareQuality(state, {
          ok: false, error: 'Update the Windows app to restart sharing with the same source automatically.'
        });
      }, 3500);
      window.dispatchEvent(new CustomEvent('dischord-screen-quality-restart', { detail: { streamId: state.streamId, requestId: pending.requestId } }));
      return;
    }
    state.pending = null;
    if (result.ok) {
      voice.ssSettings = { ...voice.ssSettings, ...pending.settings };
      broadcastState();
      renderStage();
      if (!superseded) toast(result.mode === 'restart' ? 'Screen share restarted with the same source.' : 'Screen share settings updated.');
    } else if (result.active === false || (pending.stoppedDuringRestart && result.active !== true)) {
      stopShare();
      if (!superseded) toast(result.error || 'The shared source is no longer available.', 7000);
    } else if (!superseded) toast(result.needsRestart && !document.documentElement.classList.contains('desktop-client')
      ? (document.documentElement.classList.contains('android-client') ? 'This phone could not apply that setting. Your current share is still running.'
        : 'This browser needs you to choose the source again for that setting. Your current share is still running.')
      : result.error || 'This setting could not be applied. Your current share is still running.', 7000);
    if (superseded && currentShareQuality(state)) updateScreenShareQuality();
  }
  window.addEventListener('dischord-screen-quality-restart-ready', (event) => {
    const state = voice && voice.ssQuality, pending = state && state.pending, detail = event.detail;
    if (!state || !pending || pending.operation !== 'arming' || detail?.streamId !== state.streamId || detail.requestId !== pending.requestId) return;
    if (!detail.ok) return finishShareQuality(state, { ok: false, error: detail.error || 'The previous screen or window is no longer available.' });
    if (!sameShareSettings(state.desired, pending.settings)) {
      clearTimeout(pending.timer); cancelShareRestart(state, pending.requestId); state.pending = null;
      return updateScreenShareQuality();
    }
    sendShareQuality(state, pending, 'prepareRestart');
  });
  window.addEventListener('dischord-screen-quality-restart-ran', (event) => {
    const state = voice && voice.ssQuality, pending = state && state.pending, detail = event.detail;
    if (state && pending && pending.operation === 'restart' && detail?.streamId === state.streamId && detail.requestId === pending.requestId && detail.ok === false) {
      finishShareQuality(state, { ok: false, error: detail.error || 'Could not restart sharing with the previous source.' });
    }
  });
  window.addEventListener('dischord-screen-quality-restart-failed', (event) => {
    const state = voice && voice.ssQuality, pending = state && state.pending, detail = event.detail;
    if (state && pending && detail?.streamId === state.streamId && detail.requestId === pending.requestId) {
      finishShareQuality(state, { ok: false, error: detail.error || 'Could not reuse the selected screen or window.' });
    }
  });
  function showVoice() { if (voice) { if (cur.sid !== voice.sid) selectServer(voice.sid); selectChannel(voice.cid); } }

  let audioCtx;
  // Everyone in a call hears the same rising tone when someone joins it and the falling one when someone
  // leaves, not only the person doing it. Each client works this out from who it sees in its own call.
  const callEars = { key: null, here: new Set(), gone: new Map(), quietUntil: 0 };
  function hearCallChanges() {
    const key = voice ? voice.sid + '/' + voice.cid : null;
    if (key !== callEars.key) { // I joined, left or moved: the people already there are not news
      callEars.key = key; callEars.here = new Set(); callEars.gone.clear(); callEars.quietUntil = now() + 4000;
    }
    if (!voice) return;
    const present = new Set(voiceOccupants(voice.sid, voice.cid).filter((o) => !o.self).map((o) => o.user.id));
    const quiet = now() < callEars.quietUntil;
    for (const id of present) {
      if (callEars.gone.delete(id)) continue; // straight back (a reconnect, or switching their camera): not a leave and a join
      if (!callEars.here.has(id)) { callEars.here.add(id); if (!quiet) playTone(true); }
    }
    for (const id of callEars.here) {
      if (present.has(id)) continue;
      const since = callEars.gone.get(id);
      if (!since) callEars.gone.set(id, now());
      else if (now() - since > 2500) { callEars.gone.delete(id); callEars.here.delete(id); if (!quiet) playTone(false); }
    }
  }
  function playTone(up) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine';
      const t = audioCtx.currentTime;
      o.frequency.setValueAtTime(up ? 520 : 780, t);
      o.frequency.linearRampToValueAtTime(up ? 780 : 520, t + 0.15);
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(t + 0.26);
    } catch { }
  }

  // loudness from VDO.Ninja is keyed by stream id (including our own); map it back to users.
  // A slow-moving noise floor per stream keeps background hum from lighting people up.
  const floor = {};
  function onLoudness(obj) {
    if (!obj || typeof obj !== 'object' || !voice) return;
    const ms = members[voice.sid] || {};
    const byVs = { [voice.vs]: me.id };
    for (const id in ms) if (ms[id].vs) byVs[ms[id].vs] = id;
    let changed = false;
    for (const key in obj) {
      const uid = byVs[key];
      const level = +obj[key];
      if (!uid || !isFinite(level)) continue;
      const f = floor[key] == null ? level : floor[key];
      floor[key] = level < f ? f * 0.7 + level * 0.3 : f * 0.98 + level * 0.02;
      if (uid === me.id && (!micOn || deaf)) continue;
      if (level > Math.max(18, floor[key] + 10)) {
        if (!(speaking[uid] > now())) changed = true;
        speaking[uid] = now() + 450;
      }
    }
    if (changed) paintSpeaking();
  }
  function paintSpeaking() {
    document.querySelectorAll('[data-uid]:not([data-ctx])').forEach((el) => el.classList.toggle('speaking', speaking[el.dataset.uid] > now()));
  }

  // ---------------------------------------------------------------- iframe API listener
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.dischordRoutes) return onRoutes(e.source, d.dischordRoutes);
    if (d.dataReceived && d.UUID && isId(d.dataReceived.dischordWho)) {
      const frame = diagFrame(e.source);
      if (frame && frame.kind !== 'chat') { if (diag.who.size > 500) diag.who.clear(); diag.who.set(frame.id + '/' + d.UUID, d.dataReceived.dischordWho); }
      return;
    }

    if (voice && e.source === voice.iframe.contentWindow) {
      if (['joined-room-complete', 'local-microphone-event', 'local-camera-event', 'video-element-created',
        'new-stream-added', 'new-audio-track-added', 'view-connection', 'push-connection'].includes(d.action) && d.value !== false) {
        const call = voice;
        syncVoiceState(call);
        scheduleVoice(call, () => syncVoiceState(call), 250);
      }
      if (d.dischordFlip) return onCameraFlipped(d.dischordFlip);
      if (d.loudness) { voice.loudnessReady = true; onLoudness(d.loudness); }
      if (Array.isArray(d.deviceList) && d.cib === 'dischord-devs' && devWait) devWait.show(d.deviceList);
      if (d.stats) onSendStats(false, d.stats);
      return;
    }
    if (voice && voice.ssFrame && e.source === voice.ssFrame.contentWindow) {
      if (d.dischordOwnAudio === 'ready') { voice.ssFrame.dataset.ownAudio = 'ready'; return; }
      const state = voice.ssQuality;
      if (d.dischordScreenQuality && state && state.pending && d.dischordScreenQuality.requestId === state.pending.requestId && e.origin === state.origin) {
        finishShareQuality(state, d.dischordScreenQuality);
        return;
      }
      if (d.action === 'screen-share-state') {
        if (d.value) {
          clearTimeout(voice.ssTimer); voice.ssTimer = null;
          if (state && screenPublisherOrigin(e.origin)) state.origin = e.origin;
          if (state && state.pending) state.pending.stoppedDuringRestart = false;
          voice.ss = true; broadcastState(); renderControls(); renderPresence();
          updateScreenShareQuality();
        }
        else if (state && state.pending && state.pending.operation === 'restart') state.pending.stoppedDuringRestart = true;
        else stopShare(); // cancelled the picker, or hit Chrome's "Stop sharing"
      }
      if (d.stats) onSendStats(true, d.stats);
      return;
    }

    if (d.stats) {
      for (const el of tileEls.values()) {
        const f = el.querySelector('.tile-media iframe');
        if (f && f.contentWindow === e.source) { onTileStats(el, d.stats); return; }
      }
    }

    if (joining && e.source === joining.iframe.contentWindow) {
      const invite = d.dataReceived && d.dataReceived.dischordJoin;
      if (typeof invite === 'string' && invite.length < 20000) { endJoining(); joinFromInvite(invite); }
      return;
    }
    for (const code in lobbies) if (lobbies[code].iframe.contentWindow === e.source) {
      if (d.UUID && ['push-connection', 'view-connection', 'new-push-connection', 'new-view-connection', 'guest-connected'].includes(d.action) && d.value !== false) lobbyGreet(code, d.UUID);
      return;
    }

    let sid = null;
    for (const id in meshes) if (meshes[id].iframe.contentWindow === e.source) { sid = id; break; }
    if (!sid) return;
    if (d.dischordFast) return onFastEvent(meshes[sid], d.dischordFast);
    armFast(meshes[sid]);

    if (d.dataReceived && d.dataReceived.dischord) {
      onPeerData(sid, d.dataReceived.dischord, d.UUID);
      return;
    }
    if (d.action && d.UUID) {
      const a = d.action;
      const up = ['push-connection', 'view-connection', 'new-push-connection', 'new-view-connection', 'guest-connected'].includes(a) && d.value !== false;
      const down = a === 'end-view-connection' || ((a === 'push-connection' || a === 'view-connection') && d.value === false);
      if (up) greet(sid, d.UUID);
      else if (down) peerGone(sid, d.UUID);
    }
  });

  // ---------------------------------------------------------------- navigation
  const mobileMedia = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 760px), (max-width: 1024px) and (pointer: coarse)') : null;
  const mobileLayout = () => !!(mobileMedia && mobileMedia.matches);
  let mobilePane = null;
  let mobileViewportBaseline = window.innerHeight;
  let mobileFocusFrame = null;
  const reducedMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const mobileAnimations = new WeakMap();
  const activeMobileAnimations = new Set();
  function cancelMobileAnimation(el) {
    const animation = mobileAnimations.get(el);
    if (animation) animation.cancel();
    mobileAnimations.delete(el);
  }
  function animateMobile(el, frames, duration = 180) {
    if (!el) return null;
    cancelMobileAnimation(el);
    if (!mobileLayout() || reducedMotion?.matches || typeof el.animate !== 'function') return null;
    const animation = el.animate(frames, { duration, easing: 'cubic-bezier(.2,.8,.2,1)' });
    mobileAnimations.set(el, animation);
    activeMobileAnimations.add(animation);
    const done = () => {
      activeMobileAnimations.delete(animation);
      if (mobileAnimations.get(el) === animation) mobileAnimations.delete(el);
    };
    animation.finished.then(done, done);
    return animation;
  }
  reducedMotion?.addEventListener?.('change', () => {
    if (reducedMotion.matches) activeMobileAnimations.forEach((animation) => animation.finish());
  });
  function animateMobileView() {
    const c = channel(server(cur.sid), cur.cid);
    if (c?.type === 'voice' && voice && voice.sid === cur.sid && voice.cid === c.id) return;
    const content = $(c ? c.type === 'text' ? 'messages' : 'voiceIdle' : 'welcome');
    animateMobile(content, [{ opacity: .35, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }]);
  }
  function renderMobileNavigation() {
    const narrow = mobileLayout();
    if (!narrow) mobilePane = null;
    document.body.classList.toggle('channels-open', narrow && mobilePane === 'channels');
    document.body.classList.toggle('members-open', narrow && mobilePane === 'members');
    $('mobileBackdrop').classList.toggle('hidden', !narrow || !mobilePane);
    $('mobileBackdrop').inert = !narrow || !mobilePane;
    $('mobileBackdrop').setAttribute('aria-hidden', String(!narrow || !mobilePane));
    $('mobileChannels').setAttribute('aria-expanded', String(narrow && !!mobilePane));
    $('mobileChannels').setAttribute('aria-label', mobilePane ? 'Close navigation' : 'Open servers and channels');
    $('mobileChannelsLabel').textContent = mobilePane ? 'Close' : 'Channels';
    $('mobileServerName').textContent = (server(cur.sid) || {}).name || '叮咚';
    $('mobileCall').classList.toggle('hidden', !voice);
    // Drawers do not take focus or taps while they are offscreen; media keeps running.
    for (const id of ['rail', 'sidebar']) {
      $(id).inert = narrow && mobilePane !== 'channels';
      $(id).setAttribute('aria-hidden', String(narrow && mobilePane !== 'channels'));
    }
    $('members').inert = narrow && mobilePane !== 'members';
    $('members').setAttribute('aria-hidden', String(narrow && mobilePane !== 'members'));
    $('main').inert = narrow && !!mobilePane;
  }
  function setMobilePane(pane) {
    mobilePane = mobileLayout() ? pane : null;
    renderMobileNavigation();
  }
  function updateMobileViewport() {
    const viewport = window.visualViewport;
    const height = viewport ? viewport.height : window.innerHeight;
    const top = viewport ? viewport.offsetTop : 0;
    const style = document.documentElement && document.documentElement.style;
    if (style) {
      style.setProperty('--app-height', Math.round(height) + 'px');
      style.setProperty('--app-top', Math.round(top) + 'px');
      style.setProperty('--visual-bottom', Math.max(0, Math.round(window.innerHeight - height - top)) + 'px');
    }
    const editing = document.activeElement && document.activeElement.matches && document.activeElement.matches('input, textarea, [contenteditable="true"]');
    if (!editing) mobileViewportBaseline = height;
    document.body.classList.toggle('keyboard-open', mobileLayout() && !!editing && height < mobileViewportBaseline - 120);
    renderMobileNavigation();
    if (mobileFocusFrame !== null) { cancelAnimationFrame(mobileFocusFrame); mobileFocusFrame = null; }
    if (mobileLayout() && editing && !$('modalBack').classList.contains('hidden') && $('modal').contains(document.activeElement)) {
      const field = document.activeElement;
      // The keyboard can shrink the viewport after the browser's initial focus
      // scroll. Reveal the field inside its panel once the new size has laid out.
      mobileFocusFrame = requestAnimationFrame(() => {
        mobileFocusFrame = null;
        if (document.activeElement !== field || !field.isConnected || $('modalBack').classList.contains('hidden')) return;
        const scroller = field.closest('.settings-content') || $('modal');
        const area = scroller.getBoundingClientRect(), rect = field.getBoundingClientRect();
        if (rect.bottom > area.bottom - 8) scroller.scrollTop += rect.bottom - area.bottom + 8;
        else if (rect.top < area.top + 8) scroller.scrollTop += rect.top - area.top - 8;
      });
    }
  }
  function selectServer(sid) {
    const changed = cur.sid !== sid;
    saveComposerDraft();
    cur.sid = sid;
    store.set('lastSid', sid);
    const s = server(sid);
    if (s) {
      const want = lastChan[sid];
      const firstText = s.channels.find((c) => c.type === 'text');
      cur.cid = channel(s, want) ? want : (firstText || s.channels[0] || {}).id || null;
    } else cur.cid = null;
    restoreComposerDraft();
    render();
    if (cur.cid) afterChannelSelect();
    if (changed) animateMobileView();
  }
  function selectChannel(cid) {
    const changed = cur.cid !== cid;
    setMobilePane(null);
    saveComposerDraft();
    cur.cid = cid;
    restoreComposerDraft();
    lastChan[cur.sid] = cid;
    store.set('lastChan', lastChan);
    render();
    afterChannelSelect();
    if (changed) animateMobileView();
  }
  function afterChannelSelect() {
    const c = channel(server(cur.sid), cur.cid);
    if (c && c.type === 'text') {
      markRead(cur.sid, cur.cid);
      renderRail(); renderChannels();
      renderMessages(true);
      if (matchMedia('(pointer:fine)').matches) $('msgInput').focus();
    }
  }

  // ---------------------------------------------------------------- servers
  function createServer(name) {
    const s = {
      id: rid(10), key: rid(16), name: name.slice(0, 64), v: now(),
      channels: [
        { id: rid(6), name: '闲聊', type: 'text' },
        { id: rid(6), name: '截图分享', type: 'text' },
        { id: rid(6), name: '开黑语音', type: 'voice' },
        { id: rid(6), name: '闲聊语音', type: 'voice' },
      ],
    };
    servers.push(s);
    saveServers();
    connectMesh(s);
    selectServer(s.id);
    return s;
  }

  function inviteCode(s) { return b64e({ i: s.id, k: s.key, n: s.name, c: s.channels, v: s.v, ...(liveCode(s) ? { j: s.jc } : {}) }); }
  function inviteLink(s) { return location.origin + location.pathname + '#invite=' + inviteCode(s); }

  function joinFromInvite(input) {
    let code = String(input || '').trim();
    if (code.length <= 12 && cleanCode(code).length === 8) return joinByCode(cleanCode(code)); // a short join code, not a link
    const m = code.match(/invite=([A-Za-z0-9_-]+)/);
    if (m) code = m[1];
    let d;
    try { d = b64d(code); } catch { return toast('That invite link doesn\'t look right.'); }
    const def = cleanServerDef({ id: d.i, name: d.n, channels: d.c, v: d.v, jc: d.j });
    if (!def || !isStr(d.k, 64)) return toast('That invite link doesn\'t look right.');
    let s = server(def.id);
    if (!s) {
      s = { ...def, key: d.k };
      servers.push(s);
      saveServers();
      toast(`Joined ${s.name}`);
    }
    if (me) connectMesh(s);
    syncLobbies();
    selectServer(s.id);
    return true;
  }

  function leaveServer(sid) {
    if (voice && voice.sid === sid) leaveVoice();
    disconnectMesh(sid);
    fileTransfers.closeServer(sid);
    cancelImageRequests(sid);
    for (const key of fileProviders.keys()) if (key.startsWith(sid + '/')) fileProviders.delete(key);
    for (const key of composerDrafts.keys()) if (key.startsWith(sid + '/')) composerDrafts.delete(key);
    servers = servers.filter((s) => s.id !== sid);
    saveServers();
    syncLobbies();
    store.del('msgs.' + sid); store.del('known.' + sid);
    delete msgs[sid]; delete members[sid];
    selectServer(servers[0] ? servers[0].id : null);
  }

  // ---------------------------------------------------------------- rendering
  const initials = (n) => (n.match(/\b\p{L}|\p{N}/gu) || [n[0] || '?']).slice(0, 2).join('').toUpperCase();
  function shade(hex, pct) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(c + (pct < 0 ? c : 255 - c) * pct)));
    return '#' + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map((c) => c.toString(16).padStart(2, '0')).join('');
  }
  const avBg = (color) => `linear-gradient(135deg, ${shade(color, 0.18)}, ${shade(color, -0.22)})`;
  const avatar = (u, dot, cls = '') => `<div class="avatar ${cls}" style="background:${avBg(u.color)}">${esc((u.name[0] || '?').toUpperCase())}${dot ? '<span class="dot"></span>' : ''}</div>`;
  const stateIcons = (st) => (st ? (st.s ? '<span class="live-tag">LIVE</span>' : '') + (st.c ? icon('camera', 'mini') : '') + (st.d ? icon('deaf', 'mini off') : st.m ? icon('micOff', 'mini off') : '') : '');

  function render() {
    if (!me) return;
    renderRail();
    renderHeader();
    renderChannels();
    renderMain();
    renderMembers();
    renderUserPanel();
    renderControls();
    renderStage();
  }
  function renderPresence() { renderChannels(); renderMembers(); renderUserPanel(); renderVoiceIdle(); renderStage(); }

  function renderRail() {
    if (!me) return;
    $('serverList').innerHTML = servers.map((s) =>
      `<button class="rail-btn ${s.id === cur.sid ? 'active' : ''} ${serverUnread(s) && s.id !== cur.sid ? 'unread' : ''} ${voice && voice.sid === s.id ? 'in-voice' : ''}" data-sid="${esc(s.id)}" title="${esc(s.name)}">${esc(initials(s.name))}</button>`).join('');
    let total = dmServer.channels.reduce((n, c) => n + unreadCount(DM, c.id), 0);
    $('homeBtn').classList.toggle('active', !cur.sid || cur.sid === DM);
    $('homeBtn').dataset.badge = total ? (total > 99 ? '99+' : total) : '';
    for (const s of servers) for (const c of s.channels) if (c.type === 'text') total += unreadCount(s.id, c.id);
    document.title = (total ? `(${total}) ` : '') + '叮咚';
  }

  function renderHeader() {
    const s = server(cur.sid);
    $('serverName').textContent = s ? s.name : '叮咚';
    $('serverMenuBtn').classList.toggle('hidden', !s || !!s.dm);
    document.body.classList.toggle('dm-view', !!(s && s.dm));
  }

  function voiceOccupants(sid, cid) {
    const out = [];
    if (voice && voice.sid === sid && voice.cid === cid) out.push({ user: me, st: myState(), vs: voice.vs, vss: voice.ss ? voice.ssVs : null, self: true });
    const ms = members[sid] || {};
    for (const id in ms) if (isOnline(ms[id]) && ms[id].vc === cid) out.push({ user: ms[id].user, st: ms[id].st, vs: ms[id].vs, vss: ms[id].vss, rtt: now() - (ms[id].rttAt || 0) < 30000 ? Math.round(ms[id].rtt) : null });
    return out;
  }

  // round-trip time of my chat connection to that person (answered pings); blank for me and for old versions
  function pingTag(o) {
    if (o.self) return '';
    if (o.rtt == null) return `<span class="vu-ping" title="No ping reply from ${esc(o.user.name)} yet">···</span>`;
    return `<span class="vu-ping ${o.rtt < 120 ? 'good' : o.rtt < 300 ? 'ok' : 'bad'}" title="Ping to ${esc(o.user.name)}: ${o.rtt} ms">${o.rtt}ms</span>`;
  }

  function renderChannels() {
    if (!me || listDrag) return; // rebuilding the list would drop whatever is being dragged
    const s = server(cur.sid);
    const el = $('channelList');
    if (!s) {
      el.innerHTML = `<div class="cat"><span>Your servers</span></div>` + (servers.length
        ? servers.map((x) => `<div class="chan" data-sid="${esc(x.id)}"><span class="ico">${icon('hash')}</span><span class="name">${esc(x.name)}</span></div>`).join('')
        : `<div class="chan" style="cursor:default">No servers yet</div>`);
      return;
    }
    if (s.dm) {
      const last = (u) => { const l = getMsgs(DM)[u.id] || []; return l.length ? l[l.length - 1].ts : 0; };
      const list = dms.filter((u) => !u.hid).sort((a, b) => last(b) - last(a));
      el.innerHTML = `<div class="cat"><span>Direct messages</span></div>` + (list.length ? list.map((u) => {
        const n = u.id === cur.cid ? 0 : unreadCount(DM, u.id);
        return `<div class="chan dm ${u.id === cur.cid ? 'active' : ''} ${n ? 'unread' : ''} ${dmOnline(u.id) ? '' : 'offline'}" data-cid="${esc(u.id)}" data-type="text">${avatar(u, true)}<span class="name">${esc(u.name)}</span>${n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''}</div>`;
      }).join('') : `<div class="dm-empty">No conversations yet. Right-click someone in a server and choose <b>Message</b>.</div>`);
      if (channel(s, cur.cid)) $('chanTopic').textContent = dmTopic(cur.cid); // presence changes repaint this list
      return;
    }
    const text = s.channels.filter((c) => c.type === 'text');
    const vc = s.channels.filter((c) => c.type === 'voice');
    let h = `<div class="cat"><span>Text channels</span><button class="icon-btn" data-add="text" title="Create channel">${icon('plus')}</button></div>`;
    for (const c of text) {
      const n = c.id === cur.cid ? 0 : unreadCount(s.id, c.id);
      h += `<div class="chan ${c.id === cur.cid ? 'active' : ''} ${n ? 'unread' : ''}" data-cid="${esc(c.id)}" data-type="text" draggable="true">
        <span class="ico">${icon('hash')}</span><span class="name">${esc(c.name)}</span>
        ${n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''}
</div>`;
    }
    h += `<div class="cat"><span>Voice channels</span><button class="icon-btn" data-add="voice" title="Create channel">${icon('plus')}</button></div>`;
    for (const c of vc) {
      const who = voiceOccupants(s.id, c.id);
      if (!who.length) delete callStarts[s.id + '/' + c.id]; // the call ended when the last person left
      const mine = voice && voice.sid === s.id && voice.cid === c.id;
      h += `<div class="chan ${c.id === cur.cid ? 'active' : ''} ${mine ? 'connected' : ''}" data-cid="${esc(c.id)}" data-type="voice" draggable="true">
        <span class="ico">${icon('speaker')}</span><span class="name">${esc(c.name)}</span>
        ${who.length && callStart(s.id, c.id) ? `<span class="chan-time" data-start="${callStart(s.id, c.id)}" title="Call running for">${fmtDur(now() - callStart(s.id, c.id))}</span>` : ''}
        ${who.length ? `<span class="count">${who.length}</span>` : ''}
</div>`;
      if (who.length) {
        h += `<div class="voice-users" data-vc="${esc(c.id)}">${who.map((o) => `<div class="voice-user" data-uid="${esc(o.self ? me.id : o.user.id)}" draggable="true">${avatar(o.user)}<span class="vu-name">${esc(o.user.name)}</span>${pingTag(o)}<span class="vu-icons">${stateIcons(o.st)}</span></div>`).join('')}</div>`;
      }
    }
    el.innerHTML = h;
    paintSpeaking();
  }

  function renderMain() {
    const s = server(cur.sid);
    const c = channel(s, cur.cid);
    $('welcome').classList.toggle('hidden', !!c);
    $('textView').classList.toggle('hidden', !c || c.type !== 'text');
    $('voiceView').classList.toggle('hidden', !c || c.type !== 'voice');
    const inThisVoice = !!(voice && c && voice.sid === cur.sid && voice.cid === c.id);
    const stageWas = stageShape();
    $('voiceStage').classList.toggle('offstage', !inThisVoice);
    $('voiceStage').classList.toggle('hidden', !voice);
    updateMini();
    morphStage(stageWas);
    $('mainHeader').classList.toggle('hidden', !c);
    $('voiceView').classList.toggle('behind', inThisVoice);
    refreshSearch();
    renderMobileNavigation();

    if (!c) return;
    $('chanIcon').innerHTML = icon(s.dm ? 'at' : c.type === 'text' ? 'hash' : 'speaker');
    $('chanName').textContent = c.name;
    $('chanTopic').textContent = s.dm ? dmTopic(c.id) : c.type === 'voice' ? 'Voice & video, peer-to-peer' : '';
    if (c.type === 'text') {
      $('msgInput').placeholder = s.dm ? `Message @${c.name}` : `Message #${c.name}`;
      renderMessages();
      renderTyping();
    } else renderVoiceIdle();
  }

  // ---------------------------------------------------------------- call stage
  // One tile per person. Tiles are never moved in the DOM (moving an iframe reloads it);
  // focus / strip layout is pure CSS driven by classes and custom properties.
  let listDrag = null;         // a channel or person being dragged in the channel list
  const tileEls = new Map();   // uid -> tile element
  const streamBr = {};         // vs -> chosen kbps (0 = auto)
  const autoFocused = new Set();
  const unwatched = new Set();  // screen share stream ids I chose not to watch (no video is received for them)
  function setWatching(vss, on) {
    if (!vss) return;
    if (on) unwatched.delete(vss); else unwatched.add(vss);
    renderStage();
  }
  let focusUid = null;
  let winFs = null;            // tile key filling the whole app window, or null
  let hideStrip = store.get('hideStrip', false); // focus mode: hide the row of other people under the big tile

  function wantedBr(t) {
    // Preview choices are independent of remote viewers. Keep the active share's cap until it restarts.
    if (t.self) {
      const br = t.screen ? ((voice && voice.ssSettings && voice.ssSettings.ssBr) || av.ssBr) : av.camBr;
      return av.selfPreview === 'low' ? Math.min(br, t.screen ? 1500 : 800) : br;
    }
    const pick = streamBr[t.vs];
    if (pick) return pick;
    const st = t.st || {};
    let br = (t.screen ? st.sb : st.cb) || (t.screen ? 6000 : 2500);
    if (av.recvCap) br = Math.min(br, av.recvCap);
    return br;
  }

  // what should be on stage: a tile per person (camera or avatar) + a tile per screen share
  function stageSpecs() {
    const out = [];
    for (const o of voiceOccupants(voice.sid, voice.cid)) {
      const st = o.st || {};
      const hideSelf = o.self && av.selfPreview === 'off';
      const hideCam = !o.self && hiddenVid[o.user.id];
      out.push({ key: o.user.id, uid: o.user.id, user: o.user, st, self: !!o.self, screen: false, vs: st.c && o.vs && !hideSelf && !hideCam ? o.vs : '' });
      const off = !o.self && unwatched.has(o.vss);
      if (st.s && o.vss) out.push({ key: o.user.id + ':s', uid: o.user.id, user: o.user, st, self: !!o.self, screen: true, vs: hideSelf || off ? '' : o.vss, vss: o.vss, unwatched: off });
    }
    return out;
  }

  // Going between the full call view and the small preview animates from one box to the other, so the
  // call visibly grows out of (or shrinks into) wherever the preview sits.
  function stageShape() {
    const stage = $('voiceStage');
    const shown = !stage.classList.contains('hidden');
    return {
      mini: shown && stage.classList.contains('mini'),
      full: shown && !stage.classList.contains('offstage'),
      rect: typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : null,
    };
  }
  function morphStage(was) {
    const stage = $('voiceStage');
    if (!was.rect || typeof stage.animate !== 'function') return;
    const now = stageShape();
    if (!((was.mini && now.full) || (was.full && now.mini)) || !now.rect.width || !now.rect.height || !was.rect.width) return;
    if (morphStage.running) morphStage.running.cancel(); // never stack two
    stage.classList.remove('slide'); // shrinking out of the call replaces the slide-in from the edge
    const from = `translate(${was.rect.left - now.rect.left}px, ${was.rect.top - now.rect.top}px) scale(${was.rect.width / now.rect.width}, ${was.rect.height / now.rect.height})`;
    const a = stage.animate([{ transformOrigin: '0 0', transform: from }, { transformOrigin: '0 0', transform: 'none' }],
      { duration: 380, easing: 'cubic-bezier(.2, .85, .25, 1.06)' });
    morphStage.running = a;
    a.onfinish = a.oncancel = () => { if (morphStage.running === a) morphStage.running = null; };
  }

  // ---- zoom into a stream: scroll to zoom at the cursor, drag to move, double-click to reset.
  // State is in fractions of the picture (s = scale, u/v = top-left of the visible part), so it survives
  // layout changes; the little map shows which part is on screen.
  const zooms = new Map(); // tile key -> { s, u, v }
  function paintZoom(key) {
    const el = tileEls.get(key);
    if (!el) return;
    const z = zooms.get(key), media = el.querySelector('.tile-media'), map = el.querySelector('.tile-zoom');
    el.classList.toggle('zoomed', !!z);
    if (media) media.style.transform = z ? `translate(${-z.u * z.s * 100}%, ${-z.v * z.s * 100}%) scale(${z.s})` : '';
    if (!map) return;
    map.classList.toggle('hidden', !z);
    if (!z) return;
    const box = map.querySelector('i');
    box.style.left = z.u * 100 + '%'; box.style.top = z.v * 100 + '%';
    box.style.width = 100 / z.s + '%'; box.style.height = 100 / z.s + '%';
    map.querySelector('b').textContent = z.s.toFixed(1) + '×';
  }
  function setZoom(key, s, u, v) {
    s = Math.max(1, Math.min(8, s));
    if (s <= 1.01) zooms.delete(key);
    else zooms.set(key, { s, u: Math.max(0, Math.min(1 - 1 / s, u)), v: Math.max(0, Math.min(1 - 1 / s, v)) });
    paintZoom(key);
  }

  // While I'm in a call but looking elsewhere, keep one stream visible as a small click-to-return preview.
  function updateMini() {
    const stage = $('voiceStage');
    let key = null;
    if (voice && stage.classList.contains('offstage')) {
      const vids = [...tileEls].filter(([, el]) => el.classList.contains('video'));
      const pick = vids.find(([k]) => k === focusUid) || vids.find(([, el]) => el.classList.contains('screen') && !el.classList.contains('self')) ||
        vids.find(([, el]) => !el.classList.contains('self')) || vids[0];
      if (pick) key = pick[0];
    }
    if (key && !stage.classList.contains('mini')) {
      // appearing: come in from the edge it is docked to
      const pos = store.get('miniPos', null), main = $('main');
      const left = !!(pos && main && main.clientWidth && pos.r > (main.clientWidth - (+store.get('miniW', 320) || 320)) / 2);
      stage.style.setProperty('--mini-from', left ? '-130%' : '130%');
      stage.classList.add('slide'); // only a preview that appears on its own slides in; see morphStage
    }
    if (!key) stage.classList.remove('slide');
    stage.classList.toggle('mini', !!key);
    tileEls.forEach((el, k) => el.classList.toggle('mini-main', k === key));
  }

  function renderStage() {
    const host = $('tiles');
    if (!voice) {
      tileEls.forEach((el) => el.remove()); tileEls.clear();
      return;
    }
    $('devDone').classList.toggle('hidden', !voice.devices);
    $('pubHost').classList.toggle('devices', !!voice.devices);
    // where every tile is drawn right now, so a layout change can animate from there
    const before = new Map();
    const animating = !$('voiceStage').classList.contains('offstage') && !document.hidden;
    if (animating) tileEls.forEach((el, key) => { if (typeof el.getBoundingClientRect === 'function') before.set(key, el.getBoundingClientRect()); });
    const seen = new Set();
    for (const t of stageSpecs()) {
      seen.add(t.key);
      const hasVid = !!t.vs;
      let el = tileEls.get(t.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tile';
        el.dataset.key = t.key;
        if (!t.screen) el.dataset.uid = t.uid; // speaking ring is for people, not screens
        el.innerHTML = '<div class="tile-media"></div><div class="tile-name"></div><div class="tile-tools"></div><div class="tile-stats"></div><div class="tile-zoom hidden"><i></i><b></b></div><div class="tile-fx"></div>';
        host.appendChild(el);
        tileEls.set(t.key, el);
      }
      el.style.setProperty('--c', t.user.color);
      const media = el.querySelector('.tile-media');
      const br = hasVid ? wantedBr(t) : 0;
      const vsKey = t.vs || (t.unwatched ? 'unwatched' : '');
      if (el.dataset.vs !== vsKey) {
        el.dataset.vs = vsKey;
        el.dataset.br = br;
        if (hasVid) {
          const f = document.createElement('iframe');
          f.allow = 'autoplay; fullscreen; picture-in-picture';
          f.src = viewUrl(t.vs, br, t.self && av.selfPreview === 'low' ? 35 : 100);
          media.innerHTML = '';
          media.appendChild(f);
        } else if (t.unwatched) media.innerHTML = `<div class="share-ph">${icon('eyeOff')}<span>${esc(t.user.name)} is sharing their screen</span><button type="button" class="btn primary" data-watch="${esc(t.vss)}">Watch stream</button></div>`;
        else if (t.screen) media.innerHTML = `<div class="share-ph">${icon('screen')}<span>You're sharing your screen</span></div>`;
        else media.innerHTML = avatar(t.user, false, 'big');
      } else if (hasVid && +el.dataset.br !== br) {
        el.dataset.br = br; // live bitrate change, no reconnect
        const f = media.querySelector('iframe');
        if (f && f.contentWindow) f.contentWindow.postMessage({ bitrate: br }, '*');
      }
      el.classList.toggle('video', hasVid);
      if (!hasVid) el.querySelector('.tile-stats').textContent = sendNote[t.key] || '';
      el.classList.toggle('screen', t.screen);
      el.classList.toggle('self', t.self);
      const st = t.st;
      const label = t.screen ? `${esc(t.user.name)}${t.self ? ' (you)' : ''}'s screen` : `${esc(t.user.name)}${t.self ? ' (you)' : ''}`;
      const name = (t.screen ? '<span class="live-tag">LIVE</span>' : (st.d ? icon('deaf', 'mini off') : st.m ? icon('micOff', 'mini off') : '')) + `<span>${label}</span>`;
      const nameEl = el.querySelector('.tile-name');
      if (nameEl.dataset.raw !== name) { nameEl.dataset.raw = name; nameEl.innerHTML = name; }
      const tools = hasVid
        ? (t.screen && !t.self ? `<button class="tool-btn" data-unwatch="${esc(t.vss)}" title="Stop watching">${icon('eyeOff')}</button>` : '') +
          (t.self ? '' : `<button class="tool-btn q-btn" data-q="${esc(t.key)}" title="Stream quality">${esc(streamBr[t.vs] ? mbps(br) : 'Auto · ' + mbps(br))}</button>`) +
          `<button class="tool-btn" data-wfs="${esc(t.key)}" title="${winFs === t.key ? 'Exit window fullscreen' : 'Fill the window'}">${icon(winFs === t.key ? 'collapse' : 'winfs')}</button>` +
          `<button class="tool-btn fs-btn" data-fs="${esc(t.key)}" title="${document.fullscreenElement === el ? 'Exit fullscreen' : 'Fullscreen'}">${icon(document.fullscreenElement === el ? 'collapse' : 'expand')}</button>`
        : '';
      const toolsEl = el.querySelector('.tile-tools');
      if (toolsEl.dataset.raw !== tools) { toolsEl.dataset.raw = tools; toolsEl.innerHTML = tools; }

      // someone else's new screen share takes the stage once (click away any time)
      if (t.screen && !t.self && hasVid && !autoFocused.has(t.vs)) { autoFocused.add(t.vs); focusUid = t.key; }
    }
    for (const [key, el] of tileEls) if (!seen.has(key)) { el.remove(); tileEls.delete(key); zooms.delete(key); }
    tileEls.forEach((el, key) => { if (zooms.has(key) && !el.classList.contains('video')) { zooms.delete(key); paintZoom(key); } });
    if (focusUid && !(tileEls.get(focusUid) && tileEls.get(focusUid).classList.contains('video'))) focusUid = null;
    if (winFs && !(tileEls.get(winFs) && tileEls.get(winFs).classList.contains('video'))) winFs = null;
    $('voiceStage').classList.toggle('winfs', !!winFs);
    tileEls.forEach((el, key) => el.classList.toggle('winfull', key === winFs));

    // layout
    const n = tileEls.size;
    host.classList.toggle('focus-mode', !!focusUid);
    if (focusUid) {
      let i = 0;
      const others = n - 1;
      host.style.setProperty('--sn', others);
      tileEls.forEach((el, key) => {
        el.classList.toggle('focused', key === focusUid);
        if (key !== focusUid) el.style.setProperty('--i', i++);
      });
      host.classList.toggle('no-strip', others === 0 || hideStrip);
      host.classList.toggle('strip-off', hideStrip);
    } else {
      const cols = Math.ceil(Math.sqrt(n || 1));
      host.style.setProperty('--cols', cols);
      host.style.setProperty('--rows', Math.ceil((n || 1) / cols));
      tileEls.forEach((el) => el.classList.remove('focused'));
    }
    const st = $('stripToggle'), canStrip = !!focusUid && n > 1 && !winFs;
    st.classList.toggle('hidden', !canStrip);
    st.classList.toggle('off', hideStrip);
    st.title = hideStrip ? 'Show members' : 'Hide members';
    setIcon(st, hideStrip ? 'chevUp' : 'chevDown');
    $('tiles').classList.toggle('show-stats', !!av.showStats);
    paintSpeaking();
    applyVolumes();
    if (animating) glideTiles(before);
    if (animating && winFs !== shownWinFs) { if (winFs) liftStage(before.get(winFs)); else unclipTiles(); }
    shownWinFs = winFs;
    updateMini();
  }

  // Filling the window or the screen grows the picture out of the tile it was in, and shrinks it back
  // there, with the rest of the app staying visible around it instead of cutting to black.
  const POP = { duration: 340, easing: 'cubic-bezier(.2, .85, .25, 1.04)' };
  let shownWinFs = null, unclipTimer = null;
  let fsFrom = null, fsKey = null; // where a tile was before it went fullscreen; which tile is fullscreen
  // entering fill-window: the stage (now covering the app) is revealed from the tile's old box outwards
  function liftStage(was) {
    const stage = $('voiceStage');
    if (!was || !was.width || typeof stage.animate !== 'function') return;
    const r = stage.getBoundingClientRect();
    stage.animate([
      { clipPath: `inset(${was.top - r.top}px ${r.right - was.right}px ${r.bottom - was.bottom}px ${was.left - r.left}px round 10px)` },
      { clipPath: 'inset(0px 0px 0px 0px round 0px)' },
    ], POP);
  }
  // leaving: the tile shrinks back from beyond the call area, so it must not be cut off at its edges meanwhile
  function unclipTiles() {
    document.body.classList.add('tile-out');
    clearTimeout(unclipTimer);
    unclipTimer = setTimeout(() => document.body.classList.remove('tile-out'), POP.duration + 40);
  }
  function popTile(el, from) {
    if (typeof el.animate !== 'function' || typeof el.getBoundingClientRect !== 'function') return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height || !from.width || !from.height) return;
    el.animate([{ transformOrigin: '0 0', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` },
      { transformOrigin: '0 0', transform: 'none' }], POP);
  }
  function tileFullscreen(key) {
    const el = tileEls.get(key);
    if (!el || !el.requestFullscreen) return;
    const edge = (window.outerWidth - window.innerWidth) / 2; // window border; the rest of the difference is the title / tab bar
    fsFrom = { key, rect: el.getBoundingClientRect(), x: window.screenX + edge, y: window.screenY + (window.outerHeight - window.innerHeight) - edge };
    el.requestFullscreen();
  }
  function onFullscreenChange() {
    const el = document.fullscreenElement, key = el && el.dataset ? el.dataset.key : null;
    const from = fsFrom, left = fsKey;
    fsFrom = null; fsKey = key && tileEls.get(key) === el ? key : null;
    if (voice) renderStage(); // swaps the button between expand / exit
    if (!voice || document.hidden) return;
    if (fsKey && from && from.key === fsKey) {
      // The tile's old place on the monitor, seen from the fullscreen picture. Browsers forbid transforming
      // the fullscreen element itself, so its picture is scaled and the tile is revealed along with it.
      const was = { left: from.x + from.rect.left - window.screenX, top: from.y + from.rect.top - window.screenY, width: from.rect.width, height: from.rect.height };
      const full = el.getBoundingClientRect(), media = el.querySelector('.tile-media');
      if (media) popTile(media, was);
      if (typeof el.animate === 'function') el.animate([
        { clipPath: `inset(${was.top - full.top}px ${full.right - was.left - was.width}px ${full.bottom - was.top - was.height}px ${was.left - full.left}px round 10px)` },
        { clipPath: 'inset(0px 0px 0px 0px round 0px)' },
      ], POP);
    } else if (!el && left && tileEls.get(left)) {
      unclipTiles();
      popTile(tileEls.get(left), { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
    }
  }

  // Tiles move between layouts (grid, focused, strip, fill-window) by gliding from where they were to
  // where they now belong, instead of jumping. A tile that just appeared fades in.
  function glideTiles(before) {
    const host = $('tiles');
    if (document.fullscreenElement || typeof host.getBoundingClientRect !== 'function') return;
    const origin = host.getBoundingClientRect();
    const ox = origin.left + (host.clientLeft || 0), oy = origin.top + (host.clientTop || 0);
    const near = (a, b) => Math.abs(a - b) < 1;
    tileEls.forEach((el, key) => {
      if (typeof el.animate !== 'function') return;
      // the destination comes from layout offsets, which a running animation does not disturb
      const to = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      if (!to.w || !to.h) return;
      const same = el._glideTo && near(el._glideTo.x, to.x) && near(el._glideTo.y, to.y) && near(el._glideTo.w, to.w) && near(el._glideTo.h, to.h);
      if (el._glide && same) return; // already on its way there
      const was = before.get(key);
      let frames;
      if (!was || !was.width || !was.height) frames = [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }];
      else {
        const from = { x: was.left - ox, y: was.top - oy, w: was.width, h: was.height }; // where it is drawn now
        el._glideTo = to;
        if (near(from.x, to.x) && near(from.y, to.y) && near(from.w, to.w) && near(from.h, to.h)) return;
        frames = [{ transformOrigin: '0 0', transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.w / to.w}, ${from.h / to.h})` }, { transformOrigin: '0 0', transform: 'none' }];
      }
      el._glideTo = to;
      if (el._glide) el._glide.cancel();
      const a = el._glide = el.animate(frames, { duration: 340, easing: 'cubic-bezier(.2, .85, .25, 1.04)' });
      a.onfinish = a.oncancel = () => { if (el._glide === a) el._glide = null; };
    });
  }

  // ---- per-user volume / mute (applied inside the publisher, which plays everyone's audio)
  const volOf = (uid, stream) => {
    const c = userVol[uid] || {};
    if (deaf || c.m) return 0;
    return audioPercent(stream ? c.sv : c.v) / 100 * audioPercent(av.outVol) / 100; // outVol: master volume
  };
  const sentVol = {};
  function applyVolumes(force) {
    if (!voice) return;
    const streams = {};
    for (const o of voiceOccupants(voice.sid, voice.cid)) {
      if (o.self) continue;
      for (const [vs, stream] of [[o.vs, false], [o.vss, true]]) {
        if (!vs) continue;
        const v = volOf(o.user.id, stream);
        streams[vs] = v;
        if (!force && sentVol[vs] === v) continue;
        sentVol[vs] = v;
        // The top-level volume API also changes the default for future peers.
        // Set only this stream's media element, keeping later joiners audible.
        voicePost({ target: vs, settings: { volume: Math.min(1, v) } });
      }
    }
    for (const vs of ownStreamsHere()) {
      streams[vs] = 0;
      if (!force && sentVol[vs] === 0) continue;
      sentVol[vs] = 0;
      voicePost({ target: vs, settings: { volume: 0 } });
    }
    voicePost({ function: 'eval', value: '(' + vdoAudioGainBridge.toString() + ')(' + JSON.stringify({ micGain: audioPercent(av.micGain), deaf, streams }) + ');' });
    voicePost({ function: 'eval', value: '(' + vdoDenoiseBridge.toString() + ')(' + JSON.stringify({ on: av.denoise !== false, base: new URL('rnnoise/', location.href).href }) + ');' });
  }
  function setVol(uid, patch) {
    const clean = {};
    if ('v' in patch) clean.v = audioPercent(patch.v);
    if ('sv' in patch) clean.sv = audioPercent(patch.sv);
    if ('m' in patch) clean.m = !!patch.m;
    userVol[uid] = { ...(userVol[uid] || {}), ...clean };
    store.set('vol', userVol);
    applyVolumes();
    renderPresence();
  }

  // ---- live stream stats (resolution / fps / bitrate / codec) for every video tile
  function pollStats() {
    tileEls.forEach((el) => {
      const f = el.classList.contains('video') && el.querySelector('.tile-media iframe');
      if (f && f.contentWindow) f.contentWindow.postMessage({ getStats: true }, '*');
    });
    if (voice && voice.cam) voicePost({ getStats: true }); else setSendNote(false, '');
    if (voice && voice.ss && voice.ssFrame.contentWindow) voice.ssFrame.contentWindow.postMessage({ getStats: true }, '*'); else setSendNote(true, '');
  }

  // ---- what is throttling my own stream: the browser lowers fps / resolution / bitrate by itself
  // when the encoder runs out of CPU or the uplink can't carry the bitrate. Shown on my own tiles.
  const sendNote = {};         // tile key -> text
  const limitRuns = {};        // 'cam' | 'ss' -> { why, n, told }
  function setSendNote(screen, text) {
    if (!me) return;
    const key = me.id + (screen ? ':s' : '');
    if ((sendNote[key] || '') === text) return;
    sendNote[key] = text;
    const el = tileEls.get(key);
    if (el && !el.classList.contains('video')) el.querySelector('.tile-stats').textContent = text;
  }
  function onSendStats(screen, stats) {
    const pcs = Object.values((stats && stats.outbound) || {}).filter((o) => o && typeof o === 'object' && (o.quality_limitation_reason !== undefined || o.video_encoder || o.resolution || o.video_bitrate_kbps));
    if (!pcs.length) return setSendNote(screen, '');
    const reasons = pcs.map((o) => o.quality_limitation_reason).filter((r) => r && r !== 'none');
    const why = reasons.includes('cpu') ? 'cpu' : reasons.includes('bandwidth') ? 'bandwidth' : '';
    const up = Math.min(...pcs.map((o) => +o.available_outgoing_bitrate_kbps || Infinity));
    const enc = pcs.map((o) => o.video_encoder).find(Boolean) || '';
    const hw = /MediaFoundation|VideoToolbox|Vaapi|V4L2|D3D|Nv|Amf|Qsv|External/i.test(enc);
    const parts = [];
    const frameRates = pcs.map((o) => {
      const match = String(o.resolution || '').match(/@\s*([\d.]+)/);
      const fps = o.FPS ?? o.fps ?? o._FPS ?? (match ? match[1] : undefined);
      return fps !== undefined && fps !== null && fps !== '' && Number.isFinite(+fps) ? +fps : null;
    }).filter((fps) => fps !== null);
    if (frameRates.length) parts.push(Math.round(Math.min(...frameRates)) + ' fps');
    if (why) parts.push(why === 'cpu' ? 'CPU-limited' : 'uplink-limited');
    parts.push(pcs.length + (pcs.length === 1 ? ' encode' : ' encodes'));
    if (enc) parts.push(hw ? 'hardware' : 'software');
    if (isFinite(up)) parts.push('uplink ' + mbps(Math.round(up)));
    setSendNote(screen, 'sending: ' + parts.join(' · '));

    const run = limitRuns[screen ? 'ss' : 'cam'] || (limitRuns[screen ? 'ss' : 'cam'] = { why: '', n: 0, told: {} });
    if (why !== run.why) { run.why = why; run.n = 0; }
    if (why && ++run.n === 4 && !run.told[why]) { // ~8s in a row, once per reason
      run.told[why] = 1;
      const what = screen ? 'screen share' : 'camera';
      toast(why === 'cpu'
        ? `Your ${what} is being throttled: this PC can't encode it fast enough (${pcs.length} ${hw ? 'hardware' : 'software'} encode${pcs.length === 1 ? '' : 's'}). Try a lower resolution, the H.264 codec, or a Low / Hidden own preview.`
        : `Your ${what} is being throttled: your upload can't carry the bitrate${isFinite(up) ? ' (about ' + mbps(Math.round(up)) + ' available)' : ''}. Pick a bitrate below that for a steady stream.`, 12000);
    }
  }
  function onTileStats(el, stats) {
    const inbound = stats && stats.inbound;
    if (!inbound) return;
    const st = Object.values(inbound).find((x) => x && typeof x === 'object');
    if (!st) return;
    // VDO.Ninja nests per-track stats: { <trackId>: { _type:'video', Resolution, FPS, Bitrate_in_kbps, codec }, 'Peer-to-Peer': {...} }
    const vid = Object.values(st).find((o) => o && typeof o === 'object' && (o._type === 'video' || /video/i.test(o.type || ''))) || st;
    const p2p = st['Peer-to-Peer'] || {};
    const res = vid.Resolution || vid.resolution || (vid._frameWidth ? vid._frameWidth + 'x' + vid._frameHeight : '');
    const fps = vid.FPS ?? vid.fps;
    const br = +(vid.Bitrate_in_kbps ?? vid.video_bitrate_kbps ?? 0);
    const codec = vid.codec || vid.video_codec || '';
    const loss = +(vid.packetLoss_in_percentage || 0);
    const parts = [];
    if (res) parts.push(String(res).replace(/\s+/g, ''));
    if (fps !== undefined && fps !== null && fps !== '' && Number.isFinite(+fps)) parts.push(Math.round(+fps) + ' fps');
    if (br) parts.push(mbps(Math.round(br)));
    if (codec) parts.push(String(codec).replace(/^video\//i, '').toUpperCase());
    if (loss >= 1) parts.push(loss.toFixed(1) + '% loss');
    if (p2p.candidateType_remote === 'relay') parts.push('relayed');
    if (sendNote[el.dataset.key]) parts.push(sendNote[el.dataset.key]);
    el.querySelector('.tile-stats').textContent = parts.join(' · ');
  }

  // ---- in-call reactions
  function floatReaction(uid, e) {
    const el = tileEls.get(uid);
    if (!el) return;
    const fx = el.querySelector('.tile-fx');
    const span = document.createElement('span');
    span.className = 'float-emoji';
    span.textContent = e;
    span.style.left = (20 + Math.random() * 60) + '%';
    fx.appendChild(span);
    setTimeout(() => span.remove(), 2600);
  }
  function sendCallReaction(e) {
    if (!voice) return;
    floatReaction(me.id, e);
    send(voice.sid, { t: 'creact', e });
  }

  // ---------------------------------------------------------------- right-click menus
  function openCtx(x, y, html, wire) {
    const m = $('ctxMenu');
    m.innerHTML = html;
    paintIcons(m);
    m.classList.remove('hidden');
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
    if (wire) wire(m);
  }
  let ctxAnchor = null, ctxToggled = null; // the button a menu hangs from; and the one whose click just closed it
  const closeCtx = () => { $('ctxMenu').classList.add('hidden'); ctxAnchor = null; };
  // open a menu above (or below) a button; clicking the same button again closes it
  function openAnchored(anchor, html, wire) {
    const rect = anchor.getBoundingClientRect();
    openCtx(rect.left, rect.top, html, (menu) => {
      menu.style.top = (rect.top > window.innerHeight / 2 ? Math.max(6, rect.top - menu.offsetHeight - 8) : Math.min(window.innerHeight - menu.offsetHeight - 6, rect.bottom + 8)) + 'px';
      if (wire) wire(menu);
    });
    ctxAnchor = anchor;
  }
  const ctxItem = (act, ico, label, extra = '') => `<button class="ctx-item ${extra}" data-act="${act}">${ico ? icon(ico) : ''}<span>${label}</span></button>`;
  const ctxCheck = (act, label, on) => `<button class="ctx-item check ${on ? 'on' : ''}" data-act="${act}"><span>${label}</span><i class="box">${on ? icon('check') : ''}</i></button>`;
  const ctxSlider = (act, label, val) => `<div class="ctx-slider"><div class="cs-head"><span>${label}</span><b data-out="${act}">${audioPercent(val)}%</b></div><input type="range" min="0" max="200" step="1" value="${audioPercent(val)}" data-slide="${act}" aria-label="${esc(label)}"></div>`;
  const ctxSelect = (act, label, val, opts) => `<div class="ctx-select"><span>${label}</span><select data-sel="${act}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  const qOpts = (auto) => [[0, 'Auto' + (auto ? ' · ' + mbps(auto) : '')], ...VIEW_BRS.map((k) => [k, mbps(k)])];

  // ---- device menus (the arrow beside, or a right-click on, the call buttons); all inside 叮咚
  let devWait = null;
  const sameLabel = (a, b) => !!a && !!b && String(a).replace(/\W+/g, '_').toLowerCase() === String(b).replace(/\W+/g, '_').toLowerCase();
  const DEV = {
    audioinput: { key: 'micLabel', head: 'Input device', none: 'No microphone found.' },
    audiooutput: { key: 'outLabel', head: 'Output device', none: 'This browser does not list output devices.' },
    videoinput: { key: 'camLabel', head: 'Camera', none: 'No camera found.' },
  };
  const CAM_RES = [['360', '360p'], ['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K']];
  const SS_RES = [['source', 'Source (native)'], ['2160', '4K'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p']];
  const fpsOpts = (list) => list.map((f) => [f, f + ' fps']);
  function saveAv(patch) {
    const shareChanged = SHARE_KEYS.some((key) => key in patch && String(patch[key]) !== String(av[key]));
    av = { ...av, ...patch }; store.set('av', av); broadcastState();
    if (shareChanged) updateScreenShareQuality();
  }
  function deviceMenu(anchor, kind, devicesOnly = false) { // kind: 'audioinput' | 'audiooutput' | 'videoinput'
    closeCtx();
    const info = DEV[kind];
    const token = {};
    clearTimeout(devWait && devWait.timer);
    const show = (list, fromCallFrame = true) => {
      if (!devWait || devWait.token !== token) return;
      clearTimeout(devWait.timer); devWait = null;
      const devs = (list || []).filter((d) => d.kind === kind && d.deviceId !== 'communications');
      const named = devs.some((d) => d.label);
      const saved = store.get(info.key, '');
      let h = `<div class="ctx-head"><span>${info.head}</span></div>`;
      if (!devs.length) h += `<div class="ctx-note">${info.none}</div>`;
      else if (!named) h += `<div class="ctx-note">Join a voice channel and allow ${kind === 'videoinput' ? 'camera' : 'microphone'} access to see device names.</div>`;
      else h += devs.map((d, i) => {
        const on = saved ? sameLabel(saved, d.label) : (d.deviceId === 'default' || (kind === 'videoinput' && i === 0));
        return `<button class="ctx-item check ${on ? 'on' : ''}" data-act="dev" data-i="${i}"><span>${esc(d.label)}</span><i class="box">${on ? icon('check') : ''}</i></button>`;
      }).join('');
      if (!devicesOnly) {
        h += '<div class="ctx-sep"></div>';
        if (kind === 'audioinput') h += ctxSlider('micgain', 'Input volume', av.micGain) + ctxCheck('denoise', 'Noise suppression', av.denoise !== false) + ctxCheck('mic', 'Mute', !micOn || deaf);
        else if (kind === 'audiooutput') h += ctxSlider('outvol', 'Output volume', av.outVol) + ctxCheck('deaf', 'Deafen', deaf);
        else {
          h += ctxSelect('camQ', 'Resolution', av.camQ, CAM_RES) + ctxSelect('camFps', 'Frame rate', av.camFps, fpsOpts([15, 30, 60]));
          if (voice) h += ctxCheck('cam', 'Camera on', !!voice.cam);
          if (voice && voice.cam && devs.length > 1) h += ctxItem('flip', 'flip', 'Flip camera');
        }
        h += ctxItem('avset', 'gear', 'Voice & video settings');
      }
      openAnchored(anchor, h, (menu) => {
        menu.querySelectorAll('[data-slide]').forEach((r) => {
          r.oninput = () => {
            menu.querySelector(`[data-out="${r.dataset.slide}"]`).textContent = audioPercent(r.value) + '%';
            if (r.dataset.slide === 'outvol') setOutVol(r.value); else setMicGain(r.value);
          };
        });
        menu.querySelectorAll('[data-sel]').forEach((sel) => {
          sel.onchange = () => {
            saveAv({ [sel.dataset.sel]: sel.dataset.sel === 'camFps' ? +sel.value : sel.value });
            if (voice && voice.cam) { closeCtx(); joinVoice(voice.sid, voice.cid, true); } // camera settings apply on reconnect
          };
        });
        menu.onclick = (e) => {
          const b = e.target.closest('[data-act]');
          if (!b) return;
          closeCtx();
          switch (b.dataset.act) {
            case 'dev': return pickDevice(kind, devs[+b.dataset.i], fromCallFrame);
            case 'mic': return toggleMic();
            case 'denoise': saveAv({ denoise: av.denoise === false }); return applyVolumes(true);
            case 'deaf': return toggleDeaf();
            case 'cam': return toggleCam();
            case 'flip': return flipCamera();
            case 'avset': return settingsModal('av');
          }
        };
      });
    };
    devWait = { token, show, timer: null };
    const ownList = () => (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices ? navigator.mediaDevices.enumerateDevices() : Promise.resolve([]))
      .then((l) => show(l.map((d) => ({ kind: d.kind, deviceId: d.deviceId, label: d.label })), false)).catch(() => show([], false));
    if (voice && voice.iframe && voice.iframe.contentWindow) {
      voicePost({ getDeviceList: true, cib: 'dischord-devs' });
      devWait.timer = setTimeout(ownList, 2500); // the call frame did not answer
    } else ownList();
  }
  function pickDevice(kind, d, fromCallFrame) {
    if (!d) return;
    store.set(DEV[kind].key, d.label || '');
    if (voice) {
      const call = voice;
      if (!fromCallFrame) {
        // Parent-page device ids belong to a different origin. Rejoin by the
        // saved label; joinVoice preserves the separate screen-share stream.
        joinVoice(call.sid, call.cid, call.cam);
      } else {
        // Live device IDs are only valid inside the VDO frame that listed them.
        const id = JSON.stringify(String(d.deviceId));
        if (kind === 'audioinput') voicePost({ function: 'eval', value: `if (typeof changeAudioDeviceById === 'function') changeAudioDeviceById(${id});` });
        else if (kind === 'audiooutput') voicePost({ changeAudioOutputDevice: String(d.deviceId) });
        else if (call.cam) voicePost({ function: 'eval', value: `if (typeof changeVideoDeviceById === 'function') changeVideoDeviceById(${id});` });
        scheduleVoice(call, () => syncVoiceState(call), 1500); // re-apply mute / gain after the device swap
      }
    }
    toast(({ audioinput: 'Microphone: ', audiooutput: 'Output: ', videoinput: 'Camera: ' })[kind] + (d.label || 'selected'));
  }
  function shareMenu(anchor) {
    closeCtx();
    const sharing = !!(voice && voice.ssFrame);
    let h = '<div class="ctx-head"><span>Screen share</span></div>';
    if (voice) h += ctxItem('share', 'screen', sharing ? 'Stop sharing' : 'Share your screen', sharing ? 'danger' : '');
    else h += '<div class="ctx-note">Join a voice channel to share your screen.</div>';
    h += '<div class="ctx-sep"></div>' + ctxSelect('ssQ', 'Resolution', av.ssQ, SS_RES) + ctxSelect('ssFps', 'Frame rate', av.ssFps, fpsOpts([5, 15, 30, 60])) +
      ctxSelect('ssBr', 'Bitrate', av.ssBr, SS_BRS.map((k) => [k, mbps(k)])) + ctxSelect('ssHint', 'Optimize for', av.ssHint, [['motion', 'Smoothness'], ['detail', 'Clarity']]);
    h += ctxCheck('ssAudio', 'Share computer sound', !!av.ssAudio);
    h += `<div class="ctx-note">${av.ssAudio ? 'The voices of this call are filtered out of the shared sound (needs a recent Chrome or Edge).' : 'Off: only a shared browser tab keeps its own sound.'}</div>`;
    if (sharing) h += '<div class="ctx-note">Picture settings apply to your current share. Sound applies the next time you share.</div>';
    h += ctxItem('avset', 'gear', 'Voice & video settings');
    openAnchored(anchor, h, (menu) => {
      menu.querySelectorAll('[data-sel]').forEach((sel) => {
        sel.onchange = () => saveAv({ [sel.dataset.sel]: ['ssFps', 'ssBr'].includes(sel.dataset.sel) ? +sel.value : sel.value });
      });
      menu.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        if (b.dataset.act === 'share') return toggleShare();
        if (b.dataset.act === 'avset') return settingsModal('av');
        if (b.dataset.act === 'ssAudio') { saveAv({ ssAudio: !av.ssAudio }); return shareMenu(anchor); }
      };
    });
  }
  // an arrow button: first click opens its menu, the next click closes it
  function caret(id, open) {
    $(id).onclick = (e) => {
      e.stopPropagation();
      if (ctxToggled === $(id)) { ctxToggled = null; return; }
      open($(id));
    };
  }

  // ---- channel list menus
  function renameChannelModal(cid) {
    const s = server(cur.sid), c = channel(s, cid);
    if (!c) return;
    modal(`<h2>Rename channel</h2><label>Channel name</label><input type="text" id="mName" maxlength="40" value="${esc(c.name)}">
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`, () => {
      const inp = $('mName');
      inp.select();
      const ok = () => {
        let n = inp.value.trim();
        if (c.type === 'text') n = n.toLowerCase().replace(/\s+/g, '-');
        if (!n) return;
        c.name = n.slice(0, 40);
        bumpServer(s);
        closeModal();
      };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    });
  }
  function deleteChannelConfirm(cid) {
    const s = server(cur.sid), c = channel(s, cid);
    if (!c) return;
    confirmModal('Delete channel', `Delete ${c.type === 'text' ? '#' : ''}${c.name} for everyone?`, 'Delete channel', () => {
      s.channels = s.channels.filter((x) => x.id !== c.id);
      releaseChannelFiles(s.id, c.id);
      if (voice && voice.sid === s.id && voice.cid === c.id) leaveVoice();
      if (cur.cid === c.id) selectChannel((s.channels.find((x) => x.type === 'text') || s.channels[0] || {}).id || null);
      bumpServer(s);
    });
  }
  function copyInvite(s) {
    const link = inviteLink(s);
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied'), () => { if (s.id === cur.sid) inviteModal(); });
  }
  function markServerRead(sid) {
    const s = server(sid);
    if (!s) return;
    s.channels.forEach((c) => { if (c.type === 'text') markRead(sid, c.id); });
    renderRail(); renderChannels();
  }
  function channelMenu(cid, x, y) {
    const s = server(cur.sid), c = channel(s, cid);
    if (!c) return;
    if (s.dm) {
      return openCtx(x, y, `<div class="ctx-head"><span>@ ${esc(c.name)}</span></div>` + ctxItem('read', 'check', 'Mark as read') + ctxItem('close', 'x', 'Close conversation'), (menu) => {
        menu.onclick = (e) => {
          const b = e.target.closest('[data-act]');
          if (!b) return;
          closeCtx();
          if (b.dataset.act === 'close') return closeDm(c.id);
          markRead(DM, c.id); renderRail(); renderChannels();
        };
      });
    }
    const inIt = !!(voice && voice.sid === s.id && voice.cid === c.id);
    let h = `<div class="ctx-head"><span>${c.type === 'text' ? '# ' : ''}${esc(c.name)}</span></div>`;
    const started = c.type === 'voice' && voiceOccupants(s.id, c.id).length ? callStart(s.id, c.id) : null;
    if (started) h += `<div class="ctx-note">Call running for <b class="call-clock" data-start="${started}">${fmtDur(now() - started)}</b></div>`;
    if (c.type === 'text') h += ctxItem('read', 'check', 'Mark as read');
    else h += inIt ? ctxItem('leave', 'hangup', 'Disconnect', 'danger') : ctxItem('join', 'speaker', 'Join voice') + ctxItem('joincam', 'camera', 'Join with camera');
    h += ctxItem('invite', 'userPlus', 'Invite people') + '<div class="ctx-sep"></div>';
    h += ctxItem('rename', 'edit', 'Rename channel') + ctxItem('del', 'trash', 'Delete channel', 'danger');
    openCtx(x, y, h, (menu) => {
      menu.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        switch (b.dataset.act) {
          case 'read': markRead(s.id, c.id); renderRail(); return renderChannels();
          case 'join': selectChannel(c.id); return joinVoice(s.id, c.id, false);
          case 'joincam': selectChannel(c.id); return joinVoice(s.id, c.id, true);
          case 'leave': return leaveVoice();
          case 'invite': return inviteModal();
          case 'rename': return renameChannelModal(c.id);
          case 'del': return deleteChannelConfirm(c.id);
        }
      };
    });
  }
  // empty space in the channel list, a category header, or the server header
  function serverAreaMenu(x, y) {
    const s = server(cur.sid);
    if (!s || s.dm) return;
    const h = `<div class="ctx-head"><span>${esc(s.name)}</span></div>` +
      ctxItem('addText', 'hash', 'Create text channel') + ctxItem('addVoice', 'speaker', 'Create voice channel') +
      ctxItem('invite', 'userPlus', 'Invite people') + ctxItem('read', 'check', 'Mark server as read') + '<div class="ctx-sep"></div>' +
      ctxItem('rename', 'edit', 'Rename server') + ctxItem('leave', 'logout', 'Leave server', 'danger');
    openCtx(x, y, h, (menu) => {
      menu.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        switch (b.dataset.act) {
          case 'addText': return channelModal('text');
          case 'addVoice': return channelModal('voice');
          case 'invite': return inviteModal();
          case 'read': return markServerRead(s.id);
          case 'rename': return renameModal();
          case 'leave': return confirmLeave(s);
        }
      };
    });
  }
  const confirmLeave = (s) => confirmModal(`Leave '${s.name}'`, 'You can rejoin later with an invite link. Your local message history for this server will be removed.', 'Leave server', () => leaveServer(s.id));
  function railMenu(sid, x, y) {
    const s = server(sid);
    if (!s) return;
    const h = `<div class="ctx-head"><span>${esc(s.name)}</span></div>` +
      ctxItem('read', 'check', 'Mark as read') + ctxItem('invite', 'userPlus', 'Copy invite link') + '<div class="ctx-sep"></div>' +
      ctxItem('leave', 'logout', 'Leave server', 'danger');
    openCtx(x, y, h, (menu) => {
      menu.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        switch (b.dataset.act) {
          case 'read': return markServerRead(s.id);
          case 'invite': return copyInvite(s);
          case 'leave': return confirmLeave(s);
        }
      };
    });
  }

  // Kick and move are requests the other person's app carries out. Say so plainly when it can't
  // (their page is an older release) or when it didn't (no change after a few seconds).
  function askPeer(sid, uid, payload, minVer, doing, done, what) {
    const m = (members[sid] || {})[uid];
    if (!m) return;
    const name = m.user.name;
    if (APP_VER && (m.ver || 0) < minVer) return toast(`${name} is on an older version of 叮咚 and can't ${what} until they reload the page.`, 8000);
    send(sid, payload);
    toast(doing);
    setTimeout(() => {
      const now = (members[sid] || {})[uid];
      if (now && isOnline(now) && !done(now)) toast(`${name}'s app did not respond. They may need to reload the page.`, 8000);
    }, 4000);
  }

  function userMenu(uid, x, y) {
    const self = uid === me.id;
    const sid = cur.sid;
    const ms = sid === DM ? anyMember(uid) : (members[sid] || {})[uid];
    const user = self ? me : (ms && ms.user) || getKnown(sid)[uid];
    if (!user) return;
    const occ = voice ? voiceOccupants(voice.sid, voice.cid).find((o) => o.user.id === uid) : null;
    const st = (occ && occ.st) || {};
    let h = `<div class="ctx-head">${avatar(user)}<span>${esc(user.name)}</span></div>`;
    if (self) {
      h += ctxCheck('mic', 'Mute microphone', !micOn || deaf) + ctxCheck('deaf', 'Deafen', deaf);
      h += ctxSlider('micgain', 'Microphone volume', av.micGain);
      if (voice) {
        h += '<div class="ctx-sep"></div>' + ctxCheck('cam', 'Camera', !!voice.cam) + ctxCheck('share', 'Share screen', !!voice.ssFrame);
        h += ctxSelect('selfprev', 'My preview', av.selfPreview, [['full', 'Full quality'], ['low', 'Low'], ['off', 'Hidden']]);
      }
      h += '<div class="ctx-sep"></div>' + ctxCheck('stats', 'Show stream stats', !!av.showStats) + ctxItem('diag', 'chart', 'Connection diagnostics') + ctxItem('avset', 'gear', 'Voice & video settings') + ctxItem('profile', 'edit', 'Edit profile');
    } else {
      const c = userVol[uid] || {};
      if (occ) {
        h += ctxSlider('vol', 'User volume', c.v ?? 100);
        if (st.s) h += ctxSlider('svol', 'Stream volume', c.sv ?? 100);
        h += ctxCheck('mute', 'Mute', !!c.m);
        if (st.c) h += ctxCheck('hidevid', 'Hide video', !!hiddenVid[uid]);
        if (st.c && occ.vs && !hiddenVid[uid]) h += ctxSelect('qcam', 'Video quality', streamBr[occ.vs] || 0, qOpts(st.cb));
        if (st.s && occ.vss) h += ctxSelect('qss', 'Stream quality', streamBr[occ.vss] || 0, qOpts(st.sb));
        if (st.s && occ.vss) h += ctxCheck('watching', 'Watch stream', !unwatched.has(occ.vss));
        if (st.s && occ.vss && !unwatched.has(occ.vss)) h += ctxItem('watch', 'expand', 'Focus stream') + ctxItem('fs', 'expand', 'Fullscreen stream');
        h += ctxCheck('stats', 'Show stream stats', !!av.showStats);
        h += '<div class="ctx-sep"></div>';
      } else if (c.m || (c.v ?? 100) !== 100) {
        h += ctxSlider('vol', 'User volume', c.v ?? 100) + ctxCheck('mute', 'Mute', !!c.m) + '<div class="ctx-sep"></div>';
      }
      h += ctxItem('dm', 'at', 'Message') + ctxItem('mention', 'at', 'Mention') + ctxItem('copyname', 'copy', 'Copy username');
      if (sid !== DM && !isOnline(ms)) h += '<div class="ctx-sep"></div>' + ctxItem('forget', 'trash', 'Remove from server', 'danger');
      if (sid !== DM && ms && isOnline(ms) && ms.vc) h += '<div class="ctx-sep"></div>' + ctxItem('kick', 'hangup', 'Kick from voice', 'danger');
    }
    openCtx(x, y, h, (m) => {
      m.querySelectorAll('[data-slide]').forEach((r) => {
        r.oninput = () => {
          m.querySelector(`[data-out="${r.dataset.slide}"]`).textContent = r.value + '%';
          if (r.dataset.slide === 'micgain') setMicGain(+r.value);
          else setVol(uid, r.dataset.slide === 'vol' ? { v: +r.value } : { sv: +r.value });
        };
      });
      m.querySelectorAll('[data-sel]').forEach((sel) => {
        sel.onchange = () => {
          const a = sel.dataset.sel;
          if (a === 'selfprev') { av.selfPreview = sel.value; store.set('av', av); tileEls.forEach((el) => { if (el.classList.contains('self')) el.dataset.vs = '__reload'; }); renderStage(); return; }
          const vs = a === 'qcam' ? occ.vs : occ.vss;
          streamBr[vs] = +sel.value;
          renderStage();
        };
      });
      m.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const a = b.dataset.act;
        const reopen = () => userMenu(uid, x, y);
        switch (a) {
          case 'mic': toggleMic(); return reopen();
          case 'deaf': toggleDeaf(); return reopen();
          case 'cam': closeCtx(); return toggleCam();
          case 'share': closeCtx(); return toggleShare();
          case 'stats': av.showStats = !av.showStats; store.set('av', av); renderStage(); return reopen();
          case 'avset': closeCtx(); return settingsModal('av');
          case 'diag': closeCtx(); return diagModal();
          case 'profile': closeCtx(); return settingsModal('profile');
          case 'mute': setVol(uid, { m: !(userVol[uid] || {}).m }); return reopen();
          case 'hidevid': hiddenVid[uid] = !hiddenVid[uid]; if (!hiddenVid[uid]) delete hiddenVid[uid]; store.set('hidevid', hiddenVid); renderStage(); return reopen();
          case 'watching': { const o = voice && voiceOccupants(voice.sid, voice.cid).find((x) => x.user.id === uid); if (o && o.vss) setWatching(o.vss, unwatched.has(o.vss)); return reopen(); }
          case 'watch': closeCtx(); showVoice(); focusUid = uid + ':s'; return renderStage();
          case 'fs': closeCtx(); showVoice(); return tileFullscreen(uid + ':s');
          case 'dm': closeCtx(); return openDm(user);
          case 'mention': {
            closeCtx();
            const inp = $('msgInput');
            if (!$('textView').classList.contains('hidden')) { inp.value += (inp.value && !/\s$/.test(inp.value) ? ' ' : '') + '@' + mentionTag(user.name) + ' '; inp.focus(); syncComposer(); }
            else toast('Open a text channel to mention someone.');
            return;
          }
          case 'forget': closeCtx(); if (forgetUsers(sid, [uid], true)) toast(`Removed ${user.name}`); return;
          case 'kick': closeCtx(); return askPeer(sid, uid, { t: 'kick', to: uid }, KICK_VER, `Removing ${user.name} from the call`, (m) => !m.vc, 'be kicked');
          case 'copyname': closeCtx(); navigator.clipboard && navigator.clipboard.writeText(user.name); return toast('Copied');
        }
      };
    });
  }

  function messageMenu(mid, x, y) {
    const m = (getMsgs(cur.sid)[cur.cid] || []).find((z) => z.id === mid);
    if (!m) return;
    const mine = m.a.id === me.id;
    let h = `<div class="ctx-emojis">${REACTS.slice(0, 6).map((e) => `<button data-emo="${e}">${e}</button>`).join('')}</div>`;
    h += ctxItem('react', 'smile', 'Add reaction') + ctxItem('reply', 'reply', 'Reply');
    if (m.text) h += ctxItem('copy', 'copy', 'Copy text');
    if (m.img || m.file && window.DischordImages.isImage(m.file)) {
      h += ctxItem('openimg', 'image', 'Open image');
      if (m.img) h += ctxItem('copyimg', 'copy', 'Copy image');
      h += ctxItem('saveimg', 'download', 'Download image');
      if (m.file && m.img) h += ctxItem('savepreview', 'download', 'Save preview');
    }
    if (!mine) h += ctxItem('mention', 'at', 'Mention ' + esc(m.a.name));
    if (mine && m.text) h += ctxItem('edit', 'edit', 'Edit message');
    if (mine) h += ctxItem('del', 'trash', 'Delete message', 'danger');
    openCtx(x, y, h, (menu) => {
      menu.onclick = (e) => {
        const emo = e.target.closest('[data-emo]');
        if (emo) { closeCtx(); return toggleReaction(mid, emo.dataset.emo); }
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        switch (b.dataset.act) {
          case 'react': return emojiPicker({ getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) }, (emo) => toggleReaction(mid, emo));
          case 'reply': return replyToMessage(mid);
          case 'copy': navigator.clipboard && navigator.clipboard.writeText(m.text); return toast('Copied');
          case 'openimg': return openImage(cur.sid, m.cid, m.id);
          case 'copyimg': return copyImage(cur.sid, m.cid, m.id);
          case 'saveimg': return downloadImage(cur.sid, m.cid, m.id);
          case 'savepreview': return saveImagePreview(cur.sid, m.cid, m.id);
          case 'mention': { const inp = $('msgInput'); inp.value += (inp.value && !/\s$/.test(inp.value) ? ' ' : '') + '@' + mentionTag(liveUser(m.a).name) + ' '; syncComposer(); return inp.focus(); }
          case 'edit': return editMessage(mid);
          case 'del': return deleteMessage(mid);
        }
      };
    });
  }

  function qualityMenu(key, btn) {
    const el = tileEls.get(key);
    if (!el || !el.dataset.vs) return;
    const vs = el.dataset.vs;
    const cur = streamBr[vs] || 0;
    const m = $('qMenu');
    m.innerHTML = `<div class="qm-title">Stream quality</div>` +
      [0, ...VIEW_BRS].map((k) => `<button data-qv="${k}" class="${k === cur ? 'sel' : ''}">${k ? mbps(k) : 'Auto (sender\'s setting)'}</button>`).join('');
    const stage = $('voiceStage'), r = btn.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    m.classList.remove('hidden');
    const below = r.bottom - sr.top + 6;
    const top = below + m.offsetHeight <= stage.clientHeight - 6 ? below : r.top - sr.top - m.offsetHeight - 6;
    m.style.top = Math.max(6, Math.min(top, stage.clientHeight - m.offsetHeight - 6)) + 'px';
    m.style.right = Math.max(6, Math.min(sr.right - r.right, stage.clientWidth - m.offsetWidth - 6)) + 'px';
    m.onclick = (e) => {
      const b = e.target.closest('[data-qv]');
      if (!b) return;
      streamBr[vs] = +b.dataset.qv;
      m.classList.add('hidden');
      renderStage();
    };
  }

  function renderVoiceIdle() {
    const s = server(cur.sid), c = channel(s, cur.cid);
    if (!c || c.type !== 'voice') return;
    const who = voiceOccupants(s.id, c.id);
    $('voiceIdleTitle').textContent = c.name;
    $('voiceIdleWho').innerHTML = who.length
      ? `<div class="vi-people">${who.map((o) => `<div class="vi-person" data-uid="${esc(o.user.id)}">${avatar(o.user, false, 'big')}<span>${esc(o.user.name)}</span></div>`).join('')}</div>`
      : '<p>No one is here yet. Jump in and others will see you in the channel list.</p>';
  }

  function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function fmtStamp(ts) {
    const d = new Date(ts), t = new Date();
    const y = new Date(t); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return 'Today at ' + fmtTime(ts);
    if (d.toDateString() === y.toDateString()) return 'Yesterday at ' + fmtTime(ts);
    return d.toLocaleDateString() + ' ' + fmtTime(ts);
  }

  // a mention is "@" + the name without spaces or punctuation; resolve it back to a person in this server
  const mentionTag = (name) => String(name || '').replace(/[^\p{L}\p{N}_.-]+/gu, '').slice(0, 32);
  function serverPeople(sid) {
    if (sid === DM) return dms.filter((u) => u.id === cur.cid).map((user) => ({ user, on: dmOnline(user.id) }));
    const k = getKnown(sid), ms = members[sid] || {};
    const out = [];
    for (const id of new Set([...Object.keys(k), ...Object.keys(ms)])) {
      if (id === me.id) continue;
      const user = (ms[id] && ms[id].user) || k[id];
      if (user && user.name) out.push({ user, on: isOnline(ms[id]) });
    }
    return out;
  }
  function mentionTarget(tag) {
    const want = tag.replace(/^@/, '').toLowerCase();
    if (!want) return null;
    if (mentionTag(me.name).toLowerCase() === want) return me;
    const hit = serverPeople(cur.sid).find((p) => mentionTag(p.user.name).toLowerCase() === want);
    return hit ? hit.user : null;
  }
  const mentionsMe = (text) => !!text && (text.match(/(^|\s)@[\p{L}\p{N}_.-]{1,32}/gu) || []).some((t) => { const u = mentionTarget(t.trim()); return u && u.id === me.id; });

  function formatText(raw) {
    const blocks = [];
    let t = esc(raw).replace(/```(?:[a-z0-9]+\n)?([\s\S]*?)```/gi, (_, code) => { blocks.push(`<pre>${code}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    t = t.replace(/`([^`\n]+)`/g, (_, code) => { blocks.push(`<code>${code}</code>`); return `\u0000${blocks.length - 1}\u0000`; });
    t = t
      .replace(/\b(https?:\/\/[^\s<]+[^\s<.,:;!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/__([^_\n]+)__/g, '<u>$1</u>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
      .replace(/(^|\s)(@[\p{L}\p{N}_.-]{1,32})/gu, (all, pre, tag) => {
        const u = mentionTarget(tag);
        return pre + (u ? `<span class="mention ${u.id === me.id ? 'me' : ''}" data-mention="${esc(u.id)}">@${esc(u.name)}</span>` : `<span class="mention">${tag}</span>`);
      });
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  // messages keep a snapshot of their author; show the current profile when we know it
  function liveUser(a) {
    if (a.id === me.id) return { ...a, name: me.name, color: me.color };
    const k = getKnown(cur.sid)[a.id];
    return k ? { ...a, name: k.name, color: k.color } : a;
  }

  function renderReply(m) {
    if (!m.reply) return '';
    const r = m.reply;
    const original = (getMsgs(cur.sid)[m.cid] || []).find((x) => x.id === r.id);
    const excerpt = original && original.del ? 'Original message deleted' : original
      ? original.text || (original.file && original.file.name) || (original.img ? 'Image' : 'Message')
      : r.text || r.attachment || 'Message';
    const a = liveUser(original ? original.a : r.a);
    return `<button type="button" class="msg-reply" data-reply-jump="${esc(r.id)}" title="Jump to original message">${icon('reply')}<b>${esc(a.name)}</b><span>${esc(excerpt.replace(/\s+/g, ' ').slice(0, 240))}</span></button>`;
  }
  function jumpToMessage(mid, instant) {
    const el = [...$('messages').querySelectorAll('[data-mid]')].find((x) => x.dataset.mid === mid);
    if (!el) return toast('Original message is no longer in local history.');
    el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
    el.classList.add('reply-highlight');
    setTimeout(() => el.classList.remove('reply-highlight'), 2000);
  }

  function renderMessages(forceBottom) {
    const box = $('messages');
    const s = server(cur.sid), c = channel(s, cur.cid);
    if (!c || c.type !== 'text') return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const list = (getMsgs(s.id)[c.id] || []).filter((m) => !m.del);
    let h = s.dm
      ? `<div class="chan-intro"><div class="big">${icon('at')}</div><h2>${esc(c.name)}</h2><p>This is the start of your direct messages with ${esc(c.name)}. They go straight from your device to theirs; messages sent while one of you is offline arrive the next time you are both online.</p></div>`
      : `<div class="chan-intro"><div class="big">${icon('hash')}</div><h2>Welcome to #${esc(c.name)}!</h2><p>This is the start of the #${esc(c.name)} channel. Messages travel peer-to-peer; people who join later get recent history from whoever is online.</p></div>`;
    let prev = null;
    for (const m of list) {
      const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString();
      if (newDay) h += `<div class="day-sep"><span>${new Date(m.ts).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}</span></div>`;
      const head = newDay || !prev || !!m.reply || prev.a.id !== m.a.id || m.ts - prev.ts > 7 * 60000;
      const mine = m.a.id === me.id;
      const a = liveUser(m.a);
      const acts = `<div class="actions"><button class="icon-btn" data-reply="${esc(m.id)}" title="Reply">${icon('reply')}</button><button class="icon-btn" data-react="${esc(m.id)}" title="Add reaction">${icon('smile')}</button>` +
        (mine ? `${m.text ? `<button class="icon-btn" data-edit="${esc(m.id)}" title="Edit">${icon('edit')}</button>` : ''}<button class="icon-btn danger" data-del="${esc(m.id)}" title="Delete">${icon('trash')}</button>` : '') + '</div>';
      const edited = m.ed ? ' <span class="time">(edited)</span>' : '';
      const more = `<button type="button" class="icon-btn message-more" data-message-menu="${esc(m.id)}" title="Message actions" aria-label="Message actions">⋯</button>`;
      const imageStateKey = imageMessageKey(s.id, m.cid, m.id);
      const failedPreview = imageErrors.has(imageStateKey);
      const imgW = m.img ? Math.max(48, Math.round(m.img.w * Math.min(1, 550 / m.img.w, 350 / m.img.h))) : 0;
      const imageAction = m.file ? `<span data-image-download="${esc(m.id)}" data-image-sid="${esc(s.id)}" data-image-cid="${esc(m.cid)}" data-image-compact="overlay">${imageDownloadContent(s.id, m, 'overlay')}</span>` : `<span class="img-save" data-image-save="${esc(m.id)}" role="button" tabindex="0" title="Download image" aria-label="Download image">${icon('download')}</span>`;
      const img = m.img ? `<button type="button" class="msg-img ${failedPreview ? '' : 'loading'}" style="aspect-ratio:${m.img.w}/${m.img.h};width:min(100%, ${imgW}px)" data-image-open="${esc(m.id)}" aria-label="Open image preview">
        <img data-img="${esc(m.img.id)}" data-img-sid="${esc(s.id)}" data-img-cid="${esc(m.cid)}" data-img-mid="${esc(m.id)}" decoding="async" alt="${esc(m.file ? m.file.name : 'Shared image')}"><span class="image-preview-status" role="status">${failedPreview ? 'Preview unavailable. Someone with it must be online.' : 'Loading image preview…'}</span>${imageAction}</button>` : m.file && window.DischordImages.isImage(m.file)
        ? `<div class="image-preview-placeholder" data-image-open="${esc(m.id)}">${icon('image')}<span role="status">${imagePreparing.has(imageStateKey) && !failedPreview ? 'Preparing image preview…' : 'Image preview unavailable.'}</span><span data-image-download="${esc(m.id)}" data-image-sid="${esc(s.id)}" data-image-cid="${esc(m.cid)}" data-image-compact="icon">${imageDownloadContent(s.id, m, 'icon')}</span></div>` : '';
      // Image originals download from their preview controls, without a duplicate file card.
      const file = m.file && !window.DischordImages.isImage(m.file) ? `<div class="msg-file" data-file-card="${esc(m.id)}">${fileCardContent(s.id, m)}</div>` : '';
      const reply = renderReply(m);
      const text = m.text ? `<div class="text">${formatText(m.text)}${edited}</div>` : '';
      const re = renderRe(m);
      if (head) {
        h += `<div class="msg head ${mentionsMe(m.text) ? 'mentions-me' : ''}" data-mid="${esc(m.id)}"><div class="gutter" data-uid="${esc(m.a.id)}" data-ctx="user">${avatar(a)}</div><div class="body">${more}
          <div class="meta"><span class="author" data-uid="${esc(m.a.id)}" data-ctx="user" style="color:${esc(a.color)}">${esc(a.name)}</span><span class="time" title="${esc(new Date(m.ts).toLocaleString())}">${esc(fmtStamp(m.ts))}</span></div>
          ${reply}${text}${file}${img}${re}</div>${acts}</div>`;
      } else {
        h += `<div class="msg ${mentionsMe(m.text) ? 'mentions-me' : ''}" data-mid="${esc(m.id)}"><div class="gutter time-side">${esc(fmtTime(m.ts))}</div><div class="body">${more}${reply}${text}${file}${img}${re}</div>${acts}</div>`;
      }
      prev = m;
    }
    box.innerHTML = h;
    if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
    paintImages();
    renderReplyBar();
  }

  function renderRe(m) {
    if (!m.re) return '';
    const pills = [];
    for (const e in m.re) {
      const who = Object.keys(m.re[e]).filter((u) => m.re[e][u] > 0);
      if (!who.length) continue;
      const k = getKnown(cur.sid);
      const names = who.map((u) => (u === me.id ? 'You' : (k[u] && k[u].name) || 'someone')).join(', ');
      pills.push(`<button class="re-pill ${who.includes(me.id) ? 'mine' : ''}" data-rtoggle="${esc(m.id)}" data-e="${esc(e)}" title="${esc(names)}">${esc(e)}<span>${who.length}</span></button>`);
    }
    return pills.length ? `<div class="reacts">${pills.join('')}<button class="re-pill add" data-react="${esc(m.id)}" title="Add reaction">${icon('smile')}</button></div>` : '';
  }

  // tiny emoji picker anchored to an element
  function emojiPicker(anchor, onPick, list = REACTS) {
    const m = $('emojiMenu');
    m.innerHTML = list.map((e) => `<button data-emo="${e}">${e}</button>`).join('');
    const r = anchor.getBoundingClientRect();
    m.classList.remove('hidden');
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(8, r.left + mw <= window.innerWidth - 8 ? r.left : r.right - mw) + 'px';
    m.style.top = Math.max(8, Math.min(window.innerHeight - mh - 8, r.top - mh - 6 > 8 ? r.top - mh - 6 : r.bottom + 6)) + 'px';
    m.onclick = (e) => { const b = e.target.closest('[data-emo]'); if (!b) return; m.classList.add('hidden'); onPick(b.dataset.emo); };
  }

  // show a person: open the member list at them, flash their row, and open their menu
  function jumpToPerson(uid, x, y) {
    if (!membersOpen) { membersOpen = true; store.set('membersOpen', true); }
    renderMembers();
    if (mobileLayout()) setMobilePane('members');
    const row = [...document.querySelectorAll('#members .mem')].find((el) => el.dataset.uid === uid);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
    }
    userMenu(uid, x, y);
  }

  // ---- message box: coloured copy of the text under the (transparent) textarea, and the @ picker
  function composerHtml(text) {
    let t = esc(text)
      .replace(/`[^`\n]+`/g, (m) => `<span class="hl-code">${m}</span>`)
      .replace(/\bhttps?:\/\/[^\s<]+/g, (m) => `<span class="hl-link">${m}</span>`)
      .replace(/\*\*[^*\n]+\*\*|~~[^~\n]+~~|__[^_\n]+__/g, (m) => `<span class="hl-mark">${m}</span>`)
      .replace(/(^|\s)(@[\p{L}\p{N}_.-]{1,32})/gu, (all, pre, tag) => pre + `<span class="${mentionTarget(tag) ? 'hl-mention' : 'hl-at'}">${tag}</span>`);
    return t + (text.endsWith('\n') ? ' ' : ''); // a trailing newline needs something on its line to take height
  }
  function syncComposer() {
    const inp = $('msgInput'), mirror = $('msgMirror');
    if (!inp || !mirror) return;
    const html = composerHtml(inp.value || '');
    if (mirror.innerHTML !== html) mirror.innerHTML = html;
    mirror.scrollTop = inp.scrollTop;
  }
  let mention = null; // { start, items, sel } while the @ picker is open
  function closeMention() { mention = null; $('mentionMenu').classList.add('hidden'); }
  function updateMention() {
    const inp = $('msgInput');
    const caret = inp.selectionStart ?? (inp.value || '').length;
    const m = /(^|\s)@([\p{L}\p{N}_.-]{0,32})$/u.exec((inp.value || '').slice(0, caret));
    if (!m || !server(cur.sid)) return closeMention();
    const q = m[2].toLowerCase();
    const items = serverPeople(cur.sid).map((p) => ({ ...p, tag: mentionTag(p.user.name) }))
      .filter((p) => p.tag && p.tag.toLowerCase().includes(q))
      .sort((a, b) => (b.tag.toLowerCase().startsWith(q) - a.tag.toLowerCase().startsWith(q)) || (b.on - a.on) || a.user.name.localeCompare(b.user.name))
      .slice(0, 8);
    if (!items.length) return closeMention();
    mention = { start: caret - m[2].length - 1, items, sel: mention && mention.sel < items.length ? mention.sel : 0 };
    paintMention();
  }
  function paintMention() {
    const el = $('mentionMenu');
    el.innerHTML = '<div class="mm-head">Members</div>' + mention.items.map((p, i) =>
      `<button type="button" class="mm-item ${i === mention.sel ? 'sel' : ''}" data-i="${i}" role="option">${avatar(p.user)}<span class="mm-name" style="color:${esc(p.user.color)}">${esc(p.user.name)}</span><span class="mm-sub">${p.on ? 'online' : 'offline'}</span></button>`).join('');
    el.classList.remove('hidden');
  }
  function acceptMention(i) {
    const inp = $('msgInput'), p = mention && mention.items[i];
    if (!p) return closeMention();
    const caret = inp.selectionStart ?? inp.value.length, ins = '@' + p.tag + ' ';
    inp.value = inp.value.slice(0, mention.start) + ins + inp.value.slice(caret);
    inp.selectionStart = inp.selectionEnd = mention.start + ins.length;
    closeMention();
    inp.focus();
    inp.dispatchEvent(new Event('input'));
  }

  // ---- search. It only looks through the message history saved on this device; nothing is asked of
  // anyone else. Every word must appear in the message or its file name; from:name narrows by sender.
  let searchScope = 'server';
  function searchMessages(query, scope) {
    const words = [], from = [];
    for (const w of query.toLowerCase().split(/\s+/).filter(Boolean)) (w.startsWith('from:') && w.length > 5 ? from : words).push(w.startsWith('from:') && w.length > 5 ? w.slice(5).replace(/^@/, '') : w);
    if (!words.length && !from.length) return { hits: [], words };
    const places = [];
    const add = (sv) => sv.channels.filter((c) => c.type === 'text').forEach((c) => places.push({ s: sv, c }));
    if (scope === 'channel') { const sv = server(cur.sid), c = channel(sv, cur.cid); if (c && c.type === 'text') places.push({ s: sv, c }); }
    else if (scope === 'server' && server(cur.sid)) add(server(cur.sid));
    else { servers.forEach(add); add(dmServer); }
    const hits = [];
    for (const { s: sv, c } of places) {
      const known = getKnown(sv.id);
      for (const m of getMsgs(sv.id)[c.id] || []) {
        if (m.del) continue;
        const name = m.a.id === me.id ? me.name : (known[m.a.id] || m.a).name;
        if (from.length && !from.every((f) => name.toLowerCase().replace(/\s+/g, '').includes(f))) continue;
        const text = (m.text || '') + (m.file ? ' ' + m.file.name : '');
        const low = text.toLowerCase();
        if (!words.every((w) => low.includes(w))) continue;
        hits.push({ sid: sv.id, cid: c.id, m, name, where: sv.dm ? '@' + c.name : '#' + c.name + (scope === 'all' ? ' · ' + sv.name : '') });
      }
    }
    hits.sort((a, b) => b.m.ts - a.m.ts);
    return { hits, words };
  }
  // the part of a message around the first match, with the matched words marked
  function searchSnippet(m, words) {
    const text = (m.text || (m.file ? m.file.name : m.img ? 'Image' : '')).replace(/\s+/g, ' ');
    const low = text.toLowerCase();
    const first = words.length ? Math.max(0, Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0), text.length)) : 0;
    const start = Math.max(0, first - 40), cut = text.slice(start, start + 220);
    const marks = words.length ? new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi') : null;
    const body = marks ? cut.split(marks).map((part, i) => (i % 2 ? '<mark>' + esc(part) + '</mark>' : esc(part))).join('') : esc(cut);
    return (start ? '…' : '') + body + (start + 220 < text.length ? '…' : '') + (m.file && m.text ? ` <span class="sr-file">${icon('file', 'mini')}${esc(m.file.name)}</span>` : '');
  }
  // The search lives in a panel that slides in from the right, in place of the member list. It is not a
  // dialog: the chat stays usable (scroll, read, type) while it is open, and results stay put.
  let searchHits = [], searchTimer = null;
  const searchOpen = () => !$('searchPanel').classList.contains('hidden');
  function paintSearchScopes() {
    const sv = server(cur.sid), c = channel(sv, cur.cid), inText = !!(c && c.type === 'text');
    if (!sv) searchScope = 'all'; else if (searchScope === 'channel' && !inText) searchScope = 'server';
    const scopes = [['channel', inText ? (sv.dm ? '@' : '#') + c.name : '', inText], ['server', sv ? (sv.dm ? 'All direct messages' : sv.name) : '', !!sv], ['all', 'Everywhere', true]];
    const h = scopes.filter((x) => x[2]).map(([id, label]) => `<button type="button" data-scope="${id}" class="${id === searchScope ? 'on' : ''}">${esc(label)}</button>`).join('');
    if ($('sScope').dataset.raw !== h) { $('sScope').dataset.raw = h; $('sScope').innerHTML = h; }
  }
  function runSearch() {
    const out = $('sOut'), q = $('sQ').value.trim();
    if (!q) { searchHits = []; out.innerHTML = '<div class="search-note">Searches the message history saved on this device. Type <b>from:name</b> to see one person\'s messages.</div>'; return; }
    const { hits, words } = searchMessages(q, searchScope);
    searchHits = hits.slice(0, 100);
    out.innerHTML = hits.length ? `<div class="search-count">${hits.length} ${hits.length === 1 ? 'result' : 'results'}${hits.length > 100 ? ' · showing the newest 100' : ''}</div>` +
      searchHits.map((h, i) => `<button type="button" class="sr" data-hit="${i}">${avatar(liveUser(h.m.a))}<div class="sr-main"><div class="sr-meta"><b style="color:${esc(liveUser(h.m.a).color)}">${esc(h.name)}</b><span>${esc(fmtStamp(h.m.ts))}</span></div><div class="sr-where">${esc(h.where)}</div><div class="sr-text">${searchSnippet(h.m, words)}</div></div></button>`).join('')
      : '<div class="search-note">No messages match.</div>';
  }
  // what is being viewed changed (another channel, a new message): keep the open panel in step
  function refreshSearch() {
    if (!searchOpen()) return;
    paintSearchScopes();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 150);
  }
  function openSearch() {
    if (!me) return;
    const panel = $('searchPanel');
    if (!searchOpen()) {
      clearTimeout(panel._closing);
      // it grows out of the member list it replaces (or from nothing), so the chat beside it never jumps wider first
      panel.style.setProperty('--search-from', (mobileLayout() ? 0 : $('members').offsetWidth + $('memResizer').offsetWidth) + 'px');
      panel.classList.remove('hidden', 'closing');
      document.body.classList.add('search-open');
      if (mobilePane) setMobilePane(null);
      paintSearchScopes();
      runSearch();
    }
    // preventScroll: the box is still sliding in, and scrolling it into view would yank the whole app sideways
    $('sQ').focus({ preventScroll: true });
    $('sQ').select();
  }
  function closeSearch() {
    const panel = $('searchPanel');
    if (!searchOpen() || panel.classList.contains('closing')) return;
    panel.classList.add('closing'); // slides back out, then leaves the layout
    panel._closing = setTimeout(() => { panel.classList.add('hidden'); panel.classList.remove('closing'); document.body.classList.remove('search-open'); }, 180);
  }

  // ---- connection diagnostics. Every peer connection takes one of three routes: straight across the
  // local network, straight across the internet after STUN found a way through the routers, or relayed
  // through a TURN server when no direct path exists. While recording, each connection frame is asked
  // every few seconds which route its connections are on and how much they have carried; that is kept
  // per person and totalled, so it shows how often traffic is direct and how often it is relayed.
  function vdoRouteProbe() {
    if (typeof session === 'undefined' || !session) return;
    if (!window.__dischordRouteScan) window.__dischordRouteScan = async function () {
      var out = [];
      var scan = async function (map, dir) {
        for (var uuid in (map || {})) {
          var pc = map[uuid];
          if (!pc || typeof pc.getStats !== 'function' || pc.connectionState === 'closed') continue;
          try {
            var stats = await pc.getStats(), byId = {}, pair = null;
            stats.forEach(function (r) { byId[r.id] = r; });
            stats.forEach(function (r) { if (r.type === 'transport' && r.selectedCandidatePairId && byId[r.selectedCandidatePairId]) pair = byId[r.selectedCandidatePairId]; });
            if (!pair) stats.forEach(function (r) { if (!pair && r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r; });
            if (!pair) continue;
            var mine = byId[pair.localCandidateId] || {}, theirs = byId[pair.remoteCandidateId] || {};
            // "Peer reflexive" candidates turn up both on a home network (where browsers hide local addresses)
            // and across the internet, so say whether any address on the path is a public one.
            var open = function (a) { return typeof a === 'string' && a !== '' && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|f[cd]|fe80|::1)/i.test(a) && !/\.local$/i.test(a); };
            out.push({ uuid: uuid, dir: dir, stream: typeof pc.streamID === 'string' ? pc.streamID : null, local: mine.candidateType || '', remote: theirs.candidateType || '', wide: open(mine.address) || open(theirs.address),
              proto: mine.protocol || '', relayProto: mine.relayProtocol || '', sent: pair.bytesSent || 0, recv: pair.bytesReceived || 0,
              rtt: typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null });
          } catch (_) { }
        }
      };
      await scan(session.pcs, 'out'); await scan(session.rpcs, 'in');
      try { window.parent.postMessage({ dischordRoutes: out }, '*'); } catch (_) { }
    };
    window.__dischordRouteScan();
  }
  const ROUTES = { lan: 'Direct · local network', stun: 'Direct · internet (STUN)', relay: 'Relayed · via TURN' };
  const zeroRoutes = () => ({ lan: 0, stun: 0, relay: 0 });
  const diag = {
    on: !!store.get('diagOn', false), // keep recording when the panel is closed
    open: false,
    conns: new Map(),                 // one entry per live connection, this session
    who: new Map(),                   // frame + connection -> the person who said they are watching through it
    total: { time: zeroRoutes(), bytes: zeroRoutes(), since: now(), ...store.get('diagTotal', {}) }, // kept across sessions
    savedAt: 0,
  };
  const DIAG_STEP = 3000;
  // which frame an answer came from, and so what the connections in it are for
  function diagFrame(source) {
    for (const sid in meshes) if (meshes[sid].iframe.contentWindow === source) return { id: 'chat:' + sid, kind: 'chat', sid };
    if (voice && voice.iframe.contentWindow === source) return { id: 'voice', kind: 'voice' };
    if (voice && voice.ssFrame && voice.ssFrame.contentWindow === source) return { id: 'share', kind: 'share' };
    for (const [key, el] of tileEls) { const f = el.querySelector('.tile-media iframe'); if (f && f.contentWindow === source) return { id: 'tile:' + key, kind: key.endsWith(':s') ? 'screen' : 'camera', uid: key.split(':')[0] }; }
    return null;
  }
  const diagUser = (uid) => { if (uid === me.id) return me; for (const sid in members) { const m = members[sid][uid]; if (m) return m.user; } for (const sv of servers) { const k = getKnown(sv.id)[uid]; if (k) return k; } return null; };
  function onRoutes(source, list) {
    const frame = diagFrame(source);
    if (!frame || !Array.isArray(list) || !(diag.on || diag.open)) return;
    const seen = now();
    for (const r of list.slice(0, 200)) {
      if (!r || typeof r.uuid !== 'string') continue;
      let uid = frame.uid || null, kind = frame.kind;
      if (frame.kind === 'chat') uid = (peers[frame.sid] && peers[frame.sid].get(r.uuid) || {}).uid || null;
      else if (!uid && voice) {
        // by the stream it carries (mine, or a member's), else by who the viewer said they are (announceViewers),
        // else by the other direction of the same link, which shares its id
        const tag = diag.who.get(frame.id + '/' + r.uuid);
        const hit = r.stream && Object.entries(members[voice.sid] || {}).find(([, m]) => m.vs === r.stream || m.vss === r.stream);
        if (r.stream && (r.stream === voice.vs || r.stream === voice.ssVs)) uid = me.id;
        else if (hit) uid = hit[0];
        else if (tag) { uid = tag; if (kind === 'voice') kind = 'camera'; } // someone watching my camera, which the call frame also sends
        else uid = (diag.conns.get(frame.id + '/' + r.uuid + '/' + (r.dir === 'in' ? 'out' : 'in')) || {}).uid || null;
      }
      const route = r.local === 'relay' || r.remote === 'relay' ? 'relay'
        : r.local === 'srflx' || r.remote === 'srflx' || r.wide ? 'stun' : 'lan'; // found through STUN or reaching a public address: across the internet
      const key = frame.id + '/' + r.uuid + '/' + r.dir;
      let c = diag.conns.get(key);
      if (!c) { c = { key, kind, dir: r.dir, sid: frame.sid || (voice && voice.sid) || null, since: seen, sent: +r.sent || 0, recv: +r.recv || 0, time: zeroRoutes(), bytes: zeroRoutes(), changes: [] }; diag.conns.set(key, c); }
      const moved = Math.max(0, (+r.sent || 0) - c.sent) + Math.max(0, (+r.recv || 0) - c.recv);
      if (c.route && c.route !== route) c.changes.push({ at: seen, from: c.route, to: route });
      if (c.changes.length > 20) c.changes.shift();
      Object.assign(c, { kind: kind !== frame.kind ? kind : c.kind, uid: uid || c.uid || null, self: (uid || c.uid) === me.id, route, local: r.local, remote: r.remote, proto: r.proto, relayProto: r.relayProto, rtt: r.rtt, sent: +r.sent || 0, recv: +r.recv || 0, seen });
      c.time[route] += DIAG_STEP; c.bytes[route] += moved;
      if (!c.self) { diag.total.time[route] += DIAG_STEP; diag.total.bytes[route] += moved; } // this PC talking to itself is not traffic
    }
    if (seen - diag.savedAt > 30000) { diag.savedAt = seen; store.set('diagTotal', diag.total); }
    if (diag.open) paintDiag();
  }
  // A connection that only watches a camera or screen carries no identity, so each of my viewers says who
  // it is over that connection; the sender's diagnostics can then file it under my name.
  function announceViewers() {
    if (!me) return;
    for (const el of tileEls.values()) {
      const f = el.querySelector('.tile-media iframe');
      if (f && f.contentWindow) try { f.contentWindow.postMessage({ sendData: { dischordWho: me.id } }, '*'); } catch { }
    }
  }
  function pollRoutes() {
    if (!(diag.on || diag.open) || !me) return;
    const code = '(' + vdoRouteProbe.toString() + ')();';
    const frames = [...Object.values(meshes).map((m) => m.iframe), voice && voice.iframe, voice && voice.ssFrame, ...[...tileEls.values()].map((el) => el.querySelector('.tile-media iframe'))];
    for (const f of frames) if (f && f.contentWindow) try { f.contentWindow.postMessage({ function: 'eval', value: code }, '*'); } catch { }
    for (const [key, c] of diag.conns) if (now() - c.seen > 5 * 60000) diag.conns.delete(key); // long gone
  }
  const fmtBytes = (n) => (n < 1024 ? Math.round(n) + ' B' : window.DischordFiles.formatSize(Math.round(n)));
  const share = (parts) => { const all = parts.lan + parts.stun + parts.relay; return all ? { lan: parts.lan / all, stun: parts.stun / all, relay: parts.relay / all, all } : null; };
  const pct = (x) => (x > 0 && x < 0.01 ? '<1' : Math.round(x * 100)) + '%';
  const routeBar = (sh) => (sh ? `<i class="dg-bar"><i class="lan" style="width:${sh.lan * 100}%"></i><i class="stun" style="width:${sh.stun * 100}%"></i><i class="relay" style="width:${sh.relay * 100}%"></i></i>` : '<i class="dg-bar"></i>');
  const DIAG_KINDS = { chat: 'Chat & files', voice: 'Voice', camera: 'Camera video', screen: 'Screen video', share: 'My screen share' };
  function diagReport() {
    const live = [...diag.conns.values()].filter((c) => now() - c.seen < 15000);
    return {
      app: APP_VER, at: new Date().toISOString(), recordingSince: new Date(diag.total.since).toISOString(),
      totals: { timeMs: diag.total.time, bytes: diag.total.bytes },
      connections: [...diag.conns.values()].map((c) => ({ person: c.self ? 'this device' : (diagUser(c.uid) || {}).name || 'unknown', use: DIAG_KINDS[c.kind], direction: c.dir === 'in' ? 'receiving' : 'sending', live: live.includes(c),
        route: c.route, localCandidate: c.local, remoteCandidate: c.remote, protocol: c.proto, relayProtocol: c.relayProto || undefined, rttMs: c.rtt, bytesSent: c.sent, bytesReceived: c.recv, timeMs: c.time, bytesByRoute: c.bytes,
        routeChanges: c.changes.map((x) => ({ at: new Date(x.at).toISOString(), from: x.from, to: x.to })) })),
    };
  }
  function paintDiag() {
    const box = $('dgBody');
    if (!box) return;
    const mine = [...diag.conns.values()].filter((c) => now() - c.seen < 15000 && c.self);
    const live = [...diag.conns.values()].filter((c) => now() - c.seen < 15000 && !c.self);
    const t = share(diag.total.time), b = share(diag.total.bytes);
    const card = (id) => `<div class="dg-card ${id}"><b>${t ? pct(t[id]) : '–'}</b><span>${ROUTES[id]}</span><em>${b ? pct(b[id]) + ' of data · ' + fmtBytes(diag.total.bytes[id]) : 'no data yet'}</em></div>`;
    let h = `<div class="dg-cards">${card('lan')}${card('stun')}${card('relay')}</div>
      <div class="dg-sub">Share of connection time since ${esc(fmtStamp(diag.total.since))}. ${live.length} live ${live.length === 1 ? 'connection' : 'connections'} now, ${live.filter((c) => c.route === 'relay').length} relayed.</div>`;
    const people = new Map();
    for (const c of live) { const k = c.uid || '?'; if (!people.has(k)) people.set(k, []); people.get(k).push(c); }
    if (!people.size) h += `<div class="dg-empty">${Object.keys(meshes).length ? 'No one else is connected right now. Connections appear here as people come online.' : 'Join a server to see connections.'}</div>`;
    for (const [uid, list] of [...people].sort((x, y) => ((diagUser(x[0]) || {}).name || '~').localeCompare((diagUser(y[0]) || {}).name || '~'))) {
      const u = diagUser(uid), time = zeroRoutes(), bytes = zeroRoutes();
      list.forEach((c) => { for (const r in time) { time[r] += c.time[r]; bytes[r] += c.bytes[r]; } });
      const sh = share(time), relayed = list.some((c) => c.route === 'relay');
      h += `<div class="dg-person"><div class="dg-who">${u ? avatar(u) : '<div class="avatar" style="background:#4e5058">?</div>'}<div><b>${esc(u ? u.name : 'Not identified (someone on an older version)')}</b><span>${sh ? `direct ${pct(sh.lan + sh.stun)} of the time · relayed ${pct(sh.relay)}` : ''} · ${fmtBytes(bytes.lan + bytes.stun + bytes.relay)} this session</span></div>${routeBar(sh)}<span class="dg-tag ${relayed ? 'relay' : 'ok'}">${relayed ? 'Relayed' : 'Direct'}</span></div>`;
      for (const c of list.sort((x, y) => x.kind.localeCompare(y.kind) || x.dir.localeCompare(y.dir))) {
        const sv = c.kind === 'chat' ? server(c.sid) : null;
        h += `<div class="dg-conn"><span class="dg-use">${DIAG_KINDS[c.kind]}${sv ? ' · ' + esc(sv.name) : ''} <em>${c.dir === 'in' ? '↓ from them' : '↑ to them'}</em></span>
          <span class="dg-tag ${c.route}">${ROUTES[c.route]}</span>
          <span class="dg-num" title="Candidate types: mine ${esc(c.local)}, theirs ${esc(c.remote)}">${esc((c.relayProto ? 'TURN/' + c.relayProto : c.proto || '').toUpperCase())}</span>
          <span class="dg-num">${c.rtt == null ? '–' : c.rtt + ' ms'}</span>
          <span class="dg-num">↑ ${fmtBytes(c.sent)}</span><span class="dg-num">↓ ${fmtBytes(c.recv)}</span>
          ${c.changes.length ? `<span class="dg-chg" title="${esc(c.changes.map((x) => fmtStamp(x.at) + ': ' + x.from + ' → ' + x.to).join('\n'))}">changed ${c.changes.length}×</span>` : ''}</div>`;
      }
      h += '</div>';
    }
    if (mine.length) h += `<div class="dg-person self"><div class="dg-who">${avatar(me)}<div><b>This device</b><span>Your own previews, and the link between your call and your screen share. It never leaves this device, so it is left out of the totals.</span></div><span class="dg-tag">${mine.length} local</span></div></div>`;
    box.innerHTML = h;
  }
  function diagModal() {
    modal(`<h2>Connection diagnostics</h2>
      <p class="dg-lead">How your traffic reaches each person: straight to them, or relayed through a TURN server when no direct path could be found.</p>
      <div id="dgBody"></div>
      <div class="actions"><label class="dg-rec"><input type="checkbox" id="dgOn" ${diag.on ? 'checked' : ''}> Keep recording when this is closed</label><span class="spacer"></span>
        <button class="btn link" id="dgReset">Reset totals</button><button class="btn" id="dgCopy">Copy report</button><button class="btn primary" data-close>Close</button></div>`, () => {
      diag.open = true;
      modalCleanup = () => { diag.open = false; store.set('diagTotal', diag.total); };
      $('dgOn').onchange = () => { diag.on = $('dgOn').checked; store.set('diagOn', diag.on); };
      $('dgReset').onclick = () => { diag.total = { time: zeroRoutes(), bytes: zeroRoutes(), since: now() }; diag.conns.forEach((c) => { c.time = zeroRoutes(); c.bytes = zeroRoutes(); c.changes = []; }); store.set('diagTotal', diag.total); paintDiag(); };
      $('dgCopy').onclick = () => { const text = JSON.stringify(diagReport(), null, 2); (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Report copied'), () => toast('Could not copy the report here.')); };
      paintDiag(); pollRoutes();
    }, true, true);
    $('modal').classList.add('diag');
  }

  function renderIfCurrent(sid, cid) { if (sid === cur.sid && cid === cur.cid) renderMessages(); }

  function renderTyping() {
    const k = cur.sid + '/' + cur.cid;
    const t = typing[k] || {};
    const names = Object.values(t).filter((x) => x.until > now()).map((x) => x.name);
    $('typing').innerHTML = !names.length ? '' :
      `<span class="dots"><i></i><i></i><i></i></span><b>${names.slice(0, 3).map(esc).join(', ')}</b> ${names.length === 1 ? 'is' : 'are'} typing…`;
  }

  function renderMembers() {
    if (!me) return;
    const el = $('members');
    const s = server(cur.sid);
    el.classList.toggle('collapsed', !s || !!s.dm || !membersOpen);
    if (!s || s.dm) return;
    const ms = members[s.id] || {};
    const k = getKnown(s.id);
    const ids = new Set([...Object.keys(k), ...Object.keys(ms)]);
    const online = [{ user: me, vc: myVoiceIn(s.id), st: myState(), self: true }];
    const offline = [];
    for (const id of ids) {
      if (id === me.id) continue;
      const m = ms[id];
      if (isOnline(m)) online.push(m); else offline.push({ user: (m && m.user) || k[id] });
    }
    online.sort((a, b) => (a.self ? -1 : b.self ? 1 : a.user.name.localeCompare(b.user.name)));
    offline.sort((a, b) => a.user.name.localeCompare(b.user.name));
    const vname = (cid) => { const c = channel(s, cid); return c ? c.name : ''; };
    const row = (m, on) => `<div class="mem ${on ? '' : 'offline'}" data-uid="${esc(m.user.id)}">${avatar(m.user, true)}<div class="mem-text"><div class="nm" style="color:${on ? esc(m.user.color) : 'inherit'}">${esc(m.user.name)}${m.self ? ' <span class="sub">(you)</span>' : ''}</div>${on && m.vc ? `<div class="sub">${icon('speaker', 'mini')} ${esc(vname(m.vc))}</div>` : ''}</div><span class="vu-icons">${on && m.vc ? stateIcons(m.st) : ''}</span></div>`;
    el.innerHTML = `<div class="mem-cat">Online — ${online.length}</div>${online.map((m) => row(m, true)).join('')}` +
      (offline.length ? `<div class="mem-cat" style="margin-top:20px"><span>Offline — ${offline.length}</span><button class="icon-btn" data-forget-all title="Remove all offline people">${icon('trash')}</button></div>${offline.map((m) => row(m, false)).join('')}` : '');
    paintSpeaking();
  }

  function renderUserPanel() {
    if (!me) return;
    $('meAvatar').outerHTML = `<div class="avatar" id="meAvatar" style="background:${avBg(me.color)}">${esc(me.name[0].toUpperCase())}<span class="dot"></span></div>`;
    $('meName').textContent = me.name;
    let peersN = 0;
    if (cur.sid) for (const id in members[cur.sid] || {}) if (isOnline(members[cur.sid][id])) peersN++;
    $('meStatus').textContent = cur.sid ? (peersN ? `${peersN} other${peersN === 1 ? '' : 's'} online` : 'Waiting for others…') : 'Online';
    $('voiceStatus').classList.toggle('hidden', !voice);
    if (voice) {
      const s = server(voice.sid), c = channel(s, voice.cid);
      $('voiceWhere').textContent = c ? `${c.name} / ${s.name}` : '';
      paintCallTime();
    }
  }

  // how long I have been in this call (survives camera on/off, which reconnects)
  function paintCallTime() {
    const el = $('vsTime');
    if (!el) return;
    if (!voice || !voice.since) { el.textContent = ''; return; }
    el.textContent = fmtDur(now() - voice.since);
  }
  function fmtDur(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  // the running time of each active call, in the channel list and in an open channel menu
  function paintChannelTimes() {
    document.querySelectorAll('#channelList .chan-time').forEach((el) => { el.textContent = fmtDur(now() - (+el.dataset.start || now())); });
    document.querySelectorAll('#ctxMenu .call-clock').forEach((el) => { el.textContent = fmtDur(now() - (+el.dataset.start || now())); });
  }

  function renderControls() {
    const muted = !micOn || deaf;
    for (const id of ['micBtn', 'cbMic']) { const b = $(id); setIcon(b, muted ? 'micOff' : 'mic'); b.classList.toggle('off', muted); b.title = muted ? 'Unmute' : 'Mute'; }
    for (const id of ['deafBtn', 'cbDeaf']) { const b = $(id); setIcon(b, deaf ? 'deaf' : 'headphones'); b.classList.toggle('off', deaf); b.title = deaf ? 'Undeafen' : 'Deafen'; }
    const cam = !!(voice && voice.cam), ss = !!(voice && voice.ss);
    setIcon($('cbCam'), cam ? 'camera' : 'cameraOff');
    $('cbCam').classList.toggle('on', cam); $('cbCam').title = cam ? 'Turn off camera' : 'Turn on camera';
    const pending = !!(voice && voice.ssFrame && !voice.ss);
    $('cbShare').classList.toggle('on', ss); $('cbShare').classList.toggle('pending', pending);
    $('cbShare').title = ss ? 'Stop sharing' : pending ? 'Waiting for you to pick a screen… (click to cancel)' : 'Share your screen';
    $('cbFlip').classList.toggle('hidden', !(cam && touchDevice())); // flipping only makes sense on a phone with its camera on
    $('vsCam').classList.toggle('on', cam); $('vsShare').classList.toggle('on', ss); $('vsShare').classList.toggle('pending', pending);
  }

  // ---------------------------------------------------------------- modals
  let modalGeneration = 0;
  let modalCleanup = null; // set by a dialog that holds something to release (the player, object URLs)
  const runModalCleanup = () => { const fn = modalCleanup; modalCleanup = null; if (fn) try { fn(); } catch { } };
  let modalClosing = false;
  function modal(html, mount, dismissable = true, wide = false) {
    modalGeneration++;
    modalClosing = false;
    runModalCleanup();
    cancelMobileAnimation($('modal'));
    cancelMobileAnimation($('modalBack'));
    $('modal').inert = false;
    if (mobileLayout() && document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    setMobilePane(null);
    closeCtx();
    clearTimeout(devWait && devWait.timer); devWait = null;
    $('emojiMenu').classList.add('hidden');
    $('modal').innerHTML = html;
    $('modal').className = wide ? 'wide' : '';
    $('modal').scrollTop = 0;
    $('modalBack').classList.remove('hidden');
    $('modalBack').dataset.dismiss = dismissable ? '1' : '';
    $('modal').querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
    paintIcons($('modal'));
    if (mount) mount();
    updateMobileViewport();
    animateMobile($('modal'), [{ opacity: 0, transform: 'translateY(20px) scale(.985)' }, { opacity: 1, transform: 'none' }], 200);
    animateMobile($('modalBack'), [{ backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: 'rgba(0,0,0,.7)' }], 180);
  }
  function closeModal() {
    if (modalClosing || $('modalBack').classList.contains('hidden')) return;
    modalClosing = true;
    runModalCleanup();
    const generation = ++modalGeneration;
    if (mobileLayout() && $('modal').contains(document.activeElement) && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    closeCtx();
    clearTimeout(devWait && devWait.timer); devWait = null;
    $('modalBack').dataset.dismiss = '';
    $('modal').inert = true;
    const finish = () => {
      if (generation !== modalGeneration) return;
      $('modalBack').classList.add('hidden');
      $('modal').innerHTML = ''; $('modal').className = ''; $('modal').inert = false;
      modalClosing = false;
      updateMobileViewport();
    };
    const animations = [
      animateMobile($('modal'), [{}, { opacity: 0, transform: 'translateY(16px) scale(.985)' }], 140),
      animateMobile($('modalBack'), [{}, { backgroundColor: 'rgba(0,0,0,0)' }], 140)
    ].filter(Boolean);
    if (animations.length) Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
    else finish();
    updateMobileViewport();
  }
  $('modalBack').addEventListener('mousedown', (e) => { if (e.target === $('modalBack') && $('modalBack').dataset.dismiss) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('modalBack').dataset.dismiss) closeModal(); });

  function toast(text, ms) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.tm);
    toast.tm = setTimeout(() => t.classList.add('hidden'), ms || 3000);
    return false;
  }

  // profile editor: live preview card + colour swatches (+ custom colour)
  function profileEditor(name, color) {
    const custom = !COLORS.includes(color);
    return `<div class="pedit">
      <div class="pcard" id="pCard">
        <div class="pcard-banner" style="background:${avBg(color)}"></div>
        <div class="pcard-av" style="background:${avBg(color)}">${esc((name[0] || '?').toUpperCase())}<span class="dot"></span></div>
        <div class="pcard-body"><div class="pcard-name">${esc(name || 'Your name')}</div><div class="pcard-sub">Online</div></div>
      </div>
      <div class="pedit-fields">
        <label>Display name</label><input type="text" id="mName" maxlength="32" value="${esc(name)}" placeholder="e.g. daniel">
        <label>Profile colour</label>
        <div class="swatches" id="mColors">${COLORS.map((c) => `<button type="button" class="swatch ${c === color ? 'sel' : ''}" data-color="${c}" style="--sw:${c}" title="${c}">${icon('check')}</button>`).join('')}
          <label class="swatch custom ${custom ? 'sel' : ''}" title="Custom colour" style="--sw:${custom ? color : '#2b2d31'}">${icon('plus')}<input type="color" id="mCustom" value="${color}"></label>
        </div>
      </div>
    </div>`;
  }
  function wireProfileEditor(state) {
    const paint = () => {
      const card = $('pCard');
      card.querySelector('.pcard-banner').style.background = avBg(state.color);
      const pav = card.querySelector('.pcard-av');
      pav.style.background = avBg(state.color);
      pav.firstChild.nodeValue = ($('mName').value.trim()[0] || '?').toUpperCase();
      card.querySelector('.pcard-name').textContent = $('mName').value.trim() || 'Your name';
      card.querySelector('.pcard-name').style.color = state.color;
      $('mColors').querySelectorAll('.swatch').forEach((x) => x.classList.toggle('sel', x.dataset.color === state.color || (x.classList.contains('custom') && !COLORS.includes(state.color))));
      const cu = $('mColors').querySelector('.custom');
      if (!COLORS.includes(state.color)) cu.style.setProperty('--sw', state.color);
    };
    $('mColors').onclick = (e) => { const b = e.target.closest('[data-color]'); if (!b) return; state.color = b.dataset.color; paint(); };
    $('mCustom').oninput = () => { state.color = $('mCustom').value; paint(); };
    $('mName').addEventListener('input', paint);
    paint();
  }

  function profileModal(first) {
    const state = { color: (me && me.color) || COLORS[Math.floor(Math.random() * COLORS.length)] };
    modal(`<h2>Welcome to 叮咚</h2>
      <p>Pick a name and a colour. It's stored only in this browser.</p>
      ${profileEditor('', state.color)}
      <div class="actions"><button class="btn primary" id="mOk">Continue</button></div>`, () => {
      wireProfileEditor(state);
      const inp = $('mName');
      inp.focus();
      const ok = () => {
        const name = inp.value.trim().slice(0, 32);
        if (!name) return inp.focus();
        const color = state.color;
        me = { id: rid(12), name, color };
        store.set('me', me);
        closeModal();
        start();
      };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    }, !first, true);
  }

  const opt = (val, cur, label) => `<option value="${val}" ${String(val) === String(cur) ? 'selected' : ''}>${label}</option>`;

  function settingsModal(tab = 'profile') {
    const state = { color: me.color };
    modal(`<div class="tabs settings-tabs" role="tablist" aria-label="Settings sections"><button id="settingsProfileTab" data-tab="profile" role="tab" aria-controls="settingsProfile">My profile</button><button id="settingsAvTab" data-tab="av" role="tab" aria-controls="settingsAv">Voice &amp; Video</button></div>
      <div class="settings-content">
      <div class="tab-body" id="settingsProfile" data-body="profile" role="tabpanel" aria-labelledby="settingsProfileTab">
        ${profileEditor(me.name, me.color)}
        ${'Notification' in window && Notification.permission !== 'granted' ? '<label>Notifications</label><button class="btn" id="mNotif">Enable desktop notifications</button>' : ''}
      </div>
      <div class="tab-body" id="settingsAv" data-body="av" role="tabpanel" aria-labelledby="settingsAvTab">
        <h3>Microphone</h3>
        <label for="aMicGain">Microphone volume · <output id="aMicGainValue">${audioPercent(av.micGain)}%</output></label>
        <input type="range" id="aMicGain" min="0" max="200" step="1" value="${audioPercent(av.micGain)}" aria-label="Microphone volume">
        <p class="hint">100% is the normal level. Boost a quiet microphone up to 200%; lower it if your voice sounds distorted.</p>
        <h3>Camera</h3>
        <div class="grid3">
          <div><label>Resolution</label><select id="aCamQ">${opt('360', av.camQ, '360p')}${opt('720', av.camQ, '720p')}${opt('1080', av.camQ, '1080p')}${opt('1440', av.camQ, '1440p')}${opt('2160', av.camQ, '4K')}</select></div>
          <div><label>Frame rate</label><select id="aCamFps">${opt(15, av.camFps, '15 fps')}${opt(30, av.camFps, '30 fps')}${opt(60, av.camFps, '60 fps')}</select></div>
          <div><label>Bitrate</label><select id="aCamBr">${CAM_BRS.map((k) => opt(k, av.camBr, mbps(k))).join('')}</select></div>
        </div>
        <h3>Screen share</h3>
        <div class="grid3">
          <div><label>Resolution</label><select id="aSsQ">${opt('source', av.ssQ, 'Source (native)')}${opt('2160', av.ssQ, '4K')}${opt('1440', av.ssQ, '1440p')}${opt('1080', av.ssQ, '1080p')}${opt('720', av.ssQ, '720p')}</select></div>
          <div><label>Frame rate</label><select id="aSsFps">${opt(5, av.ssFps, '5 fps (slides)')}${opt(15, av.ssFps, '15 fps')}${opt(30, av.ssFps, '30 fps')}${opt(60, av.ssFps, '60 fps (games)')}</select></div>
          <div><label>Bitrate</label><select id="aSsBr">${SS_BRS.map((k) => opt(k, av.ssBr, mbps(k))).join('')}</select></div>
          <div style="grid-column: span 3"><label>Optimize screen share for</label><select id="aSsHint">${opt('motion', av.ssHint, 'Smoothness: prioritize frame rate (recommended)')}${opt('detail', av.ssHint, 'Clarity: prioritize sharp text and detail')}</select></div>
        </div>
        <p class="hint">Smoothness prioritizes the selected FPS under load. 1080p and a Low own preview reduce the processing needed for steady motion. Clarity may reduce FPS to keep text sharp.</p>
        <h3>Watching others</h3>
        <div class="grid3">
          <div><label>Video codec</label><select id="aCodec">${opt('h264', av.codec, 'H.264 (recommended)')}${opt('', av.codec, 'Auto')}${opt('vp9', av.codec, 'VP9')}${opt('av1', av.codec, 'AV1')}</select></div>
          <div><label>Your own preview</label><select id="aSelf">${opt('full', av.selfPreview, 'Full quality')}${opt('low', av.selfPreview, 'Low (saves CPU)')}${opt('off', av.selfPreview, 'Hidden')}</select></div>
          <div style="grid-column: span 3"><label>Max download per stream</label><select id="aRecv">${opt(0, av.recvCap, 'No limit (use each sender\'s setting)')}${VIEW_BRS.map((k) => opt(k, av.recvCap, 'Up to ' + mbps(k))).join('')}</select></div>
        </div>
        <label class="inline-check"><input type="checkbox" id="aStats" ${av.showStats ? 'checked' : ''}> Always show stream stats (resolution · fps · bitrate · codec) on video tiles</label>
        <p class="hint">Higher bitrate improves detail, and every viewer needs that much upload bandwidth. Change any stream's quality from its tile. ${voice ? 'Camera changes reconnect your call. Screen share changes apply to your current share.' : ''}</p>
        ${voice ? '<button class="btn" id="aDevices">Choose camera…</button><p class="hint">Use the small arrows beside the microphone and headphones buttons to choose your input and output devices.</p>' : '<p class="hint">Join a voice channel to pick your camera. Use the small arrows beside the microphone and headphones buttons to choose your input and output devices.</p>'}
      </div>
      </div>
      <div class="actions settings-actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`, () => {
      $('modal').classList.add('settings-dialog');
      const content = $('modal').querySelector('.settings-content');
      const positions = { profile: 0, av: 0 };
      let currentTab = null;
      const show = (t) => {
        const changed = currentTab !== null && currentTab !== t;
        if (content && currentTab) positions[currentTab] = content.scrollTop;
        $('modal').querySelectorAll('[data-tab]').forEach((b) => {
          b.classList.toggle('sel', b.dataset.tab === t);
          b.setAttribute('aria-selected', String(b.dataset.tab === t));
        });
        $('modal').querySelectorAll('[data-body]').forEach((b) => {
          b.classList.toggle('hidden', b.dataset.body !== t);
          b.setAttribute('aria-hidden', String(b.dataset.body !== t));
        });
        currentTab = t;
        if (content) content.scrollTop = positions[t] || 0;
        if (changed) animateMobile($(t === 'profile' ? 'settingsProfile' : 'settingsAv'), [{ opacity: .4, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 150);
      };
      $('modal').querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
      show(tab);
      wireProfileEditor(state);
      $('aMicGain').oninput = () => { $('aMicGainValue').textContent = audioPercent($('aMicGain').value) + '%'; };
      if ($('mNotif')) $('mNotif').onclick = () => Notification.requestPermission().then(() => toast('Notifications: ' + Notification.permission));
      if ($('aDevices')) $('aDevices').onclick = (e) => {
        if (!voice) return toast('Join a voice channel to choose a camera.');
        if (e) e.stopPropagation();
        deviceMenu($('aDevices'), 'videoinput', true);
      };
      $('mOk').onclick = () => {
        const name = $('mName').value.trim().slice(0, 32);
        if (!name) { show('profile'); return $('mName').focus(); }
        const color = state.color;
        me = { ...me, name, color };
        store.set('me', me);
        const next = {
          ssAudio: !!av.ssAudio, // set from the screen share menu, not this form
          outVol: audioPercent(av.outVol), // set from the headphone menu
          denoise: av.denoise !== false, // set from the microphone menu
          micGain: audioPercent($('aMicGain').value),
          camQ: $('aCamQ').value, camFps: +$('aCamFps').value, camBr: +$('aCamBr').value,
          ssQ: $('aSsQ').value, ssFps: +$('aSsFps').value, ssBr: +$('aSsBr').value, ssHint: $('aSsHint').value, recvCap: +$('aRecv').value, codec: $('aCodec').value, selfPreview: $('aSelf').value, showStats: $('aStats').checked, v8: 1, v9: 1, v48: 1,
        };
        const sendKeys = ['camQ', 'camFps', 'camBr'];
        const viewKeys = ['codec', 'selfPreview'];
        const shareChanged = SHARE_KEYS.some((k) => String(next[k]) !== String(av[k]));
        const viewChanged = viewKeys.some((k) => String(next[k]) !== String(av[k]));
        const avChanged = sendKeys.some((k) => String(next[k]) !== String(av[k]));
        av = next;
        store.set('av', av);
        closeModal();
        broadcastState();
        // A new name travels with the next heartbeat (broadcastState above). It used to reconnect every server
        // and rejoin the call to refresh VDO.Ninja's own labels, which nothing shows; for everyone else that
        // was a person leaving and coming back, with the call redrawing around it.
        if (voice && avChanged) joinVoice(voice.sid, voice.cid, voice.cam);
        else if (voice) applyVolumes(true);
        if (voice && shareChanged && voice.ssFrame) updateScreenShareQuality();
        if (viewChanged) { tileEls.forEach((el) => { el.dataset.vs = '__reload'; }); } // reconnect viewers with the new codec
        render();
        renderStage();
      };
    }, true, true);
  }

  function createServerModal() {
    modal(`<h2>Create a server</h2><p>Your server is a private peer-to-peer space. Share the invite link with friends.</p>
      <label>Server name</label><input type="text" id="mName" maxlength="64" value="${esc(me.name)}的服务器">
      <div class="actions"><button class="btn link" id="mJoin">Have an invite?</button><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Create</button></div>`, () => {
      const inp = $('mName');
      inp.select();
      const ok = () => { const n = inp.value.trim(); if (!n) return; closeModal(); createServer(n); };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
      $('mJoin').onclick = joinModal;
    });
  }

  function joinModal() {
    modal(`<h2>Join a server</h2><p>Type a join code, or paste an invite link.</p>
      <label>Join code or invite link</label><input type="text" id="mCode" placeholder="ABCD-EFGH  or  https://…#invite=…">
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Join</button></div>`, () => {
      const inp = $('mCode');
      inp.focus();
      const ok = () => { if (joinFromInvite(inp.value)) closeModal(); };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    });
  }

  function inviteModal() {
    const s = server(cur.sid);
    if (!s) return;
    const link = inviteLink(s);
    const local = location.protocol === 'file:' || /^(localhost|127\.)/.test(location.hostname);
    modal(`<h2>Invite friends to ${esc(s.name)}</h2>
      <p>Anyone with this link can join, chat and hop into voice. Keep it private.${local ? '<br><br><b>Heads up:</b> this copy is running on your own computer, so the link only works here. Use the hosted site to invite people.' : ''}</p>
      <label>Invite link</label><input type="text" id="mLink" readonly value="${esc(link)}">
      <label>Join code</label>
      <div class="join-code">${liveCode(s)
        ? `<b>${showCode(liveCode(s))}</b><span>Expires ${new Date(s.jc.x).toLocaleDateString([], { month: 'short', day: 'numeric' })}. Works while someone from this server is online.</span><button class="btn primary" id="mCodeCopy">Copy code</button><button class="btn link" id="mCodeOff">Turn off</button>`
        : `<span>A short code friends can type instead of the link. It lasts 7 days and works while someone from this server is online.</span><button class="btn primary" id="mCodeNew">Create code</button>`}</div>
      <div class="actions"><button class="btn link" data-close>Done</button><button class="btn primary" id="mCopy">Copy link</button></div>`, () => {
      const setCode = (jc) => { if (jc) s.jc = jc; else delete s.jc; bumpServer(s); syncLobbies(); inviteModal(); };
      if ($('mCodeNew')) $('mCodeNew').onclick = () => setCode({ c: rid(8), x: now() + JOIN_CODE_MS });
      if ($('mCodeOff')) $('mCodeOff').onclick = () => setCode(null);
      if ($('mCodeCopy')) $('mCodeCopy').onclick = () => { const text = showCode(liveCode(s) || ''); (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Join code copied'), () => toast(text)); };
      $('mLink').select();
      $('mCopy').onclick = () => {
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied'), () => { $('mLink').select(); document.execCommand('copy'); toast('Invite link copied'); });
      };
    });
  }

  function channelModal(type) {
    const s = server(cur.sid);
    modal(`<h2>Create channel</h2>
      <label>Channel type</label>
      <div class="radio-row">
        <label class="opt"><input type="radio" name="ct" value="text" ${type !== 'voice' ? 'checked' : ''}> <i data-icon="hash"></i> Text</label>
        <label class="opt"><input type="radio" name="ct" value="voice" ${type === 'voice' ? 'checked' : ''}> <i data-icon="speaker"></i> Voice</label>
      </div>
      <label>Channel name</label><input type="text" id="mName" maxlength="40" placeholder="new-channel">
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Create channel</button></div>`, () => {
      const inp = $('mName');
      inp.focus();
      const ok = () => {
        const t = document.querySelector('input[name=ct]:checked').value;
        let n = inp.value.trim();
        if (t === 'text') n = n.toLowerCase().replace(/\s+/g, '-');
        if (!n) return;
        const c = { id: rid(6), name: n.slice(0, 40), type: t };
        s.channels.push(c);
        bumpServer(s);
        closeModal();
        selectChannel(c.id);
      };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    });
  }

  function confirmModal(title, text, label, fn) {
    modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn danger" id="mOk">${esc(label)}</button></div>`, () => {
      $('mOk').onclick = () => { closeModal(); fn(); };
    });
  }

  function renameModal() {
    const s = server(cur.sid);
    modal(`<h2>Rename server</h2><label>Server name</label><input type="text" id="mName" maxlength="64" value="${esc(s.name)}">
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`, () => {
      const inp = $('mName');
      inp.select();
      const ok = () => { const n = inp.value.trim(); if (!n) return; s.name = n; bumpServer(s); closeModal(); };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    });
  }

  // ---------------------------------------------------------------- events
  paintIcons();
  $('serverList').onclick = (e) => { const b = e.target.closest('[data-sid]'); if (b) selectServer(b.dataset.sid); };
  $('homeBtn').onclick = () => selectServer(DM);
  $('members').addEventListener('click', (e) => {
    if (!e.target.closest('[data-forget-all]')) return;
    const sid = cur.sid, ms = members[sid] || {};
    const ids = [...new Set([...Object.keys(getKnown(sid)), ...Object.keys(ms)])].filter((id) => id !== me.id && !isOnline(ms[id]));
    if (ids.length) confirmModal('Remove offline people', `Remove ${ids.length} offline ${ids.length === 1 ? 'person' : 'people'} from the member list? Their messages stay, and anyone who comes back online is listed again.`, 'Remove', () => { const n = forgetUsers(sid, ids, true); toast(`Removed ${n} ${n === 1 ? 'person' : 'people'}`); });
  });
  $('addServerBtn').onclick = createServerModal;
  $('searchTop').onclick = () => (searchOpen() ? closeSearch() : openSearch());
  $('sClose').onclick = closeSearch;
  $('sQ').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); };
  $('sQ').onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); }
    else if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); }
  };
  $('sScope').onclick = (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    searchScope = b.dataset.scope;
    paintSearchScopes(); runSearch();
  };
  $('sOut').onclick = (e) => {
    const b = e.target.closest('[data-hit]'), h = b && searchHits[+b.dataset.hit];
    if (!h) return;
    $('sOut').querySelectorAll('.sr.on').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    if (cur.sid !== h.sid) selectServer(h.sid);
    if (cur.cid !== h.cid) selectChannel(h.cid);
    if (mobileLayout()) closeSearch(); // a phone has no room for both
    setTimeout(() => jumpToMessage(h.m.id, true), 80); // straight there: the channel may only just have been drawn
  };
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && me && $('modalBack').classList.contains('hidden')) { e.preventDefault(); openSearch(); } });
  $('wCreate').onclick = createServerModal;
  $('wJoin').onclick = joinModal;
  $('inviteTop').onclick = inviteModal;

  $('serverMenuBtn').onclick = (e) => { e.stopPropagation(); $('serverMenu').classList.toggle('hidden'); };
  document.addEventListener('click', () => $('serverMenu').classList.add('hidden'));
  $('serverMenu').onclick = (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const s = server(cur.sid);
    switch (a.dataset.act) {
      case 'invite': inviteModal(); break;
      case 'addText': channelModal('text'); break;
      case 'addVoice': channelModal('voice'); break;
      case 'rename': renameModal(); break;
      case 'leave': confirmLeave(s); break;
    }
  };

  // drag a channel to reorder it (within text or within voice); drag a person onto a voice channel to
  // move them there (yourself directly; someone else by asking their app to switch)
  (function listDragging() {
    const list = $('channelList');
    const clearMarks = () => list.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
    const voiceRowFor = (target) => {
      const row = target.closest('.chan[data-type="voice"]');
      if (row) return row;
      const box = target.closest('.voice-users');
      return box ? [...list.querySelectorAll('.chan[data-type="voice"]')].find((r) => r.dataset.cid === box.dataset.vc) : null;
    };
    list.addEventListener('dragstart', (e) => {
      const person = e.target.closest('.voice-user[data-uid]'), row = !person && e.target.closest('.chan[data-cid]');
      if ((!person && !row) || cur.sid === DM) return;
      listDrag = person ? { kind: 'user', id: person.dataset.uid } : { kind: 'chan', id: row.dataset.cid, type: row.dataset.type };
      (person || row).classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', listDrag.id);
    });
    list.addEventListener('dragover', (e) => {
      if (!listDrag) return;
      clearMarks();
      if (listDrag.kind === 'user') {
        const row = voiceRowFor(e.target);
        if (!row) return;
        e.preventDefault();
        row.classList.add('drop-into');
        return;
      }
      const row = e.target.closest('.chan[data-cid]');
      if (!row || row.dataset.type !== listDrag.type || row.dataset.cid === listDrag.id) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    list.addEventListener('drop', (e) => {
      const d = listDrag, s = server(cur.sid);
      if (!d || !s) return;
      e.preventDefault();
      if (d.kind === 'user') {
        const row = voiceRowFor(e.target), dest = row && channel(s, row.dataset.cid);
        if (!dest) return;
        if (d.id === me.id) {
          if (!(voice && voice.sid === s.id && voice.cid === dest.id)) joinVoice(s.id, dest.id, !!(voice && voice.sid === s.id && voice.cam));
        } else {
          const m = (members[s.id] || {})[d.id];
          if (m && m.vc !== dest.id) askPeer(s.id, d.id, { t: 'move', to: d.id, cid: dest.id }, MOVE_VER, `Moving ${m.user.name} to ${dest.name}`, (x) => x.vc === dest.id, 'be moved');
        }
        return;
      }
      const row = e.target.closest('.chan[data-cid]');
      if (!row || row.dataset.type !== d.type || row.dataset.cid === d.id) return;
      const r = row.getBoundingClientRect(), after = e.clientY >= r.top + r.height / 2;
      const moving = channel(s, d.id);
      if (!moving) return;
      s.channels = s.channels.filter((c) => c.id !== d.id);
      const at = s.channels.findIndex((c) => c.id === row.dataset.cid);
      s.channels.splice(at + (after ? 1 : 0), 0, moving);
      listDrag = null; // let the list redraw
      bumpServer(s);
    });
    list.addEventListener('dragend', () => { listDrag = null; clearMarks(); renderChannels(); });
  })();

  $('channelList').onclick = (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return channelModal(add.dataset.add);
    const sv = e.target.closest('[data-sid]');
    if (sv) return selectServer(sv.dataset.sid);
    const ch = e.target.closest('[data-cid]');
    if (ch) {
      const c = channel(server(cur.sid), ch.dataset.cid);
      selectChannel(ch.dataset.cid);
      // Discord-style: clicking a voice channel joins it
      if (c && c.type === 'voice' && !(voice && voice.sid === cur.sid && voice.cid === c.id)) joinVoice(cur.sid, c.id, false);
    }
  };

  $('messages').onclick = (e) => {
    const more = e.target.closest('[data-message-menu]');
    if (more) { e.stopPropagation(); return messageMenu(more.dataset.messageMenu, e.clientX, e.clientY); }
    const action = e.target.closest('[data-file-download], [data-file-cancel]');
    if (action) {
      e.stopPropagation();
      if (action.disabled || action.getAttribute('aria-disabled') === 'true') return;
      if (action.dataset.fileCancel) return fileTransfers.cancel(cur.sid, cur.cid, action.dataset.fileCancel);
      return startDownload(cur.sid, cur.cid, action.dataset.fileDownload);
    }
    const save = e.target.closest('[data-image-save]');
    if (save) { e.stopPropagation(); return downloadImage(cur.sid, cur.cid, save.dataset.imageSave); }
    const at = e.target.closest('[data-mention]');
    if (at) { e.stopPropagation(); return jumpToPerson(at.dataset.mention, e.clientX, e.clientY); }
    const image = e.target.closest('[data-image-open]');
    if (image) return openImage(cur.sid, cur.cid, image.dataset.imageOpen);
    const rp = e.target.closest('[data-reply]');
    if (rp) return replyToMessage(rp.dataset.reply);
    const jump = e.target.closest('[data-reply-jump]');
    if (jump) return jumpToMessage(jump.dataset.replyJump);
    const rt = e.target.closest('[data-rtoggle]');
    if (rt) return toggleReaction(rt.dataset.rtoggle, rt.dataset.e);
    const ra = e.target.closest('[data-react]');
    if (ra) { e.stopPropagation(); return emojiPicker(ra, (emo) => toggleReaction(ra.dataset.react, emo)); }
    const d = e.target.closest('[data-del]');
    if (d) return deleteMessage(d.dataset.del);
    const ed = e.target.closest('[data-edit]');
    if (ed) return editMessage(ed.dataset.edit);
  };
  $('messages').addEventListener('keydown', (e) => {
    const action = e.target.closest('.img-save[role="button"]');
    if (!action || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault(); e.stopPropagation();
    if (action.getAttribute('aria-disabled') !== 'true') action.click();
  });

  const input = $('msgInput');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; syncComposer(); };
  input.addEventListener('input', () => { autosize(); updateMention(); if (input.value.trim()) sendTyping(); });
  input.addEventListener('scroll', () => { $('msgMirror').scrollTop = input.scrollTop; });
  input.addEventListener('click', updateMention);
  input.addEventListener('blur', () => setTimeout(closeMention, 150)); // let a click on the list land first
  // while the @ picker is open the arrow keys, Enter, Tab and Escape belong to it
  input.addEventListener('keydown', (e) => {
    if (!mention) return;
    const n = mention.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { mention.sel = (mention.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; paintMention(); }
    else if ((e.key === 'Enter' && !e.isComposing) || e.key === 'Tab') acceptMention(mention.sel);
    else if (e.key === 'Escape') closeMention();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  });
  $('mentionMenu').addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    e.preventDefault(); // keep the caret in the message box
    acceptMention(+b.dataset.i);
  });
  input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !mobileLayout()) {
      e.preventDefault();
      if (sendMessage(input.value)) input.value = '';
      autosize();
    }
  });
  $('composer').onsubmit = (e) => {
    e.preventDefault();
    if (sendMessage(input.value)) input.value = '';
    autosize();
  };

  $('joinVoiceBtn').onclick = () => joinVoice(cur.sid, cur.cid, false);
  $('joinVideoBtn').onclick = () => joinVoice(cur.sid, cur.cid, true);
  $('vsLeave').onclick = leaveVoice;
  $('cbLeave').onclick = leaveVoice;
  $('vsCam').onclick = toggleCam;
  $('cbCam').onclick = toggleCam;
  $('cbFlip').onclick = flipCamera;
  $('vsShare').onclick = toggleShare;
  $('cbShare').onclick = toggleShare;
  $('voiceWhere').onclick = showVoice;
  // the call bar, the member-strip pill and the buttons on a stream fade out after a moment without mouse
  // movement, even with the pointer resting on the stream; they stay while the pointer is on one of them
  (function idleControls() {
    const stage = $('voiceStage');
    let timer = null, overBar = false, overTools = false;
    const menuOpen = () => ['ctxMenu', 'emojiMenu', 'qMenu'].some((id) => !$(id).classList.contains('hidden'));
    const wake = () => {
      stage.classList.remove('idle');
      clearTimeout(timer);
      if (mobileLayout()) return;
      timer = setTimeout(() => { if (overBar || overTools || menuOpen()) wake(); else stage.classList.add('idle'); }, 1500);
    };
    stage.addEventListener('mousemove', wake);
    stage.addEventListener('mousedown', wake);
    stage.addEventListener('pointerdown', wake);
    document.addEventListener('keydown', wake);
    $('callBar').addEventListener('mouseenter', () => { overBar = true; wake(); });
    $('callBar').addEventListener('mouseleave', () => { overBar = false; wake(); });
    $('tiles').addEventListener('mouseover', (e) => { overTools = !!(e.target.closest && e.target.closest('.tile-tools')); });
    $('tiles').addEventListener('mouseleave', () => { overTools = false; });
    wake();
  })();

  // the call preview: drag it anywhere inside the chat area; a plain click returns to the call
  (function miniPreview() {
    const stage = $('voiceStage');
    let drag = null, moved = false;
    const at = { r: 16, b: 84 }; // where the preview is, as offsets from the right / bottom of the chat area
    const place = (r, b) => { at.r = r; at.b = b; stage.style.setProperty('--mini-r', r + 'px'); stage.style.setProperty('--mini-b', b + 'px'); };
    const saved = store.get('miniPos', null);
    if (saved && Number.isFinite(saved.r) && Number.isFinite(saved.b)) place(saved.r, saved.b);
    let width = Math.max(200, Math.min(720, +store.get('miniW', 320) || 320));
    stage.style.setProperty('--mini-w', width + 'px');
    const clampPreview = () => {
      if (!mobileLayout()) return;
      const main = $('main').getBoundingClientRect();
      if (!main.width || !main.height) return;
      width = Math.max(64, Math.min(width, 320, main.width - 24, (main.height - 24) * 16 / 9));
      stage.style.setProperty('--mini-w', width + 'px');
      place(Math.max(12, Math.min(at.r, main.width - width - 12)), Math.max(12, Math.min(at.b, main.height - width * 9 / 16 - 12)));
    };
    window.addEventListener('resize', clampPreview);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', clampPreview);
    if (typeof ResizeObserver === 'function') new ResizeObserver(clampPreview).observe($('main'));
    clampPreview();
    stage.addEventListener('wheel', (e) => {
      if (!stage.classList.contains('mini')) return;
      e.preventDefault();
      const main = $('main').getBoundingClientRect();
      const next = Math.max(200, Math.min(720, main.width - 32, Math.round(width * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
      if (next === width) return;
      // keep it docked to the same corner while it grows or shrinks
      const maxR = main.width - width, maxB = main.height - width * 9 / 16;
      const leftSide = at.r > maxR / 2, topSide = at.b > maxB / 2;
      width = next;
      stage.style.setProperty('--mini-w', width + 'px');
      store.set('miniW', width);
      place(leftSide ? Math.max(16, main.width - width - 16) : 16, topSide ? Math.max(84, main.height - width * 9 / 16 - 64) : 84);
      store.set('miniPos', { r: at.r, b: at.b });
    }, { passive: false });
    let spring = 0;
    // drag any corner to resize: the opposite corner stays where it is and the 16:9 shape is kept
    let sizing = null;
    stage.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest && e.target.closest('.mini-grip');
      if (!grip || !stage.classList.contains('mini') || e.button) return;
      e.stopPropagation();
      cancelAnimationFrame(spring);
      const main = $('main').getBoundingClientRect(), c = grip.dataset.c;
      sizing = { grip, x: e.clientX, y: e.clientY, w: width, r: at.r, b: at.b, left: c[1] === 'l', top: c[0] === 't', mw: main.width, mh: main.height };
      stage.classList.add('resizing');
      try { grip.setPointerCapture(e.pointerId); } catch { }
    }, true);
    stage.addEventListener('pointermove', (e) => {
      if (!sizing) return;
      const dx = (sizing.left ? -1 : 1) * (e.clientX - sizing.x), dy = (sizing.top ? -1 : 1) * (e.clientY - sizing.y) * 16 / 9;
      let w = sizing.w + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
      // limits: sensible sizes, and the moving corner may not leave the chat area
      const roomW = sizing.left ? sizing.mw - sizing.r : sizing.r + sizing.w;
      const roomH = sizing.top ? sizing.mh - sizing.b : sizing.b + sizing.w * 9 / 16;
      w = Math.round(Math.max(200, Math.min(720, roomW, roomH * 16 / 9, w)));
      width = w;
      stage.style.setProperty('--mini-w', w + 'px');
      place(sizing.left ? sizing.r : sizing.r - (w - sizing.w), sizing.top ? sizing.b : sizing.b - (w - sizing.w) * 9 / 16);
    });
    const sized = () => {
      if (!sizing) return;
      sizing = null;
      moved = true; // the click that ends a resize must not jump back to the call
      stage.classList.remove('resizing');
      store.set('miniW', width);
      store.set('miniPos', { r: at.r, b: at.b });
    };
    stage.addEventListener('pointerup', sized);
    stage.addEventListener('pointercancel', sized);
    stage.addEventListener('pointerdown', (e) => {
      if (!stage.classList.contains('mini') || e.button || sizing) return;
      cancelAnimationFrame(spring); // catch it mid-flight
      const main = $('main').getBoundingClientRect();
      // start from the tracked position, not the drawn box: the box may be mid-animation or scaled
      drag = { x: e.clientX, y: e.clientY, r: at.r, b: at.b, maxR: main.width - stage.offsetWidth, maxB: main.height - stage.offsetHeight, trail: [] };
      moved = false;
      try { stage.setPointerCapture(e.pointerId); } catch { }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      stage.classList.add('dragging');
      drag.pos = { r: drag.r - dx, b: drag.b - dy };
      drag.trail.push({ t: performance.now(), r: drag.pos.r, b: drag.pos.b });
      if (drag.trail.length > 6) drag.trail.shift();
      place(drag.pos.r, drag.pos.b);
    });
    // Released: keep the speed it was thrown with, aim for the corner it is heading to, and settle there
    // on a slightly under-damped spring so it overshoots and bounces back.
    const fling = (pos, v, maxR, maxB) => {
      const rs = [16, Math.max(16, maxR - 16)], bs = [84, Math.max(84, maxB - 64)];
      const near = (x, list) => list.reduce((a, c) => (Math.abs(c - x) < Math.abs(a - x) ? c : a));
      const target = { r: near(pos.r + v.r * 0.3, rs), b: near(pos.b + v.b * 0.3, bs) }; // where it would coast to in ~1/3 s
      store.set('miniPos', target);
      if (document.hidden || typeof requestAnimationFrame !== 'function') return place(target.r, target.b);
      const K = 150, C = 13; // stiffness and damping (critical damping would be ~24.5, so this bounces)
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(0.032, (now - last) / 1000); last = now;
        for (const k of ['r', 'b']) {
          v[k] += (-K * (pos[k] - target[k]) - C * v[k]) * dt;
          pos[k] += v[k] * dt;
        }
        if (Math.abs(pos.r - target.r) < 0.5 && Math.abs(pos.b - target.b) < 0.5 && Math.hypot(v.r, v.b) < 8) return place(target.r, target.b);
        place(Math.round(pos.r * 10) / 10, Math.round(pos.b * 10) / 10);
        spring = requestAnimationFrame(step);
      };
      spring = requestAnimationFrame(step);
    };
    const end = () => {
      if (drag && drag.pos) {
        const a = drag.trail[0], z = drag.trail[drag.trail.length - 1];
        const dt = a && z && z.t > a.t && performance.now() - z.t < 120 ? (z.t - a.t) / 1000 : 0; // a pause before letting go means no throw
        const cap = (x) => Math.max(-6000, Math.min(6000, x));
        const v = dt ? { r: cap((z.r - a.r) / dt), b: cap((z.b - a.b) / dt) } : { r: 0, b: 0 };
        fling({ ...drag.pos }, v, drag.maxR, drag.maxB);
      }
      drag = null;
      stage.classList.remove('dragging');
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('click', () => {
      if (!stage.classList.contains('mini')) return;
      if (moved) { moved = false; return; } // that was a drag, not a click
      showVoice();
    });
  })();
  $('tiles').addEventListener('click', (e) => {
    if ($('voiceStage').classList.contains('mini')) return; // the preview only jumps back to the call
    const q = e.target.closest('[data-q]');
    if (q) { e.stopPropagation(); return qualityMenu(q.dataset.q, q); }
    const wf = e.target.closest('[data-wfs]');
    if (wf) { winFs = winFs === wf.dataset.wfs ? null : wf.dataset.wfs; if (document.fullscreenElement) document.exitFullscreen(); return renderStage(); }
    const fs = e.target.closest('[data-fs]');
    if (fs) { if (document.fullscreenElement) document.exitFullscreen(); else tileFullscreen(fs.dataset.fs); return; }
    const un = e.target.closest('[data-unwatch]');
    if (un) { if (winFs) winFs = null; return setWatching(un.dataset.unwatch, false); }
    const wa = e.target.closest('[data-watch]');
    if (wa) return setWatching(wa.dataset.watch, true);
    if (winFs) return; // a click on the picture shouldn't change the layout underneath
    const t = e.target.closest('.tile.video');
    if (t && panned) { panned = false; return; } // that was a drag across a zoomed stream
    if (t) { focusUid = focusUid === t.dataset.key ? null : t.dataset.key; renderStage(); }
  });
  let pan = null, panned = false;
  $('tiles').addEventListener('wheel', (e) => {
    if ($('voiceStage').classList.contains('mini')) return; // the preview resizes itself instead
    const t = e.target.closest('.tile.video');
    if (!t || e.target.closest('.tile-tools')) return;
    e.preventDefault();
    const r = t.getBoundingClientRect(), key = t.dataset.key, z = zooms.get(key) || { s: 1, u: 0, v: 0 };
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    const s = Math.max(1, Math.min(8, z.s * Math.pow(1.0018, -e.deltaY)));
    // keep the point under the cursor where it is
    setZoom(key, s, z.u + px / z.s - px / s, z.v + py / z.s - py / s);
  }, { passive: false });
  $('tiles').addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.tile.zoomed');
    panned = false;
    if (!t || e.button || e.target.closest('.tile-tools') || $('voiceStage').classList.contains('mini')) return;
    const z = zooms.get(t.dataset.key), r = t.getBoundingClientRect();
    pan = { key: t.dataset.key, el: t, x: e.clientX, y: e.clientY, u: z.u, v: z.v, w: r.width, h: r.height };
    try { t.setPointerCapture(e.pointerId); } catch { }
  });
  $('tiles').addEventListener('pointermove', (e) => {
    if (!pan) return;
    const z = zooms.get(pan.key);
    if (!z) { pan = null; return; }
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!panned && Math.hypot(dx, dy) < 4) return;
    panned = true;
    pan.el.classList.add('panning');
    setZoom(pan.key, z.s, pan.u - dx / pan.w / z.s, pan.v - dy / pan.h / z.s);
  });
  for (const type of ['pointerup', 'pointercancel']) $('tiles').addEventListener(type, () => { if (pan) pan.el.classList.remove('panning'); pan = null; });
  $('tiles').addEventListener('dblclick', (e) => {
    const t = e.target.closest('.tile.zoomed');
    if (t) { e.preventDefault(); setZoom(t.dataset.key, 1, 0, 0); }
  });
  // Touch screens: pinch a camera or shared screen to zoom it, move both fingers to pan while pinching,
  // drag with one finger once zoomed (the pointer handlers above), double-tap to go back to the whole picture.
  let pinch = null, tileTap = { at: 0, key: null };
  $('tiles').addEventListener('touchstart', (e) => {
    const t = e.target.closest && e.target.closest('.tile.video');
    if (!t || e.touches.length !== 2 || e.target.closest('.tile-tools') || $('voiceStage').classList.contains('mini')) return;
    const [a, b] = e.touches, r = t.getBoundingClientRect(), z = zooms.get(t.dataset.key) || { s: 1, u: 0, v: 0 };
    const px = ((a.clientX + b.clientX) / 2 - r.left) / r.width, py = ((a.clientY + b.clientY) / 2 - r.top) / r.height;
    // remember which point of the picture sits between the fingers; it stays there for the whole gesture
    pinch = { key: t.dataset.key, el: t, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, s: z.s, pu: z.u + px / z.s, pv: z.v + py / z.s };
    if (pan) { pan.el.classList.remove('panning'); pan = null; }
    e.preventDefault(); // not the browser's own page zoom
  }, { passive: false });
  $('tiles').addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches, r = pinch.el.getBoundingClientRect();
    const px = ((a.clientX + b.clientX) / 2 - r.left) / r.width, py = ((a.clientY + b.clientY) / 2 - r.top) / r.height;
    const scale = Math.max(1, Math.min(8, pinch.s * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d));
    setZoom(pinch.key, scale, pinch.pu - px / scale, pinch.pv - py / scale);
    panned = true; // lifting the fingers must not count as a tap on the tile
  }, { passive: false });
  for (const type of ['touchend', 'touchcancel']) $('tiles').addEventListener(type, (e) => {
    if (pinch) { if (e.touches.length < 2) pinch = null; return; }
    const t = type === 'touchend' && !e.touches.length && e.target.closest && e.target.closest('.tile.zoomed');
    if (!t || panned) { tileTap.at = 0; return; }
    if (now() - tileTap.at < 320 && tileTap.key === t.dataset.key) { tileTap.at = 0; panned = true; setZoom(t.dataset.key, 1, 0, 0); }
    else tileTap = { at: now(), key: t.dataset.key };
  }, { passive: true });
  document.addEventListener('click', (e) => { if (!e.target.closest('#qMenu')) $('qMenu').classList.add('hidden'); });
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && focusUid && $('modalBack').classList.contains('hidden')) { focusUid = null; renderStage(); } });
  $('devDone').onclick = () => { if (!voice) return; voice.devices = false; voicePost({ toggleSettings: false }); renderStage(); };
  for (const [id, kind] of [['micCaret', 'audioinput'], ['cbMicCaret', 'audioinput'], ['deafCaret', 'audiooutput'], ['cbDeafCaret', 'audiooutput'], ['cbCamCaret', 'videoinput']]) {
    caret(id, (el) => deviceMenu(el, kind));
  }
  caret('cbShareCaret', shareMenu);
  // only the avatar and name open the profile: a click that just misses the mic or headphone button must not
  $('userPanel').addEventListener('click', (e) => { if (e.target.closest('#meAvatar, .me-info')) settingsModal('profile'); });
  $('micBtn').onclick = toggleMic;
  $('cbMic').onclick = toggleMic;
  $('deafBtn').onclick = toggleDeaf;
  $('cbDeaf').onclick = toggleDeaf;
  $('settingsBtn').onclick = () => settingsModal('profile');
  $('cbSettings').onclick = () => settingsModal('av');
  $('membersToggle').onclick = () => {
    if (mobileLayout()) {
      if (!server(cur.sid)) return;
      membersOpen = true;
      renderMembers();
      setMobilePane(mobilePane === 'members' ? null : 'members');
      return;
    }
    membersOpen = !membersOpen;
    store.set('membersOpen', membersOpen);
    renderMembers();
  };
  $('mobileChannels').onclick = () => setMobilePane(mobilePane ? null : 'channels');
  $('mobileBackdrop').onclick = () => setMobilePane(null);
  // Touch: holding a finger on a message opens its menu (reply, react, copy…), on any phone browser or app.
  (() => {
    let hold = null;
    const cancel = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
    $('messages').addEventListener('touchstart', (e) => {
      cancel();
      const row = e.touches.length === 1 && e.target.closest && !e.target.closest('button, a, input, [data-image-open]') && e.target.closest('.msg[data-mid]');
      if (!row) return;
      const x = e.touches[0].clientX, y = e.touches[0].clientY;
      hold = { x, y, timer: setTimeout(() => { hold = null; messageMenu(row.dataset.mid, x, y); }, 480) };
    }, { passive: true });
    $('messages').addEventListener('touchmove', (e) => { const t = e.touches[0]; if (hold && t && Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > 10) cancel(); }, { passive: true });
    $('messages').addEventListener('touchend', cancel, { passive: true });
    $('messages').addEventListener('touchcancel', cancel, { passive: true });
  })();
    // Phones: swipe sideways to slide the side bars in and out. Right brings in the servers and channels,
  // left the member list; the opposite swipe (or a tap outside) puts an open one away again.
  (() => {
    let from = null;
    const busy = 'input[type="range"], .tile.zoomed, #voiceStage.mini, .ctx, #qMenu, #emojiMenu, #mentionMenu, #modalBack:not(.hidden), .image-viewer';
    document.addEventListener('touchstart', (e) => {
      from = mobileLayout() && e.touches.length === 1 && !(e.target.closest && e.target.closest(busy))
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: now() } : null;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => { if (e.touches.length !== 1) from = null; }, { passive: true }); // pinch, not swipe
    document.addEventListener('touchend', (e) => {
      const start = from, t = e.changedTouches[0];
      from = null;
      if (!start || !t || now() - start.at > 700 || !mobileLayout()) return;
      const dx = t.clientX - start.x, dy = t.clientY - start.y;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
      if (String(window.getSelection && window.getSelection()) !== '') return; // selecting text, not swiping
      const right = dx > 0, s = server(cur.sid);
      if (searchOpen()) { if (right) closeSearch(); return; } // the search panel covers the chat on a phone: swipe it away
      if (mobilePane) { if ((mobilePane === 'channels') !== right) setMobilePane(null); }
      else if (right) setMobilePane('channels');
      else if (s && !s.dm) { membersOpen = true; renderMembers(); setMobilePane('members'); }
    }, { passive: true });
  })();
  $('mobileSettings').onclick = () => { if (me) settingsModal('profile'); };
  $('mobileCall').onclick = () => { setMobilePane(null); showVoice(); };
  window.addEventListener('resize', updateMobileViewport);
  window.addEventListener('dischord-desktop-ready', updateMobileViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateMobileViewport);
    window.visualViewport.addEventListener('scroll', updateMobileViewport);
  }
  if (mobileMedia && mobileMedia.addEventListener) mobileMedia.addEventListener('change', updateMobileViewport);
  document.addEventListener('focusin', updateMobileViewport);
  document.addEventListener('focusout', updateMobileViewport);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mobilePane) setMobilePane(null); });
  updateMobileViewport();

  // Touch users have the same person, channel and server menus as right-click users.
  (function touchMenus() {
    let press = null, suppress = null;
    const clear = () => { if (press) clearTimeout(press.timer); press = null; };
    document.addEventListener('pointerdown', (e) => {
      clear();
      if (!mobileLayout() || e.pointerType === 'mouse' || e.button || e.target.closest('input, textarea, a, select')) return;
      const target = e.target.closest('#channelList .chan[data-cid], #serverList [data-sid], #channelList .voice-user[data-uid], #tiles .tile[data-key]');
      if (!target) return;
      const button = e.target.closest('button');
      if (button && button !== target) return;
      press = { target, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
        if (!press) return;
        const p = press;
        suppress = { target: p.target, until: now() + 1000 };
        press = null;
        if (p.target.dataset.cid) channelMenu(p.target.dataset.cid, p.x, p.y);
        else if (p.target.dataset.sid) railMenu(p.target.dataset.sid, p.x, p.y);
        else userMenu(p.target.dataset.uid || p.target.dataset.key.split(':')[0], p.x, p.y);
      }, 550) };
    }, true);
    document.addEventListener('pointermove', (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) clear(); }, { passive: true });
    document.addEventListener('pointerup', clear, true);
    document.addEventListener('pointercancel', clear, true);
    document.addEventListener('contextmenu', (e) => {
      if (suppress && suppress.until > now() && suppress.target.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    document.addEventListener('click', (e) => {
      if (suppress && suppress.until > now() && suppress.target.contains(e.target)) { suppress = null; e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (!mobileLayout() || e.target.closest('button, a, input, select, textarea')) return;
      const person = e.target.closest('#channelList .voice-user[data-uid], #members .mem[data-uid], [data-ctx="user"][data-uid]');
      if (person) { e.stopPropagation(); userMenu(person.dataset.uid, e.clientX, e.clientY); }
    }, true);
  })();

  // right-click menus
  document.addEventListener('contextmenu', (e) => {
    const btn = e.target.closest('#cbMic, #micBtn, #micCaret, #cbMicCaret, #cbDeaf, #deafBtn, #deafCaret, #cbDeafCaret, #cbCam, #vsCam, #cbCamCaret, #cbShare, #vsShare, #cbShareCaret');
    if (btn && ctxToggled === btn) { e.preventDefault(); ctxToggled = null; return; } // its menu was open: this right-click just closed it
    const mic = e.target.closest('#cbMic, #micBtn, #micCaret, #cbMicCaret');
    if (mic) { e.preventDefault(); return deviceMenu(mic, 'audioinput'); }
    const out = e.target.closest('#cbDeaf, #deafBtn, #deafCaret, #cbDeafCaret');
    if (out) { e.preventDefault(); return deviceMenu(out, 'audiooutput'); }
    const cam = e.target.closest('#cbCam, #vsCam, #cbCamCaret');
    if (cam) { e.preventDefault(); return deviceMenu(cam, 'videoinput'); }
    const shr = e.target.closest('#cbShare, #vsShare, #cbShareCaret');
    if (shr) { e.preventDefault(); return shareMenu(shr); }
    const u = e.target.closest('#channelList .voice-user[data-uid], #members .mem[data-uid], #tiles .tile[data-key], [data-ctx="user"][data-uid], #userPanel');
    const msg = !u && e.target.closest('#messages .msg[data-mid]');
    // never show the browser's own menu, except in text fields where it provides paste / spellcheck
    if (!e.target.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
    if (!u && !msg) {
      const chan = e.target.closest('#channelList .chan[data-cid]');
      if (chan) return channelMenu(chan.dataset.cid, e.clientX, e.clientY);
      const rail = e.target.closest('#serverList [data-sid]');
      if (rail) return railMenu(rail.dataset.sid, e.clientX, e.clientY);
      if (e.target.closest('#channelList, #serverHeader') && server(cur.sid)) return serverAreaMenu(e.clientX, e.clientY);
      return closeCtx();
    }
    e.preventDefault();
    if (msg) return messageMenu(msg.dataset.mid, e.clientX, e.clientY);
    const uid = u.id === 'userPanel' ? me.id : (u.dataset.uid || (u.dataset.key || '').split(':')[0]);
    if (uid) userMenu(uid, e.clientX, e.clientY);
  });
  document.addEventListener('mousedown', (e) => {
    // pressing the button that owns the open menu closes it; remember that so its click does not reopen it
    ctxToggled = ctxAnchor && ctxAnchor.contains(e.target) ? ctxAnchor : null;
    if (!e.target.closest('#ctxMenu')) closeCtx();
    if (!e.target.closest('#emojiMenu') && !e.target.closest('[data-react]') && !e.target.closest('#cbReact') && !e.target.closest('#cbReactCaret') && !e.target.closest('#emojiBtn')) $('emojiMenu').classList.add('hidden');
  });
  window.addEventListener('blur', closeCtx);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCtx(); $('emojiMenu').classList.add('hidden'); if (winFs) { winFs = null; renderStage(); } } });

  $('replyBar').onclick = (e) => { if (e.target.closest('#cancelReplyBtn')) cancelReply(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && replyTarget) cancelReply(); });

  // Files, including images: offer metadata via button, paste, or drag & drop.
  $('emojiBtn').onclick = (e) => {
    e.stopPropagation();
    if (!$('emojiMenu').classList.contains('hidden')) return $('emojiMenu').classList.add('hidden');
    emojiPicker($('emojiBtn'), (emo) => {
      const at = input.selectionStart ?? input.value.length, to = input.selectionEnd ?? at;
      input.value = input.value.slice(0, at) + emo + input.value.slice(to);
      input.focus();
      input.selectionStart = input.selectionEnd = at + emo.length;
      input.dispatchEvent(new Event('input'));
    }, EMOJIS);
  };
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = () => { addAttachments($('fileInput').files); $('fileInput').value = ''; };
  $('msgInput').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); addAttachments(files); }
  });
  $('textView').addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('textView').classList.add('drop'); } });
  $('textView').addEventListener('dragleave', (e) => { if (!e.relatedTarget || !$('textView').contains(e.relatedTarget)) $('textView').classList.remove('drop'); });
  $('textView').addEventListener('drop', (e) => { e.preventDefault(); $('textView').classList.remove('drop'); addAttachments(e.dataTransfer.files); });
  $('attachBar').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { pending.splice(+b.dataset.rm, 1); renderAttachBar(); } };

  // drag the inner edge of the channel sidebar / member list to resize; double-click resets
  const PANEL_MIN = 180, PANEL_MAX = 420;
  function applyPanelWidths() {
    for (const [key, prop] of [['sideW', '--side-w'], ['memW', '--mem-w']]) {
      const w = +store.get(key, 0);
      $('app').style.setProperty(prop, w ? Math.max(PANEL_MIN, Math.min(PANEL_MAX, w)) + 'px' : ''); // '' falls back to the stylesheet default
    }
  }
  applyPanelWidths();
  for (const [id, key, panel, fromLeft] of [['sideResizer', 'sideW', 'sidebar', true], ['memResizer', 'memW', 'members', false]]) {
    const handle = $(id);
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch { }
      handle.classList.add('dragging'); document.body.classList.add('resizing');
      const move = (ev) => {
        const r = $(panel).getBoundingClientRect();
        const w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(fromLeft ? ev.clientX - r.left : r.right - ev.clientX)));
        store.set(key, w);
        applyPanelWidths();
      };
      const up = () => {
        handle.classList.remove('dragging'); document.body.classList.remove('resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => { store.del(key); applyPanelWidths(); });
  }

  // in-call reactions
  $('stripToggle').onclick = () => { hideStrip = !hideStrip; store.set('hideStrip', hideStrip); renderStage(); };
  let emojiOwner = null;
  for (const [id, list] of [['cbReact', REACTS], ['cbReactCaret', EMOJIS]]) {
    $(id).onclick = (e) => {
      e.stopPropagation();
      const open = !$('emojiMenu').classList.contains('hidden');
      $('emojiMenu').classList.add('hidden');
      if (open && emojiOwner === id) { emojiOwner = null; return; }
      emojiOwner = id;
      emojiPicker($(id), sendCallReaction, list);
    };
  }

  window.addEventListener('hashchange', checkInviteHash);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    syncVoiceState();
    broadcastState();
    if (cur.sid && cur.cid) { markRead(cur.sid, cur.cid); renderRail(); renderChannels(); }
  });
  window.addEventListener('pagehide', () => { clearTimeout(filePaintTimer); filePaints.clear(); fileTransfers.close(); cancelImageRequests(); for (const sid in meshes) send(sid, { t: 'bye' }); });

  function checkInviteHash() {
    const m = location.hash.match(/invite=([A-Za-z0-9_-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (!me) { pendingInvite = m[1]; return; }
    joinFromInvite(m[1]);
  }
  let pendingInvite = null;

  // ---------------------------------------------------------------- timers
  bgTimer.every(1200, hearCallChanges); // also in a background tab, where a call usually is
  bgTimer.every(PING_MS, broadcastState); // presence heartbeat, unaffected by background-tab throttling
  setInterval(() => {
    renderTyping();
    if (cur.sid) renderPresence();
  }, 3000);
  setInterval(paintSpeaking, 250);
  setInterval(() => { paintCallTime(); paintChannelTimes(); }, 1000);
  setInterval(pollStats, 2000);
  setInterval(() => applyVolumes(true), 4000);
  setInterval(pollRoutes, DIAG_STEP);
  // previews still missing in the channel on screen are asked for again from time to time
  setInterval(() => { if (me && !document.hidden && document.querySelector('#messages img[data-img]:not([src])')) paintImages(); }, 15000);
  setInterval(announceViewers, 8000);
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd' && me) { e.preventDefault(); diagModal(); } });
  setInterval(paintImages, 15000); // retry visible uncached previews when a provider returns

  // ---------------------------------------------------------------- boot
  function start() {
    servers.forEach(connectMesh);
    syncLobbies();
    setInterval(syncLobbies, 60000); // drops the lobby of a code that has expired
    if (pendingInvite) { const p = pendingInvite; pendingInvite = null; joinFromInvite(p); }
    else selectServer(server(cur.sid) ? cur.sid : (servers[0] ? servers[0].id : null));
  }

  checkInviteHash();
  if (!me) { profileModal(true); } else start();

  // handy for debugging in the console
  window.dischord = { get me() { return me; }, servers: () => servers, members: () => members, peers: () => peers, get voice() { return voice; }, speaking };
})();
