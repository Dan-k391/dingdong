/* In-page dropdown for <select> elements.
 * Native select popups are drawn by the OS outside the page, so they never show up in a page
 * capture. This keeps every <select> exactly as it looks, but opens a styled in-page list instead of
 * the native popup. Choosing an item sets the select's value and fires the same change event.
 */
(() => {
  'use strict';
  const css = `
  .dsel-list { position: fixed; z-index: 2147483000; min-width: 120px; max-height: 360px; overflow-y: auto; padding: 6px;
    background: #111214; border: 1px solid rgba(255,255,255,.06); border-radius: 8px; box-shadow: 0 12px 32px rgba(0,0,0,.55);
    font: 500 14px/1.25 "gg sans", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; color: #dbdee1;
    transform-origin: top center; animation: dselIn .14s cubic-bezier(.2,.8,.3,1) both; scrollbar-width: none; }
  .dsel-list::-webkit-scrollbar { display: none; }
  .dsel-list.up { transform-origin: bottom center; }
  @keyframes dselIn { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }
  .dsel-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
  .dsel-item:hover, .dsel-item.hot { background: #5865f2; color: #fff; }
  .dsel-item.sel { color: #fff; font-weight: 700; }
  .dsel-item .ck { margin-left: auto; width: 16px; height: 16px; flex: none; opacity: 0; }
  .dsel-item.sel .ck { opacity: 1; }
  select.dsel-open { box-shadow: 0 0 0 2px #5865f2 inset; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  let open = null;
  const close = () => { if (!open) return; open.list.remove(); open.sel.classList.remove('dsel-open'); open = null; };
  function show(sel) {
    close();
    const r = sel.getBoundingClientRect();
    const list = document.createElement('div');
    list.className = 'dsel-list';
    [...sel.options].forEach((o, i) => {
      const it = document.createElement('div');
      it.className = 'dsel-item' + (i === sel.selectedIndex ? ' sel' : '');
      it.dataset.i = i;
      it.innerHTML = '<span></span><svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
      it.firstChild.textContent = o.textContent;
      list.appendChild(it);
    });
    document.body.appendChild(list);
    const w = Math.max(r.width, list.offsetWidth);
    list.style.minWidth = r.width + 'px';
    let left = Math.min(r.left, innerWidth - w - 8);
    let top = r.bottom + 4;
    if (top + list.offsetHeight > innerHeight - 8) { top = Math.max(8, r.top - list.offsetHeight - 4); list.classList.add('up'); }
    list.style.left = Math.max(8, left) + 'px'; list.style.top = top + 'px';
    const selEl = list.querySelector('.sel'); if (selEl) selEl.scrollIntoView({ block: 'nearest' });
    for (const ev of ['mousedown', 'pointerdown', 'click', 'contextmenu']) list.addEventListener(ev, (e) => e.stopPropagation());
    list.addEventListener('click', (e) => {
      const it = e.target.closest('.dsel-item'); if (!it) return;
      const i = +it.dataset.i;
      close();
      if (sel.selectedIndex !== i) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    sel.classList.add('dsel-open');
    open = { sel, list };
  }
  document.addEventListener('mousedown', (e) => {
    const sel = e.target.closest && e.target.closest('select');
    if (sel && !sel.disabled && !sel.multiple && e.button === 0) {
      e.preventDefault();
      if (open && open.sel === sel) { close(); return; }
      sel.focus({ preventScroll: true });
      show(sel);
      return;
    }
    if (open && !(e.target.closest && e.target.closest('.dsel-list'))) close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  // close if the select disappears (its menu closed)
  setInterval(() => { if (open && !open.sel.isConnected) close(); }, 200);
})();
