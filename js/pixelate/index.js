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
      id: 'fast',
      label: '快速',
      desc: '只用 run-length 偵測格寬，格心中位數取色。適合預覽。',
      config: { detectors: ['runlength'], precise: false, sample: 'center-median', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'standard',
      label: '標準',
      desc: 'Pixel Art Fixer 三偵測器共識 + 兩階段重建。',
      config: { detectors: ['autocorr', 'runlength', 'selfsim'], precise: false, sample: 'two-stage', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'precise',
      label: '精確（慢）',
      desc: '五偵測器 + 變異數對比／重建誤差仲裁。適合難圖。',
      config: { detectors: ['autocorr', 'runlength', 'selfsim', 'fft', 'perfecter'], precise: true, sample: 'two-stage', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'unfake',
      label: 'unfake 風格',
      desc: 'run-length + 自相關偵測，眾數取色，補洞／去雜點／修鋸齒／alpha。',
      config: { detectors: ['runs', 'autocorr'], precise: false, sample: 'dominant', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg', 'holes', 'specks', 'jaggies', 'alpha'], snap: false },
    },
    {
      id: 'perfectpixel',
      label: 'perfectPixel 風格',
      desc: 'FFT 偵測主週期，格心中位數取色。',
      config: { detectors: ['fft'], precise: false, sample: 'center-median', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'perfecter',
      label: 'pixel-perfecter 風格',
      desc: 'exact-NN / Canny 投影 / 對比評分，眾數取色。',
      config: { detectors: ['perfecter'], precise: false, sample: 'dominant', quant: 'oklab-kmeans', k: 48, dither: 'none', clean: ['bg'], snap: false },
    },
    {
      id: 'photo',
      label: '照片轉像素',
      desc: '不偵測格線。PixelOE 輪廓擴張 + 對比感知降採樣，目標寬度由使用者指定。',
      config: { detectors: [], precise: false, sample: 'pixeloe', quant: 'oklab-kmeans', k: 48, dither: 'none', ditherStrength: 0.5, clean: [], snap: false, targetWidth: 64 },
    },
    {
      id: 'legacy',
      label: '原版',
      desc: '現有差分能量偵測 + 格心中位數取色 + OKLab 減色。行為與重寫前相同。',
      config: { detectors: ['legacy'], precise: false, sample: 'center-median', quant: 'oklab-kmeans', k: 48, dither: 'none', ditherStrength: 0.5, clean: ['bg'], snap: false, legacyPhase: true },
    },
  ];

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
    if (!g || g.source === 'legacy' || g.mesh || g.xs || g.ys) return g;   // mesh / 不等距線位置由偵測器負責
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
    const cleared = opts.removeBg ? PA.pixelate.removeBackground(px) : 0;
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
      wk = new Worker(new URL('../pixelate-worker.js', SCRIPT_URL));
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
