/* store — 應用狀態與所有會改到資料的操作。
   這一層不讀寫任何畫面元素，也不決定畫面長怎樣；改完狀態由 ui 決定要重畫什麼。
   v2：復原堆疊改為 past / future（Redo），每筆快照帶 label；
       新部件自動配色；切換圖片時記住各自的作用中部件與顯示集合。
   v2.1：復原改為位元組預算 + 筆畫稀疏 diff（不再空心化快照）；
         標註統計增量維護（coverage / partCounts 變 O(部件數)）；
         存檔改 pixann.v2（版本、時間戳、RLE 網格、點陣圖進 IndexedDB、配額 / 跨分頁處理）。 */
window.PA = window.PA || {};

PA.store = (() => {
  const codec = PA.codec;
  const UNDO_DEPTH = 60;                 // 每張圖最多幾筆
  const HIST_BUDGET = 192 * 1024 * 1024; // 每張圖 past + future 合計的記憶體上限（估算值）
  const LS_KEY = 'pixann.v2';
  const LS_KEY_LEGACY = 'pixann';        // v1（含舊版前端）用的鍵；只讀不寫，第一次啟動時遷移
  const LS_STALE = 'pixann.v2.stale';    // 上一次存檔因配額失敗的時間戳（存在 = 保存的資料比實際舊）

  // 新部件依序輪用的配色（高辨識度、彼此差距大）；使用者手動改過色就不再動它
  const PART_PALETTE = ['#e5484d', '#f76808', '#ffb224', '#46a758', '#12a594', '#0091ff',
                        '#6e56cf', '#d6409f', '#8e4ec6', '#a18072', '#3e63dd', '#30a46c'];

  const state = {
    imgs: [],            // [{name, w, h, rgba, cvs, rev}]  rev：點陣圖版本，改過像素就 +1（快取用）
    cur: -1,
    ann: {},             // name -> {parts:[{id,name,color}], grid:Int16Array, next, counts:{id:n}, annTotal, annOpaque}
    hist: {},            // name -> { past:[entry], future:[entry] }
                         // entry = {label, parts, next, active, shown} + 以下其一：
                         //   grid: Int16Array                     整份標註網格
                         //   diff: {idx:Int32Array, val:Int16Array, n}   標註稀疏 diff（筆刷 / 擦除）
                         //   w, h, rgba, cvs (+ grid)             整張點陣圖（裁切 / 像素化）
                         //   pdiff: {idx:Int32Array, rgba:Uint8ClampedArray, n}  像素稀疏 diff（繪圖 / 擦成透明）
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

  /* ---------- 標註統計（增量維護，不再每次掃整張圖） ----------
     a.counts[id]  = 該部件的格數
     a.annTotal    = 有標註的格數
     a.annOpaque   = 有標註且像素不透明（alpha ≥ 128）的格數 —— coverage 只算看得見的格
     im._opaque    = 不透明像素數（懶算，改到像素時同步或作廢） */

  function recount(a, im) {
    const g = a.grid, d = im.rgba, counts = {};
    let t = 0, o = 0;
    for (let i = 0; i < g.length; i++) {
      const v = g[i];
      if (!v) continue;
      t++;
      counts[v] = (counts[v] || 0) + 1;
      if (d[i * 4 + 3] >= 128) o++;
    }
    a.counts = counts; a.annTotal = t; a.annOpaque = o;
  }

  function opaqueCount(im) {
    if (im._opaque !== undefined && im._opaqueRev === im.rev) return im._opaque;
    const d = im.rgba;
    let n = 0;
    for (let p = 3; p < d.length; p += 4) if (d[p] >= 128) n++;
    im._opaque = n; im._opaqueRev = im.rev;
    return n;
  }

  // 點陣圖改了（像素 / 尺寸）：版本 +1，所有依版本的快取自然失效
  const touchBitmap = im => { im.rev = (im.rev || 0) + 1; };

  function partCounts() {
    if (!has()) return {};
    return { ...annot().counts };
  }

  // 標註完整度：只數看得見的像素（透明格不需要標註）
  function coverage(im = has() ? img() : null) {
    if (!im) return { annotated: 0, total: 0, pct: 0 };
    const a = state.ann[im.name];
    const total = opaqueCount(im), annotated = a ? a.annOpaque : 0;
    return { annotated, total, pct: total ? Math.round(annotated / total * 100) : 0 };
  }

  const inBounds = (x, y) => x >= 0 && y >= 0 && x < img().w && y < img().h;

  /* ---------- 圖片 ---------- */

  function uniqueName(base) {
    let n = String(base);
    while (state.imgs.some(i => i.name === n)) n += '_';
    return n;
  }

  function blankAnn(w, h) {
    return { parts: [], next: 1, grid: new Int16Array(w * h), counts: {}, annTotal: 0, annOpaque: 0 };
  }
  function nextPartId(parts, min = 1) {
    let n = min;
    for (const p of parts) if (p.id + 1 > n) n = p.id + 1;
    return n;
  }

  const mkImage = (name, bmp) => ({ name, w: bmp.w, h: bmp.h, rgba: bmp.rgba, cvs: bmp.cvs, rev: 0 });

  // bmp: codec 產生的 {w,h,rgba,cvs}
  function addBitmap(name, bmp) {
    const n = uniqueName(name);
    state.imgs.push(mkImage(n, bmp));
    state.ann[n] = blankAnn(bmp.w, bmp.h);
    return n;
  }

  // 貼上的資料 -> 新圖片（+ 可能夾帶的標註）。回傳 {name, warning}
  function addDecoded(d, fallbackName) {
    const { w, h, rgba } = codec.decodePixels(d);
    const raw = String((d && d.name) || fallbackName || 'pasted').replace(/\.(png|json|js)$/i, '');
    const name = uniqueName(raw);
    stashSel();                                   // 切走前先記住目前這張的選取
    const im = mkImage(name, codec.bitmapFromRgba(w, h, rgba));
    state.imgs.push(im);

    const a = blankAnn(w, h);
    let warning = null;
    const P = d && d.parts;
    if (P && Array.isArray(P.grid)) {
      // 先確認尺寸再展開，尺寸不對就不必配置整份陣列
      const rows = P.grid.length, cols = rows ? (Array.isArray(P.grid[0]) ? P.grid[0].length : 0) : 0;
      const flatLen = P.grid.every(Array.isArray) ? P.grid.reduce((s, r) => s + r.length, 0) : -1;
      if (flatLen === w * h) {
        const grid = new Int16Array(w * h);
        let k = 0;
        for (const row of P.grid) for (const v of row) grid[k++] = v | 0;
        const names = P.names || {}, colors = P.colors || {};
        const ids = new Set();
        for (let i = 0; i < grid.length; i++) if (grid[i]) ids.add(grid[i]);
        Object.keys(names).forEach(key => { if (+key) ids.add(+key); });
        a.parts = [...ids].sort((x, y) => x - y).map((id, i) => ({
          id, name: names[id] || '部件', color: colors[id] || PART_PALETTE[i % PART_PALETTE.length]
        }));
        a.next = nextPartId(a.parts);
        a.grid = grid;
      } else {
        warning = `parts.grid 有 ${flatLen < 0 ? `${rows}×${cols}（列不是陣列）` : flatLen} 格，與 ${w}×${h} 不符，已略過標註`;
      }
    }
    recount(a, im);
    state.ann[name] = a;
    state.cur = state.imgs.length - 1;
    resetSel();
    return { name, warning };
  }

  // 目前這張圖是否有任何標註（關閉前要不要確認的依據）
  function hasAnnotation() {
    return has() && annot().annTotal > 0;
  }

  function closeCurrent() {
    if (!has()) return;
    endStroke();
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
    if (saved && Array.isArray(saved.shown) && (valid(saved.active) || saved.shown.some(valid))) {
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
    endStroke();
    stashSel();
    state.cur = i;
    restoreSel();
  }

  /* ---------- 復原 / 重做 ----------
     四種快照：
       snapshot(label)          整份標註網格（魔棒 / 同色全選 / 清空 / 刪部件 / 匯入）
       beginStroke(label)       標註稀疏 diff：之後 setPx 改到的格才記，pointerup 時 endStroke()
       snapshotImage(label)     整張點陣圖（裁切 / 像素化 —— 舊物件整個換掉，存參照就好）
       beginPixelStroke(label)  像素稀疏 diff：之後 paintPixel 改到的像素才記
     每筆都連部件清單一起存：刪除部件 / 匯入標註 / 清空之後復原，部件列才會跟著回來。
     記憶體用位元組預算管（past + future 合計），超過就整筆丟最舊的 —— 不再把舊快照
     「瘦身」成套用不了的形狀。 */

  function histOf(n) { return (state.hist[n] ||= { past: [], future: [] }); }

  const partsCopy = () => ({ parts: annot().parts.map(p => ({ ...p })), next: annot().next,
                             active: state.activePart, shown: [...state.shownParts] });

  const entryBytes = e =>
    (e.grid ? e.grid.byteLength : 0) +
    (e.diff ? e.diff.idx.byteLength + e.diff.val.byteLength : 0) +
    (e.pdiff ? e.pdiff.idx.byteLength + e.pdiff.rgba.byteLength : 0) +
    (e.rgba ? e.rgba.byteLength * 2 : 0);   // rgba + canvas backing store

  function trimHistory(h) {
    let bytes = 0;
    for (const e of h.past) bytes += entryBytes(e);
    for (const e of h.future) bytes += entryBytes(e);
    // 先丟最遠的重做，再丟最舊的復原；最近一筆復原永遠留著
    while (bytes > HIST_BUDGET && h.future.length) bytes -= entryBytes(h.future.shift());
    while ((bytes > HIST_BUDGET || h.past.length > UNDO_DEPTH) && h.past.length > 1) bytes -= entryBytes(h.past.shift());
  }

  function pushUndo(entry) {
    endStroke();
    const h = histOf(img().name);
    h.past.push(entry);
    h.future = [];                       // 新動作會讓 future 失去意義
    trimHistory(h);
  }

  // 只動到標註時用這個（整份網格）
  function snapshot(label) {
    if (!has()) return;
    pushUndo({ grid: Int16Array.from(annot().grid), ...partsCopy(), label: label || '標註' });
  }

  // 會換掉點陣圖本身時用這個（裁切 / 像素化）。舊的 rgba / cvs 之後整個被換掉，
  // 只剩快照引用，存參照即可，不必複製。
  function snapshotImage(label) {
    if (!has()) return;
    const im = img();
    pushUndo({ grid: Int16Array.from(annot().grid), ...partsCopy(), w: im.w, h: im.h, rgba: im.rgba, cvs: im.cvs,
               label: label || '編輯圖片' });
  }

  /* --- 稀疏 diff 錄製 --- */
  // rec：進行中的錄製。mask 標記「這一筆已經記過的格」，同一格只記第一次的舊值。
  let rec = null;   // {name, entry, mask, kind:'ann'|'px'}

  function growI32(a, need) { if (need <= a.length) return a; const b = new Int32Array(Math.max(need, a.length * 2)); b.set(a); return b; }
  function growI16(a, need) { if (need <= a.length) return a; const b = new Int16Array(Math.max(need, a.length * 2)); b.set(a); return b; }
  function growU8c(a, need) { if (need <= a.length) return a; const b = new Uint8ClampedArray(Math.max(need, a.length * 2)); b.set(a); return b; }

  let _mask = null;   // 共用的「這筆記過」遮罩，長度跟著目前圖片；錄製結束時只清掉動過的格
  function maskFor(n) {
    if (!_mask || _mask.length < n) _mask = new Uint8Array(n);
    return _mask;
  }

  function beginStroke(label) {
    if (!has()) return;
    const im = img();
    const entry = { diff: { idx: new Int32Array(256), val: new Int16Array(256), n: 0 }, ...partsCopy(), label: label || '標註' };
    pushUndo(entry);
    rec = { name: im.name, entry, mask: maskFor(im.w * im.h), kind: 'ann' };
  }

  function beginPixelStroke(label) {
    if (!has()) return;
    const im = img();
    const entry = { pdiff: { idx: new Int32Array(256), rgba: new Uint8ClampedArray(1024), n: 0 }, ...partsCopy(), label: label || '繪圖' };
    pushUndo(entry);
    rec = { name: im.name, entry, mask: maskFor(im.w * im.h), kind: 'px' };
  }

  // 錄製結束：清掉遮罩、把 diff 縮到實際長度（budget 才算得準）
  function endStroke() {
    if (!rec) return;
    const { entry, mask } = rec;
    const d = entry.diff || entry.pdiff;
    for (let i = 0; i < d.n; i++) mask[d.idx[i]] = 0;
    d.idx = d.idx.slice(0, d.n);
    if (entry.diff) d.val = d.val.slice(0, d.n);
    else d.rgba = d.rgba.slice(0, d.n * 4);
    rec = null;
  }

  // 錄一格標註的舊值（setPx 呼叫）
  function recAnn(i, old) {
    if (!rec || rec.kind !== 'ann' || rec.mask[i]) return;
    rec.mask[i] = 1;
    const d = rec.entry.diff;
    d.idx = growI32(d.idx, d.n + 1);
    d.val = growI16(d.val, d.n + 1);
    d.idx[d.n] = i; d.val[d.n] = old; d.n++;
  }

  // 錄一個像素的舊色（paintPixel 呼叫）
  function recPx(i, r, g, b, a) {
    if (!rec || rec.kind !== 'px' || rec.mask[i]) return;
    rec.mask[i] = 1;
    const d = rec.entry.pdiff;
    d.idx = growI32(d.idx, d.n + 1);
    d.rgba = growU8c(d.rgba, (d.n + 1) * 4);
    const p = d.n * 4;
    d.idx[d.n] = i; d.rgba[p] = r; d.rgba[p + 1] = g; d.rgba[p + 2] = b; d.rgba[p + 3] = a;
    d.n++;
  }

  // 目前狀態打成「與 e 同形狀」的 entry（undo 之前先把現在的樣子存進 future，redo 才回得來）
  function counterpartOf(e, label) {
    const im = img(), a = annot();
    const base = { ...partsCopy(), label };
    if (e.diff) {
      const { idx: ix, n } = e.diff;
      const val = new Int16Array(n);
      for (let i = 0; i < n; i++) val[i] = a.grid[ix[i]];
      return { ...base, diff: { idx: ix, val, n } };          // idx 共用同一份即可（唯讀）
    }
    if (e.pdiff) {
      const { idx: ix, n } = e.pdiff;
      const rgba = new Uint8ClampedArray(n * 4), d = im.rgba;
      for (let i = 0; i < n; i++) { const p = ix[i] * 4, q = i * 4; rgba[q] = d[p]; rgba[q + 1] = d[p + 1]; rgba[q + 2] = d[p + 2]; rgba[q + 3] = d[p + 3]; }
      return { ...base, pdiff: { idx: ix, rgba, n } };
    }
    if (e.rgba) return { ...base, grid: Int16Array.from(a.grid), w: im.w, h: im.h, rgba: im.rgba, cvs: im.cvs };
    return { ...base, grid: Int16Array.from(a.grid) };
  }

  // 把像素 diff 寫回 rgba 與 canvas
  function applyPixelDiff(im, pd) {
    const { idx: ix, rgba: src, n } = pd, d = im.rgba;
    for (let i = 0; i < n; i++) {
      const p = ix[i] * 4, q = i * 4;
      d[p] = src[q]; d[p + 1] = src[q + 1]; d[p + 2] = src[q + 2]; d[p + 3] = src[q + 3];
    }
    const cx = im.cvs.getContext('2d');
    if (n <= 2048) {
      // 少量：逐點寫回；putImageData 不做 alpha 混合，寫出來就是精確值
      const one = new ImageData(1, 1);
      for (let i = 0; i < n; i++) {
        const q = i * 4;
        one.data[0] = src[q]; one.data[1] = src[q + 1]; one.data[2] = src[q + 2]; one.data[3] = src[q + 3];
        cx.putImageData(one, ix[i] % im.w, (ix[i] / im.w) | 0);
      }
    } else {
      cx.putImageData(new ImageData(d, im.w, im.h), 0, 0);
    }
    touchBitmap(im);
  }

  // 回傳這次套用有沒有改到圖片尺寸（ui 據此決定要不要重新貼合縮放）；
  // entry 跟目前圖片對不上（不該發生）時回傳 null，呼叫端要把它丟掉。
  function applyEntry(e) {
    const im = img(), a = annot();
    const before = `${im.w}×${im.h}`;
    if (e.rgba) {
      if (!e.grid || e.grid.length !== e.w * e.h || e.rgba.length !== e.w * e.h * 4) return null;
      im.w = e.w; im.h = e.h; im.rgba = e.rgba; im.cvs = e.cvs; im._ctx = null;
      touchBitmap(im);
      state.crop = null;
      a.grid = e.grid;
      recount(a, im);
    } else if (e.grid) {
      if (e.grid.length !== im.w * im.h) return null;
      a.grid = e.grid;
      recount(a, im);
    } else if (e.diff) {
      const { idx: ix, val, n } = e.diff, g = a.grid, d = im.rgba, counts = a.counts;
      for (let i = 0; i < n; i++) {
        const k = ix[i];
        if (k >= g.length) continue;
        const old = g[k], v = val[i];
        if (old === v) continue;
        g[k] = v;
        const op = d[k * 4 + 3] >= 128;
        if (old) { counts[old]--; a.annTotal--; if (op) a.annOpaque--; }
        if (v) { counts[v] = (counts[v] || 0) + 1; a.annTotal++; if (op) a.annOpaque++; }
      }
    } else if (e.pdiff) {
      applyPixelDiff(im, e.pdiff);
      recount(a, im);   // 像素透明度變了會影響 annOpaque
    }
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
      // 部件被刪掉又復原（或反過來）：counts 裡可能留著不存在的 id，清一下
      for (const k of Object.keys(a.counts)) if (!a.counts[k]) delete a.counts[k];
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
    endStroke();
    const h = histOf(img().name);
    const e = h.past.pop();
    const back = counterpartOf(e, e.label);
    const resized = applyEntry(e);
    if (resized === null) {           // 對不上的快照：連同更舊的一起丟掉，canUndo 才誠實
      h.past.length = 0;
      return null;
    }
    h.future.push(back);
    return { label: e.label, resized };
  }

  function redoOnce() {
    if (!canRedo()) return null;
    endStroke();
    const h = histOf(img().name);
    const e = h.future.pop();
    const back = counterpartOf(e, e.label);
    const resized = applyEntry(e);
    if (resized === null) { h.future.length = 0; return null; }
    h.past.push(back);
    return { label: e.label, resized };
  }

  // 撤掉最近一筆但不進 future（取消進行中的筆畫用：那一筆不該變成可重做）
  function cancelLastAction() {
    if (!canUndo()) return null;
    endStroke();
    const h = histOf(img().name);
    const e = h.past.pop();
    const resized = applyEntry(e);
    if (resized === null) { h.past.length = 0; return null; }
    return { label: e.label, resized };
  }

  // 歷史面板用：past 由舊到新、future 由「下一步」往後
  function historyLabels() {
    if (!has()) return { past: [], future: [] };
    const h = histOf(img().name);
    return { past: h.past.map(e => e.label), future: [...h.future].reverse().map(e => e.label) };
  }

  /* ---------- 塗畫 ---------- */

  const paintable = (x, y) => inBounds(x, y) && (state.paintAlpha || alphaAt(x, y) >= 128);

  function setPx(x, y, v) {
    if (!paintable(x, y)) return;
    const a = annot(), i = idx(x, y), g = a.grid, old = g[i];
    if (old === v) return;
    g[i] = v;
    recAnn(i, old);
    const op = img().rgba[i * 4 + 3] >= 128;
    if (old) { a.counts[old]--; a.annTotal--; if (op) a.annOpaque--; }
    if (v) { a.counts[v] = (a.counts[v] || 0) + 1; a.annTotal++; if (op) a.annOpaque++; }
  }

  function brushAt(x, y, v) {
    const r = state.brush - 1;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) setPx(x + dx, y + dy, v);
  }

  // 泛洪共用：scanline fill。堆疊只存每條水平 span 的起點，比 4-鄰域逐格 push 少幾個數量級。
  function floodFrom(x, y, visit) {
    const im = img(), w = im.w, h = im.h, d = im.rgba;
    if (!inBounds(x, y)) return;
    const pix = i => (d[i * 4] << 24 | d[i * 4 + 1] << 16 | d[i * 4 + 2] << 8 | d[i * 4 + 3]) >>> 0;
    const target = pix(y * w + x);
    const seen = new Uint8Array(w * h);
    let stack = new Int32Array(64), sp = 0;
    const push = i => { if (sp === stack.length) stack = growI32(stack, sp + 1); stack[sp++] = i; };
    push(y * w + x);
    while (sp) {
      let i = stack[--sp];
      if (seen[i] || pix(i) !== target) continue;
      const cy = (i / w) | 0;
      let cx = i % w;
      while (cx > 0 && !seen[i - 1] && pix(i - 1) === target) { cx--; i--; }
      let spanUp = false, spanDown = false;
      while (cx < w && !seen[i] && pix(i) === target) {
        seen[i] = 1;
        visit(i, cx, cy);
        if (cy > 0) {
          const up = i - w;
          if (!seen[up] && pix(up) === target) { if (!spanUp) { push(up); spanUp = true; } }
          else spanUp = false;
        }
        if (cy + 1 < h) {
          const dn = i + w;
          if (!seen[dn] && pix(dn) === target) { if (!spanDown) { push(dn); spanDown = true; } }
          else spanDown = false;
        }
        cx++; i++;
      }
    }
  }

  // 從 (x,y) 出發，填滿相連的同色區域
  function floodSameColour(x, y, v) {
    floodFrom(x, y, (i, cx, cy) => setPx(cx, cy, v));
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
  // 回傳的 mask 是共用緩衝，下一次呼叫會被覆寫；呼叫端拿到就要用掉。
  // 同一張圖、同一種工具、同一個目標色、游標仍在上一次的遮罩內 → 直接回上一次的結果
  //（魔棒的結果只跟起點所在的連通區有關，同一區內移動不必重算）。
  let _sel = null;   // {im, rev, kind, target, alpha, mask, count}
  function selectionMask(x, y, kind) {
    const im = img(), { w, h } = im;
    if (!inBounds(x, y)) return { mask: new Uint8Array(0), count: 0 };
    const target = rgbaAt(x, y), i0 = y * w + x;
    if (_sel && _sel.im === im && _sel.rev === im.rev && _sel.kind === kind && _sel.target === target &&
        _sel.alpha === state.paintAlpha && _sel.mask.length === w * h && (kind === 'same' || _sel.mask[i0]))
      return { mask: _sel.mask, count: _sel.count };
    const mask = (_sel && _sel.mask.length === w * h) ? _sel.mask : new Uint8Array(w * h);
    mask.fill(0);
    let count = 0;
    if (kind === 'same') {
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++)
          if (rgbaAt(xx, yy) === target && paintable(xx, yy)) { mask[yy * w + xx] = 1; count++; }
    } else {
      floodFrom(x, y, (i, cx, cy) => { if (paintable(cx, cy)) { mask[i] = 1; count++; } });
    }
    _sel = { im, rev: im.rev, kind, target, alpha: state.paintAlpha, mask, count };
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
    const a = annot(), n = a.annTotal;
    a.grid.fill(0);
    a.counts = {}; a.annTotal = 0; a.annOpaque = 0;
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
    const a = annot(), im = img(), g = a.grid, d = im.rgba;
    let t = 0, o = 0;
    for (let i = 0; i < g.length; i++) if (g[i] === id) { g[i] = 0; t++; if (d[i * 4 + 3] >= 128) o++; }
    delete a.counts[id];
    a.annTotal -= t; a.annOpaque -= o;
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

  // 從外部 JSON 覆蓋整組標註。尺寸不符回傳錯誤訊息（不改任何東西）；成功回傳 null
  function applyAnnotation(d) {
    if (!has()) return '沒有開啟的圖片';
    const im = img(), a = annot();
    const P = d && d.parts;
    if (!P || !Array.isArray(P.grid) || !P.grid.every(Array.isArray)) return '這個檔案沒有 parts.grid';
    const flatLen = P.grid.reduce((s, r) => s + r.length, 0);
    if (flatLen !== im.w * im.h) return `parts.grid 有 ${flatLen} 格，與 ${im.w}×${im.h} 不符`;
    const grid = new Int16Array(im.w * im.h);
    let k = 0;
    for (const row of P.grid) for (const v of row) grid[k++] = v | 0;
    a.parts = Object.entries(P.names || {}).map(([key, v], i) =>
      ({ id: +key, name: v, color: (P.colors || {})[key] || PART_PALETTE[i % PART_PALETTE.length] }));
    a.next = nextPartId(a.parts);
    a.grid = grid;
    recount(a, im);
    resetSel();
    return null;
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

  // 用 putImageData 而不是 fillRect：後者會做 alpha 混合，寫不出精確的顏色。
  // ImageData 跟 _one 共用同一塊記憶體，改 _one 再 put 就好，不必每個像素都 new。
  const _one = new Uint8ClampedArray(4);
  const _oneID = new ImageData(_one, 1, 1);
  function paintPixel(x, y, c) {
    if (!has() || !inBounds(x, y)) return false;
    const im = img(), i = idx(x, y), p = i * 4, d = im.rgba;
    const r0 = d[p], g0 = d[p + 1], b0 = d[p + 2], a0 = d[p + 3];
    if (r0 === c[0] && g0 === c[1] && b0 === c[2] && a0 === c[3]) return false;
    recPx(i, r0, g0, b0, a0);
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = c[3];
    _one[0] = c[0]; _one[1] = c[1]; _one[2] = c[2]; _one[3] = c[3];
    (im._ctx ||= im.cvs.getContext('2d')).putImageData(_oneID, x, y);
    // 透明度跨過門檻：不透明像素數與「有標註且不透明」數要跟著動
    const was = a0 >= 128, now = c[3] >= 128;
    if (was !== now) {
      const a = annot();
      if (a.grid[i]) a.annOpaque += now ? 1 : -1;
      // 不透明像素數的快取若還是新的，就地更新並讓它跟上新版本，免得下一次 coverage 重掃整張圖
      if (im._opaque !== undefined && im._opaqueRev === im.rev) { im._opaque += now ? 1 : -1; im._opaqueRev = im.rev + 1; }
    } else if (im._opaque !== undefined && im._opaqueRev === im.rev) im._opaqueRev = im.rev + 1;
    im.rev++;
    return true;
  }

  // 目前圖片用到的顏色 —— 修圖時直接點現成的色最省事。
  // 顏色數在上限內：全部列出（依出現次數）。超過上限：不能只取「最常出現的 N 個」——
  // 還沒減色的 AI 圖前 48 名幾乎全是差 1–2 階的灰，整片調色盤長得一模一樣、什麼都選不到；
  // 改成在最常見的候選裡挑「彼此在 OKLab 上距離最遠」的 N 個（以出現次數的平方根加權），
  // 看得出差別的顏色才會出現。結果依 (圖, 版本) 快取：像素沒改就不必重掃。
  const PAL_CANDIDATES = 512;
  function imagePalette(limit = 48) {
    if (!has()) return [];
    const im = img();
    if (im._pal && im._palRev === im.rev && im._palLimit === limit) return im._pal;
    const map = new Map();
    for (let p = 0; p < im.rgba.length; p += 4) {
      if (im.rgba[p + 3] < 8) continue;
      const k = (im.rgba[p] << 16) | (im.rgba[p + 1] << 8) | im.rgba[p + 2];
      map.set(k, (map.get(k) || 0) + 1);
    }
    const byCount = [...map.entries()].sort((a, b) => b[1] - a[1]);
    let picked;
    if (byCount.length <= limit) picked = byCount;
    else {
      const cand = byCount.slice(0, PAL_CANDIDATES);
      const lab = cand.map(([k]) => PA.pixelate.toOklab((k >> 16) & 255, (k >> 8) & 255, k & 255));
      const wgt = cand.map(([, c]) => Math.sqrt(c));
      const dist = new Float64Array(cand.length).fill(Infinity);
      const chosen = [0];                       // 從最常見的色起頭
      while (chosen.length < limit) {
        const c = lab[chosen[chosen.length - 1]];
        let bi = -1, bv = -1;
        for (let i = 0; i < cand.length; i++) {
          const d = (lab[i][0] - c[0]) ** 2 + (lab[i][1] - c[1]) ** 2 + (lab[i][2] - c[2]) ** 2;
          if (d < dist[i]) dist[i] = d;
          const v = dist[i] * wgt[i];
          if (v > bv) { bv = v; bi = i; }
        }
        if (bi < 0 || dist[bi] === 0) break;   // 候選都被挑完 / 剩下的都跟已選的一樣
        chosen.push(bi);
      }
      picked = chosen.map(i => cand[i]);
    }
    const out = picked.map(([k]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255, 255]);
    im._pal = out; im._palRev = im.rev; im._palLimit = limit;
    return out;
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
  // 目前的裁切範圍是不是整張圖（套用了等於沒裁）
  function cropIsNoop() {
    const c = state.crop;
    if (!c || !has()) return true;
    const im = img();
    return c.x === 0 && c.y === 0 && c.w === im.w && c.h === im.h;
  }

  // 像素與標註一起裁，兩張網格必須同步，否則標註會整個錯位
  function applyCrop() {
    const c = state.crop;
    if (!c || !has()) return false;
    const im = img(), a = annot();
    if (cropIsNoop()) return false;
    endStroke();

    const rgba = new Uint8ClampedArray(c.w * c.h * 4);
    const grid = new Int16Array(c.w * c.h);
    for (let y = 0; y < c.h; y++) {
      const srcRow = (c.y + y) * im.w + c.x, dstRow = y * c.w;
      rgba.set(im.rgba.subarray(srcRow * 4, (srcRow + c.w) * 4), dstRow * 4);
      grid.set(a.grid.subarray(srcRow, srcRow + c.w), dstRow);
    }
    const bmp = codec.bitmapFromRgba(c.w, c.h, rgba);
    im.w = c.w; im.h = c.h; im.rgba = bmp.rgba; im.cvs = bmp.cvs; im._ctx = null;
    touchBitmap(im);
    a.grid = grid;
    recount(a, im);
    state.crop = null;
    return true;
  }

  // 整張換掉點陣圖（像素化用）。尺寸變了，舊標註無法對應，所以清空；
  // 呼叫端要先 snapshotImage()，Ctrl+Z 才復原得回來。部件清單保留。
  function replaceImage(bmp) {
    if (!has()) return false;
    endStroke();
    const im = img(), a = annot();
    im.w = bmp.w; im.h = bmp.h; im.rgba = bmp.rgba; im.cvs = bmp.cvs; im._ctx = null;
    touchBitmap(im);
    a.grid = new Int16Array(bmp.w * bmp.h);
    a.counts = {}; a.annTotal = 0; a.annOpaque = 0;
    state.crop = null;
    return true;
  }

  /* ---------- 匯出 ---------- */
  const exportData = () => codec.encode(img(), annot());

  /* ---------- 存檔 ----------
     payload = { v:2, savedAt, imgs:[{name,w,h,idb?,url?}], ann:{name:{parts,next,grid(RLE)}}, sel, cur }
     - 點陣圖進 IndexedDB（鍵 = 檔名，值 = {w,h,rgba}）；localStorage 只留元資料 + 標註，避開 5–10MB 配額
     - IDB 失敗或尚未寫入的圖仍附 dataURL（依 rev 快取），pagehide 同步路徑才能不丟資料
     - 回傳 {ok, reason?, bytes?}；reason = 'quota' | 'foreign' | 'error'
     - 配額失敗：保留舊快照（總比全丟好），另外寫一個 stale 時間戳，restore 時據實以告
     - 另一個分頁寫過較新的資料（storage 事件）：這個分頁停止自動保存，直到 takeOver() */

  let lastWrite = 0;          // 這個分頁最後一次成功寫入的 savedAt
  let foreignWrite = 0;       // 另一個分頁寫入的 savedAt（0 = 沒有）
  const foreignListeners = [];

  const IDB_NAME = 'pixann', IDB_STORE = 'bitmaps';
  let _idb = null;
  const idbOpen = () => {
    if (_idb) return _idb;
    if (typeof indexedDB === 'undefined') return _idb = Promise.reject(new Error('no idb'));
    _idb = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(IDB_NAME, 1); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(e => { _idb = null; throw e; });
    return _idb;
  };
  const idbTx = (db, mode) => {
    const tx = db.transaction(IDB_STORE, mode);
    return { tx, store: tx.objectStore(IDB_STORE), done: new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('aborted'));
    }) };
  };
  async function idbPutBitmap(im) {
    const db = await idbOpen();
    const copy = im.rgba.slice();
    const { store, done } = idbTx(db, 'readwrite');
    store.put({ w: im.w, h: im.h, rev: im.rev, rgba: copy.buffer }, im.name);
    await done;
    im._idbRev = im.rev;
  }
  async function idbGetBitmap(name) {
    const db = await idbOpen();
    const { store } = idbTx(db, 'readonly');
    const rec = await new Promise((res, rej) => {
      const r = store.get(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!rec || rec.w < 1 || rec.h < 1 || !rec.rgba) return null;
    return { bmp: codec.bitmapFromRgba(rec.w, rec.h, new Uint8ClampedArray(rec.rgba)), rev: rec.rev };
  }
  async function idbPrune(keep) {
    const db = await idbOpen();
    const keys = await new Promise((res, rej) => {
      const { store } = idbTx(db, 'readonly');
      const r = store.getAllKeys();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
    const drop = keys.filter(k => !keep.has(k));
    if (!drop.length) return;
    const { store, done } = idbTx(db, 'readwrite');
    for (const k of drop) store.delete(k);
    await done;
  }
  async function idbClear() {
    try {
      const db = await idbOpen();
      const { store, done } = idbTx(db, 'readwrite');
      store.clear();
      await done;
    } catch (e) {}
  }

  function dataUrlOf(im) {
    if (im._url && im._urlRev === im.rev) return im._url;
    im._url = im.cvs.toDataURL();
    im._urlRev = im.rev;
    return im._url;
  }

  const isQuotaError = e => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                                    e.code === 22 || e.code === 1014);

  function save() {
    if (foreignWrite) return { ok: false, reason: 'foreign' };
    stashSel();
    const savedAt = Date.now();
    let payload;
    try {
      payload = JSON.stringify({
        v: 2, savedAt,
        imgs: state.imgs.map(im => {
          const rec = { name: im.name, w: im.w, h: im.h };
          if (im._idbRev === im.rev) { rec.idb = 1; rec.rev = im.rev; }
          else rec.url = dataUrlOf(im);
          return rec;
        }),
        ann: Object.fromEntries(Object.entries(state.ann).map(([k, v]) =>
          [k, { parts: v.parts, next: v.next, grid: codec.packGrid(v.grid) }])),
        sel: state.selByImg,
        cur: state.cur,
      });
    } catch (e) { return { ok: false, reason: 'error' }; }
    try {
      localStorage.setItem(LS_KEY, payload);
      lastWrite = savedAt;
      try { localStorage.removeItem(LS_STALE); } catch (e) {}
      return { ok: true, bytes: payload.length };
    } catch (e) {
      try { localStorage.setItem(LS_STALE, String(savedAt)); } catch (e2) {}
      return { ok: false, reason: isQuotaError(e) ? 'quota' : 'error' };
    }
  }

  // 先把髒的點陣圖寫進 IDB，再寫 localStorage（此時多數圖不必夾 dataURL）
  async function persist() {
    if (foreignWrite) return { ok: false, reason: 'foreign' };
    try {
      for (const im of state.imgs) {
        if (im._idbRev === im.rev) continue;
        await idbPutBitmap(im);
      }
      await idbPrune(new Set(state.imgs.map(im => im.name)));
    } catch (e) { /* IDB 不可用：save() 會改夾 dataURL */ }
    return save();
  }

  function loadFromUrl(url) {
    return new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => {
        try { resolve(codec.bitmapFromImage(el)); }
        catch (e) { reject(e); }
      };
      el.onerror = () => reject(new Error('decode'));
      el.src = url;
    });
  }

  // 圖片要非同步解碼，所以用 callback 回報完成：done(ok, info)
  // info = { stale: number|null（配額失敗的時間戳）, savedAt, migrated, failed:[name] }
  function restore(done) {
    let raw = null, legacy = false;
    try {
      raw = localStorage.getItem(LS_KEY);
      if (!raw) { raw = localStorage.getItem(LS_KEY_LEGACY); legacy = !!raw; }
    } catch (e) { return done(false, {}); }
    if (!raw) return done(false, {});
    let p;
    try { p = JSON.parse(raw); } catch (e) { clearSaved(); return done(false, { corrupt: true }); }
    if (!p || !Array.isArray(p.imgs) || !p.imgs.length) return done(false, {});

    let stale = null;
    try { const s = +localStorage.getItem(LS_STALE); if (s && (!p.savedAt || s > p.savedAt)) stale = s; } catch (e) {}
    const info = { stale, savedAt: p.savedAt || null, migrated: legacy, failed: [] };

    const slots = new Array(p.imgs.length);
    let pending = p.imgs.length;
    const finish = () => {
      try {
        // 解碼失敗的洞要對映回 cur：slots 壓縮之後索引會位移
        const keep = [];
        slots.forEach((s, i) => { if (s) keep.push(i); });
        state.imgs = keep.map(i => slots[i]);
        state.ann = {}; state.hist = {};
        const ann = (p.ann && typeof p.ann === 'object') ? p.ann : {};
        for (const im of state.imgs) {
          const v = ann[im.name];
          let a = null;
          if (v && typeof v === 'object') {
            const grid = codec.unpackGrid(v.grid, im.w * im.h);
            if (grid) {
              a = { parts: Array.isArray(v.parts) ? v.parts.filter(q => q && typeof q === 'object' && +q.id)
                              .map(q => ({ id: +q.id, name: String(q.name ?? '部件'), color: String(q.color || PART_PALETTE[0]) })) : [],
                    next: Math.max(1, +v.next || 0), grid };
              a.next = nextPartId(a.parts, a.next);
            } else info.failed.push(im.name + '（標註與圖片尺寸不符，已略過）');
          }
          state.ann[im.name] = a || blankAnn(im.w, im.h);
          recount(state.ann[im.name], im);
        }
        // 只留有圖片的標註（孤兒不再被寫回去）
        state.selByImg = (p.sel && typeof p.sel === 'object') ? p.sel : {};
        for (const k of Object.keys(state.selByImg)) if (!state.ann[k]) delete state.selByImg[k];
        const want = keep.indexOf(p.cur ?? 0);
        state.cur = state.imgs.length ? Math.max(0, want) : -1;
        restoreSel();
        done(state.imgs.length > 0, info);
      } catch (e) {
        // 讀進來的資料有問題：不要留在半還原狀態，也不要下次再踩一次
        state.imgs = []; state.ann = {}; state.hist = {}; state.selByImg = {}; state.cur = -1;
        clearSaved();
        done(false, { corrupt: true });
      }
    };
    // 圖片解碼是非同步的；全部（成功或失敗）回來才 finish。
    // 用 setTimeout 讓 finish 一律在下一個 task 跑，避免同步失敗時 finish 早於這個迴圈結束。
    const settle = () => { if (--pending === 0) setTimeout(finish, 0); };
    p.imgs.forEach((rec_, i) => {
      const name = String((rec_ && rec_.name) || `image${i}`);
      const url = rec_ && typeof rec_.url === 'string' ? rec_.url : '';
      const wantIdb = !!(rec_ && rec_.idb);
      const ok = (bmp, fromIdb) => {
        try {
          const im = mkImage(name, bmp);
          if (fromIdb) im._idbRev = im.rev;
          slots[i] = im;
        } catch (e) { info.failed.push(name); }
        settle();
      };
      const fail = () => { info.failed.push(name); settle(); };
      (async () => {
        if (wantIdb) {
          try {
            const got = await idbGetBitmap(name);
            if (got && (rec_.rev == null || rec_.rev === got.rev)) return ok(got.bmp, true);
          } catch (e) {}
        }
        if (url) {
          try { return ok(await loadFromUrl(url), false); }
          catch (e) { return fail(); }
        }
        fail();
      })();
    });
  }

  function clearSaved() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    try { localStorage.removeItem(LS_STALE); } catch (e) {}
    idbClear();
  }

  // 另一個分頁寫了較新的資料 → 記下來並通知 ui；save() 之後會拒絕寫入，避免互相覆蓋
  try {
    window.addEventListener('storage', e => {
      if (e.key !== LS_KEY || !e.newValue) return;
      let t = 0;
      try { t = +(JSON.parse(e.newValue).savedAt) || 0; } catch (err) { return; }
      if (t && t > lastWrite) {
        foreignWrite = t;
        foreignListeners.forEach(cb => { try { cb(t); } catch (err) {} });
      }
    });
  } catch (e) {}
  const onForeignSave = cb => { foreignListeners.push(cb); };
  const takeOver = () => { foreignWrite = 0; };
  const hasForeignWrite = () => !!foreignWrite;

  return {
    state, PART_PALETTE,
    has, img, annot, idx, partById, rgbaAt, alphaAt, inBounds, partCounts, coverage, hasAnnotation,
    addBitmap, addDecoded, closeCurrent, select, uniqueName,
    snapshot, snapshotImage, beginStroke, beginPixelStroke, endStroke, cancelLastAction,
    canUndo, canRedo, undoLabel, redoLabel, undoOnce, redoOnce, historyLabels,
    setCrop, clearCrop, cropWholeImage, cropIsNoop, applyCrop, replaceImage,
    pixelAt, paintPixel, imagePalette,
    setPx, brushAt, floodSameColour, allSameColour, selectionMask, strokeTo, clearGrid,
    addPart, deletePart, renamePart, setPartColor, movePart, applyAnnotation,
    setActive, toggleShown, soloShown, setHover, resetSel,
    exportData, save, persist, restore, clearSaved, onForeignSave, takeOver, hasForeignWrite,
  };
})();
