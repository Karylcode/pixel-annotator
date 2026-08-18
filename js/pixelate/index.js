/* pixelate/index.js — 註冊表、預設組合、runPipeline、callAsync。
   純運算掛在 PA.pixelate；主執行緒另見檔尾 callAsync。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const stages = { detect: [], sample: [], quant: [], dither: [], clean: [] };

  function register(stage, def) {
    if (!stages[stage]) throw new Error('未知的像素化階段：' + stage);
    if (!def || !def.id) throw new Error('註冊項目缺少 id');
    const list = stages[stage];
    const i = list.findIndex(d => d.id === def.id);
    if (i >= 0) list[i] = def;
    else list.push(def);
  }

  function list(stage) {
    return (stages[stage] || []).slice();
  }

  function get(stage, id) {
    return (stages[stage] || []).find(d => d.id === id) || null;
  }

  const queued = PA.pixelate._pendingRegs || [];
  PA.pixelate.register = register;
  PA.pixelate.list = list;
  PA.pixelate.get = get;
  PA.pixelate._pendingRegs = [];
  for (let i = 0; i < queued.length; i++) register(queued[i][0], queued[i][1]);

  PA.pixelate.presets = [
    {
      id: 'pixel-art-fixer',
      label: '三偵測器共識',
      source: 'Pixel Art Fixer',
      desc: '三個獨立偵測器（自相關梳狀／run-length soft-GCD／位移自相似）取共識，'
          + '再用兩階段重建上色（先用量化標籤投票決定每格屬於哪一區，再取該區原始像素的平均）。'
          + '原專案 pixel-bench 宣稱 native 解析度精確還原 77%。',
      config: { detectors: ['autocorr', 'runlength', 'selfsim'], precise: false, sample: 'two-stage', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'pixel-art-fixer-full',
      label: '全偵測器仲裁',
      source: 'Pixel Art Fixer',
      desc: '上面三個再加 perfectPixel 的 FFT 與 pixel-perfecter，並開啟原專案 Stage 2 的'
          + '變異數對比與 round-trip 重建誤差仲裁。最慢，給難圖用。',
      config: { detectors: ['autocorr', 'runlength', 'selfsim', 'fft', 'perfecter'], precise: true, sample: 'two-stage', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'perfectPixel',
      label: 'FFT 主週期偵測',
      source: 'perfectPixel',
      desc: 'FFT 抓梯度剖面的主週期得格寬，再用邊緣精修對齊。整數倍放大時最快最準。',
      config: { detectors: ['fft'], precise: false, sample: 'center-median', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'pixel-perfecter',
      label: '四路幾何偵測',
      source: 'pixel-perfecter',
      desc: '四路子偵測：精確最近鄰檢查、Canny 投影、自相關、phase-fold 掃描，'
          + '再用統一分數「格間對比 / √格內變異」挑，並用眾數取色。',
      config: { detectors: ['perfecter'], precise: false, sample: 'dominant', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'proper-pixel-art',
      label: '霍夫格線偵測',
      source: 'proper-pixel-art',
      desc: '幾何路線（與其他方法的頻域思路完全不同）：Canny 邊緣 → 形態學閉合 →'
          + '軸向霍夫取線 → 分群 → 修剪中位間距。',
      config: { detectors: ['hough'], precise: false, sample: 'dominant', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'unfake.js',
      label: '連續同色段偵測 + 清理層',
      source: 'unfake.js',
      desc: '同色 run 長度偵測 + 眾數取色，並套用它招牌的清理層：'
          + '補洞、去雜點、修鋸齒、alpha 二值化。',
      config: { detectors: ['runs', 'autocorr'], precise: false, sample: 'dominant', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg', 'holes', 'specks', 'jaggies', 'alpha'], snap: false },
    },
    {
      id: 'spritegrid',
      label: '幾何中位數取色',
      source: 'spritegrid',
      desc: '格線用 Pixel Art Fixer 的共識，取色改用 Weiszfeld 幾何中位數：'
          + '比逐通道中位數更抗離群，且吸附回格內既有顏色，不會冒出原圖沒有的色。',
      config: { detectors: ['autocorr', 'runlength', 'selfsim'], precise: false, sample: 'geomedian', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'PixelOE',
      label: '輪廓感知降採樣',
      source: 'PixelOE',
      desc: '不偵測格線，由你指定目標寬度。降採樣前先做輪廓擴張（依局部亮度分布加權膨脹／侵蝕）'
          + '保住 1px 細線，再做對比感知降採樣（LAB 空間，亮度取局部極值、色度取中位數）。',
      config: { detectors: [], precise: false, sample: 'pixeloe', quant: 'oklab-kmeans', k: 48, dither: 'none', ditherStrength: 0.5, clean: [], snap: false, targetWidth: 64 },
    },
    {
      id: 'Image-to-Pixel',
      label: '指定寬度 + 抖色',
      source: 'Image-to-Pixel',
      desc: '不偵測格線，由你指定目標寬度；減色後套用抖色（預設 Floyd–Steinberg，可換 Bayer／Ordered／Atkinson）。',
      config: { detectors: [], precise: false, sample: 'center-median', quant: 'oklab-kmeans', k: 32, dither: 'fs', ditherStrength: 0.5, clean: [], snap: false, targetWidth: 64 },
    },
    {
      id: 'legacy',
      label: '本工具原版引擎',
      source: '本工具（legacy）',
      desc: '本工具原本的差分能量偵測 + 格心中位數取色。保留作為回歸基準，輸出與重寫前逐位相同。',
      config: { detectors: ['legacy'], precise: false, sample: 'center-median', quant: 'oklab-kmeans', k: 48, dither: 'none', ditherStrength: 0.5, clean: ['bg'], snap: false, legacyPhase: true, detectNative: false },
    },
  ];

  // 舊版 UI／CLI／文件用的名稱；presets 只留正式 ID，UI 選單不會出現重複項
  PA.pixelate.presetAliases = {
    standard: 'pixel-art-fixer',
    precise: 'pixel-art-fixer-full',
  };

  function getPreset(id) {
    if (id == null || id === '') return null;
    const canonical = PA.pixelate.presetAliases[id] || id;
    return (PA.pixelate.presets || []).find(p => p.id === canonical) || null;
  }

  function validPresetNames() {
    const ids = (PA.pixelate.presets || []).map(p => p.id);
    const aliases = Object.keys(PA.pixelate.presetAliases || {});
    return ids.concat(aliases.filter(a => ids.indexOf(a) < 0));
  }

  PA.pixelate.getPreset = getPreset;
  PA.pixelate.validPresetNames = validPresetNames;

  /* ---------- 原生／整數倍前置檢查 ----------
     手繪像素圖（本來就是 1:1）與「整數倍最近鄰放大」這兩種輸入，用頻域偵測器反而會出錯：
     實測 100×100 的手繪像素圖被各方法降成 50×50／25×25／2×2，等於毀掉作品。
     這兩種輸入有非常乾淨的特徵，先判掉再說（pixel-perfecter 的 exact-NN 檢查即此想法）：
       乾淨像素圖 = 顏色數少 且 幾乎沒有反鋸齒的中間色
       其中 exact-NN ≥ 2 → 就是整數倍放大，直接用它
             exact-NN = 1 → 已經是原生，不要重取樣
     AI 生成圖（數萬色、2–3% 中間色）不會命中這條，照常走偵測器。 */
  const CLEAN_MAX_COLOURS = 512;   // 超過就不是「乾淨像素圖」
  const CLEAN_MAX_MIDTONE = 0.02;  // 相鄰像素差落在 (8,64) 的比例上限（反鋸齒指標）
  const NATIVE_MAX_SIDE = 1024;    // 原生判定後 nx=w，太大就不套用（格數上限 512）

  function cleanArtStats(rgba, w, h) {
    const seen = new Set();
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      seen.add(((rgba[p] << 24) | (rgba[p + 1] << 16) | (rgba[p + 2] << 8) | rgba[p + 3]) >>> 0);
      if (seen.size > CLEAN_MAX_COLOURS) return { clean: false };
    }
    let mid = 0, tot = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const p = (y * w + x) * 4, q = p - 4;
        const d = Math.abs(rgba[p] - rgba[q]) + Math.abs(rgba[p + 1] - rgba[q + 1]) + Math.abs(rgba[p + 2] - rgba[q + 2]);
        tot++;
        if (d > 8 && d < 64) mid++;
      }
    }
    return { clean: tot === 0 || (mid / tot) <= CLEAN_MAX_MIDTONE, colours: seen.size, midRatio: tot ? mid / tot : 0 };
  }

  // 最大的 s：每個 s×s 區塊內像素完全相同（1 = 沒有被整數倍放大過）
  function exactUpscale(rgba, w, h) {
    let best = 1;
    const cap = Math.min(64, w, h);
    for (let s = 2; s <= cap; s++) {
      if (w % s || h % s) continue;
      let ok = true;
      for (let by = 0; by < h / s && ok; by++) {
        for (let bx = 0; bx < w / s && ok; bx++) {
          const p0 = ((by * s) * w + bx * s) * 4;
          for (let y = 0; y < s && ok; y++) {
            for (let x = 0; x < s && ok; x++) {
              const p = ((by * s + y) * w + bx * s + x) * 4;
              if (rgba[p] !== rgba[p0] || rgba[p + 1] !== rgba[p0 + 1] ||
                  rgba[p + 2] !== rgba[p0 + 2] || rgba[p + 3] !== rgba[p0 + 3]) ok = false;
            }
          }
        }
      }
      if (ok) best = s;
    }
    return best;
  }

  // 回傳 Grid（整數倍或原生）或 null（交給偵測器）
  function nativeOrExact(rgba, w, h) {
    const st = cleanArtStats(rgba, w, h);
    if (!st.clean) return null;
    const s = exactUpscale(rgba, w, h);
    if (s >= 2) {
      return { sx: s, sy: s, phx: 0, phy: 0, nx: Math.round(w / s), ny: Math.round(h / s),
               scoreX: 1, scoreY: 1, source: 'exact-nn', native: false,
               meta: { colours: st.colours, midRatio: st.midRatio } };
    }
    if (w > NATIVE_MAX_SIDE || h > NATIVE_MAX_SIDE) return null;
    return { sx: 1, sy: 1, phx: 0, phy: 0, nx: w, ny: h,
             scoreX: 1, scoreY: 1, source: 'native', native: true,
             meta: { colours: st.colours, midRatio: st.midRatio } };
  }

  // 相位正規化：偵測器回報的相位是「第一條格線的位置」，慣例上落在 [0, s)。
  // 但圖片左緣本身就是第 0 格的邊界 —— 相位 = s − 0.5 其實等於「第一條線在 −0.5」，
  // 若照 [0, s) 算格數會少算一格（384px / 16 = 24 格會變成 23）。所以一律把相位折到
  // [−s/2, s/2)：離左緣最近的那條線當第一條，格數 = round((w − phase) / s)。
  // legacy 預設保留舊行為（不正規化），輸出才能與重寫前逐位相同。
  function normPhase(ph, s) {
    if (!(s > 0) || !Number.isFinite(ph)) return 0;
    let p = ((ph % s) + s) % s;
    if (p >= s / 2) p -= s;
    return p;
  }
  function normalizeGrid(g, w, h) {
    if (!g || g.source === 'legacy' || g.source === 'native' || g.source === 'exact-nn' || g.mesh || g.xs || g.ys) return g;   // mesh / 不等距線位置由偵測器負責
    const phx = normPhase(g.phx, g.sx), phy = normPhase(g.phy, g.sy);
    const nx = Math.max(1, Math.min(512, Math.round((w - phx) / g.sx)));
    const ny = Math.max(1, Math.min(512, Math.round((h - phy) / g.sy)));
    return Object.assign(g, { phx, phy, nx, ny });
  }

  function voteToGrid(vote, w, h, votes) {
    if (!vote || !(vote.sx > 0) || !(vote.sy > 0)) return null;
    const meta = vote.meta || {};
    const sx = vote.sx, sy = vote.sy;
    let phx = vote.phx || 0, phy = vote.phy || 0;
    if (vote.id !== 'legacy' && !meta.mesh && !meta.xs && !meta.ys) { phx = normPhase(phx, sx); phy = normPhase(phy, sy); }
    const nx = meta.nx != null ? meta.nx : Math.max(1, Math.min(512, Math.round((w - phx) / sx)));
    const ny = meta.ny != null ? meta.ny : Math.max(1, Math.min(512, Math.round((h - phy) / sy)));
    const g = {
      sx, sy, phx, phy, nx, ny,
      scoreX: meta.scoreX != null ? meta.scoreX : vote.score,
      scoreY: meta.scoreY != null ? meta.scoreY : vote.score,
      source: vote.id,
      votes: votes || [vote],
    };
    if (meta.mesh) g.mesh = meta.mesh;
    if (meta.xs) g.xs = meta.xs;
    if (meta.ys) g.ys = meta.ys;
    return g;
  }

  function nativeGrid(w, h) {
    const nx = Math.min(512, w), ny = Math.min(512, h);
    return { sx: w / nx, sy: h / ny, phx: 0, phy: 0, nx, ny, scoreX: 0, scoreY: 0, source: 'native' };
  }

  /* ---------- 整條管線 ---------- */

  function run(rgba, w, h, opts) {
    const g = opts.grid;
    const px = PA.pixelate.resample(rgba, w, h, g);
    // 重建誤差是診斷數字；調顏色上限 / 去背時格線沒變，呼叫端可傳 error:false 跳過
    const err = opts.error === false ? null : PA.pixelate.reconstructError(rgba, w, h, g, px);
    const cleared = opts.removeBg ? PA.pixelate.removeBackground(px, {}) : 0;
    const colours = opts.colours > 0 ? PA.pixelate.quantize(px, opts.colours) : PA.pixelate.countColours(px.rgba).size;
    return { px, err, cleared, colours };
  }

  async function runPipeline(rgba, w, h, config, hooks) {
    hooks = hooks || {};
    const onProgress = hooks.onProgress || (() => {});
    const cancelled = hooks.cancelled || (() => false);
    const tick = hooks.tick || (() => new Promise(r => setTimeout(r, 0)));
    const timings = {};
    const tAll = performance.now();
    config = config || {};

    let votes = [];
    let grid = config.forceGrid || null;

    // 乾淨的像素圖（原生或整數倍放大）先判掉，不讓頻域偵測器把作品毀掉
    if (!grid && config.detectNative !== false && config.detectors && config.detectors.length) {
      const pre = nativeOrExact(rgba, w, h);
      if (pre) {
        grid = pre;
        votes = [{ id: pre.native ? 'native' : 'exact-nn', sx: pre.sx, sy: pre.sy, phx: 0, phy: 0,
                   score: 1, ms: 0, meta: { nx: pre.nx, ny: pre.ny } }];
        config = Object.assign({}, config, { detectors: [] });
      }
    }

    if (!grid && config.detectors && config.detectors.length) {
      const ids = config.detectors;
      const n = Math.max(1, ids.length);
      for (let i = 0; i < ids.length; i++) {
        if (cancelled()) return null;
        const id = ids[i];
        const def = get('detect', id);
        if (!def) throw new Error('找不到偵測器：' + id);
        const t0 = performance.now();
        const params = (config.detectorParams && config.detectorParams[id]) || {};
        const vote = await def.run(rgba, w, h, params, {
          onProgress: f => onProgress(0.6 * (i + f) / n, { stage: 'detect', detectorId: id }),
          cancelled, tick,
        });
        timings['detect:' + id] = performance.now() - t0;
        if (vote && vote.ms == null) vote.ms = timings['detect:' + id];
        votes.push(vote);
      }
      if (cancelled()) return null;
      onProgress(0.6, { stage: 'arbitrate' });
      const arb = get('detect', 'arbitrate');
      if (arb && ids.length > 1) {
        const tA = performance.now();
        grid = await arb.run(votes, rgba, w, h, { precise: !!config.precise }, { cancelled, tick });
        timings.arbitrate = performance.now() - tA;
      } else {
        const hit = votes.find(Boolean);
        grid = voteToGrid(hit, w, h, votes);
      }
    } else if (!grid) {
      votes = [];
    } else {
      votes = grid.votes || votes;
    }
    if (grid && config.legacyPhase !== true) grid = normalizeGrid(grid, w, h);

    if (cancelled()) return null;
    if (!grid && (config.targetWidth > 0 || config.sample === 'pixeloe')) {
      const nx = Math.max(2, Math.min(512, (config.targetWidth | 0) || 64));
      const ny = Math.max(2, Math.min(512, Math.round(h * nx / w) || 2));
      grid = { sx: w / nx, sy: h / ny, phx: 0, phy: 0, nx, ny, scoreX: 1, scoreY: 1, source: 'photo', votes };
    }
    if (!grid) {
      onProgress(1);
      timings.total = performance.now() - tAll;
      return { grid: null, votes, px: null, err: null, cleared: 0, colours: 0, timings };
    }
    grid.votes = votes;

    onProgress(0.65, { stage: 'bounds' });
    if (config.snap) {
      const prof = PA.pixelate.edgeProfiles(rgba, w, h);
      const b = PA.pixelate.buildBounds(grid, prof, true);
      grid.xs = b.xs;
      grid.ys = b.ys;
      if (grid.sx >= 3) grid.mesh = PA.pixelate.meshBounds(prof, b.xs, b.ys, grid.sx);
    }
    await tick();
    if (cancelled()) return null;

    onProgress(0.7, { stage: 'sample' });
    const sampleId = config.sample || 'center-median';
    const sdef = get('sample', sampleId);
    if (!sdef) throw new Error('找不到取樣器：' + sampleId);
    const bounds = PA.pixelate.buildBounds(grid, null, false);
    const tS = performance.now();
    let px = sdef.run(rgba, w, h, grid, bounds, config.sampleParams || {});
    timings.sample = performance.now() - tS;
    await tick();
    if (cancelled()) return null;

    onProgress(0.85, { stage: 'quant' });
    const k = config.k == null ? 0 : config.k;
    let colours;
    const wantDither = config.dither && config.dither !== 'none';
    const preQuant = wantDither ? px.rgba.slice() : null;
    if (config.quant && config.quant !== 'none' && k > 0) {
      const qdef = get('quant', config.quant);
      if (!qdef) throw new Error('找不到減色器：' + config.quant);
      const tQ = performance.now();
      colours = qdef.run(px, k, {});
      timings.quant = performance.now() - tQ;
    } else {
      colours = PA.pixelate.countColours(px.rgba).size;
    }
    await tick();
    if (cancelled()) return null;

    onProgress(0.95, { stage: 'dither' });
    if (wantDither) {
      const ddef = get('dither', config.dither) || get('dither', 'adapter');
      if (!ddef) throw new Error('找不到抖色器：' + config.dither);
      const pal = [];
      const seen = new Set();
      for (let p = 0; p < px.rgba.length; p += 4) {
        if (px.rgba[p + 3] === 0) continue;
        const key = (px.rgba[p] << 16) | (px.rgba[p + 1] << 8) | px.rgba[p + 2];
        if (seen.has(key)) continue;
        seen.add(key);
        pal.push(new Uint8ClampedArray([px.rgba[p], px.rgba[p + 1], px.rgba[p + 2], 255]));
      }
      if (preQuant) px.rgba.set(preQuant);
      const tD = performance.now();
      px = ddef.run(px, pal, config.dither, config.ditherStrength == null ? 0.5 : config.ditherStrength);
      timings.dither = performance.now() - tD;
      colours = PA.pixelate.countColours(px.rgba).size;
    }
    await tick();
    if (cancelled()) return null;

    let cleared = 0;
    const cleans = config.clean || [];
    for (let i = 0; i < cleans.length; i++) {
      const cid = cleans[i];
      const cdef = get('clean', cid);
      if (!cdef) throw new Error('找不到清理器：' + cid);
      const tC = performance.now();
      cleared += cdef.run(px, (config.cleanParams && config.cleanParams[cid]) || {}) || 0;
      timings['clean:' + cid] = performance.now() - tC;
    }

    let err = null;
    if (config.error !== false) {
      err = PA.pixelate.reconstructError(rgba, w, h, grid, px);
    }
    onProgress(1);
    timings.total = performance.now() - tAll;
    return { grid, votes, px, err, cleared, colours, timings };
  }

  PA.pixelate.voteToGrid = voteToGrid;
  PA.pixelate.nativeOrExact = nativeOrExact;
  PA.pixelate.normalizeGrid = normalizeGrid;
  PA.pixelate.normPhase = normPhase;
  PA.pixelate.nativeGrid = nativeGrid;
  PA.pixelate.run = run;
  PA.pixelate.runPipeline = runPipeline;
})();

/* ---------- 主執行緒：把 detect / run 丟進 Worker；file:// 或 Worker 失敗就回退本執行緒 ---------- */
(function attachWorkerClient() {
  if (typeof document === 'undefined') return;
  const SCRIPT_URL = document.currentScript && document.currentScript.src
    ? document.currentScript.src : '';

  let wk = null, seq = 0, dying = false, workerFailed = false;
  const pending = new Map();

  function onMsg(e) {
    const d = e.data;
    if (!d || d.id == null) return;
    const p = pending.get(d.id);
    if (!p) return;
    if (d.type === 'progress') {
      if (p.onProgress) p.onProgress(d.f, { stage: d.stage, detectorId: d.detectorId });
      return;
    }
    pending.delete(d.id);
    if (d.type === 'error') p.reject(Object.assign(new Error(d.message || 'pixelate worker'), { cancelled: !!d.cancelled }));
    else p.resolve(d.result);
  }

  function spawn() {
    if (workerFailed) return false;
    if (wk) return true;
    if (!SCRIPT_URL || typeof Worker === 'undefined') { workerFailed = true; return false; }
    try {
      // 沿用本檔網址上的 ?v=… 版本參數：相對路徑不會自動帶過去，
      // 少了它 worker 會被瀏覽器的舊快取擋住，跟主執行緒版本對不上
      const wurl = new URL('../pixelate-worker.js', SCRIPT_URL);
      wurl.search = new URL(SCRIPT_URL).search;
      wk = new Worker(wurl);
      wk.onmessage = onMsg;
      wk.onerror = () => {
        if (dying) return;
        for (const p of pending.values()) p.reject(new Error('pixelate worker error'));
        pending.clear();
        try { wk.terminate(); } catch {}
        wk = null;
        workerFailed = true;
      };
      return true;
    } catch {
      workerFailed = true;
      wk = null;
      return false;
    }
  }

  function post(op, payload, hooks) {
    if (!spawn()) return null;
    const id = ++seq;
    const src = payload.rgba;
    const copy = src ? (src instanceof Uint8ClampedArray ? src.slice() : Uint8ClampedArray.from(src)) : null;
    const msg = {
      id, op,
      w: payload.w, h: payload.h,
      opts: payload.opts, grid: payload.grid,
      config: payload.config, detectorId: payload.id, params: payload.params,
      rgba: copy,
    };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress: hooks && hooks.onProgress });
      try {
        if (copy) wk.postMessage(msg, [copy.buffer]);
        else wk.postMessage(msg);
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  function fallback(op, payload, hooks) {
    if (op === 'detect') return PA.pixelate.detectGridAsync(payload.rgba, payload.w, payload.h, hooks);
    if (op === 'run') return PA.pixelate.run(payload.rgba, payload.w, payload.h, payload.opts);
    if (op === 'score') {
      const small = PA.pixelate.resample(payload.rgba, payload.w, payload.h, payload.grid);
      return PA.pixelate.reconstructError(payload.rgba, payload.w, payload.h, payload.grid, small);
    }
    if (op === 'pipeline') return PA.pixelate.runPipeline(payload.rgba, payload.w, payload.h, payload.config, hooks);
    if (op === 'detectOne') {
      const def = PA.pixelate.get('detect', payload.id);
      if (!def) throw new Error('找不到偵測器：' + payload.id);
      return def.run(payload.rgba, payload.w, payload.h, payload.params || {}, hooks);
    }
    throw new Error('未知的 pixelate 操作：' + op);
  }

  PA.pixelate.callAsync = async function(op, payload, hooks) {
    hooks = hooks || {};
    const job = post(op, payload, hooks);
    if (job) {
      try { return await job; }
      catch (e) {
        if (e.cancelled) return null;
      }
    }
    return fallback(op, payload, hooks);
  };

  PA.pixelate.cancelJobs = function() {
    dying = true;
    for (const p of pending.values())
      p.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    pending.clear();
    if (wk) { try { wk.terminate(); } catch {} wk = null; }
    dying = false;
  };
})();
