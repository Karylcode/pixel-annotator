/* pixelate/detect/perfecter.js
   移植自 pixel-perfecter（MIT）https://github.com/alexkorol/pixel-perfecter
   四子偵測：exact-NN、Canny 投影、自相關、phase-fold；統一分數 inter/√intra。
   一併致謝 proper-pixel-art（KennethJAllen）。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  function exactNN(rgba, w, h) {
    let best = 0;
    const maxS = Math.min(64, w, h);
    for (let s = 2; s <= maxS; s++) {
      if (w % s && h % s) continue;
      const nx = (w / s) | 0, ny = (h / s) | 0;
      if (!nx || !ny) continue;
      let bad = 0, cells = nx * ny;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const p0 = ((j * s) * w + i * s) * 4;
          const r0 = rgba[p0], g0 = rgba[p0 + 1], b0 = rgba[p0 + 2];
          let ok = true;
          for (let y = 0; y < s && ok; y++) {
            for (let x = 0; x < s; x++) {
              const p = ((j * s + y) * w + i * s + x) * 4;
              if (rgba[p] !== r0 || rgba[p + 1] !== g0 || rgba[p + 2] !== b0) { ok = false; break; }
            }
          }
          if (!ok) bad++;
        }
      }
      if (bad / cells <= 0.01) best = s;
    }
    return best;
  }

  function houghPitch(edge, w, h) {
    const px = new Float64Array(w), py = new Float64Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (edge[y * w + x]) { px[x]++; py[y]++; }
    }
    function peaks(E) {
      const out = [];
      for (let i = 1; i < E.length - 1; i++) if (E[i] > E[i - 1] && E[i] >= E[i + 1] && E[i] > 0) out.push(i);
      return out;
    }
    function medianGap(ps) {
      if (ps.length < 4) return 0;
      const g = [];
      for (let i = 1; i < ps.length; i++) g.push(ps[i] - ps[i - 1]);
      g.sort((a, b) => a - b);
      const cut = Math.max(1, (g.length * 0.1) | 0);
      const mid = g.slice(cut, g.length - cut);
      if (!mid.length) return g[(g.length / 2) | 0];
      return mid[(mid.length / 2) | 0];
    }
    const sx = medianGap(peaks(px)), sy = medianGap(peaks(py));
    return { sx, sy, xs: peaks(px), ys: peaks(py) };
  }

  function contrastScore(rgba, w, h, s, phi) {
    const nx = Math.max(1, Math.round((w - phi) / s));
    const ny = Math.max(1, Math.round((h - phi) / s));
    if (nx < 2 || ny < 2) return -1;
    let inter = 0, inN = 0, intra = 0, iN = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x0 = Math.round(phi + i * s), y0 = Math.round(phi + j * s);
        const x1 = Math.min(w, x0 + Math.round(s)), y1 = Math.min(h, y0 + Math.round(s));
        let sr = 0, sg = 0, sb = 0, n = 0, v = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const p = (y * w + x) * 4;
          sr += rgba[p]; sg += rgba[p + 1]; sb += rgba[p + 2]; n++;
        }
        if (!n) continue;
        const mr = sr / n, mg = sg / n, mb = sb / n;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const p = (y * w + x) * 4;
          v += (rgba[p] - mr) ** 2 + (rgba[p + 1] - mg) ** 2 + (rgba[p + 2] - mb) ** 2;
        }
        intra += v / n; iN++;
        if (i + 1 < nx) {
          const x2 = Math.min(w - 1, Math.round(phi + (i + 0.5) * s + s));
          const p2 = (Math.min(h - 1, y0 + ((y1 - y0) >> 1)) * w + x2) * 4;
          inter += Math.abs(rgba[p2] - mr) + Math.abs(rgba[p2 + 1] - mg) + Math.abs(rgba[p2 + 2] - mb);
          inN++;
        }
      }
    }
    if (!iN) return -1;
    return (inN ? inter / inN : 0) / Math.sqrt((intra / iN) + 1);
  }

  async function run(rgba, w, h, params, hooks) {
    hooks = hooks || {};
    const tick = hooks.tick || (() => new Promise(r => setTimeout(r, 0)));
    const onProgress = hooks.onProgress || (() => {});
    onProgress(0);
    await tick();
    const nn = exactNN(rgba, w, h);
    if (nn >= 2) {
      onProgress(1);
      return {
        id: 'perfecter', sx: nn, sy: nn, phx: 0, phy: 0, score: 1,
        meta: { nx: Math.round(w / nn), ny: Math.round(h / nn) },
      };
    }
    onProgress(0.3);
    await tick();
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4)
      gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    const edge = PA.pixelate.lib.canny.canny(gray, w, h, 1.0);
    const closed = PA.pixelate.lib.morph.close(edge, w, h);
    const hp = houghPitch(closed, w, h);
    onProgress(0.6);
    await tick();
    const cands = [];
    if (hp.sx >= 2) cands.push(hp.sx);
    if (hp.sy >= 2) cands.push(hp.sy);
    const prof = PA.pixelate.edgeProfiles(rgba, w, h);
    const ac = PA.pixelate.lib.fft.acf(prof.ex);
    let acBest = 2, acV = -1;
    for (let s = 2; s < w / 4; s += 0.5) {
      const v = PA.pixelate.lib.fft.interp(ac, s);
      if (v > acV) { acV = v; acBest = s; }
    }
    cands.push(acBest);
    let best = { s: acBest, phi: 0, z: -1 };
    for (let ci = 0; ci < cands.length; ci++) {
      const s = cands[ci];
      for (let k = 0; k < 8; k++) {
        const phi = s * k / 8;
        const z = contrastScore(rgba, w, h, s, phi);
        if (z > best.z) best = { s, phi, z };
      }
    }
    onProgress(1);
    const sx = best.s, sy = best.s;
    return {
      id: 'perfecter',
      sx, sy, phx: best.phi, phy: best.phi,
      score: Math.max(0, Math.min(1, best.z / 50)),
      meta: {
        nx: Math.max(1, Math.min(512, Math.round((w - best.phi) / sx))),
        ny: Math.max(1, Math.min(512, Math.round((h - best.phi) / sy))),
        lines: hp,
      },
    };
  }

  PA.pixelate.register('detect', {
    id: 'perfecter',
    label: 'pixel-perfecter',
    credit: { project: 'pixel-perfecter', file: 'pixel_perfecter/reconstructor.py', license: 'MIT', url: 'https://github.com/alexkorol/pixel-perfecter' },
    cost: 'slow',
    params: [],
    run,
  });
})();
