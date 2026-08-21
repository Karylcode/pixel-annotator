/* ui/canvas-input — 筆畫、裁切手勢、平移、觸控縮放與 pointer lifecycle。不得呼叫 PA.ui。 */
window.PA = window.PA || {};
PA._ui = PA._ui || {};

PA._ui.createCanvasInput = function(host) {
  const $ = id => host.$(id);
  const store = host.store, render = host.render, S = host.S;
  const toast = (...a) => host.toast(...a);
  const save_ = () => host.markDirty();
  const draw = () => host.draw();
  const scheduleDraw = () => host.scheduleDraw();
  const schedulePanelCounts = () => host.schedulePanelCounts();
  const renderAll = () => host.renderAll();
  const renderParts = () => host.renderParts();
  const updateHud = () => host.updateHud();
  const updateStatus = () => host.updateStatus();
  const setDrawColour = (...a) => host.setDrawColour(...a);
  const pushRecent = (...a) => host.pushRecent(...a);
  const closeMenu = () => host.closeMenu();
  const setTool = (...a) => host.setTool(...a);
  const setTab = (...a) => host.setTab(...a);
  const openPixelate = (...a) => host.openPixelate(...a);
  const doUndo = (...a) => host.doUndo(...a);
  const schedulePreview = () => host.schedulePreview();
  const cancelPreviewTimer = () => host.cancelPreviewTimer();
  const invalidatePreview = () => host.invalidatePreview();
  const openQuickMenu = (...a) => host.openQuickMenu(...a);
  const currentAxis = () => host.currentAxis();
  const isMobile = () => host.isMobile();
  const zoomStep = (...a) => host.zoomStep(...a);
  const stageBox = () => host.stageBox();
  const fit = () => host.fit();
  const relayout = () => host.relayout();
  const hex2rgb = (...a) => host.hex2rgb(...a);
  const rgb2hex = (...a) => host.rgb2hex(...a);
  let cv, stage;

  let drawing = false, lastPx = null, lastStrokeEnd = null;
  let strokeSnap = false;
  let strokePointer = null;
  let gesture = null;
  let gestureEnd = null;
  const touchDown = new Map();
  let touchGesture = null;
  const touchGestureActive = () => touchGesture !== null;
  const touchCount = () => touchDown.size;

  function bindCanvas() {
    cv.addEventListener('pointerdown', e => {
      if (!store.has()) return;
      if (host.spaceHeld) return;   // Space+左鍵 = 平移，交給 stage
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
        if (host.annotationEnabled && host.mode === 'annotate') {
          const id = store.annot().grid[store.idx(x, y)];
          if (id) { store.setActive(id); renderParts(); updateHud(); draw(); }
          else toast('這一格沒有標註');
        } else {
          const c = store.pixelAt(x, y);
          if (c[3] < 8) return toast('這一格是透明的');
          setDrawColour(rgb2hex(c)); pushRecent(host.drawColor); updateHud();
        }
        return;
      }

      if (host.PIXEL_TOOLS.has(S.tool)) {
        if (S.tool === 'pick') {
          const c = store.pixelAt(x, y);
          if (c[3] < 8) return toast('這一格是透明的');
          setDrawColour(rgb2hex(c)); pushRecent(host.drawColor); updateHud();
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
        if (S.tool === 'draw') pushRecent(host.drawColor);   // 真的用到的顏色才進「最近用色」
        // Shift+點：從上一個筆畫端點畫直線（像素畫慣例）
        if (e.shiftKey && lastStrokeEnd) paintLine(lastStrokeEnd, [x, y]);
        paintPixelAt(x, y);
        lastStrokeEnd = [x, y];
        draw();
        return;
      }

      if (!host.annotationEnabled) return;

      const v = S.tool === 'erase' ? 0 : S.activePart;
      if (!v && S.tool !== 'erase') {
        toast(store.annot().parts.length ? '先點選一個部件' : '先新增一個部件', { kind: 'warn' });
        return;
      }
      // 到這裡只剩標註工具
      if (S.tool === 'wand') {
        store.snapshot(host.TOOL_NAMES[S.tool]);
        store.floodSameColour(x, y, v);
        renderAll(); save_();
        return;
      }
      if (S.tool === 'same') {
        store.snapshot(host.TOOL_NAMES[S.tool]);
        store.allSameColour(x, y, v);
        renderAll(); save_();
        return;
      }
      try { cv.setPointerCapture(e.pointerId); } catch {}
      // 標註稀疏 diff：筆刷 / 擦除只記改到的格
      store.beginStroke(host.TOOL_NAMES[S.tool]);
      strokeSnap = true;
      drawing = true;
      strokePointer = e.pointerId;
      document.body.classList.add('interacting');
      lastPx = [x, y];
      if (e.shiftKey && lastStrokeEnd)
        store.strokeTo(lastStrokeEnd[0], lastStrokeEnd[1], x, y, v);
      store.brushAt(x, y, v);
      lastStrokeEnd = [x, y];
      draw();
      schedulePanelCounts();
    });

    cv.addEventListener('pointermove', e => {
      if (!store.has()) return;
      const [x, y] = render.pxAt(e);
      const inside = store.inBounds(x, y);
      const next = inside ? [x, y] : null;
      const changed = (next === null) !== (host.hoverCell === null) || (next && (host.hoverCell[0] !== x || host.hoverCell[1] !== y));
      host.hoverCell = next;
      const busy = drawing || gesture;
      if (changed) {
        if (host.PREVIEW_TOOLS.has(S.tool) && !busy) schedulePreview();
        // 筆刷輪廓跟著游標：合併到下一個影格畫一次就好；狀態列的 coverage 現在是 O(1)
        scheduleDraw(); updateStatus();
        if (isMobile()) updateHud();
      }

      // 裁切工具的游標形狀跟著把手走
      if (S.tool === 'crop' && !busy) {
        const [cx, cy] = render.canvasPosAt(e);
        const zone = render.cropHitTest(S.crop, S.zoom, cx, cy);
        cv.style.cursor = render.CROP_CURSORS[zone] || 'crosshair';
      } else if (!busy && host.mode === 'draw') {
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
        if (host.PIXEL_TOOLS.has(S.tool)) {
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
      host.hoverCell = null;
      host.preview = null;
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
    const c = S.tool === 'epix' ? [0, 0, 0, 0] : [...hex2rgb(host.drawColor), 255];
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
    setTool(host.mode === 'draw' ? 'draw' : 'brush');
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
      const isSpaceLeft = e.button === 0 && host.spaceHeld;
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

  // 游標是否壓在對稱軸虛線上（繪圖模式 + 鏡射差異開著時才算）
  function mirrorAxisHit(e) {
    if (host.mode !== 'draw' || !$('v-mirror').checked || !store.has()) return false;
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

  function attach() {
    cv = host.cv;
    stage = host.stage;
    bindCanvas();
    bindPan();
    bindTouch();
  }

  return {
    attach, bindCanvas, bindPan, bindTouch,
    finishStroke, abortStroke, syncCropBar, readCropBar, doCrop,
    get drawing() { return drawing; },
    get gestureEnd() { return gestureEnd; },
    get gesture() { return gesture; },
    touchGestureActive, touchCount,
  };
};
