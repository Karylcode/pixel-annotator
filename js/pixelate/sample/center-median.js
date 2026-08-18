/* pixelate/sample/center-median.js — 現有 resample 原封搬入，註冊 id 'center-median'。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const gridApi = () => PA.pixelate.grid;

  /* ---------- 第二步:每格取色 ---------- */

  // 只取每格中央的一半,把邊緣的反鋸齒過渡整個丟掉 —— 這比選什麼統計量更關鍵。
  // 取逐通道中位數後再吸附到「格內實際存在的像素」,避免產生原圖沒有的顏色。
  function resample(rgba, w, h, g) {
    const { boundsOf, cellRect } = gridApi();
    const { xs, ys } = boundsOf(g);
    const nx = Math.max(1, Math.min(1024, xs.length - 1));
    const ny = Math.max(1, Math.min(1024, ys.length - 1));

    const out = new Uint8ClampedArray(nx * ny * 4);
    const PAD = 0.25;
    // 取樣緩衝要裝得下最大的格;mesh 的格寬逐格不同,乘個餘裕最省事
    let mw = 1, mh = 1;
    for (let i = 0; i < nx; i++) mw = Math.max(mw, Math.ceil(xs[i + 1] - xs[i]));
    for (let j = 0; j < ny; j++) mh = Math.max(mh, Math.ceil(ys[j + 1] - ys[j]));
    const cap = Math.max(16, Math.min(1 << 20, mw * mh * 4));
    const R = new Int32Array(cap), G = new Int32Array(cap), B = new Int32Array(cap), A = new Int32Array(cap);
    const hist = new Uint32Array(256);
    const bounds = { xs, ys };
    const medianU8 = (src, m) => {
      hist.fill(0);
      for (let t = 0; t < m; t++) hist[src[t]]++;
      const mid = m >> 1;
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > mid) return v; }
      return 255;
    };

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const rc = cellRect(g, bounds, i, j);
        const hy = rc.y1 - rc.y0, wx = rc.x1 - rc.x0;
        let ya = Math.round(rc.y0 + hy * PAD), yb = Math.round(rc.y0 + hy * (1 - PAD));
        ya = Math.max(0, Math.min(h - 1, ya));
        yb = Math.max(ya + 1, Math.min(h, yb));
        let xa = Math.round(rc.x0 + wx * PAD), xb = Math.round(rc.x0 + wx * (1 - PAD));
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
        const o = (j * nx + i) * 4;
        if (!m) continue;

        const mr = medianU8(R, m), mg = medianU8(G, m), mb = medianU8(B, m), ma = medianU8(A, m);

        let bi = 0, bd = Infinity;
        for (let t = 0; t < m; t++) {
          const d = (R[t] - mr) ** 2 + (G[t] - mg) ** 2 + (B[t] - mb) ** 2 + (A[t] - ma) ** 2;
          if (d < bd) { bd = d; bi = t; }
        }
        out[o] = R[bi]; out[o + 1] = G[bi]; out[o + 2] = B[bi]; out[o + 3] = A[bi];
      }
    }
    return { w: nx, h: ny, rgba: out };
  }

  // 把結果依同一格線放大回原尺寸量平均色差。格線抓對的話誤差會很低,
  // 誤差高而且呈規律條紋,通常是相位偏了半格。
  function reconstructError(rgba, w, h, g, small) {
    const { boundsOf, cellRect } = gridApi();
    const bounds = boundsOf(g);
    const nx = bounds.xs.length - 1, ny = bounds.ys.length - 1;
    let err = 0, cnt = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const rc = cellRect(g, bounds, i, j);
        let ya = Math.max(0, Math.round(rc.y0)), yb = Math.min(h, Math.round(rc.y1));
        let xa = Math.max(0, Math.round(rc.x0)), xb = Math.min(w, Math.round(rc.x1));
        const o = (j * nx + i) * 4;
        for (let y = ya; y < yb; y++) {
          for (let x = xa; x < xb; x++) {
            const p = (y * w + x) * 4;
            err += Math.abs(rgba[p] - small.rgba[o]) + Math.abs(rgba[p + 1] - small.rgba[o + 1]) + Math.abs(rgba[p + 2] - small.rgba[o + 2]);
            cnt += 3;
          }
        }
      }
    }
    return cnt ? err / cnt : 0;
  }

  PA.pixelate.resample = resample;
  PA.pixelate.reconstructError = reconstructError;

  PA.pixelate.register('sample', {
    id: 'center-median',
    label: '格心中位數',
    credit: { project: 'pixel-annotator', file: 'js/pixelate.js', license: 'MIT', url: '' },
    cost: 'fast',
    params: [],
    run: function(rgba, w, h, grid, bounds, params) {
      return resample(rgba, w, h, grid);
    },
  });
})();
