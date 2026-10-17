'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dischordCapture', {
  list: () => ipcRenderer.invoke('dischord:capture-list'),
  select: (sourceId, includeAudio) => ipcRenderer.invoke('dischord:capture-select', {
    sourceId: typeof sourceId === 'string' ? sourceId : '',
    includeAudio: includeAudio === true
  }),
  cancel: () => ipcRenderer.invoke('dischord:capture-cancel')
});
