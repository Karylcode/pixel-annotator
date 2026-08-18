/* pixelate/detect/runlength.js
   移植自 Pixel Art Fixer python/pixelfixer/runlengths.py
   commit ef376e57e1c272633ca2dbf5f29ec3fcf6596465  MIT
   對應：邊界 comb / MAX_LAG=4 / 0.70 近平手取最大 s。無 cv2，改 RGB L1 + 1×7 NMS。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const S_MIN = 2.05, MAX_LAG = 4, RUN_MIN = 2, RUN_MAX = 64, THR = 24;

  function l1(rgba, a, b) {
    return Math.abs(rgba[a] - rgba[b]) + Math.abs(rgba[a + 1] - rgba[b + 1]) + Math.abs(rgba[a + 2] - rgba[b + 2]);
  }

  function boundaries(rgba, w, h, axis) {
    const nScan = axis === 0 ? h : w;
    const nExt = axis === 0 ? w : h;
    const stride = axis === 0 ? 1 : w;
    const lineStride = axis === 0 ? w : 1;
    const step = Math.max(1, (nScan / 256) | 0);
    const marks = [];
    for (let s = 0; s < nScan; s += step) {
      const pos = [];
      for (let i = 1; i < nExt; i++) {
        const p = ((axis === 0 ? s : i) * w + (axis === 0 ? i : s)) * 4;
        const q = ((axis === 0 ? s : i - 1) * w + (axis === 0 ? i - 1 : s)) * 4;
        if (l1(rgba, p, q) > THR) pos.push(i);
      }
      marks.push({ s, pos });
    }
    const kept = [];
    for (let m = 0; m < marks.length; m++) {
      const { s, pos } = marks[m];
      for (let i = 0; i < pos.length; i++) {
        const x = pos[i];
        let ok = false;
        for (let d = 1; d <= 3 && !ok; d++) {
          for (const o of [m - d, m + d]) {
            if (o < 0 || o >= marks.length) continue;
            const arr = marks[o].pos;
            for (let j = 0; j < arr.length; j++) {
              if (Math.abs(arr[j] - x) <= 2) { ok = true; break; }
            }
          }
        }
        if (ok) kept.push({ s, x });
      }
    }
    return { kept, nScan, nExt };
  }

  function lagDiffs(kept) {
    const by = new Map();
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i].s;
      let a = by.get(k);
      if (!a) { a = []; by.set(k, a); }
      a.push(kept[i].x);
    }
    const runs = [];
    by.forEach(arr => {
      arr.sort((a, b) => a - b);
      for (let lag = 1; lag <= MAX_LAG; lag++) {
        for (let i = 0; i + lag < arr.length; i++) {
          const d = arr[i + lag] - arr[i];
          if (d >= RUN_MIN && d <= RUN_MAX) runs.push(d);
        }
      }
    });
    return runs;
  }

  function pickStep(runs, extent) {
    if (runs.length < 50) return null;
    const hi = Math.min(extent / 3, 26);
    const steps = [];
    for (let s = S_MIN; s <= hi; s += 0.05) steps.push(s);
    const S = new Float64Array(steps.length);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      let acc = 0;
      for (let r = 0; r < runs.length; r++) acc += Math.cos(2 * Math.PI * runs[r] / s);
      S[i] = acc / runs.length;
    }
    const peaks = [];
    for (let i = 1; i < S.length - 1; i++) {
      if (S[i] > S[i - 1] && S[i] >= S[i + 1]) peaks.push(i);
    }
    if (!peaks.length) return null;
    peaks.sort((a, b) => S[b] - S[a]);
    const smax = S[peaks[0]];
    if (smax <= 0) return null;
    function fund(s) {
      let n = 0;
      const tol = Math.max(0.6, 0.18 * s);
      for (let i = 0; i < runs.length; i++) if (Math.abs(runs[i] - s) < tol) n++;
      return n / runs.length;
    }
    const tied = peaks.filter(i => S[i] >= 0.70 * smax).map(i => steps[i]);
    tied.sort((a, b) => b - a);
    let best = steps[peaks[0]], bestV = smax;
    for (let i = 0; i < tied.length; i++) {
      if (fund(tied[i]) >= 0.04) { best = tied[i]; bestV = S[peaks.find(p => Math.abs(steps[p] - tied[i]) < 1e-9)] || smax; break; }
    }
    if (bestV < 0.1) return null;
    let s = best;
    for (let it = 0; it < 2; it++) {
      let num = 0, den = 0;
      for (let i = 0; i < runs.length; i++) {
        const k = Math.round(runs[i] / s);
        if (k < 1) continue;
        const res = Math.abs(runs[i] - k * s);
        const w = Math.max(0, 1 - res / (0.30 * s)) * k;
        num += w * k * runs[i];
        den += w * k * k;
      }
      if (den) s = num / den;
    }
    const score = bestV >= 0.3 ? 1 : (bestV <= 0.1 ? 0 : (bestV - 0.1) / 0.2);
    const curve = steps.map((sv, i) => [sv, S[i]]);
    return { s, score, v: bestV, curve, candidates: peaks.slice(0, 8).map(i => ({ s: steps[i], z: S[i] })) };
  }

  async function run(rgba, w, h, params, hooks) {
    hooks = hooks || {};
    const cancelled = hooks.cancelled || (() => false);
    const tick = hooks.tick || (() => new Promise(r => setTimeout(r, 0)));
    const onProgress = hooks.onProgress || (() => {});
    onProgress(0);
    await tick();
    if (cancelled()) return null;
    const bx = boundaries(rgba, w, h, 0);
    onProgress(0.35);
    await tick();
    if (cancelled()) return null;
    const by = boundaries(rgba, w, h, 1);
    onProgress(0.6);
    await tick();
    if (cancelled()) return null;
    const rx = pickStep(lagDiffs(bx.kept), w);
    const ry = pickStep(lagDiffs(by.kept), h);
    if (!rx && !ry) return null;
    const sx = rx ? rx.s : ry.s;
    const sy = ry ? ry.s : rx.s;
    const score = Math.max(rx ? rx.score : 0, ry ? ry.score : 0);
    const prof = PA.pixelate.edgeProfiles(rgba, w, h);
    let phx = 0, phy = 0, bv = -1;
    for (let k = 0; k < 64; k++) {
      const phi = sx * k / 64;
      let on = 0, n = 0;
      for (let x = phi; x < w - 0.5; x += sx) { const i = Math.round(x); if (i >= 0 && i < w) { on += prof.ex[i]; n++; } }
      if (n && on / n > bv) { bv = on / n; phx = phi; }
    }
    bv = -1;
    for (let k = 0; k < 64; k++) {
      const phi = sy * k / 64;
      let on = 0, n = 0;
      for (let y = phi; y < h - 0.5; y += sy) { const i = Math.round(y); if (i >= 0 && i < h) { on += prof.ey[i]; n++; } }
      if (n && on / n > bv) { bv = on / n; phy = phi; }
    }
    onProgress(1);
    return {
      id: 'runlength',
      sx, sy, phx, phy, score,
      meta: {
        nx: Math.max(1, Math.min(512, Math.round((w - phx) / sx))),
        ny: Math.max(1, Math.min(512, Math.round((h - phy) / sy))),
        candidates: ((rx && rx.candidates) || []).concat((ry && ry.candidates) || []),
        curve: rx ? rx.curve : (ry && ry.curve),
      },
    };
  }

  PA.pixelate.register('detect', {
    id: 'runlength',
    label: 'Run-length',
    credit: { project: 'Pixel Art Fixer', file: 'python/pixelfixer/runlengths.py', license: 'MIT', url: 'https://github.com/Retro-Diffusion/pixel-art-fixer' },
    cost: 'fast',
    params: [],
    run,
  });
})();
