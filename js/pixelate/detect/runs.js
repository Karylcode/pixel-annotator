/* pixelate/detect/runs.js
   移植自 unfake.js unfake-core runs-based 尺度偵測。MIT；只移植原始碼，未使用 wasm 或 GPL 減色庫。
   https://github.com/jenissimo/unfake.js */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const THR = 18;

  function axisRuns(rgba, w, h, axis) {
    const hist = new Uint32Array(Math.min(axis === 0 ? w : h, 256) + 1);
    const nScan = axis === 0 ? h : w;
    const nExt = axis === 0 ? w : h;
    const step = Math.max(1, (nScan / 256) | 0);
    let total = 0;
    for (let s = 0; s < nScan; s += step) {
      let run = 1;
      let pr = 0, pg = 0, pb = 0;
      const pix = (i) => {
        const x = axis === 0 ? i : s, y = axis === 0 ? s : i;
        const p = (y * w + x) * 4;
        return [rgba[p], rgba[p + 1], rgba[p + 2]];
      };
      [pr, pg, pb] = pix(0);
      for (let i = 1; i <= nExt; i++) {
        let same = false;
        if (i < nExt) {
          const c = pix(i);
          same = Math.abs(c[0] - pr) + Math.abs(c[1] - pg) + Math.abs(c[2] - pb) <= THR;
        }
        if (same) run++;
        else {
          if (run >= 2 && run < hist.length) { hist[run]++; total++; }
          if (i < nExt) { const c = pix(i); pr = c[0]; pg = c[1]; pb = c[2]; }
          run = 1;
        }
      }
    }
    let mode = 2, mv = 0;
    for (let i = 2; i < hist.length; i++) if (hist[i] > mv) { mv = hist[i]; mode = i; }
    let support = 0;
    for (let m = 1; m <= 8; m++) {
      const s = mode * m;
      if (s < hist.length) support += hist[s];
    }
    const score = total ? support / total : 0;
    return { s: mode, score };
  }

  async function run(rgba, w, h, params, hooks) {
    hooks = hooks || {};
    const tick = hooks.tick || (() => new Promise(r => setTimeout(r, 0)));
    (hooks.onProgress || (() => {}))(0);
    await tick();
    const ax = axisRuns(rgba, w, h, 0);
    const ay = axisRuns(rgba, w, h, 1);
    (hooks.onProgress || (() => {}))(1);
    if (ax.score < 0.08 && ay.score < 0.08) return null;
    const sx = ax.s, sy = ay.s;
    return {
      id: 'runs',
      sx, sy, phx: 0, phy: 0,
      score: Math.max(0, Math.min(1, (ax.score + ay.score) / 2)),
      meta: {
        nx: Math.max(1, Math.min(512, Math.round(w / sx))),
        ny: Math.max(1, Math.min(512, Math.round(h / sy))),
      },
    };
  }

  PA.pixelate.register('detect', {
    id: 'runs',
    label: 'Runs',
    credit: { project: 'unfake.js', file: 'unfake-core scale detect (runs)', license: 'MIT', url: 'https://github.com/jenissimo/unfake.js' },
    cost: 'fast',
    params: [],
    run,
  });
})();
