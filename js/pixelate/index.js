/* pixelate/index.js — 註冊表、預設組合、runPipeline、callAsync。
   純運算掛在 PA.pixelate；主執行緒另見檔尾 callAsync。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
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
      id: 'legacy',
      label: '原版',
      desc: '現有差分能量偵測 + 格心中位數取色 + OKLab 減色。行為與重寫前相同。',
      config: {
        detectors: ['legacy'],
        precise: false,
        sample: 'center-median',
        quant: 'oklab-kmeans',
        k: 48,
        dither: 'none',
        ditherStrength: 0.5,
        clean: ['bg'],
        snap: false,
      },
    },
  ];

  function voteToGrid(vote, w, h, votes) {
    if (!vote) return null;
    const meta = vote.meta || {};
    const sx = vote.sx, sy = vote.sy;
    const phx = vote.phx || 0, phy = vote.phy || 0;
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

    if (cancelled()) return null;
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
    if (config.dither && config.dither !== 'none') {
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
      const tD = performance.now();
      px = ddef.run(px, pal, config.dither, config.ditherStrength == null ? 0.5 : config.ditherStrength);
      timings.dither = performance.now() - tD;
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
