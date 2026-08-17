/* pixelate — 把「看起來像像素圖但沒對齊」的圖(通常是 AI 生成後放大的)還原成真正的像素圖。
   純運算,不碰畫面也不碰狀態。三步:偵測格線 -> 每格取色 -> 減色。
   可在 Worker 裡跑（沒有 window / DOM）；主執行緒另見檔尾 callAsync。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};

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

  const sum = a => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t; };
  const axisLo = n => Math.min(4, Math.max(2, n / 12));
  const axisHi = n => Math.max(4.5, n / 8);
  function packDetected(best, cx, cy, w, h) {
    const { s, phx, phy } = best;
    return {
      sx: s, sy: s, phx, phy,
      nx: Math.max(1, Math.min(512, Math.round((w - phx) / s))),
      ny: Math.max(1, Math.min(512, Math.round((h - phy) / s))),
      scoreX: cx.score, scoreY: cy.score,
    };
  }
  function scorePair(ex, ey, tx, ty, s) {
    const a = bestPhase(ex, tx, s, 64), b = bestPhase(ey, ty, s, 64);
    return { score: a.score + b.score, s, phx: a.phase, phy: b.phase };
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
  // dx/dy 是逐點差分圖(給逐帶吸附用),ex/ey 是整軸加總後再平滑(給全圖吸附用)。
  // 平滑公式與 edgeEnergy 相同,避免把同一組差分再掃四次。
  function smooth1d(e) {
    const n = e.length, s = new Float64Array(n);
    for (let i = 0; i < n; i++)
      s[i] = 0.25 * e[Math.max(0, i - 1)] + 0.5 * e[i] + 0.25 * e[Math.min(n - 1, i + 1)];
    return s;
  }
  function edgeProfiles(rgba, w, h) {
    const dx = new Float32Array(w * h), dy = new Float32Array(w * h);
    const rawX = new Float64Array(w), rawY = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const i = (y * w + x) * 4, j = i - 4;
        const v = Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
        dx[y * w + x] = v;
        rawX[x] += v;
      }
    }
    for (let y = 1; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, j = i - w * 4;
        const v = Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
        dy[y * w + x] = v;
        rawY[y] += v;
      }
    }
    return { ex: smooth1d(rawX), ey: smooth1d(rawY), dx, dy, w, h };
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

    const U = map.size;
    const keys = new Int32Array(U), cnt = new Float64Array(U);
    { let i = 0; for (const [key, c] of map) { keys[i] = key; cnt[i] = c; i++; } }
    // 顏色一律攤平成 Float64Array(3U)：一張圖可以有十幾萬個相異色，
    // array-of-arrays 在下面 U×k×24 的內迴圈裡會慢一個數量級
    const lab = new Float64Array(U * 3);
    for (let i = 0; i < U; i++) {
      const x = keys[i];
      const o = toOklab((x >> 16) & 255, (x >> 8) & 255, x & 255);
      lab[i * 3] = o[0]; lab[i * 3 + 1] = o[1] * CHROMA_W; lab[i * 3 + 2] = o[2] * CHROMA_W;
    }
    // 用 sqrt 而不是像素數本身:像素畫裡「面積小但關鍵」的顏色(角色的腳、眼睛高光)
    // 很常見,直接用面積加權會讓它們被大片背景吃掉。
    const wgt = new Float64Array(U);
    for (let i = 0; i < U; i++) wgt[i] = Math.sqrt(cnt[i]);

    // 從最常見的色起頭,之後每次挑「距離×權重」最大的,避免隨機初始化的不穩定。
    // （不能用 Math.max(...cnt)：相異色數破十萬時展開參數列會直接 RangeError）
    let si = 0;
    for (let i = 1; i < U; i++) if (cnt[i] > cnt[si]) si = i;
    const seed = [si];
    const dist = new Float64Array(U).fill(Infinity);
    for (let n = 1; n < k; n++) {
      const c = seed[n - 1] * 3, c0 = lab[c], c1 = lab[c + 1], c2 = lab[c + 2];
      let bi = 0, bv = -1;
      for (let i = 0; i < U; i++) {
        const p = i * 3;
        const d = (lab[p] - c0) ** 2 + (lab[p + 1] - c1) ** 2 + (lab[p + 2] - c2) ** 2;
        if (d < dist[i]) dist[i] = d;
        const v = dist[i] * wgt[i];
        if (v > bv) { bv = v; bi = i; }
      }
      seed.push(bi);
    }

    const C = new Float64Array(k * 3);
    for (let j = 0; j < k; j++) { const p = seed[j] * 3; C[j * 3] = lab[p]; C[j * 3 + 1] = lab[p + 1]; C[j * 3 + 2] = lab[p + 2]; }
    const assign = new Int32Array(U);
    const sum = new Float64Array(k * 4);
    for (let it = 0; it < 24; it++) {
      let moved = false;
      for (let i = 0; i < U; i++) {
        const p = i * 3, l0 = lab[p], l1 = lab[p + 1], l2 = lab[p + 2];
        let bi = 0, bd = Infinity;
        for (let j = 0; j < k; j++) {
          const q = j * 3;
          const d = (l0 - C[q]) ** 2 + (l1 - C[q + 1]) ** 2 + (l2 - C[q + 2]) ** 2;
          if (d < bd) { bd = d; bi = j; }
        }
        if (assign[i] !== bi) { assign[i] = bi; moved = true; }
      }
      // 分派沒變 = 已收斂，之後每輪都是原地踏步
      if (!moved && it > 0) break;
      sum.fill(0);
      for (let i = 0; i < U; i++) {
        const p = i * 3, s = assign[i] * 4, u = wgt[i];
        sum[s] += lab[p] * u; sum[s + 1] += lab[p + 1] * u; sum[s + 2] += lab[p + 2] * u; sum[s + 3] += u;
      }
      for (let j = 0; j < k; j++) {
        const s = j * 4, t = sum[s + 3];
        if (t) { C[j * 3] = sum[s] / t; C[j * 3 + 1] = sum[s + 1] / t; C[j * 3 + 2] = sum[s + 2] / t; }
      }
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
    // 重建誤差是診斷數字；調顏色上限 / 去背時格線沒變，呼叫端可傳 error:false 跳過
    const err = opts.error === false ? null : reconstructError(rgba, w, h, g, px);
    const cleared = opts.removeBg ? removeBackground(px) : 0;
    const colours = opts.colours > 0 ? quantize(px, opts.colours) : countColours(px.rgba).size;
    return { px, err, cleared, colours };
  }

  /* ---------- 非同步偵測（進度 + 取消） ----------
     分段讓出主執行緒，UI 才能畫進度條、回應取消。
     hooks: { onProgress(0..1), cancelled() -> bool }。取消時回傳 null。 */
  async function detectGridAsync(rgba, w, h, hooks = {}) {
    const onProgress = hooks.onProgress || (() => {});
    const cancelled = hooks.cancelled || (() => false);
    const tick = () => new Promise(r => setTimeout(r, 0));

    // 第一次 yield 在任何全圖掃描之前，UI 才能畫出進度條、回應取消
    onProgress(0);
    await tick();
    if (cancelled()) return null;
    const ex = edgeEnergy(rgba, w, h, 0);
    onProgress(0.04);
    await tick();
    if (cancelled()) return null;
    const ey = edgeEnergy(rgba, w, h, 1);
    onProgress(0.08);
    await tick();
    if (cancelled()) return null;
    const tx = sum(ex), ty = sum(ey);

    async function coarseAxisAsync(E, total, n, base, span) {
      const lo = axisLo(n), hi = axisHi(n);
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
        const r = scorePair(ex, ey, tx, ty, s);
        if (r.score > out.score) out = r;
        if ((k & 3) === 0) { onProgress(base + span * Math.min(1, k / steps)); await tick(); }
      }
      return out;
    }

    const cx = await coarseAxisAsync(ex, tx, w, 0.08, 0.36);
    if (cancelled()) return null;
    if (!cx) { onProgress(1); return null; }
    const cy = await coarseAxisAsync(ey, ty, h, 0.44, 0.36);
    if (cancelled()) return null;
    if (!cy) { onProgress(1); return null; }

    const ra = await refineAsync(cx.size, 0.8, 0.1);
    if (!ra) return null;
    const rb = await refineAsync(cy.size, 0.9, 0.1);
    if (!rb) return null;
    onProgress(1);
    return packDetected(ra.score >= rb.score ? ra : rb, cx, cy, w, h);
  }

  return { detectGridAsync, resample, reconstructError, removeBackground, backgroundColours,
           quantize, countColours, toOklab, run,
           edgeProfiles, buildBounds, uniformBounds, snapBounds, meshBounds };
})();

/* ---------- 主執行緒：把 detect / run 丟進 Worker；file:// 或 Worker 失敗就回退本執行緒 ---------- */
(function attachWorkerClient() {
  if (typeof document === 'undefined') return;
  const SCRIPT_URL = document.currentScript && document.currentScript.src
    ? document.currentScript.src : '';

  let wk = null, seq = 0, dying = false, workerFailed = false;
  const pending = new Map();

  function onMsg(e) {
    const d = e.data;
    if (!d || d.id == null) return;
    const p = pending.get(d.id);
    if (!p) return;
    if (d.type === 'progress') { if (p.onProgress) p.onProgress(d.f); return; }
    pending.delete(d.id);
    if (d.type === 'error') p.reject(Object.assign(new Error(d.message || 'pixelate worker'), { cancelled: !!d.cancelled }));
    else p.resolve(d.result);
  }

  function spawn() {
    if (workerFailed) return false;
    if (wk) return true;
    if (!SCRIPT_URL || typeof Worker === 'undefined') { workerFailed = true; return false; }
    try {
      wk = new Worker(new URL('pixelate-worker.js', SCRIPT_URL));
      wk.onmessage = onMsg;
      wk.onerror = () => {
        if (dying) return;
        for (const p of pending.values()) p.reject(new Error('pixelate worker error'));
        pending.clear();
        try { wk.terminate(); } catch {}
        wk = null;
        workerFailed = true;
      };
      return true;
    } catch {
      workerFailed = true;
      wk = null;
      return false;
    }
  }

  function post(op, payload, hooks) {
    if (!spawn()) return null;
    const id = ++seq;
    const src = payload.rgba;
    const copy = src ? (src instanceof Uint8ClampedArray ? src.slice() : Uint8ClampedArray.from(src)) : null;
    const msg = { id, op, w: payload.w, h: payload.h, opts: payload.opts, grid: payload.grid, rgba: copy };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress: hooks && hooks.onProgress });
      try {
        if (copy) wk.postMessage(msg, [copy.buffer]);
        else wk.postMessage(msg);
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  function fallback(op, payload, hooks) {
    if (op === 'detect') return PA.pixelate.detectGridAsync(payload.rgba, payload.w, payload.h, hooks);
    if (op === 'run') return PA.pixelate.run(payload.rgba, payload.w, payload.h, payload.opts);
    if (op === 'score') {
      const small = PA.pixelate.resample(payload.rgba, payload.w, payload.h, payload.grid);
      return PA.pixelate.reconstructError(payload.rgba, payload.w, payload.h, payload.grid, small);
    }
    throw new Error('未知的 pixelate 操作：' + op);
  }

  PA.pixelate.callAsync = async function(op, payload, hooks) {
    hooks = hooks || {};
    const job = post(op, payload, hooks);
    if (job) {
      try { return await job; }
      catch (e) {
        if (e.cancelled) return null;
      }
    }
    return fallback(op, payload, hooks);
  };

  PA.pixelate.cancelJobs = function() {
    dying = true;
    for (const p of pending.values())
      p.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    pending.clear();
    if (wk) { try { wk.terminate(); } catch {} wk = null; }
    dying = false;
  };
})();
