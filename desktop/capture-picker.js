'use strict';

(() => {
  const api = window.dischordCapture;
  const grid = document.getElementById('sources');
  const panel = document.getElementById('source-panel');
  const listStatus = document.getElementById('list-status');
  const selectionStatus = document.getElementById('selection-status');
  const error = document.getElementById('error');
  const audioOption = document.getElementById('audio-option');
  const includeAudio = document.getElementById('include-audio');
  const share = document.getElementById('share');
  const cancel = document.getElementById('cancel');
  const close = document.getElementById('close');
  const refresh = document.getElementById('refresh');
  const tabs = Array.from(document.querySelectorAll('[data-kind]'));
  let sources = [];
  let kind = 'screen';
  let selectedId = '';
  let audioRequested = false;
  let loading = false;
  let submitting = false;
  let cancelling = false;
  let hasLoaded = false;

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function validImage(value) {
    return typeof value === 'string' && value.length <= 2000000 &&
      /^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i.test(value);
  }

  function updateControls() {
    const busy = loading || submitting || cancelling;
    share.disabled = busy || !sources.some((source) => source.id === selectedId && source.kind === kind);
    share.textContent = submitting ? 'Starting…' : 'Share';
    refresh.disabled = busy;
    includeAudio.disabled = submitting || cancelling;
    tabs.forEach((tab) => { tab.disabled = submitting || cancelling; });
    grid.querySelectorAll('.source-card').forEach((card) => { card.disabled = busy; });
    cancel.disabled = cancelling;
    close.disabled = cancelling;
    panel.setAttribute('aria-busy', String(loading));
  }

  function updateSelection() {
    const selected = sources.find((source) => source.id === selectedId && source.kind === kind);
    grid.querySelectorAll('.source-card').forEach((card) => {
      const active = !!selected && card.dataset.sourceId === selected.id;
      card.classList.toggle('selected', active);
      card.setAttribute('aria-pressed', String(active));
    });
    selectionStatus.textContent = selected ? 'Selected: ' + selected.name : 'Select a screen or window to continue.';
    updateControls();
  }

  function moveSourceFocus(event) {
    const buttons = Array.from(grid.querySelectorAll('.source-card'));
    const index = buttons.indexOf(event.currentTarget);
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next].focus();
  }

  function renderSources() {
    grid.replaceChildren();
    tabs.forEach((tab) => {
      const active = tab.dataset.kind === kind;
      const count = sources.filter((source) => source.kind === tab.dataset.kind).length;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const label = document.createElement('span');
      label.textContent = tab.dataset.kind === 'screen' ? 'Screens' : 'Applications';
      tab.replaceChildren(label);
      if (hasLoaded) {
        const badge = document.createElement('span');
        badge.className = 'tab-count';
        badge.textContent = String(count);
        tab.appendChild(badge);
      }
      if (active) panel.setAttribute('aria-labelledby', tab.id);
    });
    const visible = sources.filter((source) => source.kind === kind);
    listStatus.hidden = !loading && visible.length > 0;
    listStatus.textContent = loading ? 'Finding screens and windows…' : visible.length ? '' :
      'No ' + (kind === 'screen' ? 'screens' : 'application windows') + ' are available. Refresh to try again.';

    visible.forEach((source) => {
      const item = document.createElement('div');
      item.className = 'source-item';
      item.setAttribute('role', 'listitem');
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'source-card';
      card.dataset.sourceId = source.id;
      card.setAttribute('aria-label', source.name + ' (' + source.kind + ')');
      card.setAttribute('aria-pressed', 'false');
      const preview = document.createElement('span');
      preview.className = 'source-preview';
      if (validImage(source.thumbnail)) {
        const image = document.createElement('img');
        image.src = source.thumbnail;
        image.alt = '';
        image.draggable = false;
        image.addEventListener('error', () => { image.hidden = true; });
        preview.appendChild(image);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'preview-placeholder';
        placeholder.textContent = 'Preview unavailable';
        preview.appendChild(placeholder);
      }
      const caption = document.createElement('span');
      caption.className = 'source-caption';
      if (validImage(source.appIcon)) {
        const icon = document.createElement('img');
        icon.className = 'source-icon';
        icon.src = source.appIcon;
        icon.alt = '';
        icon.draggable = false;
        icon.addEventListener('error', () => { icon.hidden = true; });
        caption.appendChild(icon);
      }
      const name = document.createElement('span');
      name.className = 'source-name';
      name.textContent = source.name;
      name.title = source.name;
      caption.appendChild(name);
      card.append(preview, caption);
      card.addEventListener('click', () => {
        if (loading || submitting || cancelling) return;
        selectedId = source.id;
        showError('');
        updateSelection();
      });
      // double-click (or Enter on an already selected card) shares it straight away
      card.addEventListener('dblclick', () => { if (selectedId === source.id && !share.disabled) share.click(); });
      card.addEventListener('keydown', moveSourceFocus);
      item.appendChild(card);
      grid.appendChild(item);
    });
    updateSelection();
  }

  function selectKind(nextKind) {
    if (submitting || cancelling || nextKind === kind) return;
    kind = nextKind;
    selectedId = '';
    showError('');
    renderSources();
  }

  async function loadSources() {
    if (loading || submitting || cancelling) return;
    loading = true;
    showError('');
    renderSources();
    try {
      const result = await api.list();
      if (cancelling) return;
      const seen = new Set();
      sources = (result && Array.isArray(result.sources) ? result.sources : []).filter((source) => {
        if (!source || typeof source.id !== 'string' || !source.id || seen.has(source.id) ||
            typeof source.name !== 'string' || (source.kind !== 'screen' && source.kind !== 'window')) return false;
        seen.add(source.id);
        return true;
      });
      audioRequested = !!(result && result.audioRequested);
      audioOption.hidden = !audioRequested;
      if (!audioRequested) includeAudio.checked = false;
      if (!hasLoaded && !sources.some((source) => source.kind === kind) && sources.length) kind = sources[0].kind;
      if (!sources.some((source) => source.id === selectedId && source.kind === kind)) selectedId = '';
      hasLoaded = true;
    } catch {
      sources = [];
      selectedId = '';
      showError('Could not load screens and windows. Refresh to try again.');
    } finally {
      loading = false;
      if (!cancelling) renderSources();
    }
  }

  async function cancelCapture() {
    if (cancelling) return;
    cancelling = true;
    selectionStatus.textContent = 'Cancelling…';
    updateControls();
    try {
      await api.cancel();
    } catch {
      // The main process removes this view as soon as cancellation is accepted.
      // Keep a retry available if IPC failed before that cleanup happened.
      cancelling = false;
      showError('Could not cancel screen sharing. Try Cancel again.');
      updateControls();
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectKind(tab.dataset.kind));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectKind(tabs[next].dataset.kind);
      tabs[next].focus();
    });
  });
  refresh.addEventListener('click', loadSources);
  cancel.addEventListener('click', cancelCapture);
  close.addEventListener('click', cancelCapture);
  document.body.addEventListener('click', (event) => { if (event.target === document.body) cancelCapture(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelCapture();
    } else if (event.key === 'Tab') {
      const buttons = Array.from(document.querySelectorAll('button:not(:disabled), input:not(:disabled)'))
        .filter((element) => element.getClientRects().length && element.tabIndex >= 0);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  share.addEventListener('click', async () => {
    if (loading || submitting || cancelling || !sources.some((source) => source.id === selectedId && source.kind === kind)) return;
    submitting = true;
    showError('');
    selectionStatus.textContent = 'Starting screen sharing…';
    updateControls();
    let accepted = false;
    try {
      const result = await api.select(selectedId, audioRequested && includeAudio.checked);
      if (cancelling) return;
      accepted = !!(result && result.ok === true);
      if (!accepted) {
        showError(result && typeof result.error === 'string' ? result.error : 'Could not start screen sharing. Choose a source and try again.');
      }
    } catch {
      // Successful selection normally removes this view before IPC settles.
      if (!cancelling) showError('The source may no longer be available. Refresh and try again.');
    } finally {
      if (!accepted) submitting = false;
      if (!cancelling && !accepted) updateSelection();
    }
  });

  if (!api || typeof api.list !== 'function' || typeof api.select !== 'function' || typeof api.cancel !== 'function') {
    loading = false;
    listStatus.textContent = 'The screen-sharing picker could not start.';
    showError('Cancel this picker and try screen sharing again.');
    share.disabled = true;
    refresh.disabled = true;
  } else {
    loadSources().finally(() => { if (!cancelling) tabs.find((tab) => tab.dataset.kind === kind)?.focus(); });
  }
})();
