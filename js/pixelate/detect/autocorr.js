/* pixelate/detect/autocorr.js
   移植自 Pixel Art Fixer python/pixelfixer/autocorr.py
   commit ef376e57e1c272633ca2dbf5f29ec3fcf6596465  MIT
   對應：band_acf / comb_score / 次諧波抑制 / refine_step_acf。未移植 cepstrum。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const MIN_STEP = 2.0;
  const STEP = 0.25;
  const K0 = 12;

  function luma(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const a = rgba[p + 3] / 255;
      const y = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      g[i] = y * a + 127.5 * (1 - a);
    }
    return g;
  }

  function featAxis(g, w, h, axis) {
    const n = w * h;
    const d1 = new Float32Array(n), d2 = new Float32Array(n);
    if (axis === 0) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 1; x < w; x++) {
          const a = Math.abs(g[row + x] - g[row + x - 1]);
          d1[row + x] = a;
          if (x + 1 < w) d2[row + x] = Math.abs(Math.abs(g[row + x + 1] - g[row + x]) - a);
        }
      }
    } else {
      for (let y = 1; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = Math.abs(g[y * w + x] - g[(y - 1) * w + x]);
          d1[y * w + x] = a;
          if (y + 1 < h) d2[y * w + x] = Math.abs(Math.abs(g[(y + 1) * w + x] - g[y * w + x]) - a);
        }
      }
    }
    const mixed = new Float32Array(n);
    for (let i = 0; i < n; i++) mixed[i] = d2[i] + 0.7 * d1[i];
    return mixed;
  }

  function bandProfiles(feat, w, h, axis, band) {
    const extent = axis === 0 ? w : h;
    const lines = axis === 0 ? h : w;
    const nb = Math.max(1, (lines / band) | 0);
    const used = nb * band;
    const profs = [];
    for (let b = 0; b < nb; b++) {
      const p = new Float64Array(extent);
      const y0 = b * band;
      for (let k = 0; k < band && y0 + k < used; k++) {
        const line = y0 + k;
        if (axis === 0) {
          const row = line * w;
          for (let x = 0; x < w; x++) p[x] += feat[row + x];
        } else {
          for (let y = 0; y < h; y++) p[y] += feat[y * w + line];
        }
      }
      profs.push(p);
    }
    return profs;
  }

  function meanAcf(profs) {
    const fft = PA.pixelate.lib.fft;
    const n = profs[0].length;
    const acc = new Float64Array(n);
    for (let i = 0; i < profs.length; i++) {
      const ac = fft.acf(profs[i]);
      for (let t = 0; t < n; t++) acc[t] += ac[t];
    }
    const inv = 1 / profs.length;
    for (let t = 0; t < n; t++) acc[t] *= inv;
    return acc;
  }

  function combScore(ac, s) {
    const interp = PA.pixelate.lib.fft.interp;
    const n = ac.length;
    const K = Math.min((n / (2 * s)) | 0, 24);
    if (K < 2) return -1;
    let num = 0, den = 0;
    for (let k = 1; k <= K; k++) {
      const w = Math.exp(-k / K0);
      num += w * (interp(ac, k * s) - interp(ac, (k + 0.5) * s));
      den += w;
    }
    return den ? num / den : -1;
  }

  function refineLs(ac, s0) {
    const n = ac.length;
    const K = Math.min(((n - 3) / s0) | 0, 24);
    if (K < 2) return s0;
    const pos = [], ks = [], wts = [];
    for (let k = 1; k <= K; k++) {
      const c0 = k * s0;
      const r = Math.max(2, (0.3 * s0) | 0);
      const lo = Math.max(1, (c0 - r) | 0);
      const hi = Math.min(n - 2, Math.ceil(c0 + r));
      if (hi <= lo) continue;
      let bi = lo, bv = -Infinity;
      for (let i = lo; i <= hi; i++) if (ac[i] > bv) { bv = ac[i]; bi = i; }
      if (bi <= lo || bi >= hi) continue;
      const d = (ac[bi - 1] - ac[bi + 1]) / (2 * (ac[bi - 1] - 2 * ac[bi] + ac[bi + 1]) + 1e-12);
      pos.push(bi + Math.max(-1, Math.min(1, d)));
      ks.push(k);
      wts.push(Math.max(ac[bi], 1e-6));
    }
    if (pos.length < 2) return s0;
    let s = s0;
    for (let it = 0; it < 3; it++) {
      let num = 0, den = 0, keep = 0;
      const lim = Math.max(0.3 * s0, 1.5);
      for (let i = 0; i < pos.length; i++) {
        if (Math.abs(pos[i] - ks[i] * s) > lim) continue;
        keep++;
        num += wts[i] * pos[i] * ks[i];
        den += wts[i] * ks[i] * ks[i];
      }
      if (keep < 2 || !den) break;
      s = num / den;
    }
    if (s < 0.8 * s0 || s > 1.25 * s0) return s0;
    return s;
  }

  function bestPhase(E, s) {
    let bv = -1, bp = 0;
    const total = (() => { let t = 0; for (let i = 0; i < E.length; i++) t += E[i]; return t; })();
    for (let k = 0; k < 64; k++) {
      const phi = s * k / 64;
      let on = 0, onN = 0;
      for (let x = phi; x < E.length - 0.5; x += s) {
        const i = Math.round(x);
        if (i >= 0 && i < E.length) { on += E[i]; onN++; }
      }
      const v = onN ? on / onN : -1;
      if (v > bv) { bv = v; bp = phi; }
    }
    return { phase: bp, score: total > 0 ? bv : 0 };
  }

  function axisDetect(feat, w, h, axis, band, extent) {
    const hi = Math.min(extent / 3, 80);
    const steps = [];
    for (let s = MIN_STEP; s <= hi; s += STEP) steps.push(s);
    const bands = bandProfiles(feat, w, h, axis, band);
    if (!bands.length) return null;
    const ac = meanAcf(bands);
    const raw = new Float64Array(steps.length);
    for (let i = 0; i < steps.length; i++) raw[i] = combScore(ac, steps[i]);
    const sel = new Float64Array(steps.length);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      let pen = 0;
      for (const m of [2, 3, 4, 5]) {
        const sub = s / m;
        if (sub < MIN_STEP) continue;
        const j = Math.round((sub - MIN_STEP) / STEP);
        if (j >= 0 && j < raw.length) pen = Math.max(pen, Math.max(0, raw[j]));
      }
      sel[i] = raw[i] - 0.5 * pen;
    }
    const peaks = [];
    for (let i = 1; i < sel.length - 1; i++) {
      if (sel[i] > sel[i - 1] && sel[i] >= sel[i + 1]) peaks.push(i);
    }
    peaks.sort((a, b) => sel[b] - sel[a]);
    const top = peaks.slice(0, 5).map(i => ({ s: refineLs(ac, steps[i]), z: sel[i], raw: raw[i] }));
    if (!top.length) {
      let bi = 0;
      for (let i = 1; i < sel.length; i++) if (sel[i] > sel[bi]) bi = i;
      top.push({ s: refineLs(ac, steps[bi]), z: sel[bi], raw: raw[bi] });
    }
    const curve = steps.map((s, i) => [s, sel[i]]);
    const best = top[0];
    const zmax = Math.max.apply(null, top.map(t => t.z).concat([1e-9]));
    return { s: best.s, score: best.z / (Math.abs(zmax) + 1e-9), candidates: top, curve, ac };
  }

  async function run(rgba, w, h, params, hooks) {
    hooks = hooks || {};
    const cancelled = hooks.cancelled || (() => false);
    const tick = hooks.tick || (() => new Promise(r => setTimeout(r, 0)));
    const onProgress = hooks.onProgress || (() => {});
    const band = (params && params.band) || 24;
    onProgress(0);
    await tick();
    if (cancelled()) return null;
    const g = luma(rgba, w, h);
    const fx = featAxis(g, w, h, 0);
    onProgress(0.2);
    await tick();
    if (cancelled()) return null;
    const fy = featAxis(g, w, h, 1);
    onProgress(0.4);
    await tick();
    if (cancelled()) return null;
    const ax = axisDetect(fx, w, h, 0, band, w);
    onProgress(0.7);
    await tick();
    if (cancelled()) return null;
    const ay = axisDetect(fy, w, h, 1, band, h);
    if (!ax || !ay) return null;
    const prof = PA.pixelate.edgeProfiles(rgba, w, h);
    const px = bestPhase(prof.ex, ax.s);
    const py = bestPhase(prof.ey, ay.s);
    const score = Math.max(0, Math.min(1, (ax.score + ay.score) / 2));
    onProgress(1);
    return {
      id: 'autocorr',
      sx: ax.s, sy: ay.s, phx: px.phase, phy: py.phase, score,
      meta: {
        nx: Math.max(1, Math.min(512, Math.round((w - px.phase) / ax.s))),
        ny: Math.max(1, Math.min(512, Math.round((h - py.phase) / ay.s))),
        candidates: ax.candidates.concat(ay.candidates).map(c => ({ s: c.s, z: c.z })),
        curve: ax.curve,
        curveY: ay.curve,
      },
    };
  }

  PA.pixelate.register('detect', {
    id: 'autocorr',
    label: '自相關',
    credit: { project: 'Pixel Art Fixer', file: 'python/pixelfixer/autocorr.py', license: 'MIT', url: 'https://github.com/Retro-Diffusion/pixel-art-fixer' },
    cost: 'medium',
    params: [{ key: 'band', label: '列帶高度', type: 'select', options: [12, 24, 'all'], default: 24 }],
    run,
  });
})();
