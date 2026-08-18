/* ui — DOM 建構與所有事件綁定。
   唯一會碰到畫面元素的一層；要改資料一律呼叫 store，要重畫一律呼叫 render。
   v2（依 UIUX修改設計文件.md）：Redo、右欄分頁、狀態列、HUD、右鍵快選、
   Toast v2、可復原的破壞性操作、像素化三步驟（Worker 偵測 / 重算 + 進度 + 取消）。 */
window.PA = window.PA || {};

PA.ui = (() => {
  const store = PA.store, render = PA.render, codec = PA.codec;
  const S = store.state;
  const $ = id => document.getElementById(id);

  /* ---------- 圖示 ---------- */
  const SVG_EYE = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/></svg>';
  const SVG_EYE_OFF = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l10 10M6.6 4.7A6.9 6.9 0 018 4.5c4.1 0 6.5 3.5 6.5 3.5a12.4 12.4 0 01-2.1 2.5M9.9 11.2A6.6 6.6 0 018 11.5C3.9 11.5 1.5 8 1.5 8a12.6 12.6 0 012.4-2.7"/></svg>';
  const SVG_GRIP = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="6" cy="3.5" r="1.3"/><circle cx="10" cy="3.5" r="1.3"/><circle cx="6" cy="8" r="1.3"/><circle cx="10" cy="8" r="1.3"/><circle cx="6" cy="12.5" r="1.3"/><circle cx="10" cy="12.5" r="1.3"/></svg>';

  let cv, stage;
  let drawing = false, lastPx = null, lastStrokeEnd = null;
  let strokeSnap = false;     // 目前這一筆有沒有進復原堆疊（取消筆畫時要不要 undo）
  let strokePointer = null;   // 正在畫的那一指的 pointerId（切工具時要放掉 capture）
  // 非繪圖的畫布拖曳（裁切把手 / 對稱軸）：跟 drawing 分開，否則 pointermove 會把它當筆畫塗色
  let gesture = null;         // null | 'crop' | 'axis'
  let gestureEnd = null;      // 結束目前手勢的函式（切工具 / 觸控接手時呼叫）

  // 觸控手勢（bindTouch）：目前按著的手指、進行中的手勢。bindCanvas 要看得到，所以放模組層
  const touchDown = new Map();          // pointerId -> {x, y, sx, sy, t0, onCanvas}
  let touchGesture = null;              // null | 'pan1' | 'pinch'
  const touchGestureActive = () => touchGesture !== null;
  const touchCount = () => touchDown.size;

  /* ---------- 模式與工具 ---------- */
  let mode = 'annotate';
  const PIXEL_TOOLS = new Set(['draw', 'pick', 'epix']);
  const ANNOTATE_TOOLS = ['brush', 'wand', 'same', 'erase'];
  const TOOL_NAMES = { brush: '筆刷', wand: '魔棒', same: '同色全選', erase: '擦掉標註',
                       draw: '繪圖', pick: '滴管', epix: '擦成透明', crop: '裁切' };
  // 裁切是影像變形，兩種模式都能用，不強制切模式
  const modeOf = t => PIXEL_TOOLS.has(t) ? 'draw' : ANNOTATE_TOOLS.includes(t) ? 'annotate' : mode;

  const TOOL_HINTS = {
    brush: '筆刷 — 拖曳塗上部件 · Alt+點 吸取部件 · Shift+點 畫直線',
    wand: '魔棒 — 點一下選取相連的同色區域',
    same: '同色全選 — 點一下選取整張圖的同色像素',
    erase: '擦掉標註 — 拖曳把格子清回未標註',
    draw: '繪圖 — Alt+點 吸取顏色 · Shift+點 畫直線',
    pick: '滴管 — 點一下吸取顏色',
    epix: '擦成透明 — 拖曳把像素清成透明',
    crop: '拖曳框選範圍 · 八把手微調 · Enter 套用 · Esc 取消',
  };

  /* ---------- 檢視開關（左欄「檢視」圖示鈕的狀態） ---------- */
  const vs = { img: true, parts: true, grid: true };
  let hHold = false;          // 按住 H：暫時隱藏部件色看原圖
  let spaceHeld = false;      // 按住 Space：平移
  let hiliteUntil = 0;        // 未標註反白的截止時間
  let hoverCell = null;       // 畫布上的游標格（筆刷輪廓 / 狀態列用）
  let saveState = 'ok';       // 狀態列：'ok' | 'fail'（配額 / 例外）| 'foreign'（另一分頁較新）
  let savePending = false;    // 有變更還沒寫進 localStorage（debounce 中）

  const view = () => ({
    image: vs.img,
    parts: mode === 'annotate' && vs.parts && !hHold,
    grid: vs.grid,
    mirror: mode === 'draw' && $('v-mirror').checked,
    mirrorAxis: $('mirroraxis').value === '' ? undefined : +$('mirroraxis').value,
    brush: brushHover(),
    hiliteUnannotated: Date.now() < hiliteUntil,
    preview: PREVIEW_TOOLS.has(S.tool) && hoverCell ? preview : null,
  });
  // 滑鼠移動 / 筆畫進行中的重繪用 rAF 合併：一個影格內不管來幾個 pointermove 都只畫一次。
  // 需要「畫完立刻量」的地方（縮放錨點、settleZoom）仍呼叫同步的 draw()。
  let drawRaf = 0;
  const draw = () => { if (drawRaf) { cancelAnimationFrame(drawRaf); drawRaf = 0; } render.draw(view()); };
  function scheduleDraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => { drawRaf = 0; if (store.has()) draw(); });
  }
  // 筆畫進行中的面板更新（部件格數 / 佔比、摘要列）也合併到同一個影格
  let panelRaf = 0;
  function schedulePanelCounts() {
    if (panelRaf) return;
    panelRaf = requestAnimationFrame(() => { panelRaf = 0; updatePartCounts(); renderSummary(); });
  }

  /* ---------- 魔棒 / 同色全選的 hover 預覽（節流 60ms） ---------- */
  const PREVIEW_TOOLS = new Set(['wand', 'same']);
  let preview = null, previewTimer = 0;
  function computePreview() {
    if (!store.has() || !hoverCell || !PREVIEW_TOOLS.has(S.tool)) { preview = null; return; }
    const im = store.img();
    const { mask, count } = store.selectionMask(hoverCell[0], hoverCell[1], S.tool);
    preview = { mask, w: im.w, h: im.h, count };
  }
  function schedulePreview() {
    if (previewTimer) return;
    previewTimer = setTimeout(() => {
      previewTimer = 0;
      if (!hoverCell) return;           // 游標已離開：不要對過期狀態算一次
      computePreview();
      draw(); updateStatus();
    }, 60);
  }
  function cancelPreviewTimer() {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = 0; }
  }
  // 圖片或工具變了，舊遮罩不能再用
  function invalidatePreview() {
    preview = null;
    cancelPreviewTimer();
    if (hoverCell && PREVIEW_TOOLS.has(S.tool)) schedulePreview();
  }

  // 筆刷足跡：筆刷類工具是 (2n-1)²，點選類工具是 1 格；裁切不顯示
  function brushHover() {
    if (!store.has() || !hoverCell || S.tool === 'crop') return null;
    const cells = ['brush', 'erase', 'draw', 'epix'].includes(S.tool) ? S.brush * 2 - 1 : 1;
    return { x: hoverCell[0], y: hoverCell[1], cells };
  }

  const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgb2hex = c => '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');

  /* ═══════════ Toast v2：右下堆疊、語意色條、動作鈕、hover 暫停 ═══════════ */

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
      // file:// 沒有 clipboard API，退回舊的選取複製法
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

  /* ═══════════ 動態選單（檔案選單 / 快選 / ⋯） ═══════════ */

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
    // 焦點回到開選單前的地方（鍵盤使用者才不會掉到 body）
    if (hadFocus && menuPrevFocus && document.contains(menuPrevFocus)) menuPrevFocus.focus();
    menuPrevFocus = null;
  }

  // items: {head} | {sep} | {label, kbd, swatch, on, danger, disabled, title, action}
  function showMenu(x, y, items, invoker) {
    // 點一下「已經開著選單」的按鈕 = 關閉：pointerdown 已經關了，click 不要又打開
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
    // ↑↓ Home End 在項目間移動；Enter / Space 由按鈕本身處理；Esc 由全域關閉
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
      if (it.swatch) {
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
    // 夾回視窗內
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    menuEl = m;
    if (invoker) { invoker.setAttribute('aria-expanded', 'true'); menuInvoker = invoker; }
    // 焦點進第一個可用項目：鍵盤可以直接 ↓ / Enter；滑鼠使用者不受影響
    const first = m.querySelector('.mi.on:not(:disabled)') || m.querySelector('.mi:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  document.addEventListener('pointerdown', e => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    if (typeof histOpen === 'function' && histOpen() && !histPanel().contains(e.target) &&
        !e.target.closest('#b-hist, #b-undo, #b-redo, #hist-close'))
      closeHistPanel();
  });

  /* ═══════════ 對話框共用：焦點陷阱 + 焦點回歸 ═══════════ */

  let lastFocus = null;
  function openDialog(el, focusEl) {
    lastFocus = document.activeElement;
    el.classList.remove('hide');
    // 優先順序：呼叫端指定 > textarea > 可見輸入 > 主要按鈕 > 第一個按鈕
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

  /* ═══════════ 確認對話框（只用於不可復原的動作） ═══════════ */

  // buttons: [{label, kind, focus, action}]；focus 的那顆會成為預設焦點（通常是「取消」）
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

  /* ═══════════ 顏色（顏色分頁） ═══════════ */

  let drawColor = '#ff9148', prevColor = null;
  const recent = [];

  function setDrawColour(hex, opts = {}) {
    hex = hex.toLowerCase();
    if (hex !== drawColor) {
      if (!opts.keepPrev) prevColor = drawColor;
      drawColor = hex;
    }
    $('drawcolor').value = hex.slice(0, 7);
    $('drawhex').value = hex;
    $('prevcolor').style.background = prevColor || 'transparent';
    $('prevcolor').title = prevColor ? `上一色 ${prevColor}（點擊換回）` : '還沒有上一色';
    $('imgpal').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.hex === hex));
    $('recentpal').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.hex === hex));
  }

  function pushRecent(hex) {
    const i = recent.indexOf(hex);
    if (i === 0) return;
    if (i > 0) recent.splice(i, 1);
    recent.unshift(hex);
    if (recent.length > 8) recent.pop();
    renderRecent();
  }

  function palEmpty(box, text) {
    const s = document.createElement('span');
    s.className = 'pal-empty';
    s.textContent = text;
    box.appendChild(s);
  }

  function renderRecent() {
    const box = $('recentpal');
    box.innerHTML = '';
    if (!recent.length) { palEmpty(box, '（用過的顏色會出現在這裡）'); return; }
    for (const hex of recent) {
      const b = document.createElement('button');
      b.style.background = hex;
      b.dataset.hex = hex;
      b.title = hex;
      if (hex === drawColor) b.classList.add('on');
      b.onclick = () => setDrawColour(hex);
      box.appendChild(b);
    }
  }

  // 依色相排列。無彩色（黑白灰）的色相角是雜訊，混進彩色裡排會亂跳，
  // 所以另外抓出來依明度排在前面，形成一條灰階，後面才是彩虹順序。
  const CHROMA_MIN = 0.02;
  function sortByHue(colours) {
    const keyed = colours.map(c => {
      const [L, a, b] = PA.pixelate.toOklab(c[0], c[1], c[2]);
      let hue = Math.atan2(b, a) * 180 / Math.PI;
      if (hue < 0) hue += 360;
      return { c, L, chroma: Math.hypot(a, b), hue };
    });
    const grey = keyed.filter(k => k.chroma < CHROMA_MIN).sort((p, q) => p.L - q.L);
    const hued = keyed.filter(k => k.chroma >= CHROMA_MIN)
      .sort((p, q) => p.hue - q.hue || p.L - q.L);
    return [...grey, ...hued].map(k => k.c);
  }

  // 圖片現有的顏色，點一下就能拿來修圖 —— 修像素時幾乎都是要用畫面上已有的色
  function renderPalette() {
    const box = $('imgpal');
    box.innerHTML = '';
    if (!store.has()) { palEmpty(box, '（開啟圖片後顯示）'); return; }
    for (const c of sortByHue(store.imagePalette())) {
      const hex = rgb2hex(c);
      const b = document.createElement('button');
      b.style.background = hex;
      b.dataset.hex = hex;
      b.title = hex;
      if (hex === drawColor) b.classList.add('on');
      b.onclick = () => setDrawColour(hex);
      box.appendChild(b);
    }
  }

  /* ═══════════ 匯出（匯出分頁） ═══════════ */

  const TEXT_FMT_MAX = 64;
  const textFmtOk = () => !store.has() ||
    (store.img().w <= TEXT_FMT_MAX && store.img().h <= TEXT_FMT_MAX);
  const TEXT_FMT_REASON = `圖片大於 ${TEXT_FMT_MAX}×${TEXT_FMT_MAX}，資料量太大 — 先裁切或像素化`;

  // 與 codec.scaleBitmap 同一組上限：超過會一次吃掉上百 MB，按鈕先停用而不是按了才丟錯。
  const PNG_MAX_SIDE = codec.BITMAP_MAX_SIDE, PNG_MAX_AREA = codec.BITMAP_MAX_AREA;
  const scaleFits = (im, s) => {
    const W = im.w * s, H = im.h * s;
    return W <= PNG_MAX_SIDE && H <= PNG_MAX_SIDE && W * H <= PNG_MAX_AREA;
  };
  let pngScale = 1;

  function syncExport() {
    const has = store.has();
    // 資料格式：停用時整列 40% + 原因直接可見
    const ok = textFmtOk();
    for (const f of ['json', 'js']) {
      $(`x-${f}`).classList.toggle('off', !has || !ok);
      $(`${f}-reason`).textContent = has && !ok ? TEXT_FMT_REASON : '';
      $(`b-dl-${f}`).disabled = !has || !ok;
      $(`b-cp-${f}`).disabled = !has || !ok;
    }
    for (const f of ['png', 'svg']) {
      $(`x-${f}`).classList.toggle('off', !has);
      $(`b-dl-${f}`).disabled = !has;
      $(`b-cp-${f}`).disabled = !has;
    }
    // 匯出全部：一張以上才有意義
    const n = S.imgs.length;
    $('x-all').classList.toggle('off', n < 2);
    $('b-dl-all').disabled = n < 2;
    $('all-info').textContent = n < 2
      ? '開兩張以上圖片時，可以一次打包成 zip'
      : `${n} 張圖：每張的 PNG（目前倍率）+ JSON（≤${TEXT_FMT_MAX}×${TEXT_FMT_MAX} 才有）`;
    syncScale();
  }

  // 全部圖片打包成一個 zip：PNG 用目前倍率（放不下的退回 1×）+ 有標註資料的 JSON
  let exportingAll = false;
  async function doExportAll() {
    if (S.imgs.length < 2 || exportingAll) return;
    exportingAll = true;
    const btn = $('b-dl-all');
    btn.disabled = true; btn.textContent = '打包中…';
    try {
      const files = [], skipped = [];
      const enc = new TextEncoder();
      for (const im of S.imgs) {
        const s = scaleFits(im, pngScale) ? pngScale : 1;
        const big = codec.scaleBitmap(im, s);
        const blob = await new Promise(r => big.toBlob(r, 'image/png'));
        if (big !== im.cvs) big.width = big.height = 0;      // 放大用的暫存 canvas 用完立刻釋放（1× 時回傳的是圖片本身的 canvas）
        if (blob) files.push({ name: `${im.name}${s > 1 ? `@${s}x` : ''}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
        else skipped.push(im.name);
        if (im.w <= TEXT_FMT_MAX && im.h <= TEXT_FMT_MAX)
          files.push({ name: `${im.name}.json`, data: enc.encode(codec.toJson(codec.encode(im, S.ann[im.name]))) });
      }
      const stamp = new Date().toISOString().slice(0, 10);
      download(`pixel-export-${stamp}.zip`, codec.zip(files));
      if (skipped.length) toast(`有 ${skipped.length} 張圖的 PNG 編碼失敗（記憶體不足），未放進 zip：${skipped.join('、')}`, { kind: 'warn' });
    } catch (e) {
      toast('打包失敗：' + (e.message || e), { kind: 'danger' });
    } finally {
      exportingAll = false;
      btn.textContent = '下載';
      btn.disabled = S.imgs.length < 2;
    }
  }

  function syncScale() {
    const btns = [...$('scalesegs').querySelectorAll('button')];
    if (!store.has()) {
      btns.forEach(b => { b.disabled = true; });
      $('scaleout').textContent = '';
      return;
    }
    const im = store.img();
    btns.forEach(b => {
      const s = +b.dataset.s, fits = scaleFits(im, s);
      b.disabled = !fits;
      b.title = fits ? `${im.w * s}×${im.h * s}` : '放大後超過記憶體上限';
    });
    if (!scaleFits(im, pngScale)) {
      const usable = btns.map(b => +b.dataset.s).filter(s => scaleFits(im, s));
      pngScale = usable.length ? Math.max(...usable) : 1;
    }
    $('scaleout').textContent = `${im.w * pngScale}×${im.h * pngScale}`;
    btns.forEach(b => b.classList.toggle('on', +b.dataset.s === pngScale));
  }

  const pngBlob = () =>
    new Promise(r => codec.scaleBitmap(store.img(), pngScale).toBlob(r, 'image/png'));

  const EXPORTERS = {
    json: { ext: '.json', get: () => new Blob([codec.toJson(store.exportData())], { type: 'application/json' }) },
    js:   { ext: '.js',   get: () => new Blob([codec.toJs(store.exportData())], { type: 'text/javascript' }) },
    svg:  { ext: '.svg',  get: () => new Blob([codec.toSvg(store.img())], { type: 'image/svg+xml' }) },
  };

  async function doDownload(f) {
    if (!store.has()) return;
    const name = store.img().name;
    if (f === 'png') {
      const suffix = pngScale > 1 ? `@${pngScale}x` : '';
      return download(name + suffix + '.png', await pngBlob());
    }
    download(name + EXPORTERS[f].ext, EXPORTERS[f].get());
  }

  async function doCopy(f) {
    if (!store.has()) return;
    if (f === 'png') {
      // 圖片要用 ClipboardItem。非安全來源（例如 file://）不支援，而視窗沒有焦點時
      // clipboard.write 會一直不 resolve，所以加逾時，不能讓按鈕看起來沒反應。
      try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw 0;
        const item = new ClipboardItem({ 'image/png': await pngBlob() });
        await Promise.race([
          navigator.clipboard.write([item]),
          new Promise((_, rej) => setTimeout(rej, 1500)),
        ]);
        toast('已複製 PNG 圖片', { kind: 'success' });
      } catch { toast('複製圖片失敗，請改用下載 PNG', { kind: 'warn' }); }
      return;
    }
    if (f === 'json') return copyText(codec.toJson(store.exportData()), '已複製 .json');
    if (f === 'js') return copyText(codec.toJs(store.exportData()), '已複製 .js');
    copyText(codec.toSvg(store.img()), '已複製 .svg');
  }

  /* ═══════════ 縮放 ═══════════ */

  function setZoom(z) {
    const b = stageBox();
    S.zoom = Math.max(1, Math.min(render.zoomMax(b.w, b.h), Math.round(z)));
    $('zval').textContent = S.zoom + '×';
  }

  // 縮圖列 / 裁切列跟 stage 是同一個 flex 欄的兄弟，出現時會把 stage 壓矮。
  // 顯示狀態跟量測拆開：捏合縮放每幀只能量測，不能每次都改 class + 強迫 layout。
  function syncBars() {
    $('strip').classList.toggle('hide', S.imgs.length < 2);
    $('cropbar').classList.toggle('hide', !S.crop);
  }
  function stageBox() {
    const cs = getComputedStyle(stage);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    return { w: stage.clientWidth - padX, h: stage.clientHeight - padY };
  }
  const fit = () => { syncBars(); const b = stageBox(); setZoom(render.fitZoom(b.w, b.h)); };

  // 面板或列出現 / 消失後畫布可用空間變了：沒動過縮放就重新貼合；
  // 動過的話尊重使用者選的倍率（他可能就是要放大看細節），不去夾。
  function relayout() {
    if (!store.has()) return;
    syncBars();
    if (!S.zoomTouched) fit();
    draw();
  }

  // 縮放階梯：一格一格 +1 從 48× 退回 24× 要按 24 下，改用常見的倍率階梯
  const ZOOM_LEVELS = [1, 2, 3, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256];
  function nextZoom(cur, dir) {
    if (dir > 0) return ZOOM_LEVELS.find(z => z > cur) ?? cur;
    return [...ZOOM_LEVELS].reverse().find(z => z < cur) ?? cur;
  }

  // 以某個螢幕點為中心整數倍縮放（Ctrl+滾輪）；沒給點就以畫面中心
  function zoomStep(dir, cx, cy) {
    if (!store.has()) return;
    const old = S.zoom;
    const b = stageBox();
    const next = Math.max(1, Math.min(render.zoomMax(b.w, b.h), nextZoom(old, dir)));
    if (next === old) return;
    const r = stage.getBoundingClientRect();
    const ox = (cx ?? (r.left + r.width / 2)) - r.left;
    const oy = (cy ?? (r.top + r.height / 2)) - r.top;
    const f = next / old;
    S.zoomTouched = true;
    S.zoom = next;
    $('zval').textContent = next + '×';
    draw();
    stage.scrollLeft = (stage.scrollLeft + ox) * f - ox;
    stage.scrollTop = (stage.scrollTop + oy) * f - oy;
    updateStatus();
  }

  // 畫完後量實際寬度，被夾住就照實際值降到整數倍重畫一次
  function settleZoom() {
    if (!store.has()) return;
    const want = parseFloat(cv.style.width) || 0;
    const real = cv.getBoundingClientRect().width;
    if (want && real < want - 0.5) {
      const z = Math.max(1, Math.floor(real / store.img().w));
      if (z !== S.zoom) { setZoom(z); draw(); }
      return;
    }
    // 沒動過縮放時畫布卻超出可用區（縮圖列 / 裁切列剛出現、版面還沒穩定就量過）→ 重新貼合
    if (!S.zoomTouched) {
      const b = stageBox(), im = store.img();
      if (im.w * S.zoom > b.w || im.h * S.zoom > b.h) { fit(); draw(); }
    }
  }

  /* ═══════════ 部件清單（部件分頁） ═══════════ */

  function renderSummary() {
    if (!store.has()) {
      $('sum-text').textContent = '—';
      $('sum-fill').style.width = '0';
      return;
    }
    const c = store.coverage();
    $('sum-text').textContent = c.total
      ? `已標註 ${c.pct}%（${c.annotated.toLocaleString()} / ${c.total.toLocaleString()} 格）`
      : '這張圖沒有不透明像素';
    $('sum-fill').style.width = c.pct + '%';
  }

  function renderParts() {
    const box = $('parts');
    box.innerHTML = '';
    if (!store.has()) {
      box.innerHTML = '<div class="empty">先開啟一張圖片</div>';
      return;
    }
    const a = store.annot();
    if (!a.parts.length) {
      box.innerHTML = '<div class="empty">還沒有部件<br>在上面輸入名稱後按 Enter 新增，會自動配色</div>';
      return;
    }
    const counts = store.partCounts();
    const totalShown = Object.values(counts).reduce((s, n) => s + n, 0) || 1;

    a.parts.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'part' + (p.id === S.activePart ? ' on' : '');
      row.dataset.id = p.id;
      row.onclick = e => {
        if (e.target.closest('button, input, .grip')) return;
        store.setActive(p.id);
        renderParts(); draw(); updateHud();
      };
      row.onmouseenter = () => { if (store.setHover(p.id)) draw(); };
      row.onmouseleave = () => { if (store.setHover(0)) draw(); };

      // 編號徽章 = 快捷鍵 1–9
      const num = document.createElement('span');
      num.className = 'pnum';
      num.textContent = i < 9 ? String(i + 1) : '·';
      num.title = i < 9 ? `按 ${i + 1} 切換到這個部件` : '10 個以上沒有快捷鍵';

      const eye = document.createElement('button');
      eye.className = 'eye' + (S.shownParts.has(p.id) ? '' : ' off');
      eye.innerHTML = S.shownParts.has(p.id) ? SVG_EYE : SVG_EYE_OFF;
      const isActive = p.id === S.activePart;
      eye.title = isActive ? '作用中部件一定要顯示' : '顯示 / 隱藏（Alt+點 = 只看這個）';
      eye.disabled = isActive;
      eye.onclick = e => {
        e.stopPropagation();
        if (e.altKey) store.soloShown(p.id);
        else store.toggleShown(p.id);
        renderParts(); draw(); save_();
      };

      const sw = document.createElement('button');
      sw.className = 'sw';
      sw.type = 'button';
      sw.style.background = p.color;
      sw.title = `換顏色（目前 ${p.color}）`;
      sw.setAttribute('aria-label', `${p.name} 的顏色 ${p.color}，點擊更換`);
      sw.onclick = e => {
        e.stopPropagation();
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = p.color;
        // 拖曳色盤時 input 事件每秒幾十次：只重畫，不存檔；放開（change）才存
        inp.oninput = () => {
          store.setPartColor(p.id, inp.value);
          sw.style.background = inp.value;
          scheduleDraw();
        };
        inp.onchange = () => { store.setPartColor(p.id, inp.value); sw.style.background = inp.value; draw(); updateHud(); save_(); };
        inp.click();
      };

      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name;
      nm.title = p.name + '（雙擊改名）';
      nm.ondblclick = e => { e.stopPropagation(); startRename(nm, p); };

      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = counts[p.id] || 0;

      const share = document.createElement('span');
      share.className = 'share';
      share.title = `佔已標註 ${Math.round((counts[p.id] || 0) / totalShown * 100)}%`;
      const si = document.createElement('i');
      si.style.width = Math.round((counts[p.id] || 0) / totalShown * 100) + '%';
      si.style.background = p.color;
      share.appendChild(si);

      const more = document.createElement('button');
      more.className = 'ic';
      more.textContent = '⋯';
      more.title = '更多動作';
      more.onclick = e => {
        e.stopPropagation();
        const r = more.getBoundingClientRect();
        showMenu(r.left, r.bottom + 4, [
          { label: '改名', kbd: 'F2', action: () => startRename(nm, p) },
          { label: '換顏色', action: () => sw.onclick(new Event('x')) },
          { sep: true },
          { label: '上移', action: () => { store.movePart(p.id, i - 1); renderParts(); save_(); } },
          { label: '下移', action: () => { store.movePart(p.id, i + 2); renderParts(); save_(); } },
          { sep: true },
          { label: '刪除', danger: true, action: () => deletePartWithUndo(p.id) },
        ]);
      };

      // 左緣 ⋮ 拖曳排序（長按拖曳）
      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.innerHTML = SVG_GRIP;
      grip.title = '拖曳調整順序';
      grip.setAttribute('aria-label', '拖曳調整順序');
      grip.setAttribute('role', 'button');
      row.appendChild(grip);
      grip.onpointerdown = e => startReorder(e, p.id, row);

      row.append(num, eye, sw, nm, n, share, more);
      box.appendChild(row);
    });
  }

  // 筆畫進行中只有格數 / 佔比在變：就地改兩個文字節點，不重建整個清單
  function updatePartCounts() {
    if (!store.has()) return;
    const counts = store.partCounts();
    const totalShown = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
    for (const row of $('parts').querySelectorAll('.part')) {
      const id = +row.dataset.id, c = counts[id] || 0;
      const n = row.querySelector('.n'), share = row.querySelector('.share'), bar = share && share.firstElementChild;
      if (n && +n.textContent !== c) n.textContent = c;
      if (share) {
        const pct = Math.round(c / totalShown * 100);
        share.title = `佔已標註 ${pct}%`;
        if (bar) bar.style.width = pct + '%';
      }
    }
  }

  function deletePartWithUndo(id) {
    const p = store.partById(id);
    if (!p) return;
    store.snapshot('刪除部件');
    store.deletePart(id);
    renderAll(); save_();
    toast(`已刪除部件「${p.name}」`, { kind: 'success', action: '復原', onAction: doUndo });
  }

  function startRename(nmEl, p) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'nmedit';
    inp.value = p.name;
    inp.setAttribute('aria-label', '部件名稱');
    nmEl.replaceWith(inp);
    inp.focus();
    inp.select();

    let done = false;
    const commit = ok => {
      if (done) return;
      done = true;
      if (ok) store.renamePart(p.id, inp.value);
      renderParts(); save_(); updateHud();
    };
    inp.onclick = e => e.stopPropagation();
    inp.onblur = () => commit(true);
    inp.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    };
  }

  // 用 pointer 事件而非 HTML5 drag，手指才拖得動
  function startReorder(e, id, row) {
    e.preventDefault();
    e.stopPropagation();
    const box = $('parts'), target = e.target;
    let to = null;
    try { target.setPointerCapture(e.pointerId); } catch {}
    row.classList.add('dragging');

    const rows = () => [...box.querySelectorAll('.part')];
    const mark = () => {
      const rs = rows();
      rs.forEach((r, i) => {
        r.classList.toggle('drop-before', i === to);
        r.classList.toggle('drop-after', to === rs.length && i === rs.length - 1);
      });
    };
    const move = ev => {
      const rs = rows();
      let next = rs.length;
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { next = i; break; }
      }
      if (next !== to) { to = next; mark(); }
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      rows().forEach(r => r.classList.remove('drop-before', 'drop-after', 'dragging'));
      if (to !== null) { store.movePart(id, to); save_(); }
      renderParts();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  /* ═══════════ 圖片分頁 / 縮圖列 ═══════════ */

  const coverageOf = im => store.coverage(im).pct;

  function renderImages() {
    const box = $('imglist');
    box.innerHTML = '';
    S.imgs.forEach((im, i) => {
      const row = document.createElement('div');
      row.className = 'imgrow' + (i === S.cur ? ' on' : '');
      row.onclick = e => {
        if (e.target.closest('button')) return;
        store.select(i); fit(); renderAll(); save_();
      };
      const th = render.thumb(im);
      const meta = document.createElement('div');
      meta.className = 'imeta';
      const nm = document.createElement('div');
      nm.className = 'iname';
      nm.textContent = im.name;
      nm.title = im.name;
      const sub = document.createElement('div');
      sub.className = 'isub mono';
      sub.textContent = `${im.w}×${im.h} · 已標註 ${coverageOf(im)}%`;
      meta.append(nm, sub);
      const x = document.createElement('button');
      x.className = 'ic';
      x.textContent = '✕';
      x.title = '關閉這張圖片…';
      x.setAttribute('aria-label', `關閉 ${im.name}`);
      x.onclick = e => { e.stopPropagation(); requestCloseImage(i); };
      row.append(th, meta, x);
      box.appendChild(row);
    });
    if (!S.imgs.length)
      box.innerHTML = '<div class="empty" style="color:var(--fg-3);font-size:12px;padding:8px 2px">尚未開啟圖片</div>';
  }

  function renderStrip() {
    const s = $('strip'), box = $('stripitems');
    s.classList.toggle('hide', S.imgs.length < 2);
    $('strip-label').textContent = `${S.imgs.length} 張圖片 · ${store.has() ? store.img().name : ''}`;
    box.innerHTML = '';
    S.imgs.forEach((im, i) => {
      const d = document.createElement('div');
      d.className = 'th' + (i === S.cur ? ' on' : '');
      d.title = `${im.name} — ${im.w}×${im.h}`;
      const t = document.createElement('div');
      t.className = 'thname';
      t.textContent = im.name;
      // 右上角圓形刪除鈕：走跟圖片分頁的 × 同一條路（有標註會先確認）
      const x = document.createElement('button');
      x.className = 'thx';
      x.textContent = '✕';
      x.title = `關閉 ${im.name}…`;
      x.setAttribute('aria-label', `關閉 ${im.name}`);
      x.onclick = e => { e.stopPropagation(); requestCloseImage(i); };
      d.append(render.thumb(im), t, x);
      d.onclick = e => {
        if (e.target.closest('button')) return;
        store.select(i); fit(); renderAll(); save_();
      };
      box.appendChild(d);
    });
  }

  // 縮圖列收合：列高變了，畫布可用空間跟著變，所以要 relayout()
  function toggleStrip(close) {
    const will = close ?? !document.body.classList.contains('strip-closed');
    document.body.classList.toggle('strip-closed', will);
    const b = $('b-strip');
    b.textContent = will ? '⌃' : '⌄';
    b.title = will ? '展開縮圖列' : '收合縮圖列';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-expanded', String(!will));
    relayout();
  }

  /* ═══════════ 狀態列 / HUD / 標題列 ═══════════ */

  function updateStatus() {
    const L = $('st-left'), R = $('st-right');
    if (!store.has()) {
      L.innerHTML = '';
      L.textContent = '拖入圖片、貼上 JSON（Ctrl+V），或點「✨ 像素化」開始';
      R.textContent = '';
      return;
    }
    const c = store.coverage();
    const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
    let left = '';
    if (hoverCell && store.inBounds(hoverCell[0], hoverCell[1])) {
      const [x, y] = hoverCell;
      const px = store.pixelAt(x, y);
      const id = store.annot().grid[store.idx(x, y)];
      const pname = id ? (store.partById(id)?.name || id) : null;
      left += `${x}, ${y} · <span class="stsw" style="background:${rgb2hex(px)}"></span> ${px[3] < 8 ? '透明' : rgb2hex(px)}`;
      if (pname) left += ` · ${esc(pname)}`;
      if (PREVIEW_TOOLS.has(S.tool) && preview) left += ` · 會選到 ${preview.count.toLocaleString()} 格`;
      left += ' │ ';
    }
    left += `${S.zoom}× │ 筆刷 ${S.brush}px │ 已標註 ${c.pct}%`;
    if (mode === 'draw' && $('v-mirror').checked)
      left += ` │ 不對稱 ${render.mirrorDiff().toLocaleString()} 格（軸 ${currentAxis()}）`;
    left += ` │ ${saveState === 'foreign' ? '⚠ 另一分頁較新，未保存' : saveState === 'fail' ? '⚠ 未能保存' : savePending ? '保存中…' : '已保存 ✓'}`;
    L.innerHTML = left;
    // 焦點在新增部件輸入框時，提示怎麼離開（快捷鍵此時不作用，這是最常卡住的地方）
    R.textContent = document.activeElement === $('newpart')
      ? '輸入部件名稱 — Enter 新增（可連續輸入）· Esc 回到畫布'
      : (TOOL_HINTS[S.tool] || '');
  }

  function updateHud() {
    const hud = $('hud');
    if (!store.has()) { hud.classList.add('hide'); return; }
    hud.classList.remove('hide');
    const p = store.partById(S.activePart);
    const idxPart = p ? store.annot().parts.indexOf(p) : -1;
    const badge = idxPart >= 0 && idxPart < 9 ? ` ${idxPart + 1}` : '';
    const toolBit = `${TOOL_NAMES[S.tool]}${['brush', 'erase', 'draw', 'epix'].includes(S.tool) ? ' ' + S.brush + 'px' : ''}`;
    if (mode === 'annotate') {
      hud.innerHTML = '';
      const t = document.createElement('span');
      t.textContent = '✎ ' + toolBit;
      hud.appendChild(t);
      if (p) {
        const sw = document.createElement('span');
        sw.className = 'hsw';
        sw.style.background = p.color;
        const n = document.createElement('span');
        n.textContent = p.name + badge;
        hud.append(sw, n);
      } else {
        const n = document.createElement('span');
        n.textContent = '· 尚未選取部件';
        hud.appendChild(n);
      }
    } else {
      hud.innerHTML = '';
      const t = document.createElement('span');
      t.textContent = '✎ ' + toolBit;
      const sw = document.createElement('span');
      sw.className = 'hsw';
      sw.style.background = drawColor;
      const n = document.createElement('span');
      n.textContent = drawColor;
      hud.append(t, sw, n);
    }
    if (isMobile() && hoverCell && store.inBounds(hoverCell[0], hoverCell[1])) {
      const xy = document.createElement('span');
      xy.className = 'hudxy';
      xy.textContent = ` · ${hoverCell[0]}, ${hoverCell[1]}`;
      hud.appendChild(xy);
    }
  }

  function syncUndoRedo() {
    const u = $('b-undo'), r = $('b-redo');
    u.disabled = !store.canUndo();
    r.disabled = !store.canRedo();
    u.title = u.disabled ? '復原（Ctrl+Z）' : `復原：${store.undoLabel()}（Ctrl+Z）`;
    r.title = r.disabled ? '重做（Ctrl+Shift+Z）' : `重做：${store.redoLabel()}（Ctrl+Shift+Z）`;
  }

  function syncInfo() {
    const chip = $('info');
    if (!store.has()) {
      chip.textContent = '尚未開啟圖片';
      chip.disabled = true;
      return;
    }
    const im = store.img();
    const multi = S.imgs.length > 1;
    chip.textContent = `${im.name} — ${im.w}×${im.h}${multi ? ' ▾' : ''}`;
    chip.disabled = false;
    // 只有一張圖時它不是下拉，就別長得像可以按
    chip.classList.toggle('static', !multi);
    chip.setAttribute('aria-haspopup', String(multi));
    chip.title = multi ? `切換圖片（共 ${S.imgs.length} 張）` : '目前圖片';
    cv.setAttribute('aria-label', `${im.name}，${im.w}×${im.h} 像素畫布`);
  }

  // 無圖時：只能從入口開始，其他控制項全部停用。
  // CSS 的 pointer-events:none 只擋滑鼠；面板要真的從 tab 順序與輔助科技裡拿掉，用 inert
  //（左欄的「影像」群組留著：像素化本身就是入口，裁切鈕另外 disabled）
  function syncEmpty() {
    const has = store.has();
    document.body.classList.toggle('noimg', !has);
    const pxGrp = $('b-pixelate2').closest('.grp');
    document.querySelectorAll('.rail > .grp').forEach(g => { g.inert = !has && g !== pxGrp; });
    document.querySelector('aside').inert = !has;
    document.querySelectorAll('.toolbtn[data-tool=crop]').forEach(b => { b.disabled = !has; });
    $('newpart').disabled = !has;
    $('b-addpart').disabled = !has;
    $('b-clear').disabled = !has;
    $('b-hilite').disabled = !has;
    $('o-alpha').disabled = !has;
    $('brushsize').disabled = !has;
    for (const id of ['v-img', 'v-parts', 'v-grid', 'b-zin', 'b-zout', 'b-fit', 'b-hist', 'd-fit']) $(id).disabled = !has;
    $('zval').textContent = has ? S.zoom + '×' : '—';
    // 行動版：沒圖了就把抽屜收起來（dock 也會被 CSS 停用）
    if (!has && isMobile() && (railOpen() || asideOpen())) closeSheets();
  }

  function renderAll() {
    const has = store.has();
    $('drop').classList.toggle('hide', has);
    $('wrapcv').style.display = has ? 'block' : 'none';
    syncInfo();
    syncUndoRedo();
    syncEmpty();
    // 換圖 / 關圖後舊的裁切範圍會指向舊尺寸，重新夾一次
    if (has && S.tool === 'crop') store.setCrop(S.crop || { x: 0, y: 0, w: store.img().w, h: store.img().h });
    else store.clearCrop();
    syncCropBar();
    invalidatePreview();
    if (has) draw();
    renderParts();
    renderSummary();
    renderStrip();
    renderImages();
    renderPalette();
    syncExport();
    updateHud();
    updateStatus();
    fillHistPanel();
    if (has) settleZoom();
  }

  /* ---------- 存檔：trailing debounce，離開頁面前 flush ----------
     persist() 先把點陣圖寫進 IndexedDB，localStorage 只留元資料；
     pagehide / beforeunload 走同步 save()（已進 IDB 的圖不再夾 dataURL）。 */
  const SAVE_DELAY = 800;
  let saveTimer = 0, quotaWarned = false, saveFlushing = null;

  function applySaveResult(r) {
    if (r.ok) {
      saveState = 'ok'; quotaWarned = false;
    } else if (r.reason === 'foreign') {
      saveState = 'foreign';
    } else {
      saveState = 'fail';
      // 每次失敗都跳一次會變成每一筆都跳：只在剛開始失敗時提醒一次，之後靠狀態列常駐 ⚠
      if (!quotaWarned) {
        quotaWarned = true;
        toast(r.reason === 'quota'
          ? '⚠ 瀏覽器儲存空間不足，這之後的變更不會自動保存 — 建議下載 JSON 備份，或關閉用不到的圖片'
          : '⚠ 未能保存到瀏覽器，建議下載 JSON 備份', { kind: 'warn', duration: 8000 });
      }
    }
    updateStatus();
  }

  function save_() {
    savePending = true;
    if (!saveTimer) saveTimer = setTimeout(flushSave, SAVE_DELAY);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    if (!savePending && !saveFlushing) return;
    savePending = false;
    const run = () => store.persist().then(applySaveResult, () => applySaveResult(store.save()));
    saveFlushing = (saveFlushing || Promise.resolve()).then(run, run).finally(() => { saveFlushing = null; });
  }

  function flushSaveSync() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    savePending = false;
    applySaveResult(store.save());
  }

  // 另一個分頁保存了較新的資料：這個分頁停止自動保存（避免互相覆蓋），讓使用者選
  store.onForeignSave(() => {
    saveState = 'foreign';
    updateStatus();
    toast('另一個分頁保存了較新的資料，這個分頁已暫停自動保存，以免互相覆蓋。', {
      kind: 'warn', duration: 10000, action: '以這個分頁為準',
      onAction: () => { store.takeOver(); saveState = 'ok'; save_(); flushSave(); },
    });
  });

  // 離開 / 切到背景前把還沒寫的變更 flush 掉；真的存不進去就攔一下
  window.addEventListener('pagehide', flushSaveSync);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('beforeunload', e => {
    flushSaveSync();
    if (saveState !== 'ok' && store.has() && (store.hasAnnotation() || S.imgs.length)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ═══════════ 載入來源 ═══════════ */

  function addFiles(files) {
    const list = [...files].filter(f => /^image\//.test(f.type));
    if (!list.length) return;
    let pending = list.length, added = 0;
    const failed = [];
    const firstIndex = S.imgs.length;
    // 成功與失敗走同一個收尾：最後一張失敗時，其他成功的圖一樣要被選取 / 貼合 / 存檔
    const done = () => {
      if (--pending) return;
      if (added) {
        store.select(firstIndex);
        fit(); renderAll(); save_();
        toast(added > 1 ? `已開啟 ${added} 張圖片` : '已開啟 ' + store.img().name, { kind: 'success' });
      } else renderAll();
      if (failed.length) toast(`無法開啟：${failed.join('、')}`, { kind: 'danger' });
    };
    list.forEach(f => {
      const url = URL.createObjectURL(f);
      const el = new Image();
      el.onload = () => {
        URL.revokeObjectURL(url);
        try { store.addBitmap(f.name.replace(/\.[^.]+$/, ''), codec.bitmapFromImage(el)); added++; }
        catch (e) { failed.push(`${f.name}（${e.message}）`); }
        done();
      };
      el.onerror = () => { URL.revokeObjectURL(url); failed.push(f.name); done(); };
      el.src = url;
    });
  }

  function loadText(src) {
    const { name, warning } = store.addDecoded(codec.parseLoose(src), codec.extractName(src));
    fit(); renderAll(); save_();
    if (warning) toast(warning, { kind: 'warn' });
    return name;
  }

  /* ═══════════ 貼上視窗 ═══════════ */

  const openPaste = (text, err) => {
    openDialog($('modal'));
    if (text != null) $('m-text').value = text;
    showPasteError(err || '');
    $('m-text').focus();
  };
  const closePaste = () => closeDialog($('modal'));

  // 錯誤訊息帶「第 N 行附近」時，提供跳到該行
  function showPasteError(msg) {
    const box = $('m-err');
    box.innerHTML = '';
    if (!msg) return;
    const m = msg.match(/第 (\d+) 行附近/);
    box.appendChild(document.createTextNode('⚠ ' + msg + ' '));
    if (m) {
      const b = document.createElement('button');
      b.textContent = '跳到該行';
      b.onclick = () => jumpToLine(+m[1]);
      box.appendChild(b);
    }
  }

  function jumpToLine(n) {
    const ta = $('m-text');
    const lines = ta.value.split('\n');
    let start = 0;
    for (let i = 0; i < n - 1 && i < lines.length; i++) start += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(start, start + (lines[n - 1] || '').length);
    ta.scrollTop = Math.max(0, (n - 4) * 19.2);
  }

  /* ═══════════ 像素化視窗（三步驟） ═══════════ */

  let pxGrid = null, pxResult = null;
  let pxLockRatio = false;   // 格數是否鎖住原圖長寬比
  let pxProfiles = null, pxProfileIm = null, pxProfileRev = -1;   // 邊緣能量只跟點陣圖有關，依 (圖, 版本) 快取
  let pxAbort = false, pxBusy = false;
  const PX_K_DEFAULT = 48;   // 像素化的預設顏色上限（0 = 不減色）
  const PX_DEFAULT = 'pixel-art-fixer';   // 預設方法
  const PX_PREFS_KEY = 'pixann.px';
  let pxVotes = [];
  let pxForceVoteId = null;

  const pxModal = () => $('pxmodal');

  function pxReadPrefs() {
    try { return JSON.parse(localStorage.getItem(PX_PREFS_KEY) || 'null'); }
    catch { return null; }
  }
  function pxSavePrefs() {
    try {
      localStorage.setItem(PX_PREFS_KEY, JSON.stringify({
        preset: $('px-method').value || 'legacy',
        lockRatio: pxLockRatio,
      }));
    } catch {}
  }
  function pxFillMethods() {
    const sel = $('px-method');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const p of PA.pixelate.presets || []) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;          // 「預設」寫在 ⓘ 說明裡，選單文字才放得下
      sel.appendChild(o);
    }
    const saved = pxReadPrefs();
    const want = prev || (saved && saved.preset) || PX_DEFAULT;
    if ([...sel.options].some(o => o.value === want)) sel.value = want;
    else if ([...sel.options].some(o => o.value === PX_DEFAULT)) sel.value = PX_DEFAULT;
    else if (sel.options.length) sel.value = sel.options[0].value;
    pxSyncDetChecks();
  }
  function pxSyncDetChecks() {
    const p = (PA.pixelate.presets || []).find(x => x.id === $('px-method').value);
    const dets = (p && p.config && p.config.detectors) || [];
    ['autocorr', 'runlength', 'selfsim', 'fft', 'perfecter', 'hough', 'runs', 'legacy'].forEach(id => {
      const el = $('px-det-' + id);
      if (el) el.checked = dets.indexOf(id) >= 0;
    });
    const pr = $('px-precise');
    if (pr) pr.checked = !!(p && p.config && p.config.precise);
    const samp = $('px-sample');
    if (samp && !samp.options.length) {
      (PA.pixelate.list('sample') || []).forEach(d => {
        const o = document.createElement('option');
        o.value = d.id; o.textContent = d.label;
        samp.appendChild(o);
      });
    }
    if (samp && p && p.config && p.config.sample) samp.value = p.config.sample;
    const cleans = (p && p.config && p.config.clean) || [];
    ['holes', 'specks', 'jaggies', 'alpha'].forEach(id => {
      const el = $('px-clean-' + id);
      if (el) el.checked = cleans.indexOf(id) >= 0;
    });
    if ($('px-bg')) $('px-bg').checked = cleans.indexOf('bg') >= 0;
    const q = $('px-quant');
    if (q && p && p.config && p.config.quant) q.value = p.config.quant;
    const dith = $('px-dither');
    if (dith && p && p.config) dith.value = p.config.dither || 'none';
    const ds = $('px-dither-strength');
    if (ds) {
      const s = p && p.config && p.config.ditherStrength != null ? p.config.ditherStrength : 0.5;
      ds.value = Math.round((s > 1 ? s : s * 100));
      ds.disabled = !dith || dith.value === 'none';
    }
    const sn = $('px-snap');
    if (sn) {
      sn.checked = !!(p && p.config && p.config.snap);
      // 只有原版有這個功能；其他方法自己就會算格線，吸附會蓋掉它們的結果
      sn.disabled = !(p && p.id === 'legacy');
      const lab = sn.closest('label');
      if (lab) lab.title = sn.disabled
        ? '這是本工具原版自己的功能，會覆寫其他演算法算出來的格線，所以只在 legacy 方法可用'
        : '把等距格線逐條吸附到附近的邊緣，再逐帶微調成不等距網格';
    }
    const tw = $('px-target-w');
    if (tw && p && p.config && p.config.targetWidth) tw.value = p.config.targetWidth;
    // 指定寬度的方法（PixelOE／Image-to-Pixel）：沒有偵測器、靠 targetWidth
    const widthMode = !!(p && p.config && p.config.targetWidth > 0 &&
                         (!p.config.detectors || !p.config.detectors.length));
    pxModal().classList.toggle('px-photo-mode', widthMode);
  }
  function pxReadDetectors() {
    const ids = ['autocorr', 'runlength', 'selfsim', 'fft', 'perfecter', 'hough', 'runs', 'legacy'];
    const on = ids.filter(id => { const el = $('px-det-' + id); return el && el.checked; });
    return on.length ? on : ['legacy'];
  }
  function pxReadCleans() {
    const out = [];
    if ($('px-bg') && $('px-bg').checked) out.push('bg');
    ['holes', 'specks', 'jaggies', 'alpha'].forEach(id => {
      const el = $('px-clean-' + id);
      if (el && el.checked) out.push(id);
    });
    return out;
  }
  function pxBuildConfig(extra) {
    const presetId = $('px-method').value || PX_DEFAULT;
    const p = (PA.pixelate.presets || []).find(x => x.id === presetId);
    const cfg = Object.assign({
      detectors: ['legacy'], sample: 'center-median', quant: 'oklab-kmeans',
      k: 0, dither: 'none', clean: [], snap: false, precise: false, error: false,
    }, p && p.config, extra || {});
    if ($('px-sample') && $('px-sample').value) cfg.sample = $('px-sample').value;
    cfg.clean = pxReadCleans();
    if ($('px-quant') && $('px-quant').value) cfg.quant = $('px-quant').value;
    if ($('px-dither') && $('px-dither').value) cfg.dither = $('px-dither').value;
    if ($('px-dither-strength')) {
      cfg.ditherStrength = Math.max(0, Math.min(1, (+$('px-dither-strength').value || 0) / 100));
    }
    if ($('px-target-w')) cfg.targetWidth = Math.max(2, Math.min(512, +$('px-target-w').value || 64));
    if ($('px-method').value === 'custom') {
      cfg.detectors = pxReadDetectors();
      cfg.precise = !!($('px-precise') && $('px-precise').checked);
    }
    if ($('px-precise') && p && p.config && p.config.precise) cfg.precise = $('px-precise').checked;
    return cfg;
  }
  function pxShowMethodInfo(on) {
    const pop = $('px-method-pop');
    if (!on) { pop.classList.add('hide'); return; }
    const p = (PA.pixelate.presets || []).find(x => x.id === $('px-method').value);
    if (!p) { pop.classList.add('hide'); return; }
    const cfg = p.config || {};
    // 照片路線沒有偵測器，就不要印「偵測 —」
    const parts = [];
    if (cfg.detectors && cfg.detectors.length) parts.push('偵測 ' + cfg.detectors.join('、'));
    else if (cfg.targetWidth > 0) parts.push('不偵測格線，指定目標寬度');
    if (cfg.sample) parts.push('取樣 ' + cfg.sample);
    if (cfg.quant) parts.push('減色 ' + cfg.quant);
    if (cfg.dither && cfg.dither !== 'none') parts.push('抖色 ' + cfg.dither);
    const tag = p.id === PX_DEFAULT ? ' <span class="sub">（預設方法）</span>' : '';
    // 選單只寫技術名稱，來源專案寫在這裡
    if (p.source) parts.unshift('來源 ' + p.source);
    pop.innerHTML = `<b>${p.label}</b>${tag}<br>${p.desc || ''}<br><span class="sub">${parts.join(' · ')}</span>`;
    pop.classList.remove('hide');
  }
  function pxRenderVotes(votes, usedId) {
    const tb = $('px-votes') && $('px-votes').tBodies[0];
    if (!tb) return;
    tb.innerHTML = '';
    const rows = (votes || []).filter(Boolean);
    const consNx = pxGrid && pxGrid.nx;
    const add = (v, isCons) => {
      const tr = document.createElement('tr');
      const nx = v.meta && v.meta.nx != null ? v.meta.nx : (v.nx != null ? v.nx : (isCons && pxGrid ? pxGrid.nx : '—'));
      const ny = v.meta && v.meta.ny != null ? v.meta.ny : (v.ny != null ? v.ny : (isCons && pxGrid ? pxGrid.ny : '—'));
      const sx = v.sx != null ? Number(v.sx).toFixed(2) : (isCons && pxGrid ? pxGrid.sx.toFixed(2) : '—');
      const score = Number.isFinite(+v.score) ? +v.score : 0;
      const ms = v.ms == null ? '' : Math.round(v.ms);
      const warn = !isCons && consNx != null && nx !== '—' && Math.abs(nx - consNx) > 1;
      const using = (usedId && v.id === usedId) || (isCons && !usedId);
      if (using) tr.classList.add('px-vote-on');
      // 耗時不佔欄位，放到整列的提示裡；「使用中」用標籤標出來，其他狀態灰字
      const tip = [
        isCons ? '共識／仲裁的結果' : `點一下改用「${v.label || v.id}」算出的格線`,
        `信心 ${score.toFixed(2)}`,
        ms === '' ? null : `耗時 ${ms} ms`,
        warn ? `與共識差 ${Math.abs(nx - consNx)} 格` : null,
      ].filter(Boolean).join(' · ');
      tr.title = tip;
      const status = using ? '<span class="tag">使用中</span>' : `<span class="dim">${v.status || '完成'}</span>`;
      tr.innerHTML =
        `<td>${warn ? '<span class="warn" aria-label="與共識不一致">⚠</span>' : ''}${isCons ? '共識／仲裁' : (v.label || v.id)}</td>` +
        `<td>${nx}×${ny}</td><td>${sx}</td>` +
        `<td><span class="px-bar"><i style="width:${Math.round(Math.max(0, Math.min(1, score)) * 100)}%"></i></span></td>` +
        `<td>${status}</td>`;
      tr.onclick = () => {
        if (isCons) {
          pxForceVoteId = null;
          if (pxGrid && pxGrid._arb) Object.assign(pxGrid, pxGrid._arb);
          pxFill(pxGrid);
          pxNeedError = true;
          pxRecomputeSoon();
          pxRenderVotes(pxVotes, null);
          return;
        }
        pxForceVoteId = v.id;
        const g = PA.pixelate.voteToGrid(v, store.img().w, store.img().h, pxVotes);
        if (!g) return;
        if (pxGrid && !pxGrid._arb) pxGrid._arb = { sx: pxGrid.sx, sy: pxGrid.sy, phx: pxGrid.phx, phy: pxGrid.phy, nx: pxGrid.nx, ny: pxGrid.ny };
        pxGrid = Object.assign(pxGrid || {}, g);
        pxFill(pxGrid);
        pxNeedError = true;
        pxRecomputeSoon();
        pxRenderVotes(pxVotes, v.id);
      };
      tb.appendChild(tr);
    };
    rows.forEach(v => add(v, false));
    if (pxGrid) add({ id: 'consensus', label: '共識／仲裁', sx: pxGrid.sx, nx: pxGrid.nx, ny: pxGrid.ny, score: 1, ms: null, status: '完成' }, true);
  }

  // 快取 key 是圖片物件 + 版本，不是檔名：裁切 / 像素化 / 復原會就地換掉 rgba 但保留名稱，
  // 只認名稱會拿舊尺寸的陣列去索引新圖
  function pxEnsureProfiles() {
    const im = store.img();
    if (pxProfiles && pxProfileIm === im && pxProfileRev === im.rev) return pxProfiles;
    pxProfiles = PA.pixelate.edgeProfiles(im.rgba, im.w, im.h);
    pxProfileIm = im; pxProfileRev = im.rev;
    return pxProfiles;
  }

  // 依目前參數重建格線邊界。「自動吸附格線」= 全圖逐條吸附 + 逐帶網格微調：
  // AI 在不同區域的局部格寬可以差很多（臉部 35px vs 全圖 26px），直線格線不夠。
  // 「自動吸附格線」是本工具原版自己的功能（別的專案都沒有），會把偵測到的等距格線
  // 逐條吸附到附近的邊緣、再逐帶微調成不等距網格。它會覆寫掉其他演算法算出來的格線，
  // 所以只有在方法本身要求、或使用者在進階明確勾選時才套用。
  function pxSnapWanted() {
    const el = $('px-snap');
    if (!el || el.disabled) return false;
    return el.checked;
  }
  function pxApplyBounds() {
    if (!pxGrid) return;
    const snap = pxSnapWanted();
    if (!snap) { pxGrid.xs = null; pxGrid.ys = null; pxGrid.mesh = null; return; }
    const prof = pxEnsureProfiles();
    const b = PA.pixelate.buildBounds(pxGrid, prof, true);
    pxGrid.xs = b.xs;
    pxGrid.ys = b.ys;
    pxGrid.mesh = PA.pixelate.meshBounds(prof, b.xs, b.ys, pxGrid.sx);
  }

  // 原圖比顯示區小（本來就是原生像素圖）就用硬邊放大，否則會糊成一團；
  // 大圖縮小顯示才需要平滑取樣（格線才不會被降採樣打斷）
  function pxSmoothing(canvas, im) {
    canvas.style.imageRendering = im.w < (canvas.clientWidth || im.w) ? 'pixelated' : 'auto';
  }

  function pxDrawSource() {
    const cv2 = $('px-src'), im = store.img();
    // 預覽方框跟著原圖的長寬比，非正方形的圖才不會左右（或上下）留一大片空白。
    // 設在 .pxpane 上，比對拉條是 .pxview 的兄弟節點，也要吃得到這個變數。
    const pane = pxModal().querySelector('.pxpane');
    if (pane) pane.style.setProperty('--px-ar', (im.w / im.h).toFixed(4));
    // 指派 width/height 一定會重配 backing store（即使值沒變）；只在尺寸真的變了才設
    if (cv2.width !== im.w || cv2.height !== im.h) { cv2.width = im.w; cv2.height = im.h; }
    pxSmoothing(cv2, im);
    const cx = cv2.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.clearRect(0, 0, im.w, im.h);
    cx.drawImage(im.cvs, 0, 0);
    if (!pxGrid || !$('px-gridview').checked) return;
    // 沒開自動吸附時 xs/ys 是 null（等距格線），就地從 phase + k*s 算出來畫，
    // 算法跟 grid.js uniformBounds 一樣，畫出來的線就是實際的切法
    const xs = pxGrid.xs || PA.pixelate.uniformBounds(pxGrid.phx, pxGrid.sx, pxGrid.nx);
    const ys = pxGrid.ys || PA.pixelate.uniformBounds(pxGrid.phy, pxGrid.sy, pxGrid.ny);
    if (!xs || !ys) return;
    // 線寬換算成「約 1 個顯示像素」，否則縮小顯示時會糊成一片粗線
    const disp = cv2.clientWidth || im.w;
    const nx = pxGrid.nx || Math.max(1, xs.length - 1);
    // 手機上大圖縮成一小塊時，86 條格線會疊成整片洋紅，看起來像預覽壞掉
    if (disp / nx < 4) return;
    cx.strokeStyle = 'rgba(255,60,255,.9)';
    cx.lineWidth = Math.max(1, im.w / disp);
    cx.beginPath();
    if (pxGrid.mesh) {
      // 網格模式：格線逐帶彎曲，分段畫才是實際的切法
      const { xsB, ysB, nx, ny } = pxGrid.mesh;
      for (let j = 0; j < ny; j++) {
        const y0 = ys[j], y1 = ys[j + 1];
        for (let i = 0; i <= nx; i++) {
          const x = xsB[j * (nx + 1) + i];
          cx.moveTo(x, y0); cx.lineTo(x, y1);
        }
      }
      for (let i = 0; i < nx; i++) {
        const x0 = xs[i], x1 = xs[i + 1];
        for (let j = 0; j <= ny; j++) {
          const y = ysB[i * (ny + 1) + j];
          cx.moveTo(x0, y); cx.lineTo(x1, y);
        }
      }
    } else {
      for (const x of xs) { cx.moveTo(x, 0); cx.lineTo(x, im.h); }
      for (const y of ys) { cx.moveTo(0, y); cx.lineTo(im.w, y); }
    }
    cx.stroke();
  }

  function pxDrawResult(px) {
    const cv2 = $('px-out');
    cv2.width = px.w; cv2.height = px.h;
    const cx = cv2.getContext('2d');
    const id = cx.createImageData(px.w, px.h);
    id.data.set(px.rgba);
    cx.putImageData(id, 0, 0);
  }

  // 預覽只有一格，三種狀態：還沒有結果 → 只給原圖；有結果 → 只看結果，或勾比對做左右擦除
  function pxSetView() {
    const has = !!pxResult, cmp = has && $('px-compare').checked;
    const v = $('px-view');
    v.classList.toggle('showsrc', !has);
    v.classList.toggle('cmp', cmp);
    $('px-split').classList.toggle('hide', !cmp);
    $('px-viewlabel').textContent = !has ? '原圖' : (cmp ? '原圖 / 結果' : '結果');
    // 原圖剛從 display:none 變回可見時 clientWidth 是 0，格線寬度會算錯，要重畫
    if ((!has || cmp) && store.has()) pxDrawSource();
  }

  function pxFill(g) {
    $('px-w').value = g.nx;
    $('px-h').value = g.ny;
    $('px-sx').value = g.sx.toFixed(3);
    $('px-sy').value = g.sy.toFixed(3);
    $('px-phx').value = g.phx.toFixed(2);
    $('px-phy').value = g.phy.toFixed(2);
  }

  // 比例鎖：開著的時候，格數兩邊維持原圖的長寬比（偏移為 0 時，格子就是正方形）。
  // 只管手動編輯——偵測器算出來的格線照樣原樣填進來，不會被硬掰成整比例。
  function pxSetLock(on, snap) {
    pxLockRatio = !!on;
    const b = $('px-lock');
    b.classList.toggle('on', pxLockRatio);
    b.setAttribute('aria-pressed', pxLockRatio ? 'true' : 'false');
    b.querySelector('use').setAttribute('href', pxLockRatio ? '#i-lock' : '#i-unlock');
    // 按下鎖是明確的動作，當場就把比例套上去（以目前的格數寬為準）
    if (pxLockRatio && snap) pxOnEdit('count', 'x');
  }

  // 依原圖長寬比補另一邊。另一邊被 2..512 夾住時才反推回來，
  // 沒被夾住就不動使用者剛打的那一格，免得數字在手上被四捨五入推走。
  function pxLockCounts(edited) {
    const im = store.img();
    const r = im.w / im.h;
    const cl = v => Math.max(2, Math.min(512, Math.round(v) || 2));
    if (edited === 'y') {
      const want = pxGrid.ny * r, nx = cl(want);
      pxGrid.nx = nx;
      if (nx !== Math.round(want)) pxGrid.ny = cl(nx / r);
    } else {
      const want = pxGrid.nx / r, ny = cl(want);
      pxGrid.ny = ny;
      if (ny !== Math.round(want)) pxGrid.nx = cl(ny * r);
    }
  }

  // 格數、格寬、偏移三者獨立（格線可能超出圖片邊緣，不能互相反推死）。
  // 採「最後編輯的欄位優先」：改格數就重算格寬，改格寬/偏移就重算格數。
  // edited（'x' / 'y'）是使用者動到的那一軸，只有比例鎖需要知道。
  function pxOnEdit(which, edited) {
    if (!store.has() || !pxGrid) return;
    const im = store.img();
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // 正在打字的欄位不要覆寫，只在值真的不同時才寫回去（避免游標跳掉）
    const setIf = (id, v) => { const el = $(id); if (+el.value !== +v) el.value = v; };
    pxGrid.phx = +$('px-phx').value || 0;
    pxGrid.phy = +$('px-phy').value || 0;

    if (which === 'count') {
      pxGrid.nx = clamp(Math.round(+$('px-w').value) || 2, 2, 512);
      pxGrid.ny = clamp(Math.round(+$('px-h').value) || 2, 2, 512);
      if (pxLockRatio) {
        pxLockCounts(edited);
        setIf('px-w', pxGrid.nx);
        setIf('px-h', pxGrid.ny);
      }
      pxGrid.sx = (im.w - pxGrid.phx) / pxGrid.nx;
      pxGrid.sy = (im.h - pxGrid.phy) / pxGrid.ny;
      $('px-sx').value = pxGrid.sx.toFixed(3);
      $('px-sy').value = pxGrid.sy.toFixed(3);
    } else {
      pxGrid.sx = Math.max(1, +$('px-sx').value || 1);
      pxGrid.sy = Math.max(1, +$('px-sy').value || 1);
      pxGrid.nx = clamp(Math.round((im.w - pxGrid.phx) / pxGrid.sx), 2, 512);
      pxGrid.ny = clamp(Math.round((im.h - pxGrid.phy) / pxGrid.sy), 2, 512);
      if (pxLockRatio) {
        pxLockCounts(edited);
        // 格數被比例綁住之後，另一軸的格寬要跟著回算，兩列才不會顯示成互相矛盾的值。
        // 使用者正在打的那一格不碰。
        if (edited === 'y') {
          pxGrid.sx = (im.w - pxGrid.phx) / pxGrid.nx;
          setIf('px-sx', pxGrid.sx.toFixed(3));
        } else {
          pxGrid.sy = (im.h - pxGrid.phy) / pxGrid.ny;
          setIf('px-sy', pxGrid.sy.toFixed(3));
        }
      }
      $('px-w').value = pxGrid.nx;
      $('px-h').value = pxGrid.ny;
    }
    pxNeedError = true;
    pxRecomputeSoon();
  }

  // 欄位 / 滑桿的 input 事件連發時，整條管線（重取樣 + 減色）一個影格只跑一次
  let pxRaf = 0, pxRunId = 0, pxNeedError = true;
  function pxRecomputeSoon() {
    if (pxRaf) return;
    pxRaf = requestAnimationFrame(() => { pxRaf = 0; pxRecompute(); });
  }

  // 跑管線 -> 更新兩邊預覽與三步驟的資訊（重算走 Worker，結果以世代號丟掉過期的）
  async function pxRecompute() {
    if (pxRaf) { cancelAnimationFrame(pxRaf); pxRaf = 0; }
    if (!store.has() || !pxGrid) return;
    const im = store.img();
    pxApplyBounds();
    const id = ++pxRunId;
    const wantErr = pxNeedError;
    pxNeedError = false;
    try {
      const cfg = pxBuildConfig({
        forceGrid: pxGrid,
        k: Math.max(0, +$('px-k').value || 0),
        error: wantErr,
        snap: false,
      });
      const r = await PA.pixelate.callAsync('pipeline', {
        rgba: im.rgba, w: im.w, h: im.h, config: cfg,
      });
      if (id !== pxRunId || !r) return;
      pxResult = r.px;
      const okBtn = $('px-ok'), wasDisabled = okBtn.disabled;
      okBtn.disabled = false;
      // 第一次算出結果時，把焦點從「取消」移到「套用」，Enter 就能套用
      if (wasDisabled && document.activeElement === $('px-cancel')) okBtn.focus();
      pxDrawSource();
      pxDrawResult(r.px);
      pxSetView();

      let wmin = Infinity, wmax = -Infinity;
      if (pxGrid.mesh) {
        const { xsB, nx, ny } = pxGrid.mesh;
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const d = xsB[j * (nx + 1) + i + 1] - xsB[j * (nx + 1) + i];
            if (d < wmin) wmin = d;
            if (d > wmax) wmax = d;
          }
        }
      } else if (pxGrid.xs) {
        // 只有開自動吸附（legacy）才會有逐格邊界；其他方法是等距格線，沒有格寬分布可言
        for (let i = 0; i < pxGrid.xs.length - 1; i++) {
          const d = pxGrid.xs[i + 1] - pxGrid.xs[i];
          if (d < wmin) wmin = d;
          if (d > wmax) wmax = d;
        }
      }
      $('px-spread').textContent = pxSnapWanted() && Number.isFinite(wmin)
        ? `實際格寬 ${wmin.toFixed(0)}–${wmax.toFixed(0)}px` : '';
      $('px-outinfo').textContent = `${r.px.w}×${r.px.h} · ${r.colours} 色`;
      if (r.err != null) {
        $('px-errline').innerHTML = `重建誤差 <b>${r.err.toFixed(2)}</b> ` +
          (r.err > 12 ? '<span class="bad">⚠ 偏高（&gt;12 需要調整）</span>'
                      : '<span class="good">✓ 良好</span>');
        // 自動吸附只有 legacy 有，其他方法別叫使用者去關一個停用的選項
        $('px-warn').textContent = r.err > 12
          ? (pxSnapWanted()
              ? '⚠ 誤差偏高，格線可能沒對齊 — 試著微調格線偏移或關閉自動吸附'
              : '⚠ 誤差偏高，格線可能沒對齊 — 試著換一個方法，或在進階區微調格數與偏移')
          : '';
      }
      $('px-bginfo').textContent = r.cleared ? `已清 ${r.cleared.toLocaleString()} 格` : '';
    } catch (e) {
      if (id !== pxRunId) return;
      $('px-warn').textContent = e.message;
    }
  }

  function pxSetBusy(busy) {
    pxBusy = busy;
    pxModal().querySelector('.box').classList.toggle('busy', busy);
    $('px-progress').classList.toggle('hide', !busy);
    if (!busy) $('px-pfill').style.width = '0';
  }

  async function pxDetect() {
    if (!store.has() || pxBusy) return;
    const im = store.img();
    pxAbort = false;
    pxSetBusy(true);
    $('px-auto').textContent = '偵測格線中…';
    $('px-errline').textContent = '';
    pxVotes = [];
    pxForceVoteId = null;
    const cfg = pxBuildConfig({ k: 0, error: false, snap: false });
    cfg.k = 0;
    cfg.clean = [];

    if ((!cfg.detectors || !cfg.detectors.length) && cfg.targetWidth) {
      const nx = Math.max(2, Math.min(512, cfg.targetWidth | 0));
      const ny = Math.max(2, Math.min(512, Math.round(im.h * nx / im.w) || 2));
      pxGrid = { sx: im.w / nx, sy: im.h / ny, phx: 0, phy: 0, nx, ny, scoreX: 1, scoreY: 1, source: 'photo' };
      $('px-auto').innerHTML = `照片路線：<b>${nx}×${ny}</b>`;
      $('px-gridview').checked = false;
      pxFill(pxGrid);
      pxRenderVotes([], null);
      const srcColours = PA.pixelate.countColours(im.rgba).size;
      const cap = Math.min(256, srcColours);
      $('px-k').max = cap;
      $('px-k-range').max = cap;
      $('px-k').value = Math.min(PX_K_DEFAULT, srcColours);
      $('px-k-range').value = Math.min(PX_K_DEFAULT, srcColours);
      $('px-k-note').textContent = `原圖共 ${srcColours.toLocaleString()} 色 · 0 = 不減色`;
      $('px-snap').checked = false;
      pxSetBusy(false);
      pxNeedError = true;
      pxRecompute();
      return;
    }
    pxRenderVotes((cfg.detectors || []).map(id => ({ id, status: '等待', score: 0 })), null);

    const r = await PA.pixelate.callAsync('pipeline', { rgba: im.rgba, w: im.w, h: im.h, config: cfg }, {
      onProgress: (f, info) => {
        $('px-pfill').style.width = Math.round(f * 100) + '%';
        if (info && info.detectorId) {
          const row = { id: info.detectorId, status: '執行中', score: 0 };
          const list = (pxVotes || []).slice();
          const i = list.findIndex(v => v && v.id === info.detectorId);
          if (i >= 0) list[i] = Object.assign({}, list[i], row);
          else list.push(row);
          pxRenderVotes(list, null);
        }
      },
      cancelled: () => pxAbort,
    });
    pxSetBusy(false);
    if (pxAbort) { $('px-auto').textContent = '已取消偵測'; return; }
    if (r == null && !pxAbort) { $('px-warn').textContent = '偵測失敗'; return; }

    const g = r && r.grid;
    const isNative = !g;
    if (g) {
      pxGrid = g;
      if (g.source === 'native') {
        // 前置檢查認出「這本來就是原生像素圖」：1:1 不重取樣，格線畫出來只會整片洋紅
        $('px-auto').innerHTML = `<b>這已經是原生像素圖</b>（${g.nx}×${g.ny}、${(g.meta && g.meta.colours) || '?'} 色），` +
          '不需要還原格線；仍可減色 / 去背 / 抖色。';
        $('px-gridview').checked = false;
      } else if (g.source === 'exact-nn') {
        $('px-auto').innerHTML = `這是<b>整數倍放大</b>的像素圖（每格 ${g.sx.toFixed(0)}×${g.sy.toFixed(0)} px），` +
          `原始尺寸 <b>${g.nx}×${g.ny}</b>，可精確還原。`;
        $('px-gridview').checked = true;
      } else {
        $('px-auto').innerHTML = `已自動偵測：<b>${g.nx}×${g.ny}</b>，格寬 ${g.sx.toFixed(1)}px`;
        $('px-gridview').checked = true;
      }
    } else {
      // 偵測不到週期性，最可能的解釋是「這本來就是原生像素圖，沒有被放大過」。
      // 這時候正確的答案是 1:1 不重取樣，而不是亂猜一個格數。
      const nx = Math.min(512, im.w), ny = Math.min(512, im.h);
      pxGrid = { sx: im.w / nx, sy: im.h / ny, phx: 0, phy: 0, nx, ny, scoreX: 0, scoreY: 0 };
      $('px-auto').textContent = '看起來已是原生像素圖，將以 1:1 處理；仍可減色 / 去背';
      $('px-gridview').checked = false;   // 1:1 時格線沒意義，預設關，免得整片洋紅
    }
    pxFill(pxGrid);
    pxVotes = (r && r.votes) ? r.votes.filter(Boolean).map(v => {
      const def = PA.pixelate.get('detect', v.id);
      return Object.assign({}, v, { label: def ? def.label : v.id, status: '完成' });
    }) : [];
    pxRenderVotes(pxVotes, null);

    // 顏色上限的上限 = 實際色數；預設 48（跟調色盤一頁的格數一致），但圖沒那麼多色就不用減
    const srcColours = PA.pixelate.countColours(im.rgba).size;
    const cap = Math.min(256, srcColours);
    $('px-k').max = cap;
    $('px-k-range').max = cap;
    $('px-k').value = Math.min(PX_K_DEFAULT, srcColours);
    $('px-k-range').value = Math.min(PX_K_DEFAULT, srcColours);
    $('px-k-note').textContent = `原圖共 ${srcColours.toLocaleString()} 色 · 0 = 不減色`;

    // 吸附在大圖（格子夠大、抖動明顯）幫助很大，在小圖反而會讓格線跑到內部細節上。
    // 兩種算出來的格數相同，重建誤差可以直接比較，所以用實測結果決定預設值。
    const isPhoto = g && g.source === 'photo';
    if (!isNative && !isPhoto) {
      const prof = pxEnsureProfiles();
      const errOf = snap => {
        const b = PA.pixelate.buildBounds(pxGrid, prof, snap);
        const gg = { ...pxGrid, xs: b.xs, ys: b.ys,
                     mesh: snap ? PA.pixelate.meshBounds(prof, b.xs, b.ys, pxGrid.sx) : null };
        return PA.pixelate.callAsync('score', { rgba: im.rgba, w: im.w, h: im.h, grid: gg });
      };
      // 只有原版方法會自動決定要不要吸附；其他方法的格線由它們自己負責
      if ($('px-method').value === 'legacy') $('px-snap').checked = (await errOf(true)) < (await errOf(false));
      else $('px-snap').checked = false;
    } else $('px-snap').checked = false;

    pxNeedError = true;
    pxRecompute();
  }

  // 從網頁複製的圖有時只出現在 items 而不是 files。但一般貼上時同一張圖「兩邊都有」，
  // 所以不能兩邊都收 —— files 有圖就用它，沒有才回頭翻 items，否則會貼出兩張一樣的。
  function imageFilesFrom(dt) {
    const isImg = f => f && /^image\//.test(f.type);
    const fromFiles = [...(dt?.files || [])].filter(isImg);
    if (fromFiles.length) return fromFiles;
    const out = [];
    for (const it of dt?.items || []) {
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();            // 必須在事件當下同步取，不能 await 之後才拿
      if (isImg(f)) out.push(f);
    }
    return out;
  }

  // 「貼上圖片」按鈕：主動讀剪貼簿。需要使用者手勢與權限，所以只能由點擊觸發。
  async function pxPasteFromClipboard() {
    $('px-warn').textContent = '';
    try {
      if (!navigator.clipboard?.read) throw new Error('這個瀏覽器不支援直接讀取剪貼簿');
      const items = await Promise.race([
        navigator.clipboard.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('讀取逾時，請點一下視窗再試')), 2000)),
      ]);
      for (const it of items) {
        const type = it.types.find(t => t.startsWith('image/'));
        if (!type) continue;
        const blob = await it.getType(type);
        pxLoadFile(new File([blob], 'pasted', { type }));
        return;
      }
      $('px-warn').textContent = '剪貼簿裡沒有圖片（如果複製的是圖片網址，要先開啟圖片本身再複製）';
    } catch (err) {
      $('px-warn').textContent = `${err.message || '讀取剪貼簿失敗'} — 可改用 Ctrl+V 或把圖片拖進來`;
    }
  }

  // 在對話框裡直接換一張圖處理：載入後接著自動偵測
  function pxLoadFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => {
      URL.revokeObjectURL(url);
      store.addBitmap(file.name.replace(/\.[^.]+$/, ''), codec.bitmapFromImage(el));
      store.select(S.imgs.length - 1);
      fit();
      renderAll(); save_();
      pxSyncSourceInfo();
      pxDetect();
    };
    el.onerror = () => { URL.revokeObjectURL(url); $('px-warn').textContent = '圖片載入失敗'; };
    el.src = url;
  }

  function pxSyncSourceInfo() {
    if (!store.has()) {
      $('px-srcinfo').textContent = '尚未選擇圖片';
      return;
    }
    const im = store.img();
    $('px-srcinfo').textContent =
      `${im.name} · ${im.w}×${im.h} · ${PA.pixelate.countColours(im.rgba).size.toLocaleString()} 色`;
  }

  function openPixelate() {
    pxFillMethods();
    // 有圖：先放「取消」（套用要等偵測完才啟用，完成後焦點會移過去）；沒圖：放「選擇圖片」
    openDialog(pxModal(), store.has() ? $('px-cancel') : $('px-open'));
    pxSyncSourceInfo();
    $('px-outinfo').textContent = '';
    if (store.has()) {
      // 先把原圖畫上去（不帶上一張圖留下的格線），偵測是 async 的
      pxGrid = null; pxResult = null;
      pxSetView();                         // 還沒有結果 → 先停在原圖
      $('px-ok').disabled = true;          // 有結果才能套用
      pxDrawSource();
      pxDetect();
    } else {
      pxGrid = null; pxResult = null;
      pxSetView();
      $('px-ok').disabled = true;
      $('px-auto').textContent = '—';
      $('px-warn').textContent = '還沒有圖片：按「選擇圖片」，或把圖片拖進這個視窗';
    }
  }
  function closePixelate() {
    pxAbort = true;
    if (PA.pixelate.cancelJobs) PA.pixelate.cancelJobs();
    pxRunId++;
    closeDialog(pxModal());
  }

  async function applyPixelate() {
    if (pxRaf) { cancelAnimationFrame(pxRaf); pxRaf = 0; }
    pxNeedError = false;
    await pxRecompute();
    if (!pxResult || !store.has()) return;
    const before = `${store.img().w}×${store.img().h}`;
    store.snapshotImage(`像素化 ${before} → ${pxResult.w}×${pxResult.h}`);
    store.replaceImage(codec.bitmapFromRgba(pxResult.w, pxResult.h, pxResult.rgba));
    closePixelate();
    S.zoomTouched = false;
    fit();
    renderAll(); save_();
    toast(`已像素化：${before} → ${store.img().w}×${store.img().h}`,
          { kind: 'success', action: '復原', onAction: doUndo });
  }

  /* ═══════════ 畫布互動 ═══════════ */

  function bindCanvas() {
    cv.addEventListener('pointerdown', e => {
      if (!store.has()) return;
      if (spaceHeld) return;   // Space+左鍵 = 平移，交給 stage
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // 觸控：第二指落下 / 雙指手勢進行中，交給 bindTouch（縮放 / 平移），不起筆
      if (e.pointerType === 'touch' && (touchGestureActive() || touchCount() > 1)) return;
      closeMenu();
      const [x, y] = render.pxAt(e);

      // 裁切要先處理：右邊 / 下邊的把手正好壓在圖片邊界上（x = w），
      // 若先做 inBounds 檢查，這幾個把手就抓不到
      if (S.tool === 'crop') { startCropPointer(e, x, y); return; }
      // 鏡射差異開著時，抓對稱軸虛線（±5px）可以直接拖
      if (mirrorAxisHit(e)) { startAxisDrag(e); return; }
      if (!store.inBounds(x, y)) return;

      // Alt+點：標註模式吸取部件、繪圖模式吸取顏色，免切工具
      if (e.altKey) {
        if (mode === 'annotate') {
          const id = store.annot().grid[store.idx(x, y)];
          if (id) { store.setActive(id); renderParts(); updateHud(); draw(); }
          else toast('這一格沒有標註');
        } else {
          const c = store.pixelAt(x, y);
          if (c[3] < 8) return toast('這一格是透明的');
          setDrawColour(rgb2hex(c)); pushRecent(drawColor); updateHud();
        }
        return;
      }

      if (PIXEL_TOOLS.has(S.tool)) {
        if (S.tool === 'pick') {
          const c = store.pixelAt(x, y);
          if (c[3] < 8) return toast('這一格是透明的');
          setDrawColour(rgb2hex(c)); pushRecent(drawColor); updateHud();
          return;
        }
        try { cv.setPointerCapture(e.pointerId); } catch {}
        // 像素稀疏 diff：只記這一筆真的改到的像素，不複製整張圖
        store.beginPixelStroke(S.tool === 'epix' ? '擦成透明' : '繪圖');
        strokeSnap = true;
        drawing = true;
        strokePointer = e.pointerId;
        document.body.classList.add('interacting');
        lastPx = [x, y];
        if (S.tool === 'draw') pushRecent(drawColor);   // 真的用到的顏色才進「最近用色」
        // Shift+點：從上一個筆畫端點畫直線（像素畫慣例）
        if (e.shiftKey && lastStrokeEnd) paintLine(lastStrokeEnd, [x, y]);
        paintPixelAt(x, y);
        lastStrokeEnd = [x, y];
        draw();
        return;
      }

      const v = S.tool === 'erase' ? 0 : S.activePart;
      if (!v && S.tool !== 'erase') {
        toast(store.annot().parts.length ? '先點選一個部件' : '先新增一個部件', { kind: 'warn' });
        return;
      }
      // 到這裡只剩標註工具
      if (S.tool === 'wand') {
        store.snapshot(TOOL_NAMES[S.tool]);
        store.floodSameColour(x, y, v);
        renderAll(); save_();
        return;
      }
      if (S.tool === 'same') {
        store.snapshot(TOOL_NAMES[S.tool]);
        store.allSameColour(x, y, v);
        renderAll(); save_();
        return;
      }
      try { cv.setPointerCapture(e.pointerId); } catch {}
      // 標註稀疏 diff：筆刷 / 擦除只記改到的格
      store.beginStroke(TOOL_NAMES[S.tool]);
      strokeSnap = true;
      drawing = true;
      strokePointer = e.pointerId;
      document.body.classList.add('interacting');
      lastPx = [x, y];
      if (e.shiftKey && lastStrokeEnd)
        store.strokeTo(lastStrokeEnd[0], lastStrokeEnd[1], x, y, v);
      store.brushAt(x, y, v);
      lastStrokeEnd = [x, y];
      draw(); updatePartCounts(); renderSummary();
    });

    cv.addEventListener('pointermove', e => {
      if (!store.has()) return;
      const [x, y] = render.pxAt(e);
      const inside = store.inBounds(x, y);
      const next = inside ? [x, y] : null;
      const changed = (next === null) !== (hoverCell === null) || (next && (hoverCell[0] !== x || hoverCell[1] !== y));
      hoverCell = next;
      const busy = drawing || gesture;
      if (changed) {
        if (PREVIEW_TOOLS.has(S.tool) && !busy) schedulePreview();
        // 筆刷輪廓跟著游標：合併到下一個影格畫一次就好；狀態列的 coverage 現在是 O(1)
        scheduleDraw(); updateStatus();
        if (isMobile()) updateHud();
      }

      // 裁切工具的游標形狀跟著把手走
      if (S.tool === 'crop' && !busy) {
        const [cx, cy] = render.canvasPosAt(e);
        const zone = render.cropHitTest(S.crop, S.zoom, cx, cy);
        cv.style.cursor = render.CROP_CURSORS[zone] || 'crosshair';
      } else if (!busy && mode === 'draw') {
        cv.style.cursor = mirrorAxisHit(e) ? 'ew-resize' : '';
      }

      // 裁切 / 對稱軸拖曳有自己的 move 監聽器；筆畫以外的手勢絕對不能走到下面塗色
      if (!drawing || gesture) return;

      // 高回報率指標會把中間點合併進這一個 pointermove；逐點補上才不會留下斷線
      const raw = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      const events = raw && raw.length ? raw : [e];
      let painted = false, annot = false;
      for (const ce of events) {
        const [px, py] = render.pxAt(ce);
        if (!store.inBounds(px, py)) continue;
        if (PIXEL_TOOLS.has(S.tool)) {
          paintLine(lastPx, [px, py]);
          lastPx = [px, py];
          lastStrokeEnd = [px, py];
          painted = true;
        } else if (S.tool === 'brush' || S.tool === 'erase') {
          store.strokeTo(lastPx[0], lastPx[1], px, py, S.tool === 'erase' ? 0 : S.activePart);
          lastPx = [px, py];
          lastStrokeEnd = [px, py];
          painted = true;
          annot = true;
        }
      }
      if (painted) {
        scheduleDraw();
        if (annot) schedulePanelCounts();
      }
    });

    cv.addEventListener('pointerleave', () => {
      hoverCell = null;
      preview = null;
      cancelPreviewTimer();
      if (store.has()) { draw(); updateStatus(); }
    });
    cv.addEventListener('pointerup', () => finishStroke());
    // 瀏覽器搶走指標（觸控手勢、系統手勢）時，正在畫的那一筆要整筆撤掉，不能留半截
    cv.addEventListener('pointercancel', () => abortStroke());
  }

  // 筆畫正常結束：關掉錄製、重畫面板、存檔
  function finishStroke() {
    strokeSnap = false;
    if (!drawing) return;
    drawing = false;
    if (strokePointer !== null) { try { cv.releasePointerCapture(strokePointer); } catch {} strokePointer = null; }
    document.body.classList.remove('interacting');
    store.endStroke();
    renderAll(); save_();
  }

  // 取消進行中的筆畫並還原到筆畫前（第二指落下變成雙指手勢、pointercancel 時用）。
  // 筆畫開始時 diff 已經進 past，用 cancelLastAction 退回去 —— 它不會把這一筆推進 future，
  // 不會多出一筆假的重做。
  function abortStroke() {
    if (!drawing) return;
    drawing = false;
    lastPx = null;
    if (strokePointer !== null) { try { cv.releasePointerCapture(strokePointer); } catch {} strokePointer = null; }
    document.body.classList.remove('interacting');
    if (strokeSnap) {
      strokeSnap = false;
      store.cancelLastAction();
    } else store.endStroke();
    renderAll(); save_();
  }

  function paintLine(a, b) {
    const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      paintPixelAt(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t));
    }
  }

  // 依筆刷大小塗一塊；擦除就是把 alpha 設成 0
  function paintPixelAt(x, y) {
    const c = S.tool === 'epix' ? [0, 0, 0, 0] : [...hex2rgb(drawColor), 255];
    const r = S.brush - 1;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) store.paintPixel(x + dx, y + dy, c);
  }

  /* ═══════════ 裁切 ═══════════ */

  function syncCropBar(skipEl) {
    const bar = $('cropbar'), c = S.crop;
    const wasHidden = bar.classList.contains('hide');
    bar.classList.toggle('hide', !c);
    // 列停靠在畫布下方會壓縮可用高度：出現 / 消失時重新貼合，畫布最底列才不會被蓋住
    if (wasHidden !== !c) relayout();
    if (!c) return;
    if (skipEl !== $('crop-x')) $('crop-x').value = c.x;
    if (skipEl !== $('crop-y')) $('crop-y').value = c.y;
    if (skipEl !== $('crop-w')) $('crop-w').value = c.w;
    if (skipEl !== $('crop-h')) $('crop-h').value = c.h;
    const im = store.img();
    $('crop-info').textContent = `${c.w}×${c.h}（原 ${im.w}×${im.h}）`;
    $('crop-apply').disabled = c.x === 0 && c.y === 0 && c.w === im.w && c.h === im.h;
  }

  function readCropBar(fromInput) {
    store.setCrop({
      x: +$('crop-x').value, y: +$('crop-y').value,
      w: +$('crop-w').value, h: +$('crop-h').value,
    });
    syncCropBar(fromInput ? document.activeElement : null);
    draw();
  }

  // 裁切的三種起手式：拖把手縮放、拖框內移動、拖框外新選
  function startCropPointer(e, x, y) {
    const [cx, cy] = render.canvasPosAt(e);
    const zone = render.cropHitTest(S.crop, S.zoom, cx, cy);
    const im0 = store.img();
    // 起手點可能落在邊界外（抓最右 / 最下的把手時），夾回圖內當新選範圍的錨點
    x = Math.max(0, Math.min(im0.w - 1, x));
    y = Math.max(0, Math.min(im0.h - 1, y));
    try { cv.setPointerCapture(e.pointerId); } catch {}
    gesture = 'crop';   // 不是筆畫：不進復原堆疊、pointermove 也不會塗色

    // 把手縮放與整框移動都以起手時的矩形為基準
    const c0 = { ...S.crop };
    const move = ev => {
      const [px, py] = render.pxAt(ev);
      const im = store.img();
      const qx = Math.max(0, Math.min(im.w - 1, px));
      const qy = Math.max(0, Math.min(im.h - 1, py));
      if (!zone) {
        // 新選範圍
        store.setCrop({
          x: Math.min(x, qx), y: Math.min(y, qy),
          w: Math.abs(qx - x) + 1, h: Math.abs(qy - y) + 1,
        });
      } else if (zone === 'move') {
        const dx = px - x, dy = py - y;
        store.setCrop({
          x: Math.max(0, Math.min(im.w - c0.w, c0.x + dx)),
          y: Math.max(0, Math.min(im.h - c0.h, c0.y + dy)),
          w: c0.w, h: c0.h,
        });
      } else {
        // 八把手：各自調整對應的邊
        let { x: rx, y: ry, w: rw, h: rh } = c0;
        if (zone.includes('w')) { const nx = Math.min(qx, rx + rw - 1); rw = rx + rw - nx; rx = nx; }
        if (zone.includes('e')) rw = Math.max(1, qx - rx + 1);
        if (zone.includes('n')) { const ny = Math.min(qy, ry + rh - 1); rh = ry + rh - ny; ry = ny; }
        if (zone.includes('s')) rh = Math.max(1, qy - ry + 1);
        store.setCrop({ x: rx, y: ry, w: rw, h: rh });
      }
      syncCropBar(); draw();
    };
    const up = () => {
      gesture = null; gestureEnd = null;
      try { cv.releasePointerCapture(e.pointerId); } catch {}
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
    };
    gestureEnd = up;
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    if (!zone) {
      store.setCrop({ x, y, w: 1, h: 1 });
      syncCropBar(); draw();
    }
  }

  function doCrop() {
    const c = S.crop;
    if (!c || !store.has()) return;
    // 先確認真的會裁到東西，再進復原堆疊 —— 否則會多一筆幻影快照，還把重做清掉
    if (store.cropIsNoop()) return toast('裁切範圍就是整張圖，沒有變化');
    const before = `${store.img().w}×${store.img().h}`;
    store.snapshotImage(`裁切 ${before} → ${c.w}×${c.h}`);
    store.applyCrop();
    setTool(mode === 'draw' ? 'draw' : 'brush');
    S.zoomTouched = false;               // 尺寸變了，重新貼合
    fit();
    renderAll(); save_();
    toast(`已裁切：${before} → ${store.img().w}×${store.img().h}`,
          { kind: 'success', action: '復原', onAction: doUndo });
  }

  /* ═══════════ 平移（右鍵 / 中鍵 / Space）與右鍵快選 ═══════════ */

  function bindPan() {
    let panning = false, maybeMenu = false, sx = 0, sy = 0, sl = 0, st = 0;

    stage.addEventListener('contextmenu', e => e.preventDefault());

    stage.addEventListener('pointerdown', e => {
      const isRight = e.button === 2, isMid = e.button === 1;
      const isSpaceLeft = e.button === 0 && spaceHeld;
      if (!isRight && !isMid && !isSpaceLeft) return;
      e.preventDefault();
      closeMenu();
      sx = e.clientX; sy = e.clientY;
      sl = stage.scrollLeft; st = stage.scrollTop;
      // 右鍵點一下（位移 <4px）= 快選選單；拖曳 = 平移
      maybeMenu = isRight;
      panning = isMid || isSpaceLeft;
      if (panning) { stage.classList.add('panning'); document.body.classList.add('interacting'); }
      try { stage.setPointerCapture(e.pointerId); } catch {}
    });

    stage.addEventListener('pointermove', e => {
      if (maybeMenu && !panning &&
          Math.hypot(e.clientX - sx, e.clientY - sy) >= 4) {
        panning = true;
        maybeMenu = false;
        stage.classList.add('panning');
        document.body.classList.add('interacting');
      }
      if (!panning) return;
      stage.scrollLeft = sl - (e.clientX - sx);
      stage.scrollTop = st - (e.clientY - sy);
      render.invalidateRect();
    });

    const end = e => {
      if (maybeMenu && !panning && e.type === 'pointerup' && store.has()) {
        openQuickMenu(e.clientX, e.clientY);
      }
      maybeMenu = false;
      if (!panning) return;
      panning = false;
      stage.classList.remove('panning');
      document.body.classList.remove('interacting');
      try { stage.releasePointerCapture(e.pointerId); } catch {}
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    // Ctrl+滾輪：以游標為中心整數倍縮放（攔截瀏覽器整頁縮放）
    stage.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (!store.has()) return;
      e.preventDefault();
      zoomStep(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
    }, { passive: false });
  }

  /* ---------- 右鍵快選選單 ---------- */

  function openQuickMenu(x, y, invoker) {
    const items = [];
    if (mode === 'annotate') {
      items.push({ head: '部件' });
      const a = store.annot();
      a.parts.slice(0, 9).forEach((p, i) => items.push({
        label: p.name, swatch: p.color, kbd: String(i + 1),
        on: p.id === S.activePart,
        action: () => { store.setActive(p.id); renderParts(); updateHud(); draw(); },
      }));
      if (a.parts.length > 9) items.push({
        label: `更多部件（共 ${a.parts.length} 個）…`,
        action: () => setTab('parts'),
      });
      if (!a.parts.length) items.push({ label: '（還沒有部件）', disabled: true });
      items.push({ sep: true }, { head: '工具' });
      ANNOTATE_TOOLS.forEach(t => items.push({
        label: TOOL_NAMES[t], kbd: t === 'brush' ? 'B' : t === 'wand' ? 'W' : t === 'same' ? 'S' : 'E',
        on: S.tool === t, action: () => setTool(t),
      }));
    } else {
      items.push({ head: '工具' });
      ['draw', 'pick', 'epix'].forEach(t => items.push({
        label: TOOL_NAMES[t], kbd: t === 'draw' ? 'D' : t === 'pick' ? 'I' : 'X',
        on: S.tool === t, action: () => setTool(t),
      }));
      items.push({ sep: true });
      items.push({ label: `前景色 ${drawColor}`, swatch: drawColor, action: () => setTab('colors') });
    }
    items.push({ sep: true });
    items.push({ label: '影像：裁切', kbd: 'C', on: S.tool === 'crop', action: () => setTool('crop') });
    items.push({ label: '影像：像素化…', action: openPixelate });
    if (isMobile()) {
      // 手機的標題列沒有縮放鈕，貼合放這裡（也可以在空白處點兩下）
      items.push({ sep: true });
      items.push({ label: `⛶ 貼合視窗（目前 ${S.zoom}×）`, action: () => { S.zoomTouched = false; fit(); draw(); updateStatus(); } });
    }
    showMenu(x, y, items, invoker);
  }

  /* ═══════════ 觸控手勢（bindTouch）：單指空白處平移、雙指縮放 + 平移、空白處點兩下貼合 ═══════════
     只處理 pointerType === 'touch'；滑鼠與觸控筆完全走原本的路徑。
     stage 的 pointerdown 用 capture 階段監聽，才會跑在 #cv 的 target 監聽器之前，
     bindCanvas 才看得到「已經有第二指」而不起筆。 */

  function bindTouch() {
    let pinch = null;                              // {d0, z0, mid}
    let pan = { sx: 0, sy: 0, sl: 0, st: 0 };
    let lastTap = 0;
    const others = () => [...touchDown.values()];

    stage.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      const onCanvas = !!(e.target instanceof Element && e.target.closest('#wrapcv'));
      touchDown.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now(), onCanvas });

      if (touchDown.size === 1) {
        // 第一指：在畫布上 → 交給 bindCanvas 畫；在按鈕 / 卡片上 → 不搶；其餘空白處 → 單指平移
        if (onCanvas || !store.has()) return;
        if (e.target instanceof Element && e.target.closest('button, input, label, select, a, textarea')) return;
        touchGesture = 'pan1';
        pan = { sx: e.clientX, sy: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
        try { stage.setPointerCapture(e.pointerId); } catch {}
        return;
      }
      if (touchDown.size === 2 && store.has()) {
        // 第二指：剛開始的那一筆整筆撤掉，改成雙指縮放 / 平移
        if (gestureEnd) gestureEnd();   // 裁切 / 對稱軸拖曳：直接收尾（會拿掉 move / up 監聽器）
        abortStroke();
        for (const id of touchDown.keys()) {
          try { cv.releasePointerCapture(id); } catch {}
          try { stage.setPointerCapture(id); } catch {}
        }
        const [a, b] = others();
        pinch = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z0: S.zoom,
                  mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        touchGesture = 'pinch';
        closeMenu();
      }
    }, true);

    stage.addEventListener('pointermove', e => {
      if (e.pointerType !== 'touch' || !touchDown.has(e.pointerId)) return;
      const t = touchDown.get(e.pointerId);
      t.x = e.clientX; t.y = e.clientY;

      if (touchGesture === 'pan1') {
        stage.scrollLeft = pan.sl - (e.clientX - pan.sx);
        stage.scrollTop = pan.st - (e.clientY - pan.sy);
        return;
      }
      if (touchGesture !== 'pinch' || touchDown.size < 2 || !pinch) return;
      const [a, b] = others();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

      // 1) 整數倍縮放，以兩指中點為錨（縮放上限同 zoomStep）
      const box = stageBox();
      const target = Math.max(1, Math.min(render.zoomMax(box.w, box.h), Math.round(pinch.z0 * d / pinch.d0)));
      if (target !== S.zoom && Math.abs(d - pinch.d0) > 8) {
        const cr = cv.getBoundingClientRect();
        const ix = (mid.x - cr.left) / S.zoom, iy = (mid.y - cr.top) / S.zoom;   // 中點下的圖片座標
        S.zoomTouched = true;
        S.zoom = target;
        $('zval').textContent = target + '×';
        draw();
        // draw() 之後量新位置：不管畫布是置中（margin:auto）還是溢出，都把同一個圖片點拉回中點
        const cr2 = cv.getBoundingClientRect();
        stage.scrollLeft += (cr2.left + ix * target) - mid.x;
        stage.scrollTop += (cr2.top + iy * target) - mid.y;
        updateStatus();
      }
      // 2) 中點位移 = 平移
      stage.scrollLeft -= mid.x - pinch.mid.x;
      stage.scrollTop -= mid.y - pinch.mid.y;
      pinch.mid = mid;
    });

    const endTouch = e => {
      if (e.pointerType !== 'touch' || !touchDown.has(e.pointerId)) return;
      const t = touchDown.get(e.pointerId);
      touchDown.delete(e.pointerId);
      try { stage.releasePointerCapture(e.pointerId); } catch {}

      // 空白處點兩下 = 貼合（手機的標題列沒有縮放鈕）
      if (touchGesture === 'pan1' && e.type === 'pointerup') {
        const now = performance.now();
        const tap = now - t.t0 < 300 && Math.hypot(e.clientX - t.sx, e.clientY - t.sy) < 8;
        if (tap && now - lastTap < 300) { S.zoomTouched = false; fit(); draw(); updateStatus(); lastTap = 0; }
        else lastTap = tap ? now : 0;
      }

      if (touchDown.size === 1 && touchGesture === 'pinch') {
        // 剩一指：接著當單指平移
        const r = others()[0];
        touchGesture = 'pan1';
        pan = { sx: r.x, sy: r.y, sl: stage.scrollLeft, st: stage.scrollTop };
        pinch = null;
      } else if (touchDown.size === 0) {
        touchGesture = null; pinch = null;
        updateStatus();
      }
    };
    stage.addEventListener('pointerup', endTouch);
    stage.addEventListener('pointercancel', endTouch);
  }

  /* ═══════════ 模式 / 工具 / 分頁 ═══════════ */

  const tabFor = { annotate: 'parts', draw: 'colors' };   // 依模式記住使用者手動切的分頁

  function applyMode(m) {
    mode = m;
    document.body.dataset.mode = m;
    // 左欄與行動版 dock 各有一組模式切換，一起同步（role=tab 要連 aria-selected 一起）
    document.querySelectorAll('.modesw [data-mode]').forEach(b => {
      const on = b.dataset.mode === m;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
  }

  function setMode(m) {
    if (mode === m) return;
    applyMode(m);
    setTool(m === 'draw' ? 'draw' : 'brush');
    setTab(tabFor[m], true, !isMobile());   // 行動版：切模式不要每次都把抽屜彈出來
  }

  function setTool(t) {
    // 筆畫或手勢進行中按了快捷鍵：先把它結束掉，不能讓同一筆在新工具下繼續（會逃出它的復原快照）
    if (drawing) finishStroke();
    if (gestureEnd) gestureEnd();
    const need = modeOf(t);
    if (mode !== need) { applyMode(need); setTab(tabFor[need], true, !isMobile()); }
    S.tool = t;
    document.querySelectorAll('.toolbtn[data-tool]').forEach(b => {
      const on = b.dataset.tool === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (t === 'crop') store.cropWholeImage();   // 一進裁切模式先框住整張，再讓使用者縮小
    else store.clearCrop();
    cv.style.cursor = '';
    syncCropBar();
    invalidatePreview();
    draw(); updateHud(); updateStatus();
  }

  // reveal=false：只切分頁，不把收合中的右欄展開（行動版切模式 / 工具時用）
  function setTab(name, manual = true, reveal = true) {
    document.querySelectorAll('.tabbar [data-tab]').forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;             // tab 清單只留一個 tab stop（APG 慣例）
    });
    document.querySelectorAll('.tabpage').forEach(p =>
      p.classList.toggle('hide', p.id !== 'tab-' + name));
    if (manual) tabFor[mode] = name;
    if (reveal && document.body.classList.contains('aside-closed')) toggleAside(false);
  }

  function toggleAside(close) {
    const will = close ?? !document.body.classList.contains('aside-closed');
    document.body.classList.toggle('aside-closed', will);
    $('b-collapse').textContent = will ? '⟩' : '⟨';
    $('b-collapse').title = will ? '展開面板（Tab）' : '收合面板（Tab）';
    if (isMobile()) {
      // 行動版：右欄是蓋在畫布上的抽屜，不影響畫布空間；打開時順手收左欄抽屜
      if (!will) document.body.classList.remove('rail-open');
      syncDock();
      return;
    }
    // 右欄寬度變了，畫布可用空間跟著變
    relayout();
  }

  /* ═══════════ 行動版（≤900px）：抽屜與底部工具列 ═══════════ */
  // 桌面完全走原本的路徑；這裡的東西只在 isMobile() 為真時有作用。
  // body.aside-closed（既有）= 右欄抽屜收起；body.rail-open（新）= 左欄抽屜打開。

  const mqMobile = window.matchMedia('(max-width: 900px)');
  const isMobile = () => mqMobile.matches;
  const railOpen = () => document.body.classList.contains('rail-open');
  const asideOpen = () => !document.body.classList.contains('aside-closed');

  function syncDock() {
    const m = isMobile();
    $('d-more').classList.toggle('on', m && railOpen());
    $('d-more').setAttribute('aria-expanded', String(m && railOpen()));
    $('d-panel').classList.toggle('on', m && asideOpen());
    $('d-panel').setAttribute('aria-expanded', String(m && asideOpen()));
    $('scrim').setAttribute('aria-hidden', String(!(m && (railOpen() || asideOpen()))));
  }

  function closeSheets() {
    document.body.classList.remove('rail-open');
    if (asideOpen()) toggleAside(true);
    syncDock();
  }
  function openRailSheet() {
    if (asideOpen()) toggleAside(true);
    document.body.classList.add('rail-open');
    syncDock();
  }
  const openAsideSheet = () => toggleAside(false);   // toggleAside 會順手關左欄抽屜

  // 進入行動版：抽屜全收；回到桌面：右欄展開（桌面預設）、左欄抽屜狀態清掉
  function applyMobileMode(on) {
    document.body.classList.remove('rail-open');
    if (on && asideOpen()) toggleAside(true);
    else if (!on && !asideOpen()) toggleAside(false);
    syncDock();
  }
  mqMobile.addEventListener('change', e => applyMobileMode(e.matches));

  /* ═══════════ 復原 / 重做 ═══════════ */

  function afterHistoryStep(r, verb) {
    // 尺寸變了（裁切 / 像素化）就重新貼合，否則 213×213 會停在 16×16 的倍率上
    if (r.resized) { S.zoomTouched = false; fit(); }
    renderAll(); save_();
    toast(`${verb}：${r.label}`);
    fillHistPanel();
  }

  function doUndo() {
    const r = store.undoOnce();
    if (r) afterHistoryStep(r, '已復原');
  }

  function doRedo() {
    const r = store.redoOnce();
    if (r) afterHistoryStep(r, '已重做');
  }

  // 一次復原 / 重做多步（歷史面板用）
  function historySteps(n, step, verb) {
    let done = 0, resized = false, label = '';
    for (; done < n; done++) {
      const r = step();
      if (!r) break;
      resized = resized || r.resized;
      label = r.label;
    }
    if (!done) return;
    afterHistoryStep({ resized, label: done > 1 ? `${done} 步（最遠到「${label}」）` : label }, verb);
  }
  const undoSteps = n => historySteps(n, store.undoOnce, '已復原');
  const redoSteps = n => historySteps(n, store.redoOnce, '已重做');

  // 復原歷史面板：開著就留著，點一步跳過去但不關；Esc / 再點 ▾ / 點外面關閉
  const histPanel = () => $('histpanel');
  const histOpen = () => !histPanel().classList.contains('hide');

  function closeHistPanel() {
    if (!histOpen()) return;
    histPanel().classList.add('hide');
    $('b-hist').setAttribute('aria-expanded', 'false');
  }

  function fillHistPanel() {
    if (!histOpen()) return;
    const box = $('histlist');
    box.innerHTML = '';
    if (!store.has()) {
      const h = document.createElement('div');
      h.className = 'mhead';
      h.textContent = '沒有開啟的圖片';
      box.appendChild(h);
      return;
    }
    const { past, future } = store.historyLabels();
    const addHead = t => {
      const h = document.createElement('div');
      h.className = 'mhead';
      h.textContent = t;
      box.appendChild(h);
    };
    const addBtn = (label, kbd, action, on) => {
      const b = document.createElement('button');
      b.className = 'mi' + (on ? ' on' : '');
      b.setAttribute('role', 'option');
      const lb = document.createElement('span');
      lb.className = 'mlabel';
      lb.textContent = label;
      b.appendChild(lb);
      if (kbd) { const k = document.createElement('kbd'); k.textContent = kbd; b.appendChild(k); }
      b.onclick = () => { action(); fillHistPanel(); };
      box.appendChild(b);
    };
    if (future.length) {
      addHead('可重做');
      future.forEach((label, i) => addBtn(`↷ ${label}`, '', () => redoSteps(i + 1)));
    }
    addHead(past.length ? `可復原（最新在上）· 共 ${past.length} 步` : '沒有可復原的動作');
    [...past].reverse().forEach((label, i) => addBtn(`↶ ${label}`, i === 0 ? 'Ctrl+Z' : '', () => undoSteps(i + 1), i === 0));
  }

  function openHistPanel() {
    if (histOpen()) { closeHistPanel(); return; }
    closeMenu();
    const panel = histPanel();
    panel.classList.remove('hide');
    $('b-hist').setAttribute('aria-expanded', 'true');
    fillHistPanel();
    const r = $('b-hist').getBoundingClientRect();
    const w = panel.getBoundingClientRect().width;
    panel.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    panel.style.top = Math.min(r.bottom + 6, window.innerHeight - 80) + 'px';
    const first = panel.querySelector('.mi:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  /* ═══════════ 破壞性操作 ═══════════ */

  function clearAnnotations() {
    if (!store.has()) return;
    showConfirm({
      title: '清空標註',
      body: `清掉「${store.img().name}」的全部標註。這個動作可以復原（Ctrl+Z，或 Toast 的復原鈕）。`,
      buttons: [
        { label: '取消', kind: 'ghost', focus: true },
        { label: '清空', kind: 'danger', action: () => {
          store.snapshot('清空標註');
          const n = store.clearGrid();
          renderAll(); save_();
          toast(`已清空 ${n.toLocaleString()} 格標註`, { kind: 'success', action: '復原', onAction: doUndo });
        } },
      ],
    });
  }

  function requestCloseImage(i) {
    const idx = i ?? S.cur;
    if (idx < 0 || idx >= S.imgs.length) return;
    const im = S.imgs[idx], a = S.ann[im.name];
    // 不先切過去：確認框取消時畫面才不會停在「本來只想關掉」的那張圖上。
    // 真的要關才 select → closeCurrent → 切回原本在看的那張
    const close = () => {
      const viewing = store.has() ? store.img().name : null;
      const name = im.name;
      if (idx !== S.cur) store.select(idx);
      store.closeCurrent();
      if (viewing && viewing !== name) {
        const j = S.imgs.findIndex(x => x.name === viewing);
        if (j >= 0) store.select(j);
      }
      if (store.has()) fit();
      renderAll(); save_();
      toast('已關閉 ' + name);
    };
    if (!a || !a.annTotal) return close();
    const c = store.coverage(im);
    const fmtOk = im.w <= TEXT_FMT_MAX && im.h <= TEXT_FMT_MAX;
    showConfirm({
      title: '關閉圖片',
      body: `「${im.name}」有 ${c.annotated.toLocaleString()} 格標註，關閉後無法復原。可以先下載 JSON 保留標註，之後再匯入。`,
      buttons: [
        { label: '取消', kind: 'ghost', focus: true },
        { label: '關閉', kind: 'danger', action: close },
        ...(fmtOk ? [{
          label: '下載 JSON 後關閉', kind: 'primary',
          action: () => { if (idx !== S.cur) { store.select(idx); renderAll(); } doDownload('json'); close(); },
        }] : []),
      ],
    });
  }

  function addTyped() {
    if (!store.has()) return;
    const el = $('newpart'), nm = el.value.trim();
    if (!nm) return;
    if (store.annot().parts.some(p => p.name === nm))
      return toast(`已經有叫「${nm}」的部件了`, { kind: 'warn' });
    store.addPart(nm);
    el.value = '';
    el.focus();                       // 連續新增時焦點留在輸入框
    renderParts(); draw(); save_(); updateHud();
  }

  /* ═══════════ 綁定 ═══════════ */

  function centreMirrorAxis() {
    if (!store.has()) return;
    $('mirroraxis').value = render.mirrorAxisOf(store.img()).toFixed(1);
  }

  const currentAxis = () => $('mirroraxis').value === '' ? render.mirrorAxisOf(store.img()) : +$('mirroraxis').value;

  // 游標是否壓在對稱軸虛線上（繪圖模式 + 鏡射差異開著時才算）
  function mirrorAxisHit(e) {
    if (mode !== 'draw' || !$('v-mirror').checked || !store.has()) return false;
    const [cx] = render.canvasPosAt(e);
    return Math.abs(cx - (currentAxis() + 0.5) * S.zoom) <= 5;
  }

  // 拖對稱軸：以半格為單位（軸可以落在格線上或格中央）。
  // 這是手勢不是筆畫：用 gesture 而不是 drawing，否則畫布的 pointermove 會把它當繪圖去塗像素
  function startAxisDrag(e) {
    try { cv.setPointerCapture(e.pointerId); } catch {}
    gesture = 'axis';
    const move = ev => {
      const [cx] = render.canvasPosAt(ev);
      const im = store.img();
      const ax = Math.max(0, Math.min(im.w - 1, Math.round((cx / S.zoom - 0.5) * 2) / 2));
      $('mirroraxis').value = ax.toFixed(1);
      scheduleDraw(); updateStatus();
    };
    const up = () => {
      gesture = null; gestureEnd = null;
      try { cv.releasePointerCapture(e.pointerId); } catch {}
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      draw();
    };
    gestureEnd = up;
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  function bind() {
    /* ---- 標題列 ---- */
    $('b-file').onclick = e => {
      e.stopPropagation();
      const b = $('b-file');
      const r = b.getBoundingClientRect();
      showMenu(r.left, r.bottom + 6, [
        { label: '開啟圖片…', action: () => $('file').click() },
        { label: '貼上 JSON / JS…', kbd: 'Ctrl+V', action: () => openPaste(null, '') },
        { label: '匯入標註…', disabled: !store.has(),
          title: store.has() ? '' : '先開啟對應的圖片',
          action: () => $('filejson').click() },
        { sep: true },
        { label: '匯出目前這張…', disabled: !store.has(), action: () => setTab('export') },
        { label: `匯出全部（zip）${S.imgs.length > 1 ? `· ${S.imgs.length} 張` : ''}`, disabled: S.imgs.length < 2,
          title: S.imgs.length < 2 ? '開兩張以上圖片時可用' : '',
          action: doExportAll },
        { sep: true },
        { label: '關閉圖片…', danger: true, disabled: !store.has(),
          title: store.has() ? '' : '沒有開啟的圖片',
          action: () => requestCloseImage() },
        { label: '清除瀏覽器裡的保存資料…', danger: true,
          title: '刪掉自動保存在這個瀏覽器的圖片與標註（目前開著的不受影響，下次不再自動還原）',
          action: () => showConfirm({
            title: '清除保存資料',
            body: '會刪掉自動保存在這個瀏覽器裡的圖片與標註。目前開著的圖片不受影響，但下次開啟時不會自動還原（之後的變更仍會重新保存）。',
            buttons: [
              { label: '取消', kind: 'ghost', focus: true },
              { label: '清除', kind: 'danger', action: () => { store.clearSaved(); savePending = false; toast('已清除瀏覽器裡的保存資料'); } },
            ],
          }) },
      ], b);
    };
    $('file').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
    $('b-pixelate').onclick = openPixelate;
    $('b-pixelate2').onclick = openPixelate;

    $('info').onclick = e => {
      e.stopPropagation();
      if (S.imgs.length < 2) return;
      const chip = $('info');
      const r = chip.getBoundingClientRect();
      showMenu(r.left, r.bottom + 6, S.imgs.map((im, i) => ({
        label: `${im.name} — ${im.w}×${im.h}`,
        on: i === S.cur,
        action: () => { store.select(i); fit(); renderAll(); save_(); },
      })), chip);
    };

    $('b-undo').onclick = doUndo;
    $('b-redo').onclick = doRedo;
    $('b-hist').onclick = e => {
      e.stopPropagation();
      openHistPanel();
    };
    $('hist-close').onclick = closeHistPanel;
    // ↶ ↷ 上按右鍵也開歷史（Photoshop 慣例）
    for (const id of ['b-undo', 'b-redo']) {
      $(id).addEventListener('contextmenu', e => {
        e.preventDefault();
        if (!store.has()) return;
        if (!histOpen()) openHistPanel();
        else fillHistPanel();
      });
    }
    $('b-zin').onclick = () => zoomStep(1);
    $('b-zout').onclick = () => zoomStep(-1);
    $('b-fit').onclick = () => { S.zoomTouched = false; fit(); draw(); };
    $('b-keys').onclick = () => openDialog($('keys'));
    $('keys-close').onclick = () => closeDialog($('keys'));
    $('keys').onclick = e => { if (e.target === $('keys')) closeDialog($('keys')); };

    /* ---- 空狀態 ---- */
    $('card-open').onclick = () => $('file').click();
    $('card-paste').onclick = () => openPaste(null, '');
    $('card-pixelate').onclick = openPixelate;

    /* ---- 貼上視窗 ---- */
    $('m-close').onclick = closePaste;
    $('m-clear').onclick = () => { $('m-text').value = ''; showPasteError(''); $('m-text').focus(); };
    $('m-sample').onclick = () => {
      $('m-text').value = codec.toJs(codec.encode(
        { name: 'sample', w: 2, h: 2, rgba: codec.bitmapFromRgba(2, 2,
            Uint8ClampedArray.from([255,145,72,255, 0,0,0,0, 0,0,0,0, 70,167,88,255])).rgba },
        { parts: [], grid: new Int16Array(4) }));
      showPasteError('');
      $('m-text').focus();
    };
    $('m-ok').onclick = () => {
      const t = $('m-text').value.trim();
      if (!t) return showPasteError('請先貼上內容');
      try { const n = loadText(t); closePaste(); toast('已載入 ' + n, { kind: 'success' }); }
      catch (e) { showPasteError(e.message); }
    };
    $('modal').onclick = e => { if (e.target === $('modal')) closePaste(); };

    document.addEventListener('paste', e => {
      // 像素化視窗開著的時候，貼上的圖直接進去處理
      if (dialogOpen(pxModal())) {
        const f = imageFilesFrom(e.clipboardData)[0];
        if (f) { e.preventDefault(); pxLoadFile(f); }
        else $('px-warn').textContent = '剪貼簿裡沒有圖片';
        return;
      }
      if (e.target.matches('input, textarea')) return;
      const files = imageFilesFrom(e.clipboardData);
      if (files.length) { e.preventDefault(); addFiles(files); return; }
      const t = (e.clipboardData?.getData('text') || '').trim();
      if (!t || !/[{[]/.test(t)) return;
      e.preventDefault();
      try { const n = loadText(t); toast('已貼上 ' + n, { kind: 'success' }); }
      catch (err) { openPaste(t, err.message); }
    });

    /* ---- 像素化視窗 ---- */
    $('px-close').onclick = closePixelate;
    $('px-cancel').onclick = closePixelate;
    $('px-open').onclick = () => $('px-file').click();
    $('px-file').onchange = e => { pxLoadFile(e.target.files[0]); e.target.value = ''; };
    $('px-paste').onclick = pxPasteFromClipboard;
    $('px-abort').onclick = () => { pxAbort = true; if (PA.pixelate.cancelJobs) PA.pixelate.cancelJobs(); };

    const pxBox = pxModal().querySelector('.box');
    ['dragenter', 'dragover'].forEach(ev => pxBox.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation(); pxBox.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => pxBox.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation(); pxBox.classList.remove('over');
    }));
    pxBox.addEventListener('drop', e => {
      const f = [...(e.dataTransfer?.files || [])].find(x => /^image\//.test(x.type));
      if (f) pxLoadFile(f);
    });
    $('px-ok').onclick = applyPixelate;
    $('px-redetect').onclick = pxDetect;
    pxFillMethods();
    $('px-method').onchange = () => { pxSyncDetChecks(); pxSavePrefs(); pxDetect(); };
    if ($('px-quant')) $('px-quant').onchange = () => pxRecomputeSoon();
    if ($('px-dither')) $('px-dither').onchange = () => {
      if ($('px-dither-strength')) $('px-dither-strength').disabled = $('px-dither').value === 'none';
      pxRecomputeSoon();
    };
    if ($('px-dither-strength')) $('px-dither-strength').oninput = pxRecomputeSoon;
    if ($('px-target-w')) $('px-target-w').onchange = () => pxDetect();
    $('px-method-info').onmouseenter = () => pxShowMethodInfo(true);
    $('px-method-info').onmouseleave = () => pxShowMethodInfo(false);
    $('px-method-info').onclick = e => { e.preventDefault(); pxShowMethodInfo($('px-method-pop').classList.contains('hide')); };
    // 注意 hough 也要在這裡，否則勾了沒反應（pxReadDetectors 會讀它，但沒人觸發重新偵測）
    ['px-det-autocorr', 'px-det-runlength', 'px-det-selfsim', 'px-det-fft', 'px-det-perfecter', 'px-det-hough', 'px-det-runs', 'px-det-legacy', 'px-precise'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.onchange = () => {
        if (!$('px-method').querySelector('option[value=custom]')) {
          const o = document.createElement('option');
          o.value = 'custom'; o.textContent = '自訂組合';
          $('px-method').appendChild(o);
        }
        $('px-method').value = 'custom';
        pxSavePrefs();
        pxDetect();
      };
    });
    $('px-w').oninput = () => pxOnEdit('count', 'x');
    $('px-h').oninput = () => pxOnEdit('count', 'y');
    $('px-sx').oninput = () => pxOnEdit('size', 'x');
    $('px-sy').oninput = () => pxOnEdit('size', 'y');
    ['px-phx', 'px-phy'].forEach(id => { $(id).oninput = () => pxOnEdit('size', 'x'); });
    $('px-lock').onclick = () => { pxSetLock(!pxLockRatio, true); pxSavePrefs(); };
    pxSetLock(!!(pxReadPrefs() || {}).lockRatio, false);
    $('px-k').oninput = () => { $('px-k-range').value = Math.min(+$('px-k-range').max, Math.max(0, +$('px-k').value || 0)); pxRecomputeSoon(); };
    $('px-k-range').oninput = () => { $('px-k').value = $('px-k-range').value; pxRecomputeSoon(); };
    $('px-bg').oninput = pxRecomputeSoon;
    $('px-sample').onchange = () => { $('px-method').value === 'custom' || ($('px-method').value = $('px-method').value); pxRecomputeSoon(); };
    ['px-clean-holes', 'px-clean-specks', 'px-clean-jaggies', 'px-clean-alpha'].forEach(id => {
      const el = $(id); if (el) el.oninput = pxRecomputeSoon;
    });
    $('px-snap').oninput = () => { pxNeedError = true; pxRecomputeSoon(); };
    $('px-gridview').oninput = pxDrawSource;
    $('px-compare').oninput = pxSetView;
    $('px-split').oninput = () => { $('px-stack').style.setProperty('--split', $('px-split').value + '%'); };
    pxModal().onclick = e => { if (e.target === pxModal()) closePixelate(); };

    /* ---- 匯入標註 ---- */
    $('filejson').onchange = e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!store.has()) return toast('先開啟對應的圖片再匯入標註', { kind: 'warn' });
      const fr = new FileReader();
      fr.onload = () => {
        let d;
        try { d = JSON.parse(fr.result); } catch { return toast('JSON 解析失敗', { kind: 'danger' }); }
        if (!d.parts || !d.parts.grid) return toast('這個檔案沒有 parts.grid', { kind: 'danger' });
        const im = store.img();
        if (d.w !== im.w || d.h !== im.h)
          return toast(`尺寸不符：JSON 是 ${d.w}×${d.h}，目前圖片是 ${im.w}×${im.h} — 請先切到對應的圖片`, { kind: 'danger' });
        store.snapshot('匯入標註');
        const err = store.applyAnnotation(d);
        if (err) { store.cancelLastAction(); return toast(err, { kind: 'danger' }); }
        renderAll(); save_();
        toast('已匯入標註', { kind: 'success', action: '復原', onAction: doUndo });
      };
      fr.readAsText(f);
    };

    /* ---- 左欄 ---- */
    document.querySelectorAll('.toolbtn[data-tool]').forEach(b => { b.onclick = () => setTool(b.dataset.tool); });
    document.querySelectorAll('.modesw [data-mode]').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });

    $('brushsize').oninput = e => {
      S.brush = +e.target.value;
      $('bsval').textContent = S.brush + ' px';
      draw();
    };
    for (const [id, key] of [['v-img', 'img'], ['v-parts', 'parts'], ['v-grid', 'grid']]) {
      $(id).onclick = () => {
        vs[key] = !vs[key];
        $(id).classList.toggle('on', vs[key]);
        $(id).setAttribute('aria-pressed', String(vs[key]));
        draw();
      };
    }
    $('v-mirror').oninput = () => {
      const on = $('v-mirror').checked;
      $('mirrorrow').classList.toggle('hide', !on);
      if (on && $('mirroraxis').value === '' && store.has()) centreMirrorAxis();
      draw(); updateStatus();
    };
    $('mirroraxis').oninput = () => { draw(); updateStatus(); };
    $('mirrorcenter').onclick = () => { centreMirrorAxis(); draw(); updateStatus(); };
    $('o-alpha').oninput = e => { S.paintAlpha = e.target.checked; };

    /* ---- 顏色分頁 ---- */
    $('drawcolor').oninput = e => setDrawColour(e.target.value);
    $('drawcolor').onchange = () => pushRecent(drawColor);
    $('drawhex').onchange = () => {
      let v = $('drawhex').value.trim().replace(/^#?/, '#');
      if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
        if (v.length === 4) v = '#' + [...v.slice(1)].map(c => c + c).join('');
        setDrawColour(v.toLowerCase()); pushRecent(drawColor);
      } else $('drawhex').value = drawColor;
    };
    $('prevcolor').onclick = () => { if (prevColor) setDrawColour(prevColor); };
    $('b-swapcolor').onclick = () => { if (prevColor) setDrawColour(prevColor); };

    /* ---- 部件分頁 ---- */
    $('b-addpart').onclick = addTyped;
    $('newpart').onkeydown = e => {
      // 不能 stopPropagation：Esc 要交給全域處理（失焦回畫布），其餘快捷鍵全域會因為焦點在輸入框而略過
      if (e.key === 'Enter') { e.preventDefault(); addTyped(); }
    };
    $('newpart').addEventListener('focus', updateStatus);
    $('newpart').addEventListener('blur', updateStatus);
    $('b-clear').onclick = clearAnnotations;
    $('b-hilite').onclick = () => {
      hiliteUntil = Date.now() + 3000;
      draw();
      setTimeout(() => draw(), 3100);
    };

    /* ---- 圖片分頁 ---- */
    $('b-addimg').onclick = () => $('file').click();

    /* ---- 匯出分頁 ---- */
    for (const f of ['png', 'svg', 'json', 'js']) {
      $(`b-dl-${f}`).onclick = () => doDownload(f);
      $(`b-cp-${f}`).onclick = () => doCopy(f);
    }
    $('b-dl-all').onclick = doExportAll;
    $('scalesegs').querySelectorAll('button').forEach(b => {
      b.onclick = () => { pngScale = +b.dataset.s; syncScale(); };
    });

    /* ---- 右欄分頁 / 收合 ---- */
    document.querySelectorAll('[data-tab]').forEach(b => {
      b.onclick = () => setTab(b.dataset.tab, true);
    });
    // 分頁列只有一個 tab stop，← → 在分頁間移動（APG tabs pattern）
    document.querySelector('.tabbar').addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      const tabs = [...document.querySelectorAll('.tabbar [data-tab]')];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
              : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setTab(tabs[j].dataset.tab, true);
      tabs[j].focus();
    });
    $('b-collapse').onclick = () => toggleAside();
    $('b-expand').onclick = () => toggleAside(false);

    /* ---- 裁切列 ---- */
    ['crop-x', 'crop-y', 'crop-w', 'crop-h'].forEach(id => {
      $(id).addEventListener('input', () => readCropBar(true));
      $(id).addEventListener('change', () => readCropBar(false));
    });
    $('crop-all').onclick = () => { store.cropWholeImage(); syncCropBar(); draw(); };
    $('crop-apply').onclick = doCrop;
    $('crop-cancel').onclick = () => setTool(mode === 'draw' ? 'draw' : 'brush');

    /* ---- 行動版：底部工具列、抽屜、遮罩（桌面這些元素都 display:none，綁了也不會被觸發） ---- */
    $('d-fit').onclick = () => { if (!store.has()) return; S.zoomTouched = false; fit(); draw(); updateStatus(); };
    $('d-more').onclick = () => railOpen() ? closeSheets() : openRailSheet();
    $('d-panel').onclick = () => asideOpen() ? closeSheets() : openAsideSheet();
    $('scrim').onclick = closeSheets;
    document.querySelectorAll('.sheethandle').forEach(h => { h.onclick = closeSheets; });

    /* ---- 縮圖列收合 ---- */
    $('b-strip').onclick = () => toggleStrip();

    /* ---- 拖放：任何位置都可以放 ---- */
    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => {
      if (dialogOpen(pxModal())) return;    // 像素化視窗有自己的拖放
      e.preventDefault();
      stage.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
      if (dialogOpen(pxModal())) return;
      e.preventDefault();
      if (ev === 'dragleave' && e.relatedTarget) return;  // 在視窗內移動不算離開
      stage.classList.remove('over');
    }));
    document.addEventListener('drop', e => {
      if (dialogOpen(pxModal())) return;
      addFiles(e.dataTransfer.files);
    });

    /* ---- 鍵盤地圖 ---- */
    document.addEventListener('keydown', e => {
      // 對話框優先，各自處理 Esc / Tab / Enter
      const dlg = $('confirm'), keys = $('keys'), modal = $('modal');
      if (dialogOpen(dlg)) {
        if (e.key === 'Escape') closeDialog(dlg);
        trapTab(e, dlg.querySelector('.box'));
        return;
      }
      if (dialogOpen(keys)) {
        if (e.key === 'Escape' || e.key === '?') closeDialog(keys);
        trapTab(e, keys.querySelector('.box'));
        return;
      }
      if (dialogOpen(pxModal())) {
        if (e.key === 'Escape') { pxBusy ? (pxAbort = true) : closePixelate(); }
        trapTab(e, pxModal().querySelector('.box'));
        return;
      }
      if (dialogOpen(modal)) {
        if (e.key === 'Escape') closePaste();
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('m-ok').click();
        trapTab(e, modal.querySelector('.box'));
        return;
      }
      if (menuOpen()) {
        if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(); if (e.key === 'Escape') return; }
        // 焦點在選單項目上時，Enter / Space 是「選這一項」，不能落到下面的快捷鍵（例如裁切的 Enter）
        else if (menuEl && menuEl.contains(e.target)) return;
      }
      if (histOpen() && e.key === 'Escape') { closeHistPanel(); return; }
      // 行動版（外接鍵盤）：Esc 先關抽屜
      if (e.key === 'Escape' && isMobile() && (railOpen() || asideOpen()) &&
          !(e.target instanceof Element && e.target.matches('input, textarea'))) {
        return closeSheets();
      }

      // 輸入框裡：Esc = 失焦回畫布，其餘快捷鍵不作用
      if (e.target instanceof Element && e.target.matches('input, textarea')) {
        if (e.key === 'Escape') { e.target.blur(); e.preventDefault(); }
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;
      // 滑鼠還按著就按 Ctrl+Z：先把這一筆收掉，否則接下來的拖曳會落在復原堆疊之外
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (drawing) finishStroke(); return doUndo(); }
      if ((ctrl && e.shiftKey && e.key.toLowerCase() === 'z') || (ctrl && e.key.toLowerCase() === 'y')) {
        e.preventDefault(); if (drawing) finishStroke(); return doRedo();
      }
      if (e.key === 'Escape' && S.tool === 'crop') return setTool(mode === 'draw' ? 'draw' : 'brush');
      if (e.key === 'Enter' && S.tool === 'crop') { e.preventDefault(); return doCrop(); }

      if (e.key === ' ') {
        // 焦點在按鈕上時 Space 本來就是「按下去」，不要搶過來當平移
        if (e.target instanceof Element && e.target.closest('button')) return;
        e.preventDefault();
        if (!e.repeat) { spaceHeld = true; stage.classList.add('spacepan'); }
        return;
      }
      // Tab 收合右欄只在「沒有任何控制項聚焦」時生效：焦點在 body，或在畫布區但是用滑鼠點上去的
      //（#stage 有 tabindex 讓鍵盤到得了；滑鼠點畫布也會把焦點放到它身上，此時沒有 :focus-visible）。
      // 焦點在按鈕上、或是用鍵盤 Tab 進畫布區時，Tab 要留給瀏覽器做焦點導覽，否則鍵盤使用者會被困住
      if (e.key === 'Tab') {
        const ae = document.activeElement;
        const free = ae === document.body || (ae === stage && !stage.matches(':focus-visible'));
        if (free) { e.preventDefault(); return toggleAside(); }
        return;
      }
      if (e.key === '?') return openDialog(keys);

      if (e.key.toLowerCase() === 'h' && !e.repeat && !ctrl) {
        hHold = true; draw(); return;
      }
      if (e.key === '[' || e.key === ']') {
        const d = e.key === '[' ? -1 : 1;
        S.brush = Math.max(1, Math.min(6, S.brush + d));
        $('brushsize').value = S.brush;
        $('bsval').textContent = S.brush + ' px';
        draw(); updateStatus();
        return;
      }
      if (e.key === '+' || e.key === '=') return zoomStep(1);
      if (e.key === '-') return zoomStep(-1);
      if (e.key === '0') { S.zoomTouched = false; fit(); draw(); return; }

      if (e.key === 'Delete' && mode === 'annotate' && S.activePart) {
        return deletePartWithUndo(S.activePart);
      }
      if (e.key === 'F2' && mode === 'annotate' && S.activePart) {
        const row = $('parts').querySelector(`.part[data-id="${S.activePart}"] .nm`);
        const p = store.partById(S.activePart);
        if (row && p) startRename(row, p);
        return;
      }

      const t = { b: 'brush', w: 'wand', s: 'same', e: 'erase', c: 'crop',
                  d: 'draw', i: 'pick', x: 'epix' }[e.key.toLowerCase()];
      if (t && !ctrl) return setTool(t);

      if (mode === 'annotate' && store.has() && /^[1-9]$/.test(e.key)) {
        const p = store.annot().parts[+e.key - 1];
        if (p) { store.setActive(p.id); renderParts(); draw(); updateHud(); }
      }
    });

    document.addEventListener('keyup', e => {
      if (e.key === ' ') { spaceHeld = false; stage.classList.remove('spacepan'); }
      if (e.key === 'h' || e.key === 'H') { hHold = false; if (store.has()) draw(); }
    });
    // 按住 Space / H 時視窗失焦（Alt+Tab）永遠等不到 keyup：失焦就放開，畫布才不會卡在平移 / 只看原圖
    window.addEventListener('blur', () => {
      if (spaceHeld) { spaceHeld = false; stage.classList.remove('spacepan'); }
      if (hHold) { hHold = false; if (store.has()) draw(); }
      if (drawing) finishStroke();
      if (gestureEnd) gestureEnd();
      flushSave();
    });

    /* ---- HUD：點擊 = 開快選（再點一次 = 關） ---- */
    $('hud').onclick = e => {
      e.stopPropagation();
      const r = $('hud').getBoundingClientRect();
      openQuickMenu(r.left, r.bottom + 6, $('hud'));
    };

    /* ---- 視窗大小改變 ---- */
    // 用 rAF 延到排版穩定後再量 —— 斷點切換的當下量到的會是舊版面的尺寸
    let resizeRaf = 0;
    let lastMobile = isMobile();
    const onResize = () => {
      resizeRaf = 0;
      // 跨越 900px 斷點：matchMedia 的 change 事件是主要路徑，這裡多一道保險
      if (isMobile() !== lastMobile) { lastMobile = isMobile(); applyMobileMode(lastMobile); }
      if (!store.has()) return;
      // 行動版：虛擬鍵盤彈出也算 resize，打字中不要動畫布倍率
      if (isMobile() && document.activeElement && document.activeElement.matches('input, textarea')) return;
      // 使用者動過縮放前持續自動貼合；動過之後只在會溢出時往下夾，保住他選的倍率
      if (!S.zoomTouched) fit();
      else { const b = stageBox(); setZoom(render.clampZoom(b.w, b.h)); }
      draw();
      settleZoom();
      updateStatus();
    };
    window.addEventListener('resize', () => {
      if (!resizeRaf) resizeRaf = requestAnimationFrame(onResize);
    });
  }

  function init() {
    cv = $('cv');
    stage = $('stage');
    render.init(cv);
    bindCanvas();
    bindPan();
    bindTouch();
    bind();
    applyMobileMode(isMobile());   // 行動版：抽屜預設收起；桌面：無作用
    renderAll();
    store.restore((ok, info = {}) => {
      if (info.corrupt) toast('上次保存的資料已損毀，無法還原（已清除）', { kind: 'danger', duration: 8000 });
      if (!ok) return;
      fit();
      renderAll();
      // 版面在第一次繪製後才會完全穩定（字型、捲軸），下一個影格再貼合一次保險
      requestAnimationFrame(() => { if (store.has() && !S.zoomTouched) { fit(); draw(); } });
      const when = info.savedAt ? new Date(info.savedAt).toLocaleString() : '';
      if (info.stale) {
        // 上一個工作階段有變更因為配額不足沒能存進來：還原的是較舊的版本，要講清楚
        toast(`已還原 ${when} 保存的版本 — 之後的變更因瀏覽器儲存空間不足未能保存`, { kind: 'warn', duration: 10000 });
      } else if (info.migrated) {
        toast('已從舊版資料還原上次的標註', { kind: 'success' });
      } else {
        toast('已還原上次的標註' + (when ? `（${when}）` : ''), { kind: 'success' });
      }
      if (info.failed && info.failed.length)
        toast(`有 ${info.failed.length} 張圖無法還原：${info.failed.join('、')}`, { kind: 'warn', duration: 8000 });
      if (info.warnings && info.warnings.length)
        toast(info.warnings.join('；'), { kind: 'warn', duration: 8000 });
      // 舊版鍵遷移過來之後立刻以新格式寫一份，之後就走 pixann.v2
      if (info.migrated) { save_(); flushSave(); }
    });
  }

  return { init, toast, renderAll, renderParts, draw, loadText, addFiles, flushSave };
})();
