/* pixelate/sample/pixeloe.js
   移植自 PixelOE src/pixeloe/legacy/outline.py 與 downscale/contrast_based.py
   https://github.com/KohakuBlueleaf/PixelOE
   commit 341aa85048338d4d26c62fba23176e2b70d9f61b  Apache-2.0
   Copyright 2024 KohakuBlueLeaf
   輪廓擴張 + CIELAB 對比感知降採樣。不碰 torch；unfold 以區塊統計近似。
   TODO(v3.1)：完全對齊 apply_chunk 的 fold/unfold 重疊寫入。
   2026-08-18 修正：中位數窗邊長 k*2、min/max 窗邊長 k（原本兩者都大一倍，
   中位數取樣量超出緩衝區導致 med=undefined→NaN→輸出全黑），正規化改回 (x−min)/max。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

  function morphChan(src, w, h, mode, diamond) {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let r = mode === 'min' ? 255 : 0, g = r, b = r;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (diamond && Math.abs(dx) + Math.abs(dy) > 1) continue;
            const xx = Math.max(0, Math.min(w - 1, x + dx));
            const yy = Math.max(0, Math.min(h - 1, y + dy));
            const p = (yy * w + xx) * 4;
            if (mode === 'min') {
              if (src[p] < r) r = src[p];
              if (src[p + 1] < g) g = src[p + 1];
              if (src[p + 2] < b) b = src[p + 2];
            } else {
              if (src[p] > r) r = src[p];
              if (src[p + 1] > g) g = src[p + 1];
              if (src[p + 2] > b) b = src[p + 2];
            }
          }
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = src[o + 3];
      }
    }
    return out;
  }

  function morphN(src, w, h, mode, n, diamond) {
    let cur = src;
    for (let i = 0; i < n; i++) cur = morphChan(cur, w, h, mode, diamond);
    return cur;
  }

  function luma(rgba, w, h) {
    const L = new Float32Array(w * h);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) {
      L[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;
    }
    return L;
  }

  function expansionWeight(L, w, h, k, stride, avgScale, distScale) {
    const sw = Math.max(1, Math.ceil(w / stride));
    const sh = Math.max(1, Math.ceil(h / stride));
    const small = new Float32Array(sw * sh);
    // 上游 apply_chunk_torch(img, kernel, ...) 的 kernel 是「窗的邊長」：
    //   中位數用 k*2、min/max 用 k。半徑因此是 k 與 k/2，不是 2k 與 k。
    const medHalf = k;                 // 中位數窗邊長 = 2*medHalf = k*2
    const mmHalf = Math.max(1, k >> 1); // min/max 窗邊長 = 2*mmHalf = k
    const buf = new Float32Array((2 * medHalf + 2) * (2 * medHalf + 2));
    for (let sy = 0; sy < sh; sy++) {
      for (let sx = 0; sx < sw; sx++) {
        const cx = Math.min(w - 1, sx * stride + (stride >> 1));
        const cy = Math.min(h - 1, sy * stride + (stride >> 1));
        let n = 0, nK = 0, maxv = -Infinity, minv = Infinity, sum = 0;
        const x0 = Math.max(0, cx - medHalf), x1 = Math.min(w, cx + medHalf);
        const y0 = Math.max(0, cy - medHalf), y1 = Math.min(h, cy + medHalf);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (n < buf.length) buf[n++] = L[y * w + x];
          }
        }
        if (!n) { small[sy * sw + sx] = 0.5; continue; }
        const tmp = buf.slice(0, n).sort();
        const med = tmp[n >> 1];
        const xk0 = Math.max(0, cx - mmHalf), xk1 = Math.min(w, cx + mmHalf);
        const yk0 = Math.max(0, cy - mmHalf), yk1 = Math.min(h, cy + mmHalf);
        for (let y = yk0; y < yk1; y++) {
          for (let x = xk0; x < xk1; x++) {
            const v = L[y * w + x];
            if (v > maxv) maxv = v;
            if (v < minv) minv = v;
            sum += v; nK++;
          }
        }
        if (!nK) { maxv = med; minv = med; }
        const avg = med;
        const bright = maxv - avg, dark = avg - minv;
        small[sy * sw + sx] = sigmoid((avg - 0.5) * avgScale - (bright - dark) * distScale);
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) * sh / h - 0.5;
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
      const y1 = Math.min(sh - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = (x + 0.5) * sw / w - 0.5;
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
        const x1 = Math.min(sw - 1, x0 + 1);
        const tx = fx - x0;
        const a = small[y0 * sw + x0], b = small[y0 * sw + x1];
        const c = small[y1 * sw + x0], d = small[y1 * sw + x1];
        out[y * w + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      }
    }
    // 上游：(output - np.min(output)) / (np.max(output))　—— 分母是最大值，不是全距
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < out.length; i++) { if (out[i] < mn) mn = out[i]; if (out[i] > mx) mx = out[i]; }
    const den = mx || 1;
    for (let i = 0; i < out.length; i++) {
      const v = (out[i] - mn) / den;
      out[i] = v >= 0 ? (v <= 1 ? v : 1) : 0;
    }
    return out;
  }

  function outlineExpansion(rgba, w, h, params) {
    const erodeN = params.erode != null ? params.erode : 2;
    const dilateN = params.dilate != null ? params.dilate : 2;
    const k = params.k != null ? params.k : 16;
    const avgScale = params.avgScale != null ? params.avgScale : 10;
    const distScale = params.distScale != null ? params.distScale : 3;
    const stride = Math.max(2, (k >> 2) * 2);
    const L = luma(rgba, w, h);
    const weight = expansionWeight(L, w, h, k, stride, avgScale, distScale);
    const eroded = morphN(rgba, w, h, 'min', erodeN, false);
    const dilated = morphN(rgba, w, h, 'max', dilateN, false);
    const mixed = new Uint8ClampedArray(rgba.length);
    for (let i = 0, p = 0; i < weight.length; i++, p += 4) {
      const wt = weight[i];
      const ow = sigmoid((wt - 0.5) * 5) * 0.25;
      for (let c = 0; c < 3; c++) {
        const v = eroded[p + c] * wt + dilated[p + c] * (1 - wt);
        mixed[p + c] = v * (1 - ow) + rgba[p + c] * ow;
      }
      mixed[p + 3] = rgba[p + 3];
    }
    let out = morphN(mixed, w, h, 'min', erodeN, true);
    out = morphN(out, w, h, 'max', dilateN * 2, true);
    out = morphN(out, w, h, 'min', erodeN, true);
    return out;
  }

  function findL(vals, n) {
    if (!n) return 0;
    let sum = 0, mini = Infinity, maxi = -Infinity;
    const tmp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      tmp[i] = v; sum += v;
      if (v < mini) mini = v;
      if (v > maxi) maxi = v;
    }
    tmp.sort();
    const med = tmp[n >> 1];
    const mu = sum / n;
    const mid = tmp[n >> 1];
    if (med < mu && maxi - med > med - mini) return mini;
    if (med > mu && maxi - med < med - mini) return maxi;
    return mid;
  }

  function medianF(vals, n) {
    if (!n) return 0;
    const tmp = new Float32Array(n);
    for (let i = 0; i < n; i++) tmp[i] = vals[i];
    tmp.sort();
    return tmp[n >> 1];
  }

  function contrastSample(rgba, w, h, grid, bounds) {
    const b = bounds || PA.pixelate.grid.boundsOf(grid);
    const cellRect = PA.pixelate.grid.cellRect;
    const nx = Math.max(1, Math.min(1024, grid.nx));
    const ny = Math.max(1, Math.min(1024, grid.ny));
    let mw = 1, mh = 1;
    for (let i = 0; i < b.xs.length - 1; i++) mw = Math.max(mw, Math.ceil(b.xs[i + 1] - b.xs[i]));
    for (let j = 0; j < b.ys.length - 1; j++) mh = Math.max(mh, Math.ceil(b.ys[j + 1] - b.ys[j]));
    const cap = Math.max(16, Math.min(1 << 20, mw * mh));
    const Ls = new Float32Array(cap), As = new Float32Array(cap), Bs = new Float32Array(cap);
    const out = new Uint8ClampedArray(nx * ny * 4);
    const toLab = PA.pixelate.toCielab;
    const fromLab = PA.pixelate.fromCielab;

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const rc = cellRect(grid, b, i, j);
        const ya = Math.max(0, Math.min(h, Math.round(rc.y0)));
        const yb = Math.max(ya + 1, Math.min(h, Math.round(rc.y1)));
        const xa = Math.max(0, Math.min(w, Math.round(rc.x0)));
        const xb = Math.max(xa + 1, Math.min(w, Math.round(rc.x1)));
        let m = 0, opaque = 0;
        for (let y = ya; y < yb && m < cap; y++) {
          for (let x = xa; x < xb && m < cap; x++) {
            const p = (y * w + x) * 4;
            if (rgba[p + 3] === 0) continue;
            const lab = toLab(rgba[p], rgba[p + 1], rgba[p + 2]);
            Ls[m] = lab[0]; As[m] = lab[1]; Bs[m] = lab[2];
            m++; opaque++;
          }
        }
        const o = (j * nx + i) * 4;
        if (!m) { out[o + 3] = 0; continue; }
        const rgb = fromLab(findL(Ls, m), medianF(As, m), medianF(Bs, m));
        out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
      }
    }
    return { w: nx, h: ny, rgba: out };
  }

  function run(rgba, w, h, grid, bounds, params) {
    params = params || {};
    let src = rgba;
    if (params.outline !== false) {
      src = outlineExpansion(rgba, w, h, params);
    }
    return contrastSample(src, w, h, grid, bounds);
  }

  PA.pixelate.register('sample', {
    id: 'pixeloe',
    label: 'PixelOE 對比降採樣',
    credit: { project: 'PixelOE', file: 'src/pixeloe/legacy/outline.py', license: 'Apache-2.0', url: 'https://github.com/KohakuBlueleaf/PixelOE' },
    cost: 'slow',
    params: [
      { key: 'outline', label: '輪廓擴張', type: 'bool', default: true },
      { key: 'k', label: '權重核', type: 'number', min: 4, max: 32, step: 2, default: 16 },
    ],
    run,
  });
})();
