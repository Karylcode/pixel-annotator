/* pixelate/detect/selfsim.js
   移植自 Pixel Art Fixer python/pixelfixer/selfsim.py
   commit ef376e57e1c272633ca2dbf5f29ec3fcf6596465  MIT
   對應：|grad| / 模糊|grad| / |Laplacian| 位移自相似 + 多諧波 t 統計。無 cv2/PIL。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const TMAX = 72, PMIN = 1.7, PSTEP = 0.05, KCAP = 24;
  const QUALIFY_FRAC = 0.40, QUALIFY_ABS = 4.0, DISP_UNIFORM = 0.015;

  function luma(rgba, w, h) {
    const y = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      y[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    }
    return y;
  }

  function gauss1(src, w, h) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    const k = [0.06136, 0.24477, 0.38774, 0.24477, 0.06136];
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let d = -2; d <= 2; d++) v += k[d + 2] * src[row + Math.max(0, Math.min(w - 1, x + d))];
        tmp[row + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let d = -2; d <= 2; d++) {
          const yy = Math.max(0, Math.min(h - 1, y + d));
          v += k[d + 2] * tmp[yy * w + x];
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  function gradMag(y, w, h) {
    const g = new Float32Array(w * h);
    for (let row = 0; row < h; row++) {
      for (let x = 0; x < w; x++) {
        const i = row * w + x;
        const gx = x ? Math.abs(y[i] - y[i - 1]) : 0;
        const gy = row ? Math.abs(y[i] - y[i - w]) : 0;
        g[i] = gx + gy;
      }
    }
    return g;
  }

  function laplacian(y, w, h) {
    const g = new Float32Array(w * h);
    for (let row = 1; row < h - 1; row++) {
      for (let x = 1; x < w - 1; x++) {
        const i = row * w + x;
        g[i] = Math.abs(4 * y[i] - y[i - 1] - y[i + 1] - y[i - w] - y[i + w]);
      }
    }
    return g;
  }

  function dCurve(F, w, h, axis, tmax, stride) {
    const extent = axis === 0 ? w : h;
    const other = axis === 0 ? h : w;
    const T = Math.max(1, Math.min(tmax, (extent / 3) | 0));
    const d = new Float64Array(T);
    const nOther = Math.max(1, (other / stride) | 0);
    for (let t = 1; t <= T; t++) {
      let acc = 0, n = 0;
      if (axis === 0) {
        for (let y = 0; y < h; y += stride) {
          const row = y * w;
          for (let x = 0; x < w - t; x++) {
            acc += Math.abs(F[row + x] - F[row + x + t]);
            n++;
          }
        }
      } else {
        for (let y = 0; y < h - t; y += stride) {
          for (let x = 0; x < w; x++) {
            acc += Math.abs(F[y * w + x] - F[(y + t) * w + x]);
            n++;
          }
        }
      }
      d[t - 1] = n ? acc / n : 0;
    }
    return d;
  }

  function combT(d, pGrid) {
    const T = d.length;
    const S = new Float64Array(pGrid.length);
    S.fill(-1e9);
    if (T < 8) return S;
    let noise = 0;
    for (let i = 2; i < T; i++) noise += Math.abs(d[i] - 2 * d[i - 1] + d[i - 2]);
    noise = (noise / Math.max(1, T - 2)) + 1e-9;
    function interp(q) {
      if (q <= 1) return d[0];
      if (q >= T) return d[T - 1];
      const i = (q - 1) | 0;
      const f = q - 1 - i;
      return d[i] * (1 - f) + d[Math.min(T - 1, i + 1)] * f;
    }
    for (let pi = 0; pi < pGrid.length; pi++) {
      const p = pGrid[pi];
      const K = Math.min((T / p - 0.5) | 0, KCAP);
      if (K < 2) continue;
      const c = [];
      for (let k = 1; k <= K; k++) {
        const qm = k * p;
        const rm = interp(qm);
        const rh = 0.5 * (interp(qm - p / 2) + interp(qm + p / 2));
        c.push(rh - rm);
      }
      let mean = 0;
      for (let i = 0; i < c.length; i++) mean += c[i];
      mean /= c.length;
      let v = 0;
      for (let i = 0; i < c.length; i++) v += (c[i] - mean) * (c[i] - mean);
      const std = Math.sqrt(v / c.length);
      const kpen = Math.min(1, (K - 1) / 3);
      S[pi] = kpen * mean * Math.sqrt(K) / (std + 0.5 * noise + 1e-9);
    }
    return S;
  }

  function axisDetect(feats, w, h, axis, size) {
    const hi = Math.min(24, size / 4);
    const pGrid = [];
    for (let p = PMIN; p < hi; p += PSTEP) pGrid.push(p);
    const stride = Math.max(1, Math.ceil((w * h) / 1.2e6));
    let Stot = new Float64Array(pGrid.length);
    for (let f = 0; f < feats.length; f++) {
      const d = dCurve(feats[f], w, h, axis, TMAX, stride);
      let mean = 0;
      for (let i = 0; i < d.length; i++) mean += d[i];
      mean /= d.length || 1;
      if (mean > 1e-9) for (let i = 0; i < d.length; i++) d[i] /= mean;
      const S = combT(d, pGrid);
      for (let i = 0; i < Stot.length; i++) {
        const v = Math.max(-10, Math.min(30, S[i]));
        Stot[i] += v;
      }
    }
    const peaks = [];
    for (let i = 1; i < Stot.length - 1; i++) {
      if (Stot[i] >= Stot[i - 1] && Stot[i] > Stot[i + 1]) peaks.push(i);
    }
    peaks.sort((a, b) => Stot[b] - Stot[a]);
    if (!peaks.length || Stot[peaks[0]] <= 0) return null;
    const smax = Stot[peaks[0]];
    const floor = Math.max(QUALIFY_FRAC * smax, QUALIFY_ABS);
    const qual = peaks.filter(i => Stot[i] >= floor);
    let bestI = qual.length ? qual.reduce((a, b) => pGrid[a] < pGrid[b] ? a : b) : peaks[0];
    const s0 = pGrid[bestI];
    const score = Math.max(0, Math.min(1, Stot[bestI] / 30));
    const curve = pGrid.map((p, i) => [p, Stot[i]]);
    const tiles = Math.min(8, Math.max(1, (size / 128) | 0));
    let drift = false;
    if (tiles >= 2) {
      const local = [];
      const tw = axis === 0 ? Math.floor(w / tiles) : w;
      const th = axis === 0 ? h : Math.floor(h / tiles);
      // 簡化：用全域 s；離散度檢查略過重算，標記 TODO(v3.1) 完整 tile 投票
      if (size / s0 > 40) drift = false;
    }
    return { s: s0, score, curve, candidates: peaks.slice(0, 8).map(i => ({ s: pGrid[i], z: Stot[i] })), drift };
  }

  async function run(rgba, w, h, params, hooks) {
    hooks = hooks || {};
    const cancelled = hooks.cancelled || (() => false);
    const tick = hooks.tick || (() => new Promise(r => setTimeout(r, 0)));
    const onProgress = hooks.onProgress || (() => {});
    onProgress(0);
    await tick();
    if (cancelled()) return null;
    const y = luma(rgba, w, h);
    const yb = gauss1(y, w, h);
    const feats = [gradMag(y, w, h), gradMag(yb, w, h), laplacian(yb, w, h)];
    onProgress(0.3);
    await tick();
    if (cancelled()) return null;
    const ax = axisDetect(feats, w, h, 0, w);
    onProgress(0.65);
    await tick();
    if (cancelled()) return null;
    const ay = axisDetect(feats, w, h, 1, h);
    if (!ax || !ay) return null;
    const prof = PA.pixelate.edgeProfiles(rgba, w, h);
    let phx = 0, phy = 0, bv = -1;
    for (let k = 0; k < 64; k++) {
      const phi = ax.s * k / 64;
      let on = 0, n = 0;
      for (let x = phi; x < w - 0.5; x += ax.s) { const i = Math.round(x); if (i >= 0 && i < w) { on += prof.ex[i]; n++; } }
      if (n && on / n > bv) { bv = on / n; phx = phi; }
    }
    bv = -1;
    for (let k = 0; k < 64; k++) {
      const phi = ay.s * k / 64;
      let on = 0, n = 0;
      for (let y0 = phi; y0 < h - 0.5; y0 += ay.s) { const i = Math.round(y0); if (i >= 0 && i < h) { on += prof.ey[i]; n++; } }
      if (n && on / n > bv) { bv = on / n; phy = phi; }
    }
    onProgress(1);
    return {
      id: 'selfsim',
      sx: ax.s, sy: ay.s, phx, phy,
      score: (ax.score + ay.score) / 2,
      meta: {
        nx: Math.max(1, Math.min(512, Math.round((w - phx) / ax.s))),
        ny: Math.max(1, Math.min(512, Math.round((h - phy) / ay.s))),
        candidates: ax.candidates.concat(ay.candidates),
        curve: ax.curve,
        drift: ax.drift || ay.drift,
      },
    };
  }

  PA.pixelate.register('detect', {
    id: 'selfsim',
    label: '自相似',
    credit: { project: 'Pixel Art Fixer', file: 'python/pixelfixer/selfsim.py', license: 'MIT', url: 'https://github.com/Retro-Diffusion/pixel-art-fixer' },
    cost: 'medium',
    params: [],
    run,
  });
})();
