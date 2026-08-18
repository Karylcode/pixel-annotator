/* pixelate/sample/two-stage.js
   移植自 Pixel Art Fixer python/pixelfixer/reconstruct.py two_stage_pack
   commit ef376e57e1c272633ca2dbf5f29ec3fcf6596465  MIT
   結構用量化標籤投票，顏色取原圖像素的中心加權平均。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  function adaptiveK(rgba) {
    const cnt = new Uint32Array(4096);
    let n = 0;
    for (let p = 0; p < rgba.length; p += 4) {
      if (rgba[p + 3] === 0) continue;
      const key = ((rgba[p] >> 4) << 8) | ((rgba[p + 1] >> 4) << 4) | (rgba[p + 2] >> 4);
      cnt[key]++; n++;
    }
    if (!n) return 16;
    const share = 0.003 * n;
    let k = 0;
    for (let i = 0; i < 4096; i++) if (cnt[i] >= share) k++;
    return Math.max(16, Math.min(48, k));
  }

  function labelsOf(rgba, w, h, k) {
    const copy = new Uint8ClampedArray(rgba);
    PA.pixelate.quantize({ rgba: copy, w, h }, k);
    const map = new Map();
    const labels = new Int32Array(w * h);
    let next = 0;
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      if (copy[p + 3] === 0) { labels[i] = -1; continue; }
      const key = (copy[p] << 16) | (copy[p + 1] << 8) | copy[p + 2];
      let id = map.get(key);
      if (id == null) { id = next++; map.set(key, id); }
      labels[i] = id;
    }
    return { labels, kUsed: next };
  }

  function run(rgba, w, h, grid, bounds, params) {
    const nx = grid.nx, ny = grid.ny;
    const K = (params && params.k) || adaptiveK(rgba);
    const { labels, kUsed } = labelsOf(rgba, w, h, K);
    const out = new Uint8ClampedArray(nx * ny * 4);
    const cellRect = PA.pixelate.grid.cellRect;
    const b = bounds || PA.pixelate.grid.boundsOf(grid);

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const rc = cellRect(grid, b, i, j);
        const x0 = Math.max(0, Math.floor(rc.x0));
        const x1 = Math.min(w, Math.ceil(rc.x1));
        const y0 = Math.max(0, Math.floor(rc.y0));
        const y1 = Math.min(h, Math.ceil(rc.y1));
        const cx = (rc.x0 + rc.x1) / 2, cy = (rc.y0 + rc.y1) / 2;
        const sig = Math.max(0.5, 0.3 * Math.max(rc.x1 - rc.x0, rc.y1 - rc.y0));
        const inv2s = 1 / (2 * sig * sig);
        const votes = new Float64Array(Math.max(1, kUsed));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const lab = labels[y * w + x];
            if (lab < 0) continue;
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            votes[lab] += Math.exp(-(dx * dx + dy * dy) * inv2s);
          }
        }
        let win = 0, wv = -1;
        for (let t = 0; t < votes.length; t++) if (votes[t] > wv) { wv = votes[t]; win = t; }
        let sr = 0, sg = 0, sb = 0, sa = 0, sw = 0, allW = 0, ar = 0, ag = 0, ab = 0, aa = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const p = (y * w + x) * 4;
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            const wt = Math.exp(-(dx * dx + dy * dy) * inv2s);
            ar += rgba[p] * wt; ag += rgba[p + 1] * wt; ab += rgba[p + 2] * wt; aa += rgba[p + 3] * wt;
            allW += wt;
            if (labels[y * w + x] !== win) continue;
            sr += rgba[p] * wt; sg += rgba[p + 1] * wt; sb += rgba[p + 2] * wt; sa += rgba[p + 3] * wt;
            sw += wt;
          }
        }
        const o = (j * nx + i) * 4;
        if (sw > 1e-6) {
          out[o] = sr / sw; out[o + 1] = sg / sw; out[o + 2] = sb / sw; out[o + 3] = sa / sw;
        } else if (allW > 1e-6) {
          out[o] = ar / allW; out[o + 1] = ag / allW; out[o + 2] = ab / allW; out[o + 3] = aa / allW;
        }
      }
    }
    return { w: nx, h: ny, rgba: out };
  }

  PA.pixelate.register('sample', {
    id: 'two-stage',
    label: '兩階段（結構／顏色）',
    credit: { project: 'Pixel Art Fixer', file: 'python/pixelfixer/reconstruct.py', license: 'MIT', url: 'https://github.com/Retro-Diffusion/pixel-art-fixer' },
    cost: 'medium',
    params: [],
    run,
  });
})();
