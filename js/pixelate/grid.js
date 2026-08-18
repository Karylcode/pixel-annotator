/* pixelate/grid.js — 格線邊界。自 js/pixelate.js 原封搬入。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

PA.pixelate.grid = (() => {

  /* ---------- 格線位置:等距只是起點,實際要逐條吸附 ---------- */

  // AI 放大出來的格子寬度是逐格抖動的(實測同一張圖有 21~27px 的差距),
  // 硬套固定格寬會讓某些格被多切一刀,對稱的東西(例如兩隻眼睛)就會一邊寬一邊窄。
  function uniformBounds(phase, s, n) {
    const out = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) out[k] = phase + k * s;
    return out;
  }

  // 逐條吸附到附近真正的邊緣。預測值來自「上一條的實際位置 + 格寬」而不是從頭累加,
  // 才追得上漂移;bias 讓它偏好靠近預測的位置,免得被遠處的強邊搶走。
  function snapBounds(E, phase, s, n, tol = 0.42, bias = 0.55) {
    const L = E.length, win = Math.max(1, Math.round(s * tol));
    const out = new Float64Array(n + 1);
    let pred = phase;
    for (let k = 0; k <= n; k++) {
      const lo = Math.max(0, Math.round(pred - win));
      const hi = Math.min(L - 1, Math.round(pred + win));
      let pick = Math.min(Math.max(pred, 0), L - 1), bv = -Infinity;
      for (let i = lo; i <= hi; i++) {
        const v = E[i] * (1 - bias * Math.abs(i - pred) / win);
        if (v > bv) { bv = v; pick = i; }
      }
      out[k] = pick;
      pred = pick + s;
    }
    for (let k = 1; k <= n; k++) if (out[k] <= out[k - 1]) out[k] = out[k - 1] + 1;
    return out;
  }

  // 網格吸附:AI 在不同區域用的局部格寬可以差很多(實測同一張圖臉部 35~39px、
  // 整體平均 26px),一組直線格線註定在某些帶切錯。所以在全圖吸附之後,
  // 每個輸出「列」再用自己那條帶的能量把垂直格線各自微調一次(行同理)。
  // 帶內太平坦(能量峰不夠強)就保留全圖位置,免得在空白區亂吸。
  function meshBounds(prof, xs, ys, s) {
    const { dx, dy, w, h } = prof;
    const nx = xs.length - 1, ny = ys.length - 1;
    const win = Math.max(2, s * 0.35);

    // sScan / sBand：不轉置就能沿另一軸掃描。
    // dx 沿 x 掃（sScan=1, sBand=w）；dy 沿 y 掃（sScan=w, sBand=1）。
    const refine = (diff, scanN, lines, bands, out, sScan, sBand, bandMax) => {
      let gm = 0;
      for (let i = 0; i < diff.length; i++) gm += diff[i];
      gm /= diff.length;

      const Eb = new Float64Array(scanN), Es = new Float64Array(scanN);
      for (let j = 0; j < bands.length - 1; j++) {
        const a = Math.max(0, Math.round(bands[j]));
        const b = Math.min(bandMax, Math.max(a + 1, Math.round(bands[j + 1])));
        Eb.fill(0);
        for (let band = a; band < b; band++) {
          const base = band * sBand;
          for (let x = 0; x < scanN; x++) Eb[x] += diff[base + x * sScan];
        }
        for (let x = 0; x < scanN; x++) {
          Es[x] = 0.25 * Eb[Math.max(0, x - 1)] + 0.5 * Eb[x] + 0.25 * Eb[Math.min(scanN - 1, x + 1)];
        }
        const floor = gm * (b - a) * 0.6;     // 峰值至少要有這個強度才可信
        let prev = -Infinity;
        for (let i = 0; i < lines.length; i++) {
          const pred = lines[i];
          const lo = Math.max(0, Math.round(pred - win));
          const hi = Math.min(scanN - 1, Math.round(pred + win));
          let pick = pred, bv = -Infinity;
          for (let x = lo; x <= hi; x++) {
            const v = Es[x] * (1 - 0.55 * Math.abs(x - pred) / win);
            if (v > bv) { bv = v; pick = x; }
          }
          let p = (bv >= floor) ? pick : pred;
          if (p <= prev) p = prev + 1;
          out[j * lines.length + i] = p;
          prev = p;
        }
      }
    };

    const xsB = new Float64Array(ny * (nx + 1));
    const ysB = new Float64Array(nx * (ny + 1));
    refine(dx, w, xs, ys, xsB, 1, w, h);
    refine(dy, h, ys, xs, ysB, w, 1, w);
    return { xsB, ysB, nx, ny };
  }

  // 依 g 的格數/格寬/相位重建邊界;有 profiles 且 snap 為真就吸附
  function buildBounds(g, profiles, snap) {
    const xs = uniformBounds(g.phx, g.sx, g.nx);
    const ys = uniformBounds(g.phy, g.sy, g.ny);
    // 格子只有一兩 px 時「吸附到附近的邊緣」沒有意義,只會把 1:1 的對應打亂
    if (!snap || !profiles || g.sx < 3 || g.sy < 3) return { xs, ys };
    return {
      xs: snapBounds(profiles.ex, g.phx, g.sx, g.nx),
      ys: snapBounds(profiles.ey, g.phy, g.sy, g.ny),
    };
  }

  const boundsOf = g => ({
    xs: g.xs || uniformBounds(g.phx, g.sx, g.nx),
    ys: g.ys || uniformBounds(g.phy, g.sy, g.ny),
  });

  // 每一格的實際邊界:有 mesh 就逐格查,否則退回一維邊界
  function cellRect(g, bounds, i, j) {
    if (g.mesh) {
      const { xsB, ysB, nx, ny } = g.mesh;
      return {
        x0: xsB[j * (nx + 1) + i], x1: xsB[j * (nx + 1) + i + 1],
        y0: ysB[i * (ny + 1) + j], y1: ysB[i * (ny + 1) + j + 1],
      };
    }
    return { x0: bounds.xs[i], x1: bounds.xs[i + 1], y0: bounds.ys[j], y1: bounds.ys[j + 1] };
  }

  return { uniformBounds, snapBounds, meshBounds, buildBounds, boundsOf, cellRect };
})();

PA.pixelate.uniformBounds = PA.pixelate.grid.uniformBounds;
PA.pixelate.snapBounds = PA.pixelate.grid.snapBounds;
PA.pixelate.meshBounds = PA.pixelate.grid.meshBounds;
PA.pixelate.buildBounds = PA.pixelate.grid.buildBounds;
PA.pixelate.cellRect = PA.pixelate.grid.cellRect;
