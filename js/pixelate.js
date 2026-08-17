/* pixelate — 把「看起來像像素圖但沒對齊」的圖(通常是 AI 生成後放大的)還原成真正的像素圖。
   純運算,不碰畫面也不碰狀態。三步:偵測格線 -> 每格取色 -> 減色。 */
window.PA = window.PA || {};

PA.pixelate = (() => {

  /* ---------- 第一步:偵測格線 ---------- */

  // 像素邊界會在差分能量上留下週期性尖峰。回傳長度 n 的能量序列。
  function edgeEnergy(rgba, w, h, axis) {
    const n = axis === 0 ? w : h;
    const e = new Float64Array(n);
    if (axis === 0) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 1; x < w; x++) {
          const i = (row + x) * 4, j = i - 4;
          e[x] += Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
        }
      }
    } else {
      for (let y = 1; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4, j = i - w * 4;
          e[y] += Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
        }
      }
    }
    // AI 的邊緣會糊成 2-3 px,輕微平滑讓峰值集中
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      s[i] = 0.25 * e[Math.max(0, i - 1)] + 0.5 * e[i] + 0.25 * e[Math.min(n - 1, i + 1)];
    }
    return s;
  }

  // 用世代戳記重複利用同一塊記憶體,免得每次評分都配置新陣列
  const scratch = { buf: null, gen: 0 };
  function stamp(n) {
    if (!scratch.buf || scratch.buf.length < n) { scratch.buf = new Int32Array(n); scratch.gen = 0; }
    return ++scratch.gen;
  }

  // 分數 = 精確度 × 召回率。
  //   精確度 = 格線位置的平均能量 / 非格線位置的平均能量
  //   召回率 = 格線解釋掉的能量 / 總能量
  // 只看精確度的話,愈粗的格線取樣愈少、愈容易只挑到強邊而虛高,結果會選到真實
  // 週期的整數倍(實測有圖被選成 4 倍)。乘上召回率就會懲罰「漏掉一堆真實邊界」。
  function scoreAt(E, total, s, phi) {
    const n = E.length, gen = stamp(n), buf = scratch.buf;   // stamp 會配置 buf,順序不能反
    let on = 0, onN = 0, ex = 0, exN = 0;
    for (let x = phi; x < n - 0.5; x += s) {
      const i = Math.round(x);
      if (i < 1 || i >= n) continue;
      if (buf[i] !== gen) { buf[i] = gen; on += E[i]; onN++; ex += E[i]; exN++; }
      for (let d = -2; d <= 2; d++) {         // 邊緣被糊開,鄰近格也要排除在 off 之外
        if (d === 0) continue;
        const j = i + d;
        if (j < 0 || j >= n || buf[j] === gen) continue;
        buf[j] = gen; ex += E[j]; exN++;
      }
    }
    const offN = n - exN;
    if (onN < 4 || offN < n * 0.2 || total <= 0) return -1;
    const off = (total - ex) / offN;
    return off <= 1e-9 ? -1 : ((on / onN) / off) * (ex / total);
  }

  function bestPhase(E, total, s, steps) {
    let bv = -1, bp = 0;
    for (let k = 0; k < steps; k++) {
      const phi = s * k / steps, v = scoreAt(E, total, s, phi);
      if (v > bv) { bv = v; bp = phi; }
    }
    return { score: bv, phase: bp };
  }

  // 單軸粗掃,回傳最佳格寬。圖太小或完全沒有週期性時回傳 null,
  // 不要回傳格寬 0 —— 呼叫端會算出 Infinity 格。
  function coarseAxis(E, total, n) {
    // 範圍要隨圖片大小調整:原本固定 4~n/8,對 32px 以下的圖上限會小於起點,
    // 迴圈一次都不跑,偵測必然失敗。大圖的範圍維持原樣不受影響。
    const lo = Math.min(4, Math.max(2, n / 12));
    const hi = Math.max(4.5, n / 8);
    let bv = -1, bs = 0;
    for (let s = lo; s <= hi; s += 0.25) {
      const r = bestPhase(E, total, s, 16);
      if (r.score > bv) { bv = r.score; bs = s; }
    }
    return bs >= 2 ? { score: bv, size: bs } : null;
  }

  const sum = a => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t; };

  function detectGrid(rgba, w, h) {
    const ex = edgeEnergy(rgba, w, h, 0), ey = edgeEnergy(rgba, w, h, 1);
    const tx = sum(ex), ty = sum(ey);
    const cx = coarseAxis(ex, tx, w), cy = coarseAxis(ey, ty, h);
    if (!cx || !cy) return null;

    // 像素圖的像素幾乎一定是正方形,所以鎖同一個格寬 —— 兩軸各自的最佳值常差 1~2px,
    // 不鎖的話結果會歪斜。兩軸的候選都試一遍,取「兩軸分數總和」較高的那個,
    // 只挑單軸分數較高者不夠可靠(實測有圖的 Y 軸會選到完全錯的尺度)。
    const refine = s0 => {
      let out = { score: -1, s: s0, phx: 0, phy: 0 };
      for (let s = Math.max(2, s0 - 0.4); s <= s0 + 0.4; s += 0.02) {
        const a = bestPhase(ex, tx, s, 64), b = bestPhase(ey, ty, s, 64);
        const v = a.score + b.score;
        if (v > out.score) out = { score: v, s, phx: a.phase, phy: b.phase };
      }
      return out;
    };
    const ra = refine(cx.size), rb = refine(cy.size);
    const best = ra.score >= rb.score ? ra : rb;
    const { s, phx, phy } = best;

    return {
      sx: s, sy: s, phx, phy,
      nx: Math.max(1, Math.min(512, Math.round((w - phx) / s))),
      ny: Math.max(1, Math.min(512, Math.round((h - phy) / s))),
      scoreX: cx.score, scoreY: cy.score,
    };
  }

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

  // 邊緣能量只跟圖片有關,UI 會快取起來,調參數時不必重算。
  // dx/dy 是逐點差分圖(給逐帶吸附用),ex/ey 是整軸加總(給全圖吸附用)。
  function edgeProfiles(rgba, w, h) {
    const dx = new Float32Array(w * h), dy = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const i = (y * w + x) * 4, j = i - 4;
        dx[y * w + x] = Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
      }
    }
    for (let y = 1; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, j = i - w * 4;
        dy[y * w + x] = Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
      }
    }
    return { ex: edgeEnergy(rgba, w, h, 0), ey: edgeEnergy(rgba, w, h, 1), dx, dy, w, h };
  }

  // 網格吸附:AI 在不同區域用的局部格寬可以差很多(實測同一張圖臉部 35~39px、
  // 整體平均 26px),一組直線格線註定在某些帶切錯。所以在全圖吸附之後,
  // 每個輸出「列」再用自己那條帶的能量把垂直格線各自微調一次(行同理)。
  // 帶內太平坦(能量峰不夠強)就保留全圖位置,免得在空白區亂吸。
  function meshBounds(prof, xs, ys, s) {
    const { dx, dy, w, h } = prof;
    const nx = xs.length - 1, ny = ys.length - 1;
    const win = Math.max(2, s * 0.35);

    const refine = (diff, W2, H2, lines, bands, out, stride) => {
      let gm = 0;
      for (let i = 0; i < diff.length; i++) gm += diff[i];
      gm /= diff.length;

      const Eb = new Float64Array(W2), Es = new Float64Array(W2);
      for (let j = 0; j < bands.length - 1; j++) {
        const a = Math.max(0, Math.round(bands[j]));
        const b = Math.min(H2, Math.max(a + 1, Math.round(bands[j + 1])));
        Eb.fill(0);
        for (let y = a; y < b; y++) {
          const row = y * W2;
          for (let x = 0; x < W2; x++) Eb[x] += diff[row + x];
        }
        for (let x = 0; x < W2; x++) {
          Es[x] = 0.25 * Eb[Math.max(0, x - 1)] + 0.5 * Eb[x] + 0.25 * Eb[Math.min(W2 - 1, x + 1)];
        }
        const floor = gm * (b - a) * 0.6;     // 峰值至少要有這個強度才可信
        let prev = -Infinity;
        for (let i = 0; i < lines.length; i++) {
          const pred = lines[i];
          const lo = Math.max(0, Math.round(pred - win));
          const hi = Math.min(W2 - 1, Math.round(pred + win));
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
    refine(dx, w, h, xs, ys, xsB);
    // 行方向:把 dy 視為「以 y 為掃描軸」— 直接用轉置存取
    const dyT = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dyT[x * h + y] = dy[y * w + x];
    refine(dyT, h, w, ys, xs, ysB);
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

  /* ---------- 第二步:每格取色 ---------- */

  // 只取每格中央的一半,把邊緣的反鋸齒過渡整個丟掉 —— 這比選什麼統計量更關鍵。
  // 取逐通道中位數後再吸附到「格內實際存在的像素」,避免產生原圖沒有的顏色。
  function resample(rgba, w, h, g) {
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
    const sr = new Int32Array(cap), sg = new Int32Array(cap), sb = new Int32Array(cap), sa = new Int32Array(cap);
    const bounds = { xs, ys };

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

        const med = (src, dst) => {
          for (let t = 0; t < m; t++) dst[t] = src[t];
          const v = dst.subarray(0, m);
          v.sort();
          return v[m >> 1];
        };
        const mr = med(R, sr), mg = med(G, sg), mb = med(B, sb), ma = med(A, sa);

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

  /* ---------- 背景:AI 常把「透明棋盤格」直接畫進圖裡 ---------- */

  // 從邊框取樣,佔比夠高的顏色視為背景。計數時先量化,才不會被 ±1 的變體拆散。
  function backgroundColours(px) {
    const { w, h, rgba } = px;
    const buckets = new Map();
    const add = (x, y) => {
      const p = (y * w + x) * 4;
      if (rgba[p + 3] === 0) return;
      const k = ((rgba[p] >> 2) << 16) | ((rgba[p + 1] >> 2) << 8) | (rgba[p + 2] >> 2);
      let b = buckets.get(k);
      if (!b) buckets.set(k, b = { n: 0, r: 0, g: 0, bl: 0 });
      b.n++; b.r += rgba[p]; b.g += rgba[p + 1]; b.bl += rgba[p + 2];
    };
    for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
    for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }

    const border = 2 * w + 2 * h;
    return [...buckets.values()]
      .filter(b => b.n >= border * 0.12)
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map(b => [b.r / b.n, b.g / b.n, b.bl / b.n]);
  }

  // 只清掉「從畫面外緣連得過來」的背景色區域。
  // 全圖比對同色會把角色身上同色的部分(白袍、灰髮)一起清掉 —— 泛洪不會,
  // 因為那些像素被角色本體擋住,連不到邊界。
  function removeBackground(px, tol = 10) {
    const { w, h, rgba } = px;
    const bg = backgroundColours(px);
    if (!bg.length) return 0;

    const isBg = p => {
      for (const c of bg) {
        if (Math.abs(rgba[p] - c[0]) <= tol &&
            Math.abs(rgba[p + 1] - c[1]) <= tol &&
            Math.abs(rgba[p + 2] - c[2]) <= tol) return true;
      }
      return false;
    };

    const seen = new Uint8Array(w * h);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * w + x;
      if (seen[i]) return;
      seen[i] = 1;                                   // 標記過就不再看,非背景的像素等於擋住去路
      if (rgba[i * 4 + 3] === 0 || isBg(i * 4)) stack.push(i);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

    let removed = 0;
    while (stack.length) {
      const i = stack.pop(), p = i * 4;
      if (rgba[p + 3] !== 0) { rgba[p + 3] = 0; removed++; }
      const x = i % w, y = (i / w) | 0;
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    return removed;
  }

  /* ---------- 第三步:減色 ---------- */

  // OKLab 是感知均勻的;在原始 RGB 做距離會把該分開的顏色合併掉。
  function toOklab(r, g, b) {
    const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const R = f(r), G = f(g), B = f(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }

  function countColours(rgba) {
    const map = new Map();
    for (let p = 0; p < rgba.length; p += 4) {
      if (rgba[p + 3] === 0) continue;
      const k = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  }

  // 低彩度的顏色在 OKLab 的 a/b 上數值很小,不放大就會被亮度差整個蓋過去 ——
  // 深藍灰的腳和褐色底座亮度可以完全相同,只差在色相,不放大就會被併成同一色。
  const CHROMA_W = 2;

  function quantize(px, k) {
    const { rgba } = px;
    const map = countColours(rgba);
    if (k < 1 || map.size <= k) return map.size;

    const keys = [...map.keys()];
    const cnt = keys.map(x => map.get(x));
    const lab = keys.map(x => {
      const o = toOklab((x >> 16) & 255, (x >> 8) & 255, x & 255);
      return [o[0], o[1] * CHROMA_W, o[2] * CHROMA_W];
    });
    // 用 sqrt 而不是像素數本身:像素畫裡「面積小但關鍵」的顏色(角色的腳、眼睛高光)
    // 很常見,直接用面積加權會讓它們被大片背景吃掉。
    const wgt = cnt.map(c => Math.sqrt(c));

    // 從最常見的色起頭,之後每次挑「距離×權重」最大的,避免隨機初始化的不穩定
    const seed = [cnt.indexOf(Math.max(...cnt))];
    const dist = new Float64Array(keys.length).fill(Infinity);
    for (let n = 1; n < k; n++) {
      const c = lab[seed[n - 1]];
      let bi = 0, bv = -1;
      for (let i = 0; i < keys.length; i++) {
        const d = (lab[i][0] - c[0]) ** 2 + (lab[i][1] - c[1]) ** 2 + (lab[i][2] - c[2]) ** 2;
        if (d < dist[i]) dist[i] = d;
        const v = dist[i] * wgt[i];
        if (v > bv) { bv = v; bi = i; }
      }
      seed.push(bi);
    }

    let C = seed.map(i => lab[i].slice());
    const assign = new Int32Array(keys.length);
    for (let it = 0; it < 24; it++) {
      for (let i = 0; i < keys.length; i++) {
        let bi = 0, bd = Infinity;
        for (let j = 0; j < k; j++) {
          const d = (lab[i][0] - C[j][0]) ** 2 + (lab[i][1] - C[j][1]) ** 2 + (lab[i][2] - C[j][2]) ** 2;
          if (d < bd) { bd = d; bi = j; }
        }
        assign[i] = bi;
      }
      const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
      for (let i = 0; i < keys.length; i++) {
        const s = sum[assign[i]], u = wgt[i];
        s[0] += lab[i][0] * u; s[1] += lab[i][1] * u; s[2] += lab[i][2] * u; s[3] += u;
      }
      for (let j = 0; j < k; j++) if (sum[j][3]) C[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
    }

    // 代表色取叢集裡最常見的「原圖既有顏色」,不要用叢集中心 ——
    // 否則會冒出原圖沒有的中間色,像素畫看起來會髒。
    const bestOf = new Int32Array(k).fill(-1);
    for (let i = 0; i < keys.length; i++) {
      const j = assign[i];
      if (bestOf[j] < 0 || cnt[i] > cnt[bestOf[j]]) bestOf[j] = i;
    }
    const lut = new Map();
    for (let i = 0; i < keys.length; i++) lut.set(keys[i], keys[bestOf[assign[i]]]);

    for (let p = 0; p < rgba.length; p += 4) {
      if (rgba[p + 3] === 0) continue;
      const v = lut.get((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]);
      rgba[p] = (v >> 16) & 255; rgba[p + 1] = (v >> 8) & 255; rgba[p + 2] = v & 255;
    }
    return new Set(lut.values()).size;
  }

  /* ---------- 整條管線 ---------- */

  function run(rgba, w, h, opts) {
    const g = opts.grid;
    const px = resample(rgba, w, h, g);
    const err = reconstructError(rgba, w, h, g, px);
    const cleared = opts.removeBg ? removeBackground(px) : 0;
    const colours = opts.colours > 0 ? quantize(px, opts.colours) : countColours(px.rgba).size;
    return { px, err, cleared, colours };
  }

  /* ---------- 非同步偵測（進度 + 取消） ----------
     邏輯與 detectGrid 相同，但分段讓出主執行緒，UI 才能畫進度條、回應取消。
     hooks: { onProgress(0..1), cancelled() -> bool }。取消時回傳 null。 */
  async function detectGridAsync(rgba, w, h, hooks = {}) {
    const onProgress = hooks.onProgress || (() => {});
    const cancelled = hooks.cancelled || (() => false);
    const tick = () => new Promise(r => setTimeout(r, 0));

    const ex = edgeEnergy(rgba, w, h, 0), ey = edgeEnergy(rgba, w, h, 1);
    const tx = sum(ex), ty = sum(ey);

    async function coarseAxisAsync(E, total, n, base, span) {
      const lo = Math.min(4, Math.max(2, n / 12));
      const hi = Math.max(4.5, n / 8);
      const steps = Math.max(1, Math.round((hi - lo) / 0.25));
      let bv = -1, bs = 0, k = 0, last = performance.now();
      for (let s = lo; s <= hi; s += 0.25, k++) {
        if (cancelled()) return null;
        const r = bestPhase(E, total, s, 16);
        if (r.score > bv) { bv = r.score; bs = s; }
        if ((k & 7) === 0) {
          onProgress(base + span * Math.min(1, k / steps));
          const now = performance.now();
          if (now - last > 24) { await tick(); last = now; }
        }
      }
      return bs >= 2 ? { score: bv, size: bs } : null;
    }

    async function refineAsync(s0, base, span) {
      let out = { score: -1, s: s0, phx: 0, phy: 0 };
      const steps = Math.max(1, Math.round(0.8 / 0.02));
      let k = 0;
      for (let s = Math.max(2, s0 - 0.4); s <= s0 + 0.4; s += 0.02, k++) {
        if (cancelled()) return null;
        const a = bestPhase(ex, tx, s, 64), b = bestPhase(ey, ty, s, 64);
        const v = a.score + b.score;
        if (v > out.score) out = { score: v, s, phx: a.phase, phy: b.phase };
        if ((k & 3) === 0) { onProgress(base + span * Math.min(1, k / steps)); await tick(); }
      }
      return out;
    }

    const cx = await coarseAxisAsync(ex, tx, w, 0, 0.4);
    if (cancelled()) return null;
    if (!cx) { onProgress(1); return null; }
    const cy = await coarseAxisAsync(ey, ty, h, 0.4, 0.4);
    if (cancelled()) return null;
    if (!cy) { onProgress(1); return null; }

    const ra = await refineAsync(cx.size, 0.8, 0.1);
    if (!ra) return null;
    const rb = await refineAsync(cy.size, 0.9, 0.1);
    if (!rb) return null;
    const best = ra.score >= rb.score ? ra : rb;
    const { s, phx, phy } = best;
    onProgress(1);

    return {
      sx: s, sy: s, phx, phy,
      nx: Math.max(1, Math.min(512, Math.round((w - phx) / s))),
      ny: Math.max(1, Math.min(512, Math.round((h - phy) / s))),
      scoreX: cx.score, scoreY: cy.score,
    };
  }

  return { detectGrid, detectGridAsync, resample, reconstructError, removeBackground, backgroundColours,
           quantize, countColours, toOklab, run,
           edgeProfiles, buildBounds, uniformBounds, snapBounds, meshBounds };
})();
