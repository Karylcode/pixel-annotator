/* pixelate/detect/hough.js
   移植自 proper-pixel-art（KennethJAllen，MIT）https://github.com/KennethJAllen/proper-pixel-art
   原鏈：2× 最近鄰放大 → Canny → 形態學閉合 → 機率霍夫 → 直線分群 → 修剪中位間距。
   格線一定水平／垂直，所以霍夫簡化成「邊緣圖沿 X／Y 軸投影取峰」
   （等價於只累加 θ=0° 與 90° 的霍夫累加器），不做通用霍夫。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const MIN_PITCH = 2;
  const TRIM = 0.10;          // 修剪中位數：兩端各去掉 10%

  // 邊緣圖沿某軸投影 → 找峰 → 相鄰峰分群 → 峰之間的間距
  function pitchFromEdges(edge, w, h, axis) {
    const n = axis === 0 ? w : h;
    const m = axis === 0 ? h : w;
    const proj = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < m; j++) acc += edge[axis === 0 ? (j * w + i) : (i * w + j)];
      proj[i] = acc;
    }
    // 峰：高於平均且是局部極大
    let mean = 0;
    for (let i = 0; i < n; i++) mean += proj[i];
    mean /= n || 1;
    const raw = [];
    for (let i = 1; i < n - 1; i++)
      if (proj[i] > mean && proj[i] >= proj[i - 1] && proj[i] >= proj[i + 1]) raw.push(i);
    if (raw.length < 3) return null;
    // 分群：距離 < 2px 的峰合併成一條線（取加權中心）
    const lines = [];
    let g = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
      if (raw[i] - raw[i - 1] <= 2) g.push(raw[i]);
      else { lines.push(centre(g, proj)); g = [raw[i]]; }
    }
    lines.push(centre(g, proj));
    if (lines.length < 3) return null;
    // 間距 → 修剪中位數
    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      const d = lines[i] - lines[i - 1];
      if (d >= MIN_PITCH) gaps.push(d);
    }
    if (gaps.length < 2) return null;
    gaps.sort((a, b) => a - b);
    const lo = Math.floor(gaps.length * TRIM), hi = Math.ceil(gaps.length * (1 - TRIM));
    const kept = gaps.slice(lo, Math.max(lo + 1, hi));
    const pitch = kept[kept.length >> 1];
    if (!(pitch >= MIN_PITCH)) return null;
    // 相位：第一條線對 pitch 取模
    const phase = ((lines[0] % pitch) + pitch) % pitch;
    // 信心：間距落在 pitch ±20% 內的比例
    let near = 0;
    for (let i = 0; i < gaps.length; i++) if (Math.abs(gaps[i] - pitch) <= 0.2 * pitch) near++;
    return { pitch, phase, score: near / gaps.length };
  }

  function centre(group, proj) {
    let num = 0, den = 0;
    for (let i = 0; i < group.length; i++) { num += group[i] * proj[group[i]]; den += proj[group[i]]; }
    return den ? num / den : group[0];
  }

  async function run(rgba, w, h, params, hooks) {
    hooks = hooks || {};
    const tick = hooks.tick || (() => new Promise(r => setTimeout(r, 0)));
    const onProgress = hooks.onProgress || (() => {});
    const cancelled = hooks.cancelled || (() => false);
    onProgress(0);
    await tick();
    if (cancelled()) return null;

    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4)
      gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    const sigma = (params && params.sigma) || 1.0;
    const edge = PA.pixelate.lib.canny.canny(gray, w, h, sigma);
    onProgress(0.5);
    await tick();
    if (cancelled()) return null;
    const closed = PA.pixelate.lib.morph.close(edge, w, h);
    const ax = pitchFromEdges(closed, w, h, 0);
    const ay = pitchFromEdges(closed, w, h, 1);
    onProgress(1);
    if (!ax || !ay) return null;
    return {
      id: 'hough',
      sx: ax.pitch, sy: ay.pitch,
      phx: ax.phase, phy: ay.phase,
      score: Math.min(ax.score, ay.score),
      meta: {
        nx: Math.max(1, Math.min(512, Math.round((w - ax.phase) / ax.pitch))),
        ny: Math.max(1, Math.min(512, Math.round((h - ay.phase) / ay.pitch))),
        scoreX: ax.score, scoreY: ay.score,
      },
    };
  }

  PA.pixelate.register('detect', {
    id: 'hough',
    label: '霍夫',
    credit: {
      project: 'proper-pixel-art',
      file: 'proper_pixel_art/（Canny → 閉合 → 霍夫 → 分群 → 修剪中位間距）',
      license: 'MIT',
      url: 'https://github.com/KennethJAllen/proper-pixel-art',
    },
    cost: 'medium',
    params: [{ key: 'sigma', label: 'Canny σ', type: 'number', min: 0.5, max: 3, step: 0.1, default: 1.0 }],
    run,
  });
})();
