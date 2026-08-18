/* ui/pixelate-dialog — 全部 px* 狀態、偵測、重算、取消、來源圖片與事件。不得呼叫 PA.ui。 */
window.PA = window.PA || {};
PA._ui = PA._ui || {};

PA._ui.createPixelateDialog = function(host) {
  const $ = id => host.$(id);
  const store = host.store, codec = host.codec, S = host.S;
  const toast = (...a) => host.toast(...a);
  const save_ = () => host.markDirty();
  const fit = () => host.fit();
  const renderAll = () => host.renderAll();
  const openDialog = (...a) => host.openDialog(...a);
  const closeDialog = (...a) => host.closeDialog(...a);
  const doUndo = (...a) => host.doUndo(...a);

  let pxGrid = null, pxResult = null;
  let pxLockRatio = false;   // 格數是否鎖住原圖長寬比
  let pxProfiles = null, pxProfileIm = null, pxProfileRev = -1;   // 邊緣能量只跟點陣圖有關，依 (圖, 版本) 快取
  let pxAbort = false, pxBusy = false;
  const PX_K_DEFAULT = 48;   // 像素化的預設顏色上限（0 = 不減色）
  const PX_DEFAULT = 'pixel-perfecter';   // 預設方法（四路幾何偵測）
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
      const raw = $('px-method').value || PX_DEFAULT;
      const p = raw === 'custom' ? null : PA.pixelate.getPreset(raw);
      localStorage.setItem(PX_PREFS_KEY, JSON.stringify({
        preset: (p && p.id) || raw,
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
    const wantRaw = prev || (saved && saved.preset) || PX_DEFAULT;
    const resolved = wantRaw === 'custom' ? null : PA.pixelate.getPreset(wantRaw);
    const want = resolved ? resolved.id : wantRaw;
    if ([...sel.options].some(o => o.value === want)) sel.value = want;
    else if ([...sel.options].some(o => o.value === PX_DEFAULT)) sel.value = PX_DEFAULT;
    else if (sel.options.length) sel.value = sel.options[0].value;
    pxSyncDetChecks();
  }
  function pxCurrentPreset() {
    const id = $('px-method').value;
    if (!id || id === 'custom') return null;
    return PA.pixelate.getPreset(id);
  }
  function pxSyncDetChecks() {
    const p = pxCurrentPreset();
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
    const p = pxCurrentPreset();
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
    const p = pxCurrentPreset();
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

  function bind() {
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
  }

  return {
    bind,
    openPixelate, closePixelate, applyPixelate, pxDetect, pxLoadFile,
    imageFilesFrom, pxPasteFromClipboard, pxFillMethods,
    get busy() { return pxBusy; },
    abort() { pxAbort = true; if (PA.pixelate.cancelJobs) PA.pixelate.cancelJobs(); },
    modal: pxModal,
  };
};
