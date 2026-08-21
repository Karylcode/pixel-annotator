/* ui — DOM 與事件 orchestrator。子控制器見 js/ui/。 */
window.PA = window.PA || {};

PA.ui = (() => {
  const store = PA.store, render = PA.render, codec = PA.codec;
  const S = store.state;
  const $ = id => document.getElementById(id);

  const host = { store, render, codec, pixelate: PA.pixelate, S, $ };

  const overlays = PA._ui.createOverlays(host);
  const { toast, download, copyText, showMenu, closeMenu, menuOpen, openDialog, closeDialog, trapTab, dialogOpen, showConfirm } = overlays;
  host.toast = toast;
  host.download = download;
  host.copyText = copyText;
  host.openDialog = openDialog;
  host.closeDialog = closeDialog;
  host.showMenu = showMenu;
  host.closeMenu = closeMenu;

  const persistence = PA._ui.createPersistence(host);
  host.markDirty = () => persistence.markDirty();
  const save_ = () => persistence.markDirty();
  function flushSave() { persistence.flush(); }

  const exportCtrl = PA._ui.createExport(host);

  const pixelateDlg = PA._ui.createPixelateDialog(host);
  host.openPixelate = (...a) => pixelateDlg.openPixelate(...a);

  const canvas = PA._ui.createCanvasInput(host);

  /* 暫時隱藏標註：只改 annotationEnabled 即可切換，不必再改 HTML。
     false 關閉所有前台入口並保留資料；true 完整恢復標註介面。
     HTML 的 draw / annotate=off 預設只避免 JS 載入前閃現。 */
  const annotationEnabled = false;
  host.annotationEnabled = annotationEnabled;

  /* ---------- 圖示 ---------- */
  const SVG_EYE = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/></svg>';
  const SVG_EYE_OFF = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l10 10M6.6 4.7A6.9 6.9 0 018 4.5c4.1 0 6.5 3.5 6.5 3.5a12.4 12.4 0 01-2.1 2.5M9.9 11.2A6.6 6.6 0 018 11.5C3.9 11.5 1.5 8 1.5 8a12.6 12.6 0 012.4-2.7"/></svg>';
  const SVG_GRIP = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="6" cy="3.5" r="1.3"/><circle cx="10" cy="3.5" r="1.3"/><circle cx="6" cy="8" r="1.3"/><circle cx="10" cy="8" r="1.3"/><circle cx="6" cy="12.5" r="1.3"/><circle cx="10" cy="12.5" r="1.3"/></svg>';

  let cv, stage;
  /* ---------- 模式與工具 ---------- */
  let mode = annotationEnabled ? 'annotate' : 'draw';
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
  const view = () => ({
    image: vs.img,
    parts: annotationEnabled && mode === 'annotate' && vs.parts && !hHold,
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
  const setSwatch = (el, hex) => { if (hex && /^#[0-9a-f]{6}$/.test(hex)) el.style.background = hex; };

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
    if (prevColor) setSwatch($('prevcolor'), prevColor);
    else $('prevcolor').style.background = 'transparent';
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
      setSwatch(b, hex);
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
      setSwatch(b, hex);
      b.dataset.hex = hex;
      b.title = hex;
      if (hex === drawColor) b.classList.add('on');
      b.onclick = () => setDrawColour(hex);
      box.appendChild(b);
    }
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
      setSwatch(sw, p.color);
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
          const c = store.partById(p.id).color;
          if (/^#[0-9a-f]{6}$/.test(c)) sw.style.background = c;
          scheduleDraw();
        };
        inp.onchange = () => {
          store.setPartColor(p.id, inp.value);
          const c = store.partById(p.id).color;
          if (/^#[0-9a-f]{6}$/.test(c)) sw.style.background = c;
          draw(); updateHud(); save_();
        };
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
      setSwatch(si, p.color);
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
      sub.textContent = annotationEnabled
        ? `${im.w}×${im.h} · 已標註 ${coverageOf(im)}%`
        : `${im.w}×${im.h}`;
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
      const pname = annotationEnabled && id ? (store.partById(id)?.name || id) : null;
      left += `${x}, ${y} · <span class="stsw" style="background:${rgb2hex(px)}"></span> ${px[3] < 8 ? '透明' : rgb2hex(px)}`;
      if (pname) left += ` · ${esc(pname)}`;
      if (annotationEnabled && PREVIEW_TOOLS.has(S.tool) && preview) left += ` · 會選到 ${preview.count.toLocaleString()} 格`;
      left += ' │ ';
    }
    left += `${S.zoom}× │ 筆刷 ${S.brush}px`;
    if (annotationEnabled) left += ` │ 已標註 ${c.pct}%`;
    if (mode === 'draw' && $('v-mirror').checked)
      left += ` │ 不對稱 ${render.mirrorDiff().toLocaleString()} 格（軸 ${currentAxis()}）`;
    left += ` │ ${persistence.saveState === 'foreign' ? '⚠ 另一分頁較新，未保存' : persistence.saveState === 'fail' ? '⚠ 未能保存' : persistence.savePending ? '保存中…' : '已保存 ✓'}`;
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
        setSwatch(sw, p.color);
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
      setSwatch(sw, drawColor);
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
    canvas.syncCropBar();
    invalidatePreview();
    if (has) draw();
    renderParts();
    renderSummary();
    renderStrip();
    renderImages();
    renderPalette();
    exportCtrl.syncExport();
    updateHud();
    updateStatus();
    fillHistPanel();
    if (has) settleZoom();
  }
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
    if (warning) toast(publicDataMessage(warning), { kind: 'warn' });
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
  /* ---------- 右鍵快選選單 ---------- */

  function openQuickMenu(x, y, invoker) {
    const items = [];
    if (annotationEnabled && mode === 'annotate') {
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
    items.push({ label: '影像：像素化…', action: pixelateDlg.openPixelate });
    if (isMobile()) {
      // 手機的標題列沒有縮放鈕，貼合放這裡（也可以在空白處點兩下）
      items.push({ sep: true });
      items.push({ label: `⛶ 貼合視窗（目前 ${S.zoom}×）`, action: () => { S.zoomTouched = false; fit(); draw(); updateStatus(); } });
    }
    showMenu(x, y, items, invoker);
  }
  /* ═══════════ 模式 / 工具 / 分頁 ═══════════ */

  const tabFor = { annotate: 'parts', draw: 'colors' };   // 依模式記住使用者手動切的分頁

  function visibleTabButtons() {
    return [...document.querySelectorAll('.tabbar [data-tab]')]
      .filter(b => annotationEnabled || b.dataset.tab !== 'parts');
  }

  function publicDataMessage(message) {
    if (annotationEnabled) return String(message ?? '');
    return String(message ?? '')
      .replace(/parts\.grid 有 (.+?) 格，與 (\d+×\d+) 不符，已略過標註/g,
        '附加資料有 $1 格，與圖片 $2 不符，已略過')
      .replace(/（標註與圖片尺寸不符，已略過）/g, '（附加資料與圖片尺寸不符，已略過）')
      .replace(/parts\.grid/g, '附加資料')
      .replace(/標註/g, '附加資料')
      .replace(/部件/g, '資料項目');
  }

  function applyAnnotationGate() {
    document.body.dataset.annotate = annotationEnabled ? 'on' : 'off';
    if (annotationEnabled) {
      $('x-data-label').textContent = '資料（含部件標註）';
      $('d-panel').title = '部件 / 顏色 / 圖片 / 匯出';
      $('v-img').title = '原圖（按住 H 暫時只看原圖）';
      if ($('k-alt-hint')) $('k-alt-hint').textContent = '吸取部件 / 顏色';
      applyMode('annotate');
      setTool('brush');
      setTab('parts', true, false);
      return;
    }
    $('x-data-label').textContent = '資料';
    $('d-panel').title = '顏色 / 圖片 / 匯出';
    $('v-img').title = '原圖';
    if ($('k-alt-hint')) $('k-alt-hint').textContent = '吸取顏色';
    applyMode('draw');
    setTool('draw');
    setTab('colors', true, false);
  }

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
    if (!annotationEnabled && m === 'annotate') return;
    if (mode === m) return;
    applyMode(m);
    setTool(m === 'draw' ? 'draw' : 'brush');
    setTab(tabFor[m], true, !isMobile());   // 行動版：切模式不要每次都把抽屜彈出來
  }

  function setTool(t) {
    // 筆畫或手勢進行中按了快捷鍵：先把它結束掉，不能讓同一筆在新工具下繼續（會逃出它的復原快照）
    if (canvas.drawing) canvas.finishStroke();
    if (canvas.gestureEnd) canvas.gestureEnd();
    if (!annotationEnabled && ANNOTATE_TOOLS.includes(t)) {
      if (ANNOTATE_TOOLS.includes(S.tool)) t = 'draw';
      else return;
    }
    const need = modeOf(t);
    if (!annotationEnabled && need === 'annotate') return;
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
    canvas.syncCropBar();
    invalidatePreview();
    draw(); updateHud(); updateStatus();
  }

  // reveal=false：只切分頁，不把收合中的右欄展開（行動版切模式 / 工具時用）
  function setTab(name, manual = true, reveal = true) {
    if (!annotationEnabled && name === 'parts') name = 'colors';
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
    const fmtOk = im.w <= exportCtrl.TEXT_FMT_MAX && im.h <= exportCtrl.TEXT_FMT_MAX;
    showConfirm({
      title: '關閉圖片',
      body: annotationEnabled
        ? `「${im.name}」有 ${c.annotated.toLocaleString()} 格標註，關閉後無法復原。可以先下載 JSON 保留標註，之後再匯入。`
        : `「${im.name}」含有附加資料，關閉後無法復原。可以先下載 JSON 保留工作資料，之後再匯入。`,
      buttons: [
        { label: '取消', kind: 'ghost', focus: true },
        { label: '關閉', kind: 'danger', action: close },
        ...(fmtOk ? [{
          label: '下載 JSON 後關閉', kind: 'primary',
          action: () => { if (idx !== S.cur) { store.select(idx); renderAll(); } exportCtrl.doDownload('json'); close(); },
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
  function bind() {
    pixelateDlg.bind();
    exportCtrl.bind();
    /* ---- 標題列 ---- */
    $('b-file').onclick = e => {
      e.stopPropagation();
      const b = $('b-file');
      const r = b.getBoundingClientRect();
      showMenu(r.left, r.bottom + 6, [
        { label: '開啟圖片…', action: () => $('file').click() },
        { label: '貼上 JSON / JS…', kbd: 'Ctrl+V', action: () => openPaste(null, '') },
        ...(annotationEnabled ? [{ label: '匯入標註…', disabled: !store.has(),
          title: store.has() ? '' : '先開啟對應的圖片',
          action: () => $('filejson').click() }] : []),
        { sep: true },
        { label: '匯出目前這張…', disabled: !store.has(), action: () => setTab('export') },
        { label: `匯出全部（zip）${S.imgs.length > 1 ? `· ${S.imgs.length} 張` : ''}`, disabled: S.imgs.length < 2,
          title: S.imgs.length < 2 ? '開兩張以上圖片時可用' : '',
          action: exportCtrl.doExportAll },
        { sep: true },
        { label: '關閉圖片…', danger: true, disabled: !store.has(),
          title: store.has() ? '' : '沒有開啟的圖片',
          action: () => requestCloseImage() },
        { label: '清除瀏覽器裡的保存資料…', danger: true,
          title: annotationEnabled
            ? '刪掉自動保存在這個瀏覽器的圖片與標註（目前開著的不受影響，下次不再自動還原）'
            : '刪掉自動保存在這個瀏覽器的圖片與工作資料（目前開著的不受影響，下次不再自動還原）',
          action: () => showConfirm({
            title: '清除保存資料',
            body: annotationEnabled
              ? '會刪掉自動保存在這個瀏覽器裡的圖片與標註。目前開著的圖片不受影響，但下次開啟時不會自動還原（之後的變更仍會重新保存）。'
              : '會刪掉自動保存在這個瀏覽器裡的圖片與工作資料。目前開著的圖片不受影響，但下次開啟時不會自動還原（之後的變更仍會重新保存）。',
            buttons: [
              { label: '取消', kind: 'ghost', focus: true },
              { label: '清除', kind: 'danger', action: async () => {
                const r = await persistence.clear();
                if (r && r.ok) toast('已清除瀏覽器裡的保存資料');
                else toast('未能完全清除保存資料' + (r && r.reason ? '（' + r.reason + '）' : ''), { kind: 'warn' });
              } },
            ],
          }) },
      ], b);
    };
    $('file').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
    $('b-pixelate').onclick = pixelateDlg.openPixelate;
    $('b-pixelate2').onclick = pixelateDlg.openPixelate;

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
    $('card-pixelate').onclick = pixelateDlg.openPixelate;

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
      if (dialogOpen(pixelateDlg.modal())) {
        const f = pixelateDlg.imageFilesFrom(e.clipboardData)[0];
        if (f) { e.preventDefault(); pixelateDlg.pxLoadFile(f); }
        else $('px-warn').textContent = '剪貼簿裡沒有圖片';
        return;
      }
      if (e.target.matches('input, textarea')) return;
      const files = pixelateDlg.imageFilesFrom(e.clipboardData);
      if (files.length) { e.preventDefault(); addFiles(files); return; }
      const t = (e.clipboardData?.getData('text') || '').trim();
      if (!t || !/[{[]/.test(t)) return;
      e.preventDefault();
      try { const n = loadText(t); toast('已貼上 ' + n, { kind: 'success' }); }
      catch (err) { openPaste(t, err.message); }
    });
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
        const { error, warnings } = store.applyAnnotation(d);
        if (error) { store.cancelLastAction(); return toast(error, { kind: 'danger' }); }
        renderAll(); save_();
        const extra = warnings && warnings.length ? '（' + warnings.join('；') + '）' : '';
        toast('已匯入標註' + extra, { kind: 'success', action: '復原', onAction: doUndo });
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

    /* ---- 右欄分頁 / 收合 ---- */
    document.querySelectorAll('[data-tab]').forEach(b => {
      b.onclick = () => setTab(b.dataset.tab, true);
    });
    // 分頁列只有一個 tab stop，← → 在分頁間移動（APG tabs pattern）
    document.querySelector('.tabbar').addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      const tabs = visibleTabButtons();
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
      $(id).addEventListener('input', () => canvas.readCropBar(true));
      $(id).addEventListener('change', () => canvas.readCropBar(false));
    });
    $('crop-all').onclick = () => { store.cropWholeImage(); canvas.syncCropBar(); draw(); };
    $('crop-apply').onclick = () => canvas.doCrop();
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
      if (dialogOpen(pixelateDlg.modal())) return;    // 像素化視窗有自己的拖放
      e.preventDefault();
      stage.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
      if (dialogOpen(pixelateDlg.modal())) return;
      e.preventDefault();
      if (ev === 'dragleave' && e.relatedTarget) return;  // 在視窗內移動不算離開
      stage.classList.remove('over');
    }));
    document.addEventListener('drop', e => {
      if (dialogOpen(pixelateDlg.modal())) return;
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
      if (dialogOpen(pixelateDlg.modal())) {
        if (e.key === 'Escape') { pixelateDlg.busy ? (pixelateDlg.abort()) : pixelateDlg.closePixelate(); }
        trapTab(e, pixelateDlg.modal().querySelector('.box'));
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
        else if (overlays.menuEl && overlays.menuEl.contains(e.target)) return;
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
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (canvas.drawing) canvas.finishStroke(); return doUndo(); }
      if ((ctrl && e.shiftKey && e.key.toLowerCase() === 'z') || (ctrl && e.key.toLowerCase() === 'y')) {
        e.preventDefault(); if (canvas.drawing) canvas.finishStroke(); return doRedo();
      }
      if (e.key === 'Escape' && S.tool === 'crop') return setTool(mode === 'draw' ? 'draw' : 'brush');
      if (e.key === 'Enter' && S.tool === 'crop') { e.preventDefault(); return canvas.doCrop(); }

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
        if (!annotationEnabled) return;
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

      if (e.key === 'Delete' && annotationEnabled && mode === 'annotate' && S.activePart) {
        return deletePartWithUndo(S.activePart);
      }
      if (e.key === 'F2' && annotationEnabled && mode === 'annotate' && S.activePart) {
        const row = $('parts').querySelector(`.part[data-id="${S.activePart}"] .nm`);
        const p = store.partById(S.activePart);
        if (row && p) startRename(row, p);
        return;
      }

      const t = { b: 'brush', w: 'wand', s: 'same', e: 'erase', c: 'crop',
                  d: 'draw', i: 'pick', x: 'epix' }[e.key.toLowerCase()];
      if (t && !ctrl) {
        if (!annotationEnabled && ANNOTATE_TOOLS.includes(t)) return;
        return setTool(t);
      }

      if (annotationEnabled && mode === 'annotate' && store.has() && /^[1-9]$/.test(e.key)) {
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
      if (canvas.drawing) canvas.finishStroke();
      if (canvas.gestureEnd) canvas.gestureEnd();
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

  function wireHost() {
    host.cv = cv; host.stage = stage;
    const live = (key, get, set) => Object.defineProperty(host, key, { get, set, configurable: true });
    live('mode', () => mode, v => { mode = v; });
    live('spaceHeld', () => spaceHeld, v => { spaceHeld = v; });
    live('hoverCell', () => hoverCell, v => { hoverCell = v; });
    live('preview', () => preview, v => { preview = v; });
    live('drawColor', () => drawColor, v => { drawColor = v; });
    Object.assign(host, {
      PIXEL_TOOLS, ANNOTATE_TOOLS, TOOL_NAMES, PREVIEW_TOOLS,
      draw, scheduleDraw, schedulePanelCounts, renderAll, renderParts,
      updateHud, updateStatus, setDrawColour, pushRecent, setTool, setTab, doUndo,
      schedulePreview, cancelPreviewTimer, invalidatePreview, openQuickMenu,
      currentAxis, isMobile, zoomStep, stageBox, fit, relayout, hex2rgb, rgb2hex,
      histOpen, histPanel, closeHistPanel,
    });
  }

  function init() {
    cv = $('cv');
    stage = $('stage');
    wireHost();
    render.init(cv);
    canvas.attach();
    bind();
    applyAnnotationGate();
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
        toast(annotationEnabled ? '已從舊版資料還原上次的標註' : '已從舊版資料還原上次的工作資料', { kind: 'success' });
      } else {
        toast((annotationEnabled ? '已還原上次的標註' : '已還原上次的工作資料') + (when ? `（${when}）` : ''), { kind: 'success' });
      }
      if (info.failed && info.failed.length)
        toast(publicDataMessage(`有 ${info.failed.length} 張圖無法還原：${info.failed.join('、')}`), { kind: 'warn', duration: 8000 });
      if (info.warnings && info.warnings.length)
        toast(publicDataMessage(info.warnings.join('；')), { kind: 'warn', duration: 8000 });
      // 舊版鍵遷移過來之後立刻以新格式寫一份，之後就走 pixann.v2
      if (info.migrated) { save_(); flushSave(); }
    });
  }

  return { init, toast, renderAll, renderParts, draw, loadText, addFiles, flushSave };
})();