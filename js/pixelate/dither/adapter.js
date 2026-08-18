/* pixelate/dither/adapter.js
   包 Tezumie/Image-to-Pixel 的抖色核（MIT）。
   https://github.com/Tezumie/Image-to-Pixel  commit b0d5b7422db309dae22c2a69d4ebca0ce8c14b78
   vendor 檔依賴 document，Worker / Node 走下方備援（演算法與 vendor 相同）。
   不呼叫 fetchPalette（Lospec）。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const G = PA_ROOT;

  const BAYER2 = [[0, 2], [3, 1]];
  const BAYER4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const BAYER8 = [
    [0, 48, 12, 60, 3, 51, 15, 63],
    [32, 16, 44, 28, 35, 19, 47, 31],
    [8, 56, 4, 52, 11, 59, 7, 55],
    [40, 24, 36, 20, 43, 27, 39, 23],
    [2, 50, 14, 62, 1, 49, 13, 61],
    [34, 18, 46, 30, 33, 17, 45, 29],
    [10, 58, 6, 54, 9, 57, 5, 53],
    [42, 26, 38, 22, 41, 25, 37, 21],
  ];
  const CLUSTERED4 = [
    [7, 13, 11, 4],
    [12, 16, 14, 8],
    [10, 15, 6, 2],
    [5, 9, 3, 1],
  ];

  const ID_TO_VENDOR = {
    fs: 'Floyd-Steinberg',
    bayer2: '2x2 Bayer',
    bayer4: '4x4 Bayer',
    ordered: 'ordered',
    clustered4: 'clustered 4x4',
    atkinson: 'atkinson',
  };

  function palRgb(palette) {
    const out = [];
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      out.push([p[0], p[1], p[2]]);
    }
    return out;
  }

  function closest(color, pal) {
    let best = pal[0], bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const d = (color[0] - pal[i][0]) ** 2 + (color[1] - pal[i][1]) ** 2 + (color[2] - pal[i][2]) ** 2;
      if (d < bd) { bd = d; best = pal[i]; }
    }
    return best;
  }

  function distribute(buf, x, y, err, f, w, h) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 4;
    buf[i] += err[0] * f;
    buf[i + 1] += err[1] * f;
    buf[i + 2] += err[2] * f;
  }

  function errorDiffuse(data, w, h, strength, pal, neighbors) {
    const err = new Float32Array(data.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] === 0) continue;
        const r = data[i] + err[i], g = data[i + 1] + err[i + 1], b = data[i + 2] + err[i + 2];
        const nc = closest([r, g, b], pal);
        data[i] = nc[0]; data[i + 1] = nc[1]; data[i + 2] = nc[2];
        const qe = [(r - nc[0]) * strength, (g - nc[1]) * strength, (b - nc[2]) * strength];
        for (let n = 0; n < neighbors.length; n++) {
          const t = neighbors[n];
          distribute(err, x + t[0], y + t[1], qe, t[2], w, h);
        }
      }
    }
  }

  function ordered(data, w, h, strength, pal, matrix) {
    const n = matrix.length;
    const den = n * n;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] === 0) continue;
        const thr = ((matrix[y % n][x % n] + 0.5) / den) * 255;
        const adj = [
          data[i] + (thr - 127.5) * strength,
          data[i + 1] + (thr - 127.5) * strength,
          data[i + 2] + (thr - 127.5) * strength,
        ];
        const nc = closest(adj, pal);
        data[i] = nc[0]; data[i + 1] = nc[1]; data[i + 2] = nc[2];
      }
    }
  }

  function fallbackRun(small, pal, id, strength) {
    if (id === 'none' || !pal.length) return small;
    const data = small.rgba;
    const w = small.w, h = small.h;
    if (id === 'fs') {
      errorDiffuse(data, w, h, strength, pal, [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]);
    } else if (id === 'atkinson') {
      errorDiffuse(data, w, h, strength, pal, [
        [1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8],
      ]);
    } else if (id === 'bayer2') ordered(data, w, h, strength, pal, BAYER2);
    else if (id === 'bayer4') ordered(data, w, h, strength, pal, BAYER4);
    else if (id === 'ordered') ordered(data, w, h, strength, pal, BAYER8);
    else if (id === 'clustered4') ordered(data, w, h, strength, pal, CLUSTERED4);
    else errorDiffuse(data, w, h, strength, pal, [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]);
    return small;
  }

  function vendorRun(small, pal, id, strength) {
    const img = { data: small.rgba, width: small.w, height: small.h };
    const s = strength;
    if (id === 'fs' && typeof G.floydSteinbergDithering === 'function') {
      G.floydSteinbergDithering(img, small.w, small.h, s, pal);
      return small;
    }
    if (id === 'atkinson' && typeof G.atkinsonDithering === 'function') {
      G.atkinsonDithering(img, small.w, small.h, s, pal);
      return small;
    }
    if (typeof G.orderedDithering === 'function' && typeof G.getBayerMatrix === 'function') {
      let m = null;
      if (id === 'bayer2') m = G.getBayerMatrix('2x2');
      else if (id === 'bayer4') m = G.getBayerMatrix('4x4');
      else if (id === 'ordered') m = G.getBayerMatrix('8x8');
      else if (id === 'clustered4') m = G.getBayerMatrix('clustered 4x4');
      if (m) {
        G.orderedDithering(img, small.w, small.h, s, pal, m);
        return small;
      }
    }
    return fallbackRun(small, pal, id, strength);
  }

  function run(small, palette, id, strength) {
    if (!id || id === 'none') return small;
    const pal = palRgb(palette || []);
    if (!pal.length) return small;
    let s = strength;
    if (s == null) s = 0.5;
    if (s > 1) s = s / 100;
    s = Math.max(0, Math.min(1, s));
    try {
      return vendorRun(small, pal, id, s);
    } catch {
      return fallbackRun(small, pal, id, s);
    }
  }

  const credit = {
    project: 'Image-to-Pixel',
    file: 'image-to-pixel.js',
    license: 'MIT',
    url: 'https://github.com/Tezumie/Image-to-Pixel',
  };
  const modes = [
    ['none', '無'],
    ['fs', 'Floyd–Steinberg'],
    ['bayer2', 'Bayer 2×2'],
    ['bayer4', 'Bayer 4×4'],
    ['ordered', 'Ordered 8×8'],
    ['clustered4', 'Clustered 4×4'],
    ['atkinson', 'Atkinson'],
  ];
  modes.forEach(([id, label]) => {
    PA.pixelate.register('dither', {
      id, label, credit, cost: 'fast', params: [],
      run: function(small, palette, did, strength) { return run(small, palette, did || id, strength); },
    });
  });
  PA.pixelate.register('dither', {
    id: 'adapter', label: 'Image-to-Pixel', credit, cost: 'fast', params: [],
    run,
  });
  PA.pixelate.ditherIds = modes.map(m => m[0]);
})();
