/* ui/overlays — toast、選單、對話框、焦點陷阱、複製／下載輔助。
   傳統 script 工廠，掛在 PA._ui。不得呼叫 PA.ui。 */
window.PA = window.PA || {};
PA._ui = PA._ui || {};

PA._ui.createOverlays = function(host) {
  const $ = id => host.$(id);

  const TOAST_MAX = 3;
  function toast(msg, opts = {}) {
    const box = $('toasts');
    while (box.children.length >= TOAST_MAX) box.firstChild.remove();

    const el = document.createElement('div');
    el.className = 'toast ' + (opts.kind || 'info');
    const m = document.createElement('span');
    m.className = 'tmsg';
    m.textContent = msg;
    el.appendChild(m);

    let duration = opts.duration ??
      Math.max(2000, Math.min(8000, msg.length * 80));
    if (opts.action) duration = Math.max(duration, 6000);

    if (opts.action) {
      const b = document.createElement('button');
      b.className = 'taction';
      b.textContent = opts.action;
      b.onclick = () => { dismiss(); opts.onAction && opts.onAction(); };
      el.appendChild(b);
    }
    const x = document.createElement('button');
    x.className = 'tclose';
    x.textContent = '✕';
    x.title = '關閉';
    x.onclick = () => dismiss();
    el.appendChild(x);
    box.appendChild(el);

    let timer = null, deadline = Date.now() + duration;
    const start = () => { deadline = Date.now() + duration; timer = setTimeout(dismiss, duration); };
    const stop = () => { clearTimeout(timer); duration = Math.max(400, deadline - Date.now()); };
    el.addEventListener('mouseenter', stop);
    el.addEventListener('mouseleave', start);
    function dismiss() {
      clearTimeout(timer);
      el.classList.add('out');
      setTimeout(() => el.remove(), 200);
    }
    start();
    return el;
  }

  function download(fn, blob) {
    const u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = fn; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
    toast('已下載 ' + fn, { kind: 'success' });
  }

  async function copyText(t, msg) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(t);
      else throw 0;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    toast(msg || '已複製', { kind: 'success' });
  }

  let menuEl = null, menuInvoker = null, menuPrevFocus = null;
  let menuClosedInfo = { invoker: null, t: 0 };
  const menuOpen = () => !!menuEl;

  function closeMenu() {
    if (!menuEl) return;
    const hadFocus = menuEl.contains(document.activeElement);
    menuEl.remove();
    menuEl = null;
    menuClosedInfo = { invoker: menuInvoker, t: performance.now() };
    if (menuInvoker) { menuInvoker.setAttribute('aria-expanded', 'false'); menuInvoker = null; }
    if (hadFocus && menuPrevFocus && document.contains(menuPrevFocus)) menuPrevFocus.focus();
    menuPrevFocus = null;
  }

  function showMenu(x, y, items, invoker) {
    if (invoker && menuClosedInfo.invoker === invoker && performance.now() - menuClosedInfo.t < 400) {
      menuClosedInfo = { invoker: null, t: 0 };
      return;
    }
    closeMenu();
    menuPrevFocus = document.activeElement;
    const m = document.createElement('div');
    m.className = 'menu';
    m.setAttribute('role', 'menu');
    m.tabIndex = -1;
    m.addEventListener('keydown', e => {
      const f = [...m.querySelectorAll('.mi:not(:disabled)')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      const go = el => { e.preventDefault(); el && el.focus(); };
      if (e.key === 'ArrowDown') go(f[i + 1] || f[0]);
      else if (e.key === 'ArrowUp') go(f[i - 1] || f[f.length - 1]);
      else if (e.key === 'Home') go(f[0]);
      else if (e.key === 'End') go(f[f.length - 1]);
    });
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'msep'; m.appendChild(s); continue; }
      if (it.head) { const h = document.createElement('div'); h.className = 'mhead'; h.textContent = it.head; m.appendChild(h); continue; }
      const b = document.createElement('button');
      b.className = 'mi' + (it.on ? ' on' : '') + (it.danger ? ' danger' : '');
      b.setAttribute('role', 'menuitem');
      b.disabled = !!it.disabled;
      if (it.title) b.title = it.title;
      if (it.swatch && /^#[0-9a-fA-F]{6}$/.test(it.swatch)) {
        const sw = document.createElement('span');
        sw.className = 'msw';
        sw.style.background = it.swatch;
        b.appendChild(sw);
      }
      const lb = document.createElement('span');
      lb.className = 'mlabel';
      lb.textContent = it.label;
      b.appendChild(lb);
      if (it.kbd) { const k = document.createElement('kbd'); k.textContent = it.kbd; b.appendChild(k); }
      b.onclick = () => { closeMenu(); it.action && it.action(); };
      m.appendChild(b);
    }
    $('menulayer').appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    menuEl = m;
    if (invoker) { invoker.setAttribute('aria-expanded', 'true'); menuInvoker = invoker; }
    const first = m.querySelector('.mi.on:not(:disabled)') || m.querySelector('.mi:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  document.addEventListener('pointerdown', e => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    if (host.histOpen && host.histOpen() && host.histPanel && !host.histPanel().contains(e.target) &&
        !e.target.closest('#b-hist, #b-undo, #b-redo, #hist-close'))
      host.closeHistPanel && host.closeHistPanel();
  });

  let lastFocus = null;
  function openDialog(el, focusEl) {
    lastFocus = document.activeElement;
    el.classList.remove('hide');
    const visible = x => !x.disabled && !x.hidden && x.offsetParent !== null;
    const f = focusEl ||
      el.querySelector('textarea') ||
      [...el.querySelectorAll('input')].find(i => i.type !== 'hidden' && i.type !== 'file' && visible(i)) ||
      el.querySelector('button.primary') || el.querySelector('button');
    if (f) setTimeout(() => f.focus(), 0);
  }
  function closeDialog(el) {
    el.classList.add('hide');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }
  function trapTab(e, box) {
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll('button, input, textarea, select, summary, [tabindex]')]
      .filter(el2 => !el2.disabled && el2.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last && !e.target.closest('textarea')) { e.preventDefault(); first.focus(); }
  }
  const dialogOpen = el => !el.classList.contains('hide');

  function showConfirm({ title, body, buttons }) {
    $('c-title').textContent = title;
    $('c-body').textContent = body;
    const box = $('c-buttons');
    box.innerHTML = '';
    const dlg = $('confirm');
    let focusBtn = null;
    for (const spec of buttons) {
      const b = document.createElement('button');
      b.className = 'btn ' + (spec.kind || 'secondary');
      b.textContent = spec.label;
      b.onclick = () => { closeDialog(dlg); spec.action && spec.action(); };
      box.appendChild(b);
      if (spec.focus) focusBtn = b;
    }
    openDialog(dlg, focusBtn);
  }

  return {
    toast, download, copyText,
    showMenu, closeMenu, menuOpen,
    get menuEl() { return menuEl; },
    openDialog, closeDialog, trapTab, dialogOpen, showConfirm,
  };
};
