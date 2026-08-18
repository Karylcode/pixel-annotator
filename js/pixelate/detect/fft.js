/* pixelate/detect/fft.js
   移植自 perfectPixel（MIT）https://github.com/theamusing/perfectPixel
   梯度剖面 + Hann + rfft 主頻 → 格寬。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  function hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1 || 1)));
    return w;
  }
  function axisS(E) {
    const n = E.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += E[i];
    mean /= n || 1;
    const win = hann(n);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = (E[i] - mean) * win[i];
    const spec = PA.pixelate.lib.fft.rfft(x);
    const nfft = spec.nfft;
    const half = spec.re.length;
    let b1 = 2, p1 = -1;
    const powers = [];
    const lo = 2, hi = Math.min(half - 1, (n / 2) | 0);
    for (let f = lo; f < hi; f++) {
      const p = spec.re[f] * spec.re[f] + spec.im[f] * spec.im[f];
      powers.push({ f, p });
      if (p > p1) { p1 = p; b1 = f; }
    }
    powers.sort((a, b) => b.p - a.p);
    let f = b1;
    if (b1 > 0 && b1 < half - 1) {
      const y0 = spec.re[b1 - 1] * spec.re[b1 - 1] + spec.im[b1 - 1] * spec.im[b1 - 1];
      const y1 = p1;
      const y2 = spec.re[b1 + 1] * spec.re[b1 + 1] + spec.im[b1 + 1] * spec.im[b1 + 1];
      const den = y0 - 2 * y1 + y2;
      if (Math.abs(den) > 1e-12) f = b1 + 0.5 * (y0 - y2) / den;
    }
    const s = nfft / f;
    const top5 = powers.slice(0, 5).reduce((a, b) => a + b.p, 0) || 1;
    return { s, score: p1 / top5 };
  }

  async function run(rgba, w, h, params, hooks) {
    hooks = hooks || {};
    const tick = hooks.tick || (() => new Promise(r => setTimeout(r, 0)));
    const onProgress = hooks.onProgress || (() => {});
    onProgress(0);
    await tick();
    const prof = PA.pixelate.edgeProfiles(rgba, w, h);
    const ax = axisS(prof.ex);
    const ay = axisS(prof.ey);
    onProgress(1);
    const sx = Math.max(2, ax.s), sy = Math.max(2, ay.s);
    return {
      id: 'fft',
      sx, sy, phx: 0, phy: 0,
      score: (ax.score + ay.score) / 2,
      meta: {
        nx: Math.max(1, Math.min(512, Math.round(w / sx))),
        ny: Math.max(1, Math.min(512, Math.round(h / sy))),
      },
    };
  }

  PA.pixelate.register('detect', {
    id: 'fft',
    label: 'FFT',
    credit: { project: 'perfectPixel', file: 'perfectpixel.py', license: 'MIT', url: 'https://github.com/theamusing/perfectPixel' },
    cost: 'fast',
    params: [],
    run,
  });
})();
