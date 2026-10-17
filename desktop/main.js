'use strict';

const { app, BrowserWindow, Menu, WebContentsView, desktopCapturer, dialog, ipcMain, nativeTheme, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SITE = new URL('https://dan-k391.github.io/dingdong/');
const MEDIA_ORIGIN = 'https://vdo.ninja';
const PICKER_URL = pathToFileURL(path.join(__dirname, 'capture-picker.html')).href;
const OFFLINE_URL = pathToFileURL(path.join(__dirname, 'offline.html')).href;
const TITLE_BAR_HEIGHT = 32;
const pickers = new Map();
const cancelledCaptureFrames = new WeakSet();
// A selection belongs only to its current publisher document. It is never saved
// to disk or offered to a different frame, room, or manually started share.
let selectedCaptureFrames = new WeakMap();
const grants = new Set();
const permissionDialogs = new Map();
let mainWindow = null;
let retryDestination = SITE;
let queuedInvite = null;

app.setName('DingDong');
app.setAppUserModelId('io.github.dank391.dingdong');
nativeTheme.themeSource = 'dark';

function siteURL(value) {
  try {
    const url = new URL(value);
    return url.origin === SITE.origin && !url.username && !url.password &&
      [SITE.pathname, SITE.pathname.slice(0, -1), SITE.pathname + 'index.html'].includes(url.pathname) ? url : null;
  } catch { return null; }
}
function originOf(value) {
  try { return new URL(value).origin; } catch { return ''; }
}
function appContents(contents) {
  return !!contents && !!mainWindow && !mainWindow.isDestroyed() &&
    contents === mainWindow.webContents && !contents.isDestroyed() && !!siteURL(contents.getURL());
}
function trustedFrame(contents, value) {
  return appContents(contents) && [SITE.origin, MEDIA_ORIGIN].includes(originOf(value));
}
function launchURL(commandLine) {
  return commandLine.map(siteURL).find(Boolean) || SITE;
}
function openExternal(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) shell.openExternal(url.href).catch(() => {});
  } catch { }
}

function pendingPicker(event) {
  const pending = pickers.get(event.sender.id);
  return pending && event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === PICKER_URL ? pending : null;
}
function captureFrameLive(pending) {
  try {
    return appContents(mainWindow?.webContents) && pending.request.frame &&
      !pending.request.frame.detached && pending.request.frame.top === mainWindow.webContents.mainFrame &&
      trustedFrame(mainWindow.webContents, pending.request.frame.url);
  } catch { return false; }
}
function captureStreamId(frame) {
  try {
    if (originOf(frame.url) !== MEDIA_ORIGIN) return '';
    const streamId = new URL(frame.url).searchParams.get('push');
    return typeof streamId === 'string' && streamId.length > 0 && streamId.length <= 256 ? streamId : '';
  } catch { return ''; }
}
function captureOwner(event) {
  return appContents(event.sender) && event.senderFrame === event.sender.mainFrame &&
    !!siteURL(event.senderFrame.url);
}
function captureSelection(streamId) {
  if (!appContents(mainWindow?.webContents)) return null;
  for (const frame of mainWindow.webContents.mainFrame.framesInSubtree) {
    const record = selectedCaptureFrames.get(frame);
    if (record && !frame.isDestroyed() && !frame.detached &&
      captureStreamId(frame) === streamId && record.streamId === streamId) return { frame, record };
  }
  return null;
}
function restartDetails(payload) {
  return typeof payload?.streamId === 'string' && payload.streamId.length > 0 && payload.streamId.length <= 256 &&
    typeof payload.requestId === 'string' && payload.requestId.length > 0 && payload.requestId.length <= 128;
}
function restartFailed(frame, record, error) {
  // Denial must also suppress VDO's automatic no-audio retry: a quality change
  // must never unexpectedly replace its source with a newly selected screen.
  cancelledCaptureFrames.add(frame);
  selectedCaptureFrames.delete(frame);
  if (appContents(mainWindow?.webContents)) {
    mainWindow.webContents.send('dischord:screen-quality-restart-failed', {
      streamId: record.streamId, requestId: record.restart?.requestId || '', error
    });
  }
}
ipcMain.handle('dischord:screen-quality-restart', (event, payload) => {
  if (!captureOwner(event) || !restartDetails(payload)) return { ok: false, error: 'Invalid sharing request.' };
  const selection = captureSelection(payload.streamId);
  if (!selection || cancelledCaptureFrames.has(selection.frame)) {
    return { ok: false, error: 'The previous sharing source is no longer available.' };
  }
  if (selection.record.restart) return { ok: false, error: 'A quality change is already in progress.' };
  selection.record.restart = { requestId: payload.requestId, expiresAt: Date.now() + 15000, consumed: false };
  return { ok: true };
});
ipcMain.handle('dischord:screen-quality-restart-run', async (event, payload) => {
  if (!captureOwner(event) || !restartDetails(payload)) return { ok: false, error: 'Invalid sharing request.' };
  const selection = captureSelection(payload.streamId);
  const restart = selection?.record.restart;
  if (!restart || restart.requestId !== payload.requestId || restart.consumed || restart.runStarted ||
    restart.expiresAt < Date.now() || cancelledCaptureFrames.has(selection.frame)) {
    return { ok: false, error: 'The quality change is no longer armed.' };
  }
  restart.runStarted = true;
  // This is the only script the bridge can run. Preferences are prepared by
  // Dischord's fixed iframe helper; IPC accepts only an existing request id.
  // Calling getDisplayMedia synchronously here retains Chromium's activation.
  const code = `(() => { const bridge = window.__dischordScreenQualityV1;
    if (!bridge || typeof bridge.runArmedRestart !== 'function') return false;
    return bridge.runArmedRestart(${JSON.stringify(payload.requestId)}) !== false; })()`;
  try {
    const started = await selection.frame.executeJavaScript(code, true);
    return started === true ? { ok: true } : { ok: false, error: 'The stream quality helper is unavailable.' };
  } catch {
    return { ok: false, error: 'The stream quality helper could not restart this share.' };
  }
});
ipcMain.on('dischord:screen-quality-restart-cancel', (event, payload) => {
  if (!captureOwner(event) || !restartDetails(payload)) return;
  const selection = captureSelection(payload.streamId);
  if (selection?.record.restart?.requestId === payload.requestId) {
    selection.record.restart = null;
  }
});
ipcMain.on('dischord:screen-share-stopped', (event, payload) => {
  if (!captureOwner(event) || typeof payload?.streamId !== 'string' || payload.streamId.length > 256) return;
  const selection = captureSelection(payload.streamId);
  if (selection) {
    cancelledCaptureFrames.add(selection.frame);
    selectedCaptureFrames.delete(selection.frame);
  }
});
function finishCapture(pending, source, includeAudio = false) {
  if (pending.finished) return;
  pending.finished = true;
  clearInterval(pending.lifetimeTimer);
  pickers.delete(pending.id);
  const streams = source && captureFrameLive(pending) ? { video: source } : {};
  if (streams.video && pending.request.audioRequested && includeAudio && process.platform === 'win32') {
    streams.audio = 'loopback';
  }
  if (streams.video) {
    const streamId = captureStreamId(pending.request.frame);
    if (streamId) selectedCaptureFrames.set(pending.request.frame, {
      sourceId: source.id, displayId: source.display_id || '', streamId, includeAudio: !!streams.audio, restart: null
    });
  }
  try { pending.callback(streams); } catch { }
  pending.owner.removeListener('resize', pending.layout);
  if (!pending.owner.isDestroyed()) {
    pending.owner.contentView.removeChildView(pending.view);
    if (!pending.owner.webContents.isDestroyed()) pending.owner.webContents.focus();
  }
  // WebContentsView clears its webContents getter once the renderer is destroyed.
  if (!pending.contents.isDestroyed()) pending.contents.close({ waitForBeforeUnload: false });
}

ipcMain.handle('dischord:capture-list', async (event) => {
  const pending = pendingPicker(event);
  if (!pending || !captureFrameLive(pending)) {
    if (pending) finishCapture(pending);
    throw new Error('This sharing request has ended.');
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true
  });
  if (pending.finished || !captureFrameLive(pending)) {
    finishCapture(pending);
    throw new Error('This sharing request has ended.');
  }
  // The picker is a view inside Dischord, so it creates no separate window source.
  const available = sources;
  pending.sources = new Map(available.map((source) => [source.id, source]));
  return {
    sources: available.map((source) => ({ id: source.id, name: source.name,
      thumbnail: source.thumbnail.toDataURL(), appIcon: source.appIcon?.toDataURL() || '',
      kind: source.id.startsWith('screen:') ? 'screen' : 'window' })),
    audioRequested: !!pending.request.audioRequested && process.platform === 'win32'
  };
});
ipcMain.handle('dischord:capture-select', (event, selection) => {
  const pending = pendingPicker(event);
  if (pending && !captureFrameLive(pending)) {
    finishCapture(pending);
    return { ok: false, error: 'This sharing request has ended.' };
  }
  const source = pending && typeof selection?.sourceId === 'string' && pending.sources.get(selection.sourceId);
  if (!pending || !source) return { ok: false, error: 'That source is no longer available. Refresh the list.' };
  finishCapture(pending, source, selection.includeAudio === true);
  return { ok: true };
});
ipcMain.handle('dischord:capture-cancel', (event) => {
  const pending = pendingPicker(event);
  if (pending && !pending.finished) {
    if (captureFrameLive(pending)) {
      // VDO retries AbortError once without audio. A deliberate Cancel must not
      // immediately reopen the chooser for this same iframe's fallback request.
      cancelledCaptureFrames.add(pending.request.frame);
      const streamId = new URL(pending.request.frame.url).searchParams.get('push');
      if (streamId && streamId.length <= 256) {
        pending.owner.webContents.send('dischord:screen-share-cancelled', { streamId });
      }
    }
    finishCapture(pending);
  }
  return { ok: true };
});

async function chooseCapture(request, callback) {
  let frameIsOurs = false;
  try {
    frameIsOurs = appContents(mainWindow?.webContents) && request.frame &&
      request.frame.top === mainWindow.webContents.mainFrame && trustedFrame(mainWindow.webContents, request.frame.url);
  } catch { }
  if (!frameIsOurs || !request.videoRequested || pickers.size || cancelledCaptureFrames.has(request.frame)) {
    // Electron also reports this denial to the requesting renderer as an error.
    // Its callback can throw while validating the intentionally empty streams.
    try { callback({}); } catch { }
    return;
  }
  const selection = selectedCaptureFrames.get(request.frame);
  if (selection?.restart) {
    const restart = selection.restart;
    if (restart.consumed || restart.expiresAt < Date.now() || captureStreamId(request.frame) !== selection.streamId) {
      restartFailed(request.frame, selection, 'The quality change has expired.');
      try { callback({}); } catch { }
      return;
    }
    restart.consumed = true;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false
      });
      const live = captureFrameLive({ request }) && selectedCaptureFrames.get(request.frame) === selection &&
        selection.restart === restart && captureStreamId(request.frame) === selection.streamId;
      if (!live) { try { callback({}); } catch { } return; }
      if (restart.expiresAt < Date.now()) throw new Error('The quality change has expired.');
      const source = sources.find((item) => item.id === selection.sourceId);
      if (!source) throw new Error('The previously shared window or screen has closed or disconnected.');
      if (selection.displayId && source.display_id !== selection.displayId) {
        throw new Error('The previously shared display has disconnected or changed.');
      }
      const streams = { video: source };
      if (selection.includeAudio && request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
      selection.restart = null;
    } catch (error) {
      // A stopped/navigated frame cannot use a selection even if enumeration
      // completed after its explicit Stop action.
      restartFailed(request.frame, selection, error?.message || 'The sharing source could not be restarted.');
      try { callback({}); } catch { }
    }
    return;
  }
  if (selection) {
    // This document already owns its explicit selection. VDO may retry a failed
    // native capture without audio; it cannot open another chooser unless the
    // user first stops the current share and starts a new publisher document.
    try { callback({}); } catch { }
    return;
  }
  const owner = mainWindow;
  const pickerSession = session.fromPartition('capture-picker');
  pickerSession.setPermissionCheckHandler(() => false);
  pickerSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const picker = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'capture-picker-preload.js'), session: pickerSession,
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true
    }
  });
  picker.setBackgroundColor('#00000000');
  picker.setVisible(false);
  const pending = { id: picker.webContents.id, contents: picker.webContents, view: picker, owner,
    request, callback, sources: new Map(), finished: false };
  pending.layout = () => {
    if (pending.finished || owner.isDestroyed()) return;
    const [width, height] = owner.getContentSize();
    picker.setBounds({ x: 0, y: TITLE_BAR_HEIGHT, width, height: Math.max(0, height - TITLE_BAR_HEIGHT) });
  };
  pickers.set(pending.id, pending);
  owner.contentView.addChildView(picker);
  owner.on('resize', pending.layout);
  pending.layout();
  // VDO can cancel its request or remove its iframe while the chooser is open.
  pending.lifetimeTimer = setInterval(() => {
    if (!captureFrameLive(pending)) finishCapture(pending);
  }, 1000);
  picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  picker.webContents.on('will-navigate', (event) => event.preventDefault());
  picker.webContents.once('dom-ready', () => {
    if (!pending.finished) { picker.setVisible(true); picker.webContents.focus(); }
  });
  picker.webContents.on('destroyed', () => { if (!pending.finished) finishCapture(pending); });
  picker.webContents.on('render-process-gone', () => finishCapture(pending));
  picker.webContents.loadFile(path.join(__dirname, 'capture-picker.html')).catch(() => finishCapture(pending));
}

function configurePermissions(ses) {
  const normal = new Set(['fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write', 'screen-wake-lock']);
  const prompted = new Map([
    ['media', 'use your microphone and camera'],
    ['speaker-selection', 'select your audio output device'],
    ['notifications', 'show desktop notifications'],
    ['clipboard-read', 'read your clipboard'],
    ['local-network', 'connect to peers on your local network'],
    ['local-network-access', 'connect to peers on your local network']
  ]);
  const keyOf = (origin, permission) => origin + '|' + permission;
  function permissionContext(contents, permission, requesting) {
    return trustedFrame(contents, requesting) ||
      (!contents && permission === 'notifications' && originOf(requesting) === SITE.origin &&
        appContents(mainWindow?.webContents));
  }
  function automatic(contents, permission, requesting) {
    if (!trustedFrame(contents, requesting)) return false;
    if (normal.has(permission) || permission === 'display-capture') return true;
    // A chosen file handle stays under Chromium's native picker and user gesture.
    // fileSystem checks can report isMainFrame=false even for the hosted page.
    return permission === 'fileSystem' && originOf(requesting) === SITE.origin;
  }
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details = {}) => {
    const requesting = details.requestingUrl || details.securityOrigin || requestingOrigin;
    return automatic(contents, permission, requesting) ||
      permissionContext(contents, permission, requesting) && grants.has(keyOf(originOf(requesting), permission));
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details = {}) => {
    const requesting = details.requestingUrl || details.securityOrigin || contents?.getURL();
    if (automatic(contents, permission, requesting)) { callback(true); return; }
    if (!permissionContext(contents, permission, requesting) || !prompted.has(permission)) { callback(false); return; }
    const origin = originOf(requesting), key = keyOf(origin, permission);
    if (grants.has(key)) { callback(true); return; }
    let pending = permissionDialogs.get(key);
    if (!pending) {
      pending = dialog.showMessageBox(mainWindow, {
        type: 'question', title: '叮咚 权限',
        message: 'Allow 叮咚 to ' + prompted.get(permission) + '?',
        detail: origin + '\nThis permission lasts for the current app session.',
        buttons: ['Allow', 'Don’t allow'], defaultId: 1, cancelId: 1, noLink: true
      }).then(({ response }) => {
        if (response === 0 && permissionContext(contents, permission, requesting)) { grants.add(key); return true; }
        return false;
      }).catch(() => false).finally(() => permissionDialogs.delete(key));
      permissionDialogs.set(key, pending);
    }
    pending.then((allowed) => { try { callback(allowed && permissionContext(contents, permission, requesting)); } catch { } });
  });
  ses.setDisplayMediaRequestHandler(chooseCapture);
}

function createWindow(destination) {
  retryDestination = destination;
  queuedInvite = null;
  const ses = session.fromPartition('persist:dingdong');
  // VDO's Electron detection expects its own Node IPC capture bridge. Select
  // its Chromium getDisplayMedia path while keeping the real browser version.
  // Cross-site iframe renderers also need the app/WebContents UA: Electron can
  // override a session-only UA when it creates the window or an iframe process.
  const browserUserAgent = ses.getUserAgent().replace(/\sElectron\/\S+/gi, '');
  app.userAgentFallback = browserUserAgent;
  ses.setUserAgent(browserUserAgent);
  configurePermissions(ses);
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 720, minHeight: 500,
    title: '叮咚', backgroundColor: '#313338', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: { color: '#2b2d31', symbolColor: '#dbdee1', height: TITLE_BAR_HEIGHT }
    }),
    webPreferences: {
      preload: path.join(__dirname, 'desktop-preload.js'),
      session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  mainWindow.webContents.setUserAgent(browserUserAgent);
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isSameDocument) return;
    if (details.isMainFrame) selectedCaptureFrames = new WeakMap();
    else if (details.frame) selectedCaptureFrames.delete(details.frame);
  });
  mainWindow.webContents.on('render-process-gone', () => { selectedCaptureFrames = new WeakMap(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const invite = siteURL(url);
    if (invite) acceptInvite(invite); else openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (mainWindow.webContents.getURL() === OFFLINE_URL && siteURL(url)) {
      event.preventDefault();
      loadHosted(queuedInvite || retryDestination);
    } else if (!siteURL(url)) { event.preventDefault(); openExternal(url); }
  });
  mainWindow.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame && !siteURL(url)) event.preventDefault();
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(path.join(__dirname, 'offline.html')).catch(() => {});
      mainWindow.show();
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    const loaded = siteURL(mainWindow.webContents.getURL());
    if (!loaded) return;
    retryDestination = loaded;
    // Initial URL hashes are consumed by the web app during boot. Only deliver
    // a newer invite that arrived while that page was still loading.
    if (queuedInvite) {
      const invite = queuedInvite;
      queuedInvite = null;
      deliverInvite(invite);
    }
  });
  mainWindow.on('close', () => {
    for (const pending of [...pickers.values()]) finishCapture(pending);
  });
  mainWindow.on('closed', () => { mainWindow = null; grants.clear(); selectedCaptureFrames = new WeakMap(); });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.loadURL(destination.href).catch(() => {});
}

function loadHosted(destination) {
  retryDestination = destination;
  queuedInvite = null;
  mainWindow.loadURL(destination.href).catch(() => {});
}
function deliverInvite(destination) {
  if (!destination.hash) return;
  const contents = mainWindow.webContents;
  contents.executeJavaScript('location.hash = ' + JSON.stringify(destination.hash)).catch(() => {
    if (!contents.isDestroyed() && !queuedInvite) queuedInvite = destination;
  });
}
function acceptInvite(destination) {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(destination); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
  // Adding an invite to an open client must not reload and interrupt a call.
  if (siteURL(mainWindow.webContents.getURL()) && !mainWindow.webContents.isLoadingMainFrame()) {
    deliverInvite(destination);
  } else if (mainWindow.webContents.isLoadingMainFrame()) {
    if (destination.hash) queuedInvite = destination;
  } else {
    loadHosted(destination.hash ? destination : (queuedInvite || retryDestination));
  }
}

const destination = launchURL(process.argv);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    app.whenReady().then(() => acceptInvite(launchURL(commandLine)));
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '叮咚', submenu: [
        { label: 'Open website', click: () => openExternal(SITE.href) },
        { type: 'separator' }, { role: 'quit' }
      ] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] }
    ]));
    createWindow(destination);
  });
  app.on('activate', () => { if (!mainWindow) createWindow(SITE); });
  app.on('window-all-closed', () => app.quit());
}
