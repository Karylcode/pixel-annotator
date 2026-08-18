/* render — 把 store 的狀態畫到 canvas 上。
   這一層只讀狀態、不改狀態，也不處理任何事件。
   v2：雙色格線（淺色像素上也看得見）、筆刷輪廓（黑白雙線）、
       鏡射差異改洋紅斑馬、裁切八把手、未標註格斑馬反白。 */
window.PA = window.PA || {};

PA.render = (() => {
  const store = PA.store;
  const HILITE = '#ffffff';      // 滑過部件列時該部件反白的顏色
  const GRID_MIN_ZOOM = 6;       // 太小的時候格線只會糊成一片
  const MAX_ZOOM = 48;
  const SAFE_FILL = /^#[0-9a-f]{6}$/;   // 外部顏色進 Canvas 前的最後一道門

  // 疊加層固定色（不隨主題，對應設計文件 --ov-*）
  const OV_GRID_DARK = 'rgba(0,0,0,.28)';
  const OV_GRID_LIGHT = 'rgba(255,255,255,.20)';
  const OV_GRID_MAJOR_DARK = 'rgba(0,0,0,.40)';
  const OV_GRID_MAJOR = 'rgba(255,255,255,.35)';
  const OV_CROP_MASK = 'rgba(6,6,10,.62)';
  const OV_CROP_LINE = '#ff9148';
  const OV_MIRROR = '#ff3cff';
  const OV_WARN = '#ffcf5a';

  let cv = null, ctx = null;

  function init(canvas) {
    cv = canvas;
    ctx = canvas.getContext('2d');
  }

  /* ---------- 斑馬紋（斜線圖樣，鏡射差異 / 未標註反白共用） ---------- */
  const _patterns = {};
  function zebraPattern(colour) {
    if (_patterns[colour]) return _patterns[colour];
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const x = c.getContext('2d');
    x.strokeStyle = colour;
    x.lineWidth = 2.5;
    x.beginPath();
    x.moveTo(-2, 10); x.lineTo(10, -2);
    x.moveTo(-2, 2); x.lineTo(2, -2);   // 補齊角落，斜線才連續
    x.moveTo(6, 10); x.lineTo(10, 6);
    x.stroke();
    return (_patterns[colour] = ctx.createPattern(c, 'repeat'));
  }

  // view: {image, parts, grid, mirror, mirrorAxis, brush:{x,y,cells}|null, hiliteUnannotated,
  //        preview:{mask,w,h}|null}
  function draw(view) {
    if (!cv || !store.has()) return;
    const S = store.state;
    const im = store.img(), a = store.annot();
    const { w, h } = im, zoom = S.zoom;
    const dpr = window.devicePixelRatio || 1;
    const cw = w * zoom, ch = h * zoom;

    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
      cv.style.width = cw + 'px';
      cv.style.height = ch + 'px';
      invalidateRect();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cw, ch);

    if (view.image) ctx.drawImage(im.cvs, 0, 0, cw, ch);
    if (view.parts) drawParts(a, w, h, zoom, S);
    if (view.hiliteUnannotated) drawUnannotated(im, a, zoom);
    if (view.mirror) drawMirror(im, zoom, view.mirrorAxis);
    if (view.grid && zoom >= GRID_MIN_ZOOM) drawGrid(w, h, zoom, cw, ch);
    if (view.preview && view.preview.w === w && view.preview.h === h) drawPreview(view.preview, zoom);
    if (S.crop) drawCrop(S.crop, zoom, cw, ch);
    if (view.brush) drawBrush(view.brush, zoom);
  }

  /* ---------- 魔棒 / 同色全選的 hover 預覽：選取範圍的外框畫成黑白虛線（螞蟻線） ---------- */
  function drawPreview(pv, zoom) {
    const { mask, w, h } = pv;
    const path = new Path2D();
    let any = false;
    // 只畫「遮罩內 / 外」交界的邊，內部不畫線，看起來才是一圈輪廓
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        any = true;
        const X = x * zoom, Y = y * zoom;
        if (y === 0 || !mask[(y - 1) * w + x]) { path.moveTo(X, Y + .5); path.lineTo(X + zoom, Y + .5); }
        if (y === h - 1 || !mask[(y + 1) * w + x]) { path.moveTo(X, Y + zoom - .5); path.lineTo(X + zoom, Y + zoom - .5); }
        if (x === 0 || !mask[y * w + x - 1]) { path.moveTo(X + .5, Y); path.lineTo(X + .5, Y + zoom); }
        if (x === w - 1 || !mask[y * w + x + 1]) { path.moveTo(X + zoom - .5, Y); path.lineTo(X + zoom - .5, Y + zoom); }
      }
    }
    if (!any) return;
    ctx.save();
    // 底下先淡淡填一層，讓大範圍選取一眼看得出「會選到多少」
    ctx.fillStyle = 'rgba(122,167,255,.14)';
    const fill = new Path2D();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (mask[y * w + x]) fill.rect(x * zoom, y * zoom, zoom, zoom);
    ctx.fill(fill);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.stroke(path);
    ctx.strokeStyle = 'rgba(0,0,0,.9)';
    ctx.setLineDash([4, 4]);
    ctx.stroke(path);
    ctx.restore();
  }

  /* ---------- 鏡射差異：洋紅斑馬 + 對稱軸 ---------- */
  const MIRROR_TOL = 10;
  let lastMirrorDiff = 0;   // 上一次畫鏡射差異時不對稱的格數（狀態列顯示用）
  function drawMirror(im, zoom, axis) {
    const { w, h, rgba } = im;
    const ax = Number.isFinite(axis) ? axis : mirrorAxisOf(im);

    // 先把所有不符的格收成一個 Path2D，再一次填底色 + 斑馬，比逐格 fillRect 省很多
    const path = new Path2D();
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const mx = Math.round(2 * ax - x);
        if (mx < 0 || mx >= w || mx === x) continue;
        const p = (y * w + x) * 4, q = (y * w + mx) * 4;
        const a0 = rgba[p + 3], a1 = rgba[q + 3];
        if (a0 < 8 && a1 < 8) continue;
        const diff = (a0 < 8) !== (a1 < 8) ||
          Math.abs(rgba[p] - rgba[q]) > MIRROR_TOL ||
          Math.abs(rgba[p + 1] - rgba[q + 1]) > MIRROR_TOL ||
          Math.abs(rgba[p + 2] - rgba[q + 2]) > MIRROR_TOL;
        if (diff) { path.rect(x * zoom, y * zoom, zoom, zoom); n++; }
      }
    }
    lastMirrorDiff = n;
    if (n) {
      ctx.fillStyle = 'rgba(255,60,255,.22)';
      ctx.fill(path);
      ctx.fillStyle = zebraPattern('rgba(255,60,255,.55)');
      ctx.fill(path);
    }

    // 對稱軸本身畫虛線，才知道是照哪條軸在比
    ctx.save();
    ctx.strokeStyle = OV_MIRROR;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo((ax + 0.5) * zoom + .5, 0);
    ctx.lineTo((ax + 0.5) * zoom + .5, h * zoom);
    ctx.stroke();
    ctx.restore();
  }

  // 對稱軸用搜尋的，不是取幾何中心 —— 角色常有法杖、單邊瀏海之類的不對稱物件，
  // 拿不透明範圍的中心當軸會整片標紅，毫無參考價值。
  // 評分取「相符率」，自然會落在真正對稱的那條軸上。
  // 這是 O(w²·h) 的搜尋，結果只跟點陣圖有關，所以依 (圖, 版本) 記住 —— 否則對稱軸欄位一清空，
  // 每次滑鼠移動都會重跑一次整張圖的搜尋。
  let _axisIm = null, _axisRev = -1, _axisVal = 0;
  function mirrorAxisOf(im) {
    if (_axisIm === im && _axisRev === (im.rev || 0)) return _axisVal;
    _axisVal = computeMirrorAxis(im);
    _axisIm = im; _axisRev = im.rev || 0;
    return _axisVal;
  }
  function computeMirrorAxis(im) {
    const { w, h, rgba } = im;
    let lo = w, hi = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (rgba[(y * w + x) * 4 + 3] >= 8) { if (x < lo) lo = x; if (x > hi) hi = x; }
      }
    }
    if (hi < lo) return (w - 1) / 2;

    const rows = [];
    let maxN = 0;
    for (let ax = lo; ax <= hi; ax += 0.5) {
      let match = 0, n = 0;
      for (let y = 0; y < h; y++) {
        for (let x = lo; x <= hi; x++) {
          const mx = Math.round(2 * ax - x);
          if (mx < 0 || mx >= w || mx <= x) continue;
          const p = (y * w + x) * 4, q = (y * w + mx) * 4;
          const a0 = rgba[p + 3], a1 = rgba[q + 3];
          if (a0 < 8 && a1 < 8) continue;
          n++;
          if ((a0 < 8) === (a1 < 8) &&
              Math.abs(rgba[p] - rgba[q]) <= MIRROR_TOL &&
              Math.abs(rgba[p + 1] - rgba[q + 1]) <= MIRROR_TOL &&
              Math.abs(rgba[p + 2] - rgba[q + 2]) <= MIRROR_TOL) match++;
        }
      }
      rows.push({ ax, match, n });
      if (n > maxN) maxN = n;
    }
    // 用「相符率」而不是「相符-不符」：後者會偏袒靠邊、幾乎沒東西可比的軸。
    // 再要求比對數夠多，免得選到只重疊一小塊的軸。
    let bestAx = (lo + hi) / 2, bestScore = -1;
    for (const r of rows) {
      if (r.n < maxN * 0.6) continue;
      const s = r.match / r.n;
      if (s > bestScore) { bestScore = s; bestAx = r.ax; }
    }
    return bestAx;
  }

  /* ---------- 未標註格反白（黃色斑馬 3 秒） ---------- */
  function drawUnannotated(im, a, zoom) {
    const { w, h, rgba } = im, g = a.grid;
    const path = new Path2D();
    let any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (g[i] || rgba[i * 4 + 3] < 128) continue;
        path.rect(x * zoom, y * zoom, zoom, zoom);
        any = true;
      }
    }
    if (!any) return;
    ctx.fillStyle = 'rgba(255,207,90,.16)';
    ctx.fill(path);
    ctx.fillStyle = zebraPattern('rgba(255,207,90,.6)');
    ctx.fill(path);
  }

  /* ---------- 裁切：遮罩 + 框 + 八把手 ---------- */
  function drawCrop(c, zoom, cw, ch) {
    const x = c.x * zoom, y = c.y * zoom, w = c.w * zoom, h = c.h * zoom;
    ctx.fillStyle = OV_CROP_MASK;
    ctx.fillRect(0, 0, cw, y);
    ctx.fillRect(0, y + h, cw, ch - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, cw - x - w, h);
    ctx.strokeStyle = OV_CROP_LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));

    // 八把手：白底橘框小方塊，跟格線與遮罩都拉得開對比
    const hs = cropHandles(c, zoom);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = OV_CROP_LINE;
    ctx.lineWidth = 1.5;
    for (const [hx, hy] of hs) {
      ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
      ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
    }
  }

  // 八把手的畫布座標（像素格座標 × zoom）：四角 + 四邊中點
  function cropHandles(c, zoom) {
    const x0 = c.x * zoom, y0 = c.y * zoom;
    const x1 = (c.x + c.w) * zoom, y1 = (c.y + c.h) * zoom;
    const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    return [[x0, y0], [xm, y0], [x1, y0], [x1, ym], [x1, y1], [xm, y1], [x0, y1], [x0, ym]];
  }

  // 命中測試（給 ui 用）：回傳 'nw','n','ne','e','se','s','sw','w' / 'move' / null。
  // 以畫布 CSS 像素為單位，容許 7px 的抓取範圍。
  function cropHitTest(c, zoom, cx, cy) {
    if (!c) return null;
    const TOL = 7;
    const ids = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const hs = cropHandles(c, zoom);
    for (let i = 0; i < hs.length; i++)
      if (Math.abs(cx - hs[i][0]) <= TOL && Math.abs(cy - hs[i][1]) <= TOL) return ids[i];
    if (cx > c.x * zoom && cx < (c.x + c.w) * zoom &&
        cy > c.y * zoom && cy < (c.y + c.h) * zoom) return 'move';
    return null;
  }

  const CROP_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
                         n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

  /* ---------- 筆刷輪廓：黑白雙線，深淺像素上都看得見 ---------- */
  // brush: {x, y, cells} cells = 邊長（筆刷足跡 = 2*size-1 格；點選工具 = 1 格）
  function drawBrush(b, zoom) {
    const half = (b.cells - 1) / 2;
    const x = (b.x - half) * zoom, y = (b.y - half) * zoom, s = b.cells * zoom;
    // 反相填充：hover 反白在純白像素上也成立
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.fillRect(x, y, s, s);
    ctx.restore();
    // 外白內黑的雙線框
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 1, y - 1, s + 2, s + 2);
    ctx.strokeStyle = 'rgba(0,0,0,.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + .5, y + .5, s - 1, s - 1);
  }

  /* ---------- 部件色 ---------- */
  // 每個 id 先查一次要不要畫、畫什麼色（不在內迴圈裡 parts.find），
  // 同色的格收成一個 Path2D 一次 fill —— 每幀從 w·h 次 fillRect 變成「部件數」次 fill。
  function drawParts(a, w, h, zoom, S) {
    const g = a.grid;
    const fillOf = new Map();          // id -> colour | null
    for (const p of a.parts) {
      const id = p.id;
      fillOf.set(id, id === S.hoverPart ? HILITE : S.shownParts.has(id) ? (SAFE_FILL.test(p.color) ? p.color : null) : null);
    }
    const paths = new Map();           // colour -> Path2D
    for (let y = 0; y < h; y++) {
      const row = y * w, Y = y * zoom;
      for (let x = 0; x < w;) {
        const id = g[row + x];
        if (!id) { x++; continue; }
        // 同一列連續同 id 的格併成一個矩形
        let xe = x + 1;
        while (xe < w && g[row + xe] === id) xe++;
        const fill = fillOf.get(id);
        if (fill) {
          let path = paths.get(fill);
          if (!path) { path = new Path2D(); paths.set(fill, path); }
          path.rect(x * zoom, Y, (xe - x) * zoom, zoom);
        }
        x = xe;
      }
    }
    for (const [fill, path] of paths) { ctx.fillStyle = fill; ctx.fill(path); }
  }

  /* ---------- 格線：深淺雙色，亮暗像素上都有一條能看見 ---------- */
  function drawGrid(w, h, zoom, cw, ch) {
    const pass = (colour, off) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < w; x++) { ctx.moveTo(x * zoom + off + .5, 0); ctx.lineTo(x * zoom + off + .5, ch); }
      for (let y = 1; y < h; y++) { ctx.moveTo(0, y * zoom + off + .5); ctx.lineTo(cw, y * zoom + off + .5); }
      ctx.stroke();
    };
    pass(OV_GRID_DARK, 0);
    pass(OV_GRID_LIGHT, 1);
    // 每 8 格加粗一條，方便數座標
    if (w % 8 === 0 || h % 8 === 0) {
      const major = (colour, off) => {
        ctx.strokeStyle = colour;
        ctx.beginPath();
        for (let x = 8; x < w; x += 8) { ctx.moveTo(x * zoom + off + .5, 0); ctx.lineTo(x * zoom + off + .5, ch); }
        for (let y = 8; y < h; y += 8) { ctx.moveTo(0, y * zoom + off + .5); ctx.lineTo(cw, y * zoom + off + .5); }
        ctx.stroke();
      };
      major(OV_GRID_MAJOR_DARK, 0);
      major(OV_GRID_MAJOR, 1);
    }
  }

  // 讓整張圖貼合可用空間的整數倍縮放。
  // availW/availH 要傳「內容區」的尺寸 —— 版面可能用不對稱的 padding 讓開浮動面板，
  // 拿含 padding 的 clientWidth 來算會嚴重高估可用空間。
  function fitZoom(availW, availH) {
    if (!store.has() || availW <= 0 || availH <= 0) return store.state.zoom;
    const im = store.img();
    const z = Math.min(availW / im.w, availH / im.h);
    return Math.max(1, Math.min(zoomMax(availW, availH), Math.floor(z)));
  }

  // 小圖的上限放寬：8×8 只有 384px 太小，至少放到放得下為止
  function zoomMax(availW, availH) {
    if (!store.has()) return MAX_ZOOM;
    const im = store.img();
    const fitW = availW > 0 ? Math.floor(availW / im.w) : MAX_ZOOM;
    const fitH = availH > 0 ? Math.floor(availH / im.h) : MAX_ZOOM;
    return Math.max(MAX_ZOOM, Math.min(256, Math.min(fitW, fitH)));
  }

  // 畫布會超出可用空間時，往下夾到剛好塞得下的整數倍
  function clampZoom(availW, availH) {
    const z = store.state.zoom;
    if (!store.has() || availW <= 0 || availH <= 0) return z;
    const im = store.img();
    if (im.w * z <= availW && im.h * z <= availH) return z;
    return Math.max(1, Math.min(Math.floor(availW / im.w), Math.floor(availH / im.h)));
  }

  // 畫布的螢幕矩形。每次 pointermove 都 getBoundingClientRect 會強制排版；
  // 同一個影格內（同一輪事件）多次呼叫共用一次量測，畫布搬動時由 ui 呼叫 invalidateRect()。
  let _rect = null, _rectFrame = -1, _frameNo = 0;
  function canvasRect() {
    if (_rect && _rectFrame === _frameNo) return _rect;
    _rect = cv.getBoundingClientRect();
    _rectFrame = _frameNo;
    return _rect;
  }
  // 讓下一次 canvasRect() 重新量（縮放 / 捲動 / 版面變化後）
  const invalidateRect = () => { _frameNo++; };
  // 沒有 rAF 也要有「影格」的概念：每次 pointer 事件之間有可能捲動，所以保守一點——
  // 只在同一個 macrotask 內共用；用 queueMicrotask 在事件處理完後就失效
  function canvasRectOnce() {
    const r = canvasRect();
    queueMicrotask(invalidateRect);
    return r;
  }

  // 由實際繪製尺寸反推像素座標 —— 窄螢幕時 CSS 可能縮過畫布，不能直接用 zoom 換算
  function pxAt(e) {
    const r = canvasRectOnce();
    const im = store.img();
    return [Math.floor((e.clientX - r.left) / (r.width / im.w)),
            Math.floor((e.clientY - r.top) / (r.height / im.h))];
  }

  // 畫布上的 CSS 像素座標（裁切把手命中測試用）
  function canvasPosAt(e) {
    const r = canvasRectOnce();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // 縮圖用的小 canvas：CSS 只顯示 40–52px，來源解析度的 canvas 純粹浪費 backing store，
  // 縮到最長邊 64px 就夠。縮小的結果依 (圖, 版本) 快取在圖片物件上；每次呼叫回傳的是
  // 一個從快取複製出來的新 canvas（同一個 DOM 節點不能同時掛在縮圖列與圖片分頁兩處）。
  const THUMB_MAX = 64;
  function thumb(im) {
    const rev = im.rev || 0;
    let src = im._thumb;
    if (!src || im._thumbRev !== rev) {
      const s = Math.min(1, THUMB_MAX / Math.max(im.w, im.h));
      src = document.createElement('canvas');
      src.width = Math.max(1, Math.round(im.w * s));
      src.height = Math.max(1, Math.round(im.h * s));
      const x = src.getContext('2d');
      x.imageSmoothingEnabled = false;
      x.drawImage(im.cvs, 0, 0, src.width, src.height);
      im._thumb = src; im._thumbRev = rev;
    }
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  return { init, draw, fitZoom, clampZoom, zoomMax, pxAt, canvasPosAt, invalidateRect, thumb, mirrorAxisOf,
           mirrorDiff: () => lastMirrorDiff,
           cropHitTest, CROP_CURSORS, HILITE, MAX_ZOOM };
})();
