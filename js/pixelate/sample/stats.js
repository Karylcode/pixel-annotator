/* pixelate/sample/stats.js
   移植自 unfake.js 的格內統計取樣（dominant / mode / mean / median / qvote）。
   MIT；只移植演算法，未使用 imagequant / wasm。
   https://github.com/jenissimo/unfake.js */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  function collect(rgba, w, h, grid, bounds, pad, cap) {
    const cellRect = PA.pixelate.grid.cellRect;
    const nx = grid.nx, ny = grid.ny;
    const R = new Int32Array(cap), G = new Int32Array(cap), B = new Int32Array(cap), A = new Int32Array(cap);
    return function each(i, j) {
      const rc = cellRect(grid, bounds, i, j);
      const hy = rc.y1 - rc.y0, wx = rc.x1 - rc.x0;
      let ya = Math.round(rc.y0 + hy * pad), yb = Math.round(rc.y0 + hy * (1 - pad));
      ya = Math.max(0, Math.min(h - 1, ya));
      yb = Math.max(ya + 1, Math.min(h, yb));
      let xa = Math.round(rc.x0 + wx * pad), xb = Math.round(rc.x0 + wx * (1 - pad));
      xa = Math.max(0, Math.min(w - 1, xa));
      xb = Math.max(xa + 1, Math.min(w, xb));
      let m = 0;
      for (let y = ya; y < yb && m < cap; y++) {
        for (let x = xa; x < xb && m < cap; x++) {
          const p = (y * w + x) * 4;
          R[m] = rgba[p]; G[m] = rgba[p + 1]; B[m] = rgba[p + 2]; A[m] = rgba[p + 3];
          m++;
        }
      }
      return m;
    };
  }

  function maxCell(grid, bounds) {
    const xs = bounds.xs, ys = bounds.ys;
    let mw = 1, mh = 1;
    for (let i = 0; i < xs.length - 1; i++) mw = Math.max(mw, Math.ceil(xs[i + 1] - xs[i]));
    for (let j = 0; j < ys.length - 1; j++) mh = Math.max(mh, Math.ceil(ys[j + 1] - ys[j]));
    return Math.max(16, Math.min(1 << 20, mw * mh * 4));
  }

  function medianU8(src, m, hist) {
    hist.fill(0);
    for (let t = 0; t < m; t++) hist[src[t]]++;
    const mid = m >> 1;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > mid) return v; }
    return 255;
  }

  function snapToPixel(R, G, B, A, m, mr, mg, mb, ma) {
    let bi = 0, bd = Infinity;
    for (let t = 0; t < m; t++) {
      const d = (R[t] - mr) ** 2 + (G[t] - mg) ** 2 + (B[t] - mb) ** 2 + (A[t] - ma) ** 2;
      if (d < bd) { bd = d; bi = t; }
    }
    return bi;
  }

  function makeSampler(kind) {
    return function(rgba, w, h, grid, bounds, params) {
      const pad = params && params.pad != null ? params.pad : 0.25;
      const b = bounds || PA.pixelate.grid.boundsOf(grid);
      const nx = Math.max(1, Math.min(1024, grid.nx));
      const ny = Math.max(1, Math.min(1024, grid.ny));
      const cap = maxCell(grid, b);
      const R = new Int32Array(cap), Gcol = new Int32Array(cap), B = new Int32Array(cap), A = new Int32Array(cap);
      const each = (function() {
        const cellRect = PA.pixelate.grid.cellRect;
        return function(i, j) {
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
              R[m] = rgba[p]; Gcol[m] = rgba[p + 1]; B[m] = rgba[p + 2]; A[m] = rgba[p + 3];
              m++;
            }
          }
          return m;
        };
      })();
      const out = new Uint8ClampedArray(nx * ny * 4);
      const hist = new Uint32Array(256);
      const bins = new Map();

      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const m = each(i, j);
          const o = (j * nx + i) * 4;
          if (!m) continue;
          let mr, mg, mb, ma;
          if (kind === 'mean') {
            let sr = 0, sg = 0, sb = 0, sa = 0;
            for (let t = 0; t < m; t++) { sr += R[t]; sg += Gcol[t]; sb += B[t]; sa += A[t]; }
            mr = sr / m; mg = sg / m; mb = sb / m; ma = sa / m;
          } else if (kind === 'median') {
            mr = medianU8(R, m, hist); mg = medianU8(Gcol, m, hist); mb = medianU8(B, m, hist); ma = medianU8(A, m, hist);
          } else if (kind === 'mode' || kind === 'dominant') {
            bins.clear();
            const shift = kind === 'dominant' ? 3 : 0;
            for (let t = 0; t < m; t++) {
              const key = ((R[t] >> shift) << 16) | ((Gcol[t] >> shift) << 8) | (B[t] >> shift);
              let rec = bins.get(key);
              if (!rec) bins.set(key, rec = { n: 0, r: 0, g: 0, b: 0, a: 0 });
              rec.n++; rec.r += R[t]; rec.g += Gcol[t]; rec.b += B[t]; rec.a += A[t];
            }
            let best = null;
            bins.forEach(rec => { if (!best || rec.n > best.n) best = rec; });
            mr = best.r / best.n; mg = best.g / best.n; mb = best.b / best.n; ma = best.a / best.n;
          } else { // qvote：5 分位桶，取票數最高桶的中位數
            const tmp = new Int32Array(m);
            for (let t = 0; t < m; t++) tmp[t] = (R[t] << 16) | (Gcol[t] << 8) | B[t];
            tmp.sort();
            const qn = 5;
            const counts = new Int32Array(qn);
            for (let t = 0; t < m; t++) counts[Math.min(qn - 1, (t * qn / m) | 0)]++;
            let qi = 0;
            for (let q = 1; q < qn; q++) if (counts[q] > counts[qi]) qi = q;
            const lo = Math.floor(m * qi / qn), hi = Math.max(lo + 1, Math.floor(m * (qi + 1) / qn));
            const mid = tmp[(lo + hi) >> 1];
            mr = (mid >> 16) & 255; mg = (mid >> 8) & 255; mb = mid & 255; ma = 255;
          }
          const bi = snapToPixel(R, Gcol, B, A, m, mr, mg, mb, ma == null ? 255 : ma);
          out[o] = R[bi]; out[o + 1] = Gcol[bi]; out[o + 2] = B[bi]; out[o + 3] = A[bi];
        }
      }
      return { w: nx, h: ny, rgba: out };
    };
  }

  const credit = { project: 'unfake.js', file: 'unfake-core downscale', license: 'MIT', url: 'https://github.com/jenissimo/unfake.js' };
  const kinds = [
    ['dominant', '眾數（5-bit 分箱）'],
    ['mode', '眾數'],
    ['mean', '平均'],
    ['median', '中位數'],
    ['qvote', '分位投票'],
  ];
  kinds.forEach(([id, label]) => {
    PA.pixelate.register('sample', {
      id, label, credit, cost: 'fast',
      params: [{ key: 'pad', label: '邊緣修剪', type: 'number', min: 0, max: 0.45, step: 0.05, default: 0.25 }],
      run: makeSampler(id),
    });
  });
})();
