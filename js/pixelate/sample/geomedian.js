/* pixelate/sample/geomedian.js
   移植自 spritegrid src/spritegrid/utils.py geometric_median（Weiszfeld）
   https://github.com/marksverdhei/spritegrid
   commit 64ab6f38b914d8e4bc7db681a541c898b876a1b1  MIT
   格內 RGB 幾何中位數，再吸附到格內實際存在的最近像素色。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const MAX_IT = 20;
  const EPS = 0.5;

  function weiszfeld(R, G, B, m) {
    let y0 = 0, y1 = 0, y2 = 0;
    for (let t = 0; t < m; t++) { y0 += R[t]; y1 += G[t]; y2 += B[t]; }
    y0 /= m; y1 /= m; y2 /= m;
    for (let it = 0; it < MAX_IT; it++) {
      let wsum = 0, t0 = 0, t1 = 0, t2 = 0, zeros = 0;
      for (let t = 0; t < m; t++) {
        const d = Math.hypot(R[t] - y0, G[t] - y1, B[t] - y2);
        if (d < 1e-6) { zeros++; continue; }
        const w = 1 / d;
        wsum += w;
        t0 += w * R[t]; t1 += w * G[t]; t2 += w * B[t];
      }
      if (!wsum) return [y0, y1, y2];
      t0 /= wsum; t1 /= wsum; t2 /= wsum;
      if (zeros) {
        const r = Math.hypot(t0 - y0, t1 - y1, t2 - y2);
        const rinv = r === 0 ? 0 : zeros / r;
        const a = Math.max(0, 1 - rinv), b = Math.min(1, rinv);
        t0 = a * t0 + b * y0;
        t1 = a * t1 + b * y1;
        t2 = a * t2 + b * y2;
      }
      if (Math.hypot(t0 - y0, t1 - y1, t2 - y2) < EPS) return [t0, t1, t2];
      y0 = t0; y1 = t1; y2 = t2;
    }
    return [y0, y1, y2];
  }

  function run(rgba, w, h, grid, bounds, params) {
    const pad = params && params.pad != null ? params.pad : 0.25;
    const b = bounds || PA.pixelate.grid.boundsOf(grid);
    const cellRect = PA.pixelate.grid.cellRect;
    const nx = Math.max(1, Math.min(1024, grid.nx));
    const ny = Math.max(1, Math.min(1024, grid.ny));
    let mw = 1, mh = 1;
    for (let i = 0; i < b.xs.length - 1; i++) mw = Math.max(mw, Math.ceil(b.xs[i + 1] - b.xs[i]));
    for (let j = 0; j < b.ys.length - 1; j++) mh = Math.max(mh, Math.ceil(b.ys[j + 1] - b.ys[j]));
    const cap = Math.max(16, Math.min(1 << 20, mw * mh));
    const R = new Int32Array(cap), Gc = new Int32Array(cap), Bch = new Int32Array(cap), A = new Int32Array(cap);
    const out = new Uint8ClampedArray(nx * ny * 4);

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const rc = cellRect(grid, b, i, j);
        const hy = rc.y1 - rc.y0, wx = rc.x1 - rc.x0;
        let ya = Math.round(rc.y0 + hy * pad), yb = Math.round(rc.y0 + hy * (1 - pad));
        ya = Math.max(0, Math.min(h - 1, ya)); yb = Math.max(ya + 1, Math.min(h, yb));
        let xa = Math.round(rc.x0 + wx * pad), xb = Math.round(rc.x0 + wx * (1 - pad));
        xa = Math.max(0, Math.min(w - 1, xa)); xb = Math.max(xa + 1, Math.min(w, xb));
        let m = 0;
        for (let y = ya; y < yb && m < cap; y++) {
          for (let x = xa; x < xb && m < cap; x++) {
            const p = (y * w + x) * 4;
            R[m] = rgba[p]; Gc[m] = rgba[p + 1]; Bch[m] = rgba[p + 2]; A[m] = rgba[p + 3];
            m++;
          }
        }
        const o = (j * nx + i) * 4;
        if (!m) { out[o + 3] = 0; continue; }
        const gmed = weiszfeld(R, Gc, Bch, m);
        let bi = 0, bd = Infinity;
        for (let t = 0; t < m; t++) {
          const d = (R[t] - gmed[0]) ** 2 + (Gc[t] - gmed[1]) ** 2 + (Bch[t] - gmed[2]) ** 2;
          if (d < bd) { bd = d; bi = t; }
        }
        out[o] = R[bi]; out[o + 1] = Gc[bi]; out[o + 2] = Bch[bi]; out[o + 3] = A[bi];
      }
    }
    return { w: nx, h: ny, rgba: out };
  }

  PA.pixelate.register('sample', {
    id: 'geomedian',
    label: '幾何中位數',
    credit: { project: 'spritegrid', file: 'src/spritegrid/utils.py', license: 'MIT', url: 'https://github.com/marksverdhei/spritegrid' },
    cost: 'medium',
    params: [{ key: 'pad', label: '邊緣修剪', type: 'number', min: 0, max: 0.45, step: 0.05, default: 0.25 }],
    run,
  });
})();
