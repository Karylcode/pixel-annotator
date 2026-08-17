/* store — 應用狀態與所有會改到資料的操作。
   這一層不讀寫任何畫面元素，也不決定畫面長怎樣；改完狀態由 ui 決定要重畫什麼。
   v2：復原堆疊改為 past / future（Redo），每筆快照帶 label；
       新部件自動配色；切換圖片時記住各自的作用中部件與顯示集合。 */
window.PA = window.PA || {};

PA.store = (() => {
  const codec = PA.codec;
  const UNDO_DEPTH = 60;
  const LS_KEY = 'pixann';

  // 新部件依序輪用的配色（高辨識度、彼此差距大）；使用者手動改過色就不再動它
  const PART_PALETTE = ['#e5484d', '#f76808', '#ffb224', '#46a758', '#12a594', '#0091ff',
                        '#6e56cf', '#d6409f', '#8e4ec6', '#a18072', '#3e63dd', '#30a46c'];

  const state = {
    imgs: [],            // [{name, w, h, rgba, cvs}]
    cur: -1,
    ann: {},             // name -> {parts:[{id,name,color}], grid:Int16Array, next}
    hist: {},            // name -> { past:[entry], future:[entry] }  entry={grid,label,w?,h?,rgba?,cvs?}
    selByImg: {},        // name -> {active, shown:[id]}  每張圖各自的選取狀態
    tool: 'brush',
    zoom: 24,
    zoomTouched: false,  // 使用者動過縮放之後就不再自動貼合
    brush: 1,
    paintAlpha: false,   // 允許標註透明像素
    activePart: 0,       // 筆刷目標，一定在 shownParts 裡
    shownParts: new Set(),
    hoverPart: 0,
    crop: null,          // {x,y,w,h} 或 null；只有裁切工具啟用時才有值
  };

  /* ---------- 讀取 ---------- */
  const has = () => state.cur >= 0 && state.imgs.length > 0;
  const img = () => state.imgs[state.cur];
  const annot = () => state.ann[img().name];
  const idx = (x, y) => y * img().w + x;
  const partById = id => annot().parts.find(p => p.id === id);
  const alphaAt = (x, y) => img().rgba[idx(x, y) * 4 + 3];

  function rgbaAt(x, y) {
    const i = idx(x, y) * 4, d = img().rgba;
    return (d[i] << 24 | d[i + 1] << 16 | d[i + 2] << 8 | d[i + 3]) >>> 0;
  }

  function partCounts() {
    const c = {};
    if (!has()) return c;
    for (const v of annot().grid) if (v) c[v] = (c[v] || 0) + 1;
    return c;
  }

  // 標註完整度：只數看得見的像素（透明格不需要標註）
  function coverage() {
    if (!has()) return { annotated: 0, total: 0, pct: 0 };
    const im = img(), g = annot().grid;
    let annotated = 0, total = 0;
    for (let i = 0; i < g.length; i++) {
      if (im.rgba[i * 4 + 3] < 128) continue;
      total++;
      if (g[i]) annotated++;
    }
    return { annotated, total, pct: total ? Math.round(annotated / total * 100) : 0 };
  }

  const inBounds = (x, y) => x >= 0 && y >= 0 && x < img().w && y < img().h;

  /* ---------- 圖片 ---------- */

  function uniqueName(base) {
    let n = String(base);
    while (state.imgs.some(i => i.name === n)) n += '_';
    return n;
  }

  function blankAnn(w, h) { return { parts: [], next: 1, grid: new Int16Array(w * h) }; }

  // bmp: codec 產生的 {w,h,rgba,cvs}
  function addBitmap(name, bmp) {
    const n = uniqueName(name);
    state.imgs.push({ name: n, ...bmp });
    state.ann[n] = blankAnn(bmp.w, bmp.h);
    return n;
  }

  // 貼上的資料 -> 新圖片（+ 可能夾帶的標註）。回傳 {name, warning}
  function addDecoded(d, fallbackName) {
    const { w, h, rgba } = codec.decodePixels(d);
    const raw = String((d && d.name) || fallbackName || 'pasted').replace(/\.(png|json|js)$/i, '');
    const name = uniqueName(raw);
    state.imgs.push({ name, ...codec.bitmapFromRgba(w, h, rgba) });

    const a = blankAnn(w, h);
    let warning = null;
    const P = d && d.parts;
    if (P && Array.isArray(P.grid)) {
      const names = P.names || {}, colors = P.colors || {};
      const flat = P.grid.flat();
      const ids = new Set(flat.filter(Boolean));
      Object.keys(names).forEach(k => { if (+k) ids.add(+k); });
      a.parts = [...ids].sort((x, y) => x - y).map((id, i) => ({
        id, name: names[id] || '部件', color: colors[id] || PART_PALETTE[i % PART_PALETTE.length]
      }));
      a.next = Math.max(0, ...a.parts.map(p => p.id)) + 1;
      if (flat.length === w * h) a.grid = Int16Array.from(flat);
      else warning = `parts.grid 有 ${flat.length} 格，與 ${w}×${h} 不符，已略過標註`;
    }
    state.ann[name] = a;
    state.cur = state.imgs.length - 1;
    resetSel();
    return { name, warning };
  }

  // 目前這張圖是否有任何標註（關閉前要不要確認的依據）
  function hasAnnotation() {
    if (!has()) return false;
    const g = annot().grid;
    for (let i = 0; i < g.length; i++) if (g[i]) return true;
    return false;
  }

  function closeCurrent() {
    if (!has()) return;
    const n = img().name;
    state.imgs.splice(state.cur, 1);
    delete state.ann[n];
    delete state.hist[n];
    delete state.selByImg[n];
    state.cur = Math.min(state.cur, state.imgs.length - 1);
    restoreSel();
  }

  // 切圖前先把目前的選取收起來，切回來時還原（記住每張的作用中部件）
  function stashSel() {
    if (!has()) return;
    state.selByImg[img().name] = { active: state.activePart, shown: [...state.shownParts] };
  }

  function restoreSel() {
    if (!has()) { state.activePart = 0; state.shownParts = new Set(); state.hoverPart = 0; return; }
    const saved = state.selByImg[img().name];
    const a = annot();
    const valid = id => a.parts.some(p => p.id === id);
    if (saved && (valid(saved.active) || saved.shown.some(valid))) {
      state.shownParts = new Set(saved.shown.filter(valid));
      state.activePart = valid(saved.active) ? saved.active : ([...state.shownParts].pop() ?? 0);
    } else {
      const first = a.parts[0]?.id ?? 0;
      state.activePart = first;
      state.shownParts = new Set(first ? [first] : []);
    }
    if (state.activePart) state.shownParts.add(state.activePart);
    state.hoverPart = 0;
  }

  function select(i) {
    if (i < 0 || i >= state.imgs.length || i === state.cur) return;
    stashSel();
    state.cur = i;
    restoreSel();
  }

  /* ---------- 復原 / 重做 ---------- */
  // entry 有 rgba 代表整張圖等級的快照（裁切 / 像素化 / 就地改像素）。
  // 每筆都連部件清單一起存：刪除部件 / 匯入標註 / 清空之後復原，部件列才會跟著回來。

  function histOf(n) { return (state.hist[n] ||= { past: [], future: [] }); }

  const partsCopy = () => ({ parts: annot().parts.map(p => ({ ...p })), next: annot().next,
                             active: state.activePart, shown: [...state.shownParts] });

  function pushUndo(entry) {
    const h = histOf(img().name);
    h.past.push(entry);
    h.future = [];                       // 新動作會讓 future 失去意義
    if (h.past.length > UNDO_DEPTH) h.past.shift();
  }

  // 只動到標註時用這個
  function snapshot(label) {
    if (!has()) return;
    pushUndo({ grid: Int16Array.from(annot().grid), ...partsCopy(), label: label || '標註' });
  }

  // 會改到點陣圖本身時用這個，才復原得回來。
  // copy=true 給「就地改像素」的操作用 —— 不複製的話快照會跟著被改掉。
  function snapshotImage(copy, label) {
    if (!has()) return;
    const im = img();
    let rgba = im.rgba, cvs = im.cvs;
    if (copy) {
      rgba = new Uint8ClampedArray(im.rgba);
      cvs = document.createElement('canvas');
      cvs.width = im.w; cvs.height = im.h;
      cvs.getContext('2d').drawImage(im.cvs, 0, 0);
    }
    pushUndo({ grid: Int16Array.from(annot().grid), ...partsCopy(), w: im.w, h: im.h, rgba, cvs,
               label: label || '編輯圖片' });
    // 點陣圖快照很吃記憶體，大圖時只留最近幾筆
    const h = histOf(im.name);
    if (im.w * im.h > 262144) {
      let seen = 0;
      for (let i = h.past.length - 1; i >= 0; i--) {
        if (!h.past[i].rgba) continue;
        if (++seen > 8) {
          const { grid, parts, next, label: lb } = h.past[i];
          h.past[i] = { grid, parts, next, label: lb };
        }
      }
    }
  }

  // 目前狀態打成 entry（redo 前要先把現在的樣子存起來）。
  // rgba/cvs 用參照即可：undo 之後整張被換掉，舊物件只剩 future 引用，不會再被改到。
  function currentEntry(label) {
    const im = img();
    return { grid: Int16Array.from(annot().grid), ...partsCopy(), w: im.w, h: im.h,
             rgba: im.rgba, cvs: im.cvs, label };
  }

  // 回傳這次套用有沒有改到圖片尺寸（ui 據此決定要不要重新貼合縮放）
  function applyEntry(e) {
    const im = img(), a = annot();
    const before = `${im.w}×${im.h}`;
    if (e.rgba) {
      im.w = e.w; im.h = e.h; im.rgba = e.rgba; im.cvs = e.cvs;
      state.crop = null;
    }
    a.grid = e.grid;
    if (e.parts) {
      a.parts = e.parts.map(p => ({ ...p }));
      a.next = e.next;
      // 連當時的作用中 / 顯示中部件一起回去（刪掉的部件復原後應該回到作用中），
      // 但只採用還存在的 id
      const valid = id => a.parts.some(p => p.id === id);
      state.shownParts = new Set((e.shown || [...state.shownParts]).filter(valid));
      const wantActive = e.active !== undefined ? e.active : state.activePart;
      state.activePart = valid(wantActive) ? wantActive : ([...state.shownParts].pop() ?? a.parts[0]?.id ?? 0);
      if (state.activePart) state.shownParts.add(state.activePart);
      if (!valid(state.hoverPart)) state.hoverPart = 0;
    }
    return before !== `${im.w}×${im.h}`;
  }

  const canUndo = () => has() && !!histOf(img().name).past.length;
  const canRedo = () => has() && !!histOf(img().name).future.length;
  const undoLabel = () => canUndo() ? histOf(img().name).past.at(-1).label : '';
  const redoLabel = () => canRedo() ? histOf(img().name).future.at(-1).label : '';

  // 回傳 {label, resized}；沒得復原回傳 null
  function undoOnce() {
    if (!canUndo()) return null;
    const h = histOf(img().name);
    const e = h.past.pop();
    h.future.push(currentEntry(e.label));
    return { label: e.label, resized: applyEntry(e) };
  }

  function redoOnce() {
    if (!canRedo()) return null;
    const h = histOf(img().name);
    const e = h.future.pop();
    h.past.push(currentEntry(e.label));
    return { label: e.label, resized: applyEntry(e) };
  }

  // 歷史面板用：past 由舊到新、future 由「下一步」往後
  function historyLabels() {
    if (!has()) return { past: [], future: [] };
    const h = histOf(img().name);
    return { past: h.past.map(e => e.label), future: [...h.future].reverse().map(e => e.label) };
  }

  /* ---------- 塗畫 ---------- */

  const paintable = (x, y) => inBounds(x, y) && (state.paintAlpha || alphaAt(x, y) >= 128);

  function setPx(x, y, v) { if (paintable(x, y)) annot().grid[idx(x, y)] = v; }

  function brushAt(x, y, v) {
    const r = state.brush - 1;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) setPx(x + dx, y + dy, v);
  }

  // 從 (x,y) 出發，填滿相連的同色區域
  function floodSameColour(x, y, v) {
    const target = rgbaAt(x, y), { w, h } = img();
    const seen = new Uint8Array(w * h), stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (!inBounds(cx, cy)) continue;
      const i = idx(cx, cy);
      if (seen[i] || rgbaAt(cx, cy) !== target) continue;
      seen[i] = 1;
      setPx(cx, cy, v);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  // 整張圖所有同色像素
  function allSameColour(x, y, v) {
    const target = rgbaAt(x, y), { w, h } = img();
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++)
        if (rgbaAt(xx, yy) === target) setPx(xx, yy, v);
  }

  // 魔棒 / 同色全選的 hover 預覽：算出「點下去會被塗到哪些格」的遮罩（唯讀，不改狀態）。
  // kind = 'wand'（相連同色）| 'same'（整張同色）。回傳 {mask: Uint8Array, count}
  function selectionMask(x, y, kind) {
    const { w, h } = img();
    const mask = new Uint8Array(w * h);
    if (!inBounds(x, y)) return { mask, count: 0 };
    const target = rgbaAt(x, y);
    let count = 0;
    if (kind === 'same') {
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++)
          if (rgbaAt(xx, yy) === target && paintable(xx, yy)) { mask[yy * w + xx] = 1; count++; }
      return { mask, count };
    }
    const seen = new Uint8Array(w * h), stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (!inBounds(cx, cy)) continue;
      const i = idx(cx, cy);
      if (seen[i] || rgbaAt(cx, cy) !== target) continue;
      seen[i] = 1;
      if (paintable(cx, cy)) { mask[i] = 1; count++; }
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    return { mask, count };
  }

  // 沿 (x0,y0)->(x1,y1) 補點，避免快速拖曳留下斷點
  function strokeTo(x0, y0, x1, y1, v) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      brushAt(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), v);
    }
  }

  function clearGrid() {
    if (!has()) return 0;
    const g = annot().grid;
    let n = 0;
    for (let i = 0; i < g.length; i++) if (g[i]) { g[i] = 0; n++; }
    return n;
  }

  /* ---------- 部件 ---------- */

  function addPart(name) {
    if (!has()) return null;
    const a = annot();
    const id = a.next++;
    a.parts.push({ id, name: name || '部件',
                   color: PART_PALETTE[a.parts.length % PART_PALETTE.length] });
    setActive(id);
    return id;
  }

  function deletePart(id) {
    const a = annot();
    for (let i = 0; i < a.grid.length; i++) if (a.grid[i] === id) a.grid[i] = 0;
    a.parts = a.parts.filter(p => p.id !== id);
    state.shownParts.delete(id);
    if (state.hoverPart === id) state.hoverPart = 0;
    if (state.activePart === id) {
      state.activePart = [...state.shownParts].pop() ?? a.parts[0]?.id ?? 0;
      if (state.activePart) state.shownParts.add(state.activePart);
    }
  }

  function renamePart(id, name) {
    const p = partById(id);
    const v = String(name || '').trim();
    if (p && v) p.name = v;
  }

  function setPartColor(id, color) { const p = partById(id); if (p) p.color = color; }

  function movePart(id, to) {
    const parts = annot().parts;
    const from = parts.findIndex(p => p.id === id);
    if (from < 0) return;
    const [m] = parts.splice(from, 1);
    if (to > from) to--;
    parts.splice(Math.max(0, Math.min(parts.length, to)), 0, m);
  }

  // 從外部 JSON 覆蓋整組標註
  function applyAnnotation(d) {
    const a = annot();
    a.parts = Object.entries(d.parts.names || {}).map(([k, v], i) =>
      ({ id: +k, name: v, color: (d.parts.colors || {})[k] || PART_PALETTE[i % PART_PALETTE.length] }));
    a.next = Math.max(0, ...a.parts.map(p => p.id)) + 1;
    a.grid = Int16Array.from(d.parts.grid.flat());
    resetSel();
  }

  /* ---------- 選取 ---------- */
  // 筆刷目標一律強制顯示，否則畫下去會看不見。

  function setActive(id) {
    state.activePart = id;
    if (id) state.shownParts.add(id);
  }

  function toggleShown(id) {
    if (state.shownParts.has(id)) {
      state.shownParts.delete(id);
      if (state.activePart === id) state.activePart = [...state.shownParts].pop() ?? 0;
    } else state.shownParts.add(id);
  }

  // 只顯示這一個部件（Alt+點眼睛）
  function soloShown(id) {
    state.shownParts = new Set([id]);
    state.activePart = id;
  }

  function setHover(id) {
    if (state.hoverPart === id) return false;
    state.hoverPart = id;
    return true;
  }

  function resetSel() {
    const first = has() ? (annot().parts[0]?.id ?? 0) : 0;
    state.activePart = first;
    state.shownParts = new Set(first ? [first] : []);
    state.hoverPart = 0;
  }

  /* ---------- 直接改像素 ---------- */

  const pixelAt = (x, y) => {
    const p = idx(x, y) * 4, d = img().rgba;
    return [d[p], d[p + 1], d[p + 2], d[p + 3]];
  };

  // 用 putImageData 而不是 fillRect：後者會做 alpha 混合，寫不出精確的顏色
  const _one = new Uint8ClampedArray(4);
  function paintPixel(x, y, c) {
    if (!has() || !inBounds(x, y)) return false;
    const im = img(), p = idx(x, y) * 4;
    if (im.rgba[p] === c[0] && im.rgba[p + 1] === c[1] &&
        im.rgba[p + 2] === c[2] && im.rgba[p + 3] === c[3]) return false;
    im.rgba[p] = c[0]; im.rgba[p + 1] = c[1]; im.rgba[p + 2] = c[2]; im.rgba[p + 3] = c[3];
    _one[0] = c[0]; _one[1] = c[1]; _one[2] = c[2]; _one[3] = c[3];
    im.cvs.getContext('2d').putImageData(new ImageData(_one, 1, 1), x, y);
    return true;
  }

  // 目前圖片用到的顏色，依出現次數排序 —— 修圖時直接點現成的色最省事
  function imagePalette(limit = 48) {
    if (!has()) return [];
    const im = img(), map = new Map();
    for (let p = 0; p < im.rgba.length; p += 4) {
      if (im.rgba[p + 3] < 8) continue;
      const k = (im.rgba[p] << 16) | (im.rgba[p + 1] << 8) | im.rgba[p + 2];
      map.set(k, (map.get(k) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([k]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255, 255]);
  }

  /* ---------- 裁切 ---------- */

  // 把範圍夾回圖片邊界內，寬高至少 1
  function setCrop(r) {
    if (!has()) { state.crop = null; return null; }
    const im = img();
    let x = Math.round(r.x) || 0, y = Math.round(r.y) || 0;
    let w = Math.round(r.w) || 1, h = Math.round(r.h) || 1;
    x = Math.max(0, Math.min(im.w - 1, x));
    y = Math.max(0, Math.min(im.h - 1, y));
    w = Math.max(1, Math.min(im.w - x, w));
    h = Math.max(1, Math.min(im.h - y, h));
    state.crop = { x, y, w, h };
    return state.crop;
  }
  function clearCrop() { state.crop = null; }
  function cropWholeImage() {
    if (!has()) return null;
    const im = img();
    return setCrop({ x: 0, y: 0, w: im.w, h: im.h });
  }

  // 像素與標註一起裁，兩張網格必須同步，否則標註會整個錯位
  function applyCrop() {
    const c = state.crop;
    if (!c || !has()) return false;
    const im = img(), a = annot();
    if (c.x === 0 && c.y === 0 && c.w === im.w && c.h === im.h) return false;

    const rgba = new Uint8ClampedArray(c.w * c.h * 4);
    const grid = new Int16Array(c.w * c.h);
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const src = (c.y + y) * im.w + (c.x + x);
        const dst = y * c.w + x;
        rgba.set(im.rgba.subarray(src * 4, src * 4 + 4), dst * 4);
        grid[dst] = a.grid[src];
      }
    }
    const bmp = codec.bitmapFromRgba(c.w, c.h, rgba);
    im.w = c.w; im.h = c.h; im.rgba = bmp.rgba; im.cvs = bmp.cvs;
    a.grid = grid;
    state.crop = null;
    return true;
  }

  // 整張換掉點陣圖（像素化用）。尺寸變了，舊標註無法對應，所以清空；
  // 呼叫端要先 snapshotImage()，Ctrl+Z 才復原得回來。部件清單保留。
  function replaceImage(bmp) {
    if (!has()) return false;
    const im = img();
    im.w = bmp.w; im.h = bmp.h; im.rgba = bmp.rgba; im.cvs = bmp.cvs;
    annot().grid = new Int16Array(bmp.w * bmp.h);
    state.crop = null;
    return true;
  }

  /* ---------- 匯出 ---------- */
  const exportData = () => codec.encode(img(), annot());

  /* ---------- 存檔 ---------- */
  // 回傳是否寫入成功；配額滿了 ui 要警告使用者改用手動下載

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        imgs: state.imgs.map(im => ({ name: im.name, w: im.w, h: im.h, url: im.cvs.toDataURL() })),
        ann: Object.fromEntries(Object.entries(state.ann).map(([k, v]) =>
          [k, { parts: v.parts, next: v.next, grid: Array.from(v.grid) }])),
        cur: state.cur
      }));
      return true;
    } catch (e) { return false; }
  }

  // 圖片要非同步解碼，所以用 callback 回報完成
  function restore(done) {
    let raw;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { return done(false); }
    if (!raw) return done(false);
    let p; try { p = JSON.parse(raw); } catch (e) { return done(false); }
    if (!p.imgs || !p.imgs.length) return done(false);

    const slots = new Array(p.imgs.length);
    let pending = p.imgs.length;
    const finish = () => {
      state.imgs = slots.filter(Boolean);
      for (const [k, v] of Object.entries(p.ann || {}))
        state.ann[k] = { parts: v.parts, next: v.next, grid: Int16Array.from(v.grid) };
      for (const im of state.imgs)
        if (!state.ann[im.name]) state.ann[im.name] = blankAnn(im.w, im.h);
      state.cur = Math.min(p.cur ?? 0, state.imgs.length - 1);
      restoreSel();
      done(state.imgs.length > 0);
    };
    p.imgs.forEach((rec, i) => {
      const el = new Image();
      el.onload = () => { slots[i] = { name: rec.name, ...codec.bitmapFromImage(el) }; if (--pending === 0) finish(); };
      el.onerror = () => { if (--pending === 0) finish(); };
      el.src = rec.url;
    });
  }

  function clearSaved() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }

  return {
    state, PART_PALETTE,
    has, img, annot, idx, partById, rgbaAt, alphaAt, inBounds, partCounts, coverage, hasAnnotation,
    addBitmap, addDecoded, closeCurrent, select, uniqueName,
    snapshot, snapshotImage, canUndo, canRedo, undoLabel, redoLabel, undoOnce, redoOnce, historyLabels,
    setCrop, clearCrop, cropWholeImage, applyCrop, replaceImage,
    pixelAt, paintPixel, imagePalette,
    setPx, brushAt, floodSameColour, allSameColour, selectionMask, strokeTo, clearGrid,
    addPart, deletePart, renamePart, setPartColor, movePart, applyAnnotation,
    setActive, toggleShown, soloShown, setHover, resetSel,
    exportData, save, restore, clearSaved,
  };
})();
