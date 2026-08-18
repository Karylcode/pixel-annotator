/* pixelate/clean/bg.js — 移除背景。
   移植自 sprite-lab（boona13，MIT）https://github.com/boona13/sprite-lab
   對應上游檔案：src/core/analyzeBackground.ts、src/edgeCleanup.ts、
                 src/core/chromaKey.ts、src/core/floodFill.ts

   取代本工具原版的 removeBackground（邊框取樣 + 單一泛洪）。原版只認「邊框上佔比最高的顏色」，
   綠幕／洋紅幕、棋盤格的鑲邊、以及去背後殘留的白邊都處理不了。

   sprite-lab 的做法是先分類背景種類再分頭處理（analyzeBackgroundFromRgba → removeAuto）：
     transparent  → 已經去過背，只做 defringe
     magenta/green→ chroma key：依色偏算 alpha，並 despill 去溢色
     checkerboard → 抓出棋盤的兩個灰、從邊界泛洪、再逐圈剝掉棋盤色鑲邊（會避開比棋盤暗的投影）
     solid        → 四角平均色泛洪（角落色差 < 24 才算單色背景）
   泛洪一律只從畫面邊界進來，被角色輪廓擋住的同色區域（白裙、白袖口）不會被清掉。

   ── 與上游的差異，三處，都是刻意的 ──
   1. 新增 borderHasTwoToneNeutral()：上游的棋盤判定寫死「白 + 淺灰」，認不出 ChatGPT 匯出的
      中灰棋盤。詳見該函式上方註解。這是本工具加的，不是 sprite-lab 的行為。
   2. 不移植 refineEdgeMatteInPlace()：那是給反鋸齒邊緣算「部分 alpha」的 matting solver。
      本工具的輸出是每格一色的索引點陣圖，alpha 只有 0 / 255，引進半透明反而破壞資料模型。
   3. 不移植 removeNeutralIslandsInPlace()：上游用 max(256, 0.15%) 當「碎屑島」面積上限，
      那是給 512px 以上的整圖用的；在 80×80 的像素圖上 256 格 = 全圖 4%，會把白色高光整塊吃掉。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const ALPHA_CUT = 16;

  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const saturation = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
  const colorDist = (r, g, b, tr, tg, tb) => Math.abs(r - tr) + Math.abs(g - tg) + Math.abs(b - tb);
  const magentaCast = (r, g, b) => Math.max(0, Math.min(r, b) - g);
  const greenCast = (r, g, b) => Math.max(0, g - Math.max(r, b));

  function minCheckerDist(r, g, b, colors) {
    let min = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const d = colorDist(r, g, b, colors[i][0], colors[i][1], colors[i][2]);
      if (d < min) min = d;
    }
    return min;
  }
  function matchesChecker(r, g, b, colors, tolerance, maxSat) {
    if (maxSat == null) maxSat = 42;
    if (saturation(r, g, b) > maxSat) return false;
    return minCheckerDist(r, g, b, colors) <= tolerance;
  }
  function minCkLumOf(ck) {
    let m = Infinity;
    for (let k = 0; k < ck.length; k++) m = Math.min(m, lum(ck[k][0], ck[k][1], ck[k][2]));
    return m;
  }

  // 走一圈邊框（上下兩列 + 左右兩行），callback 收到座標
  function eachBorder(w, h, fn) {
    for (let x = 0; x < w; x++) { fn(x, 0); fn(x, h - 1); }
    for (let y = 0; y < h; y++) { fn(0, y); fn(w - 1, y); }
  }

  /* ---------- 背景分類（analyzeBackground.ts） ---------- */

  function borderHasCheckerPattern(d, w, h) {
    let whiteish = 0, greyish = 0, samples = 0;
    eachBorder(w, h, (x, y) => {
      const i = (y * w + x) * 4;
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mx - mn > 42) return;
      samples++;
      if (mx > 225) whiteish++;
      else if (mx > 130 && mx < 215) greyish++;
    });
    if (!samples) return false;
    return whiteish / samples > 0.1 && greyish / samples > 0.1;
  }

  /* ★ 本工具的擴充，不是 sprite-lab 原本的行為 ★
     上游的 borderHasCheckerPattern 把棋盤寫死成「白（max>225）+ 淺灰（130..215）」，
     那是 Photoshop / Aseprite 預設棋盤的顏色。ChatGPT 匯出的假透明棋盤是 128 / 190
     兩個中灰，兩色都不到 225 → whiteish 恆為 0 → 被判成 solid，泛洪只認得四角那一色，
     結果棋盤只被清掉一半（實測 GPT.png：四角全是 128，190 那半格原封不動留著）。

     這裡沿用上游自己的 detectCheckerColors 抓邊框最主要的兩個低彩度色，只有在
       (a) 兩色確實分得開（sum-abs ≥ 60，上游自己的去重門檻是 40），且
       (b) 兩色各自都佔「低彩度邊框樣本」一成以上（比照上游的 > 0.1），且
       (c) 邊框有一半以上是低彩度（避免彩色照片邊上幾顆灰點就誤判）
     三個條件同時成立時才補判為棋盤。detectCheckerColors 找不到色時會回退成合成色
     （[255,255,255]/[196,196,196] 或 c-64），那些合成色在 (b) 的覆蓋率必然趨近 0，
     所以回退情形會被自動擋掉。 */
  function borderHasTwoToneNeutral(d, w, h) {
    const ck = detectCheckerColors(d, w, h);
    if (ck.length < 2) return false;
    if (colorDist(ck[0][0], ck[0][1], ck[0][2], ck[1][0], ck[1][1], ck[1][2]) < 60) return false;
    let n0 = 0, n1 = 0, samples = 0, border = 0;
    eachBorder(w, h, (x, y) => {
      border++;
      const i = (y * w + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      if (saturation(r, g, b) > 42) return;
      samples++;
      const d0 = colorDist(r, g, b, ck[0][0], ck[0][1], ck[0][2]);
      const d1 = colorDist(r, g, b, ck[1][0], ck[1][1], ck[1][2]);
      if (Math.min(d0, d1) > 52) return;
      if (d0 <= d1) n0++; else n1++;
    });
    if (!border || !samples) return false;
    if (samples / border < 0.5) return false;
    return n0 / samples > 0.1 && n1 / samples > 0.1;
  }

  function borderIsSolidLight(d, w, h) {
    const cols = [];
    eachBorder(w, h, (x, y) => { const i = (y * w + x) * 4; cols.push([d[i], d[i + 1], d[i + 2]]); });
    if (!cols.length) return false;
    const avg = [0, 1, 2].map(c => Math.round(cols.reduce((s, q) => s + q[c], 0) / cols.length));
    if (Math.max(avg[0], avg[1], avg[2]) < 180) return false;
    let match = 0;
    for (let i = 0; i < cols.length; i++)
      if (colorDist(cols[i][0], cols[i][1], cols[i][2], avg[0], avg[1], avg[2]) < 50) match++;
    return match / cols.length > 0.65;
  }

  // 回傳 'transparent' | 'magenta' | 'green' | 'checkerboard' | 'solid' | 'none'
  function analyzeBackground(px) {
    const w = px.w, h = px.h, d = px.rgba;
    const n = w * h;
    if (!n) return 'none';
    let transparent = 0, magenta = 0, green = 0;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      if (d[i + 3] < 200) { transparent++; continue; }
      if (magentaCast(d[i], d[i + 1], d[i + 2]) > 60) magenta++;
      if (greenCast(d[i], d[i + 1], d[i + 2]) > 60) green++;
    }
    if (transparent / n > 0.02) return 'transparent';
    const mFrac = magenta / n, gFrac = green / n;
    if (mFrac > 0.06 && mFrac >= gFrac) return 'magenta';
    if (gFrac > 0.06) return 'green';
    if (borderHasCheckerPattern(d, w, h)) return 'checkerboard';
    if (borderHasTwoToneNeutral(d, w, h)) return 'checkerboard';   // ★ 本工具擴充
    if (borderIsSolidLight(d, w, h)) return 'solid';
    const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]
      .map(c => { const i = (c[1] * w + c[0]) * 4; return [d[i], d[i + 1], d[i + 2]]; });
    let spread = 0;
    for (let c = 0; c < corners.length; c++)
      for (let k = 0; k < 3; k++) spread = Math.max(spread, Math.abs(corners[c][k] - corners[0][k]));
    if (spread < 24) return 'solid';
    return 'none';
  }

  /* ---------- 棋盤格（edgeCleanup.ts） ---------- */

  // 從邊框抓出棋盤的兩個灰階（低彩度、夠亮的兩個主色；桶寬 16）
  function detectCheckerColors(d, w, h) {
    const buckets = new Map();
    eachBorder(w, h, (x, y) => {
      const i = (y * w + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn > 40 || mx < 120) return;
      const key = (Math.round(r / 16) << 16) | (Math.round(g / 16) << 8) | Math.round(b / 16);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    });
    const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
    const colors = [];
    for (const entry of sorted) {
      if (colors.length >= 2) break;
      const key = entry[0];
      const r = ((key >> 16) & 0xff) * 16 + 8, g = ((key >> 8) & 0xff) * 16 + 8, b = (key & 0xff) * 16 + 8;
      if (!colors.some(c => colorDist(c[0], c[1], c[2], r, g, b) < 40)) colors.push([r, g, b]);
    }
    if (!colors.length) { colors.push([255, 255, 255], [196, 196, 196]); }
    else if (colors.length === 1) {
      const c = Math.max(0, colors[0][0] - 64);
      colors.push([c, c, c]);
    }
    return colors;
  }

  function hasTransparentNeighbor(d, w, h, idx) {
    const x = idx % w, y = (idx / w) | 0;
    if (x > 0 && d[(idx - 1) * 4 + 3] < ALPHA_CUT) return true;
    if (x < w - 1 && d[(idx + 1) * 4 + 3] < ALPHA_CUT) return true;
    if (y > 0 && d[(idx - w) * 4 + 3] < ALPHA_CUT) return true;
    if (y < h - 1 && d[(idx + w) * 4 + 3] < ALPHA_CUT) return true;
    return false;
  }

  // 0 = 完全像棋盤，1 = 完全像前景。
  // 投影是低彩度的灰，但比棋盤暗，所以離「周圍前景平均色」比離棋盤色近。
  function foregroundAffinity(d, w, h, idx, ck) {
    const i = idx * 4, r = d[i], g = d[i + 1], b = d[i + 2];
    const x = idx % w, y = (idx / w) | 0;
    const minCkLum = minCkLumOf(ck);
    let fgR = 0, fgG = 0, fgB = 0, fgN = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = (ny * w + nx) * 4;
        if (d[ni + 3] < ALPHA_CUT) continue;
        const nr = d[ni], ng = d[ni + 1], nb = d[ni + 2];
        const darkerThanChecker = lum(nr, ng, nb) < minCkLum - 12;
        if (saturation(nr, ng, nb) > 36 || minCheckerDist(nr, ng, nb, ck) > 58 || darkerThanChecker) {
          fgR += nr; fgG += ng; fgB += nb; fgN++;
        }
      }
    }
    if (!fgN) return 0;
    const fgDist = colorDist(r, g, b, fgR / fgN, fgG / fgN, fgB / fgN);
    const ckDist = minCheckerDist(r, g, b, ck);
    return fgDist / (fgDist + ckDist + 1);
  }

  function isCheckerFringePixel(d, w, h, idx, ck) {
    const i = idx * 4, r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
    const sat = saturation(r, g, b), l = lum(r, g, b), minCkLum = minCkLumOf(ck);

    // 比棋盤暗 = 投影，留著
    if (l < minCkLum - 18 && sat < 40) return false;

    const affinity = foregroundAffinity(d, w, h, idx, ck);
    if (affinity > 0.52) return false;

    if (matchesChecker(r, g, b, ck, 48, 40)) return true;

    // 半透明的反鋸齒（棋盤透出來），不是不透明的投影
    if (a < 220 && l > minCkLum - 10 && sat < 38 && matchesChecker(r, g, b, ck, 68, 48)) return true;

    // 輪廓上的淺灰光暈：仍須比起前景更靠近棋盤色
    if (l > minCkLum - 8 && sat < 26 && affinity < 0.38) return minCheckerDist(r, g, b, ck) <= 72;

    return false;
  }

  function shouldExpandCheckerPixel(d, w, h, idx, ck, tol) {
    const i = idx * 4;
    if (d[i + 3] < ALPHA_CUT) return false;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (!matchesChecker(r, g, b, ck, tol, 48)) return false;
    if (lum(r, g, b) < minCkLumOf(ck) - 16 && saturation(r, g, b) < 40) return false;
    return foregroundAffinity(d, w, h, idx, ck) < 0.48;
  }

  function peelCheckerFringe(d, w, h, ck, maxPasses) {
    const n = w * h;
    let removed = 0;
    for (let pass = 0; pass < maxPasses; pass++) {
      const remove = [];
      for (let idx = 0; idx < n; idx++) {
        if (d[idx * 4 + 3] < ALPHA_CUT) continue;
        if (!hasTransparentNeighbor(d, w, h, idx)) continue;
        if (isCheckerFringePixel(d, w, h, idx, ck)) remove.push(idx);
      }
      if (!remove.length) break;
      for (let k = 0; k < remove.length; k++) d[remove[k] * 4 + 3] = 0;
      removed += remove.length;
    }
    return removed;
  }

  /* ---------- 泛洪：只從畫面邊界進來，被前景擋住的同色區域不會被清掉 ---------- */

  function floodFromBorder(d, w, h, isBg) {
    const n = w * h;
    const visited = new Uint8Array(n);
    let stack = new Int32Array(1024), sp = 0;
    const push = idx => {
      if (idx < 0 || idx >= n || visited[idx]) return;
      visited[idx] = 1;
      if (!isBg(idx)) return;
      if (sp === stack.length) { const t = new Int32Array(sp * 2); t.set(stack); stack = t; }
      stack[sp++] = idx;
    };
    eachBorder(w, h, (x, y) => push(y * w + x));
    let removed = 0;
    while (sp) {
      const idx = stack[--sp];
      if (d[idx * 4 + 3] !== 0) { d[idx * 4 + 3] = 0; removed++; }
      const x = idx % w, y = (idx / w) | 0;
      if (x > 0) push(idx - 1);
      if (x < w - 1) push(idx + 1);
      if (y > 0) push(idx - w);
      if (y < h - 1) push(idx + w);
    }
    return removed;
  }

  /* ---------- chroma key（洋紅 / 綠幕，含 despill 去溢色）chromaKey.ts ---------- */

  function chromaKey(d, kind, castThreshold, castSoftness, despill) {
    const isMagenta = kind === 'magenta';
    const greenBoost = 0.5;      // 上游 despillGreenBoost 預設值
    let removed = 0;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      const cast = isMagenta ? magentaCast(r, g, b) : greenCast(r, g, b);
      let alpha;
      if (cast >= castThreshold) alpha = 0;
      else if (cast <= 0) alpha = 255;
      else {
        const softFloor = Math.max(0, castThreshold - castSoftness);
        alpha = cast <= softFloor ? 255
          : Math.round(255 * (1 - (cast - softFloor) / (castThreshold - softFloor)));
      }
      if (alpha === 0 && d[i + 3] !== 0) removed++;
      d[i + 3] = alpha;
      if (cast > 0 && despill > 0) {
        const reduction = cast * despill;
        if (isMagenta) {
          r = Math.max(0, Math.round(r - reduction));
          b = Math.max(0, Math.round(b - reduction));
          if (greenBoost > 0) g = Math.min(255, Math.round(g + reduction * greenBoost));
        } else {
          g = Math.max(0, Math.round(g - reduction));
          r = Math.min(255, Math.round(r + reduction * 0.35));
          b = Math.min(255, Math.round(b + reduction * 0.35));
        }
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
    }
    return removed;
  }

  /* ---------- defringe：透明像素的 RGB 用鄰近不透明像素補起來 ---------- */
  /* 縮放／放大時取樣器會把透明格的 RGB 一起內插，不補的話邊緣會滲出背景色 */

  function defringe(d, w, h, radius) {
    const n = w * h;
    const rgb = new Float32Array(n * 3);
    for (let pass = 0; pass < radius; pass++) {
      for (let idx = 0; idx < n; idx++) {
        const i = idx * 4;
        if (d[i + 3] < ALPHA_CUT) continue;
        rgb[idx * 3] = d[i]; rgb[idx * 3 + 1] = d[i + 1]; rgb[idx * 3 + 2] = d[i + 2];
      }
      for (let idx = 0; idx < n; idx++) {
        if (d[idx * 4 + 3] >= ALPHA_CUT) continue;
        const x = idx % w, y = (idx / w) | 0;
        let r = 0, g = 0, b = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const ni = ny * w + nx;
            if (d[ni * 4 + 3] < ALPHA_CUT) continue;
            r += rgb[ni * 3]; g += rgb[ni * 3 + 1]; b += rgb[ni * 3 + 2]; cnt++;
          }
        }
        if (cnt) { rgb[idx * 3] = r / cnt; rgb[idx * 3 + 1] = g / cnt; rgb[idx * 3 + 2] = b / cnt; }
      }
    }
    for (let idx = 0; idx < n; idx++) {
      const i = idx * 4;
      if (d[i + 3] >= ALPHA_CUT) continue;
      if (rgb[idx * 3] + rgb[idx * 3 + 1] + rgb[idx * 3 + 2] > 0) {
        d[i] = Math.round(rgb[idx * 3]);
        d[i + 1] = Math.round(rgb[idx * 3 + 1]);
        d[i + 2] = Math.round(rgb[idx * 3 + 2]);
      }
    }
  }

  /* ---------- 各種背景的處理 ---------- */

  // edgeCleanup.ts removeCheckerboardInPlace
  function removeCheckerboard(d, w, h, tol, peelPasses) {
    const n = w * h;
    const ck = detectCheckerColors(d, w, h);
    let removed = 0;

    let transparent = 0;
    for (let i = 0; i < n; i++) if (d[i * 4 + 3] < ALPHA_CUT) transparent++;
    const alreadyKeyed = transparent / n > 0.02;

    if (!alreadyKeyed) {
      removed += floodFromBorder(d, w, h, idx => {
        const i = idx * 4;
        if (d[i + 3] < ALPHA_CUT) return true;
        return matchesChecker(d[i], d[i + 1], d[i + 2], ck, tol);
      });
      // 逐圈往內吃掉貼著透明區的棋盤色鑲邊（比棋盤暗的投影會被擋下）
      for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        for (let idx = 0; idx < n; idx++) {
          if (d[idx * 4 + 3] >= ALPHA_CUT) continue;
          if (!hasTransparentNeighbor(d, w, h, idx)) continue;
          const x = idx % w, y = (idx / w) | 0;
          const nbs = [x > 0 ? idx - 1 : -1, x < w - 1 ? idx + 1 : -1,
                       y > 0 ? idx - w : -1, y < h - 1 ? idx + w : -1];
          for (let k = 0; k < 4; k++) {
            const nb = nbs[k];
            if (nb < 0) continue;
            if (shouldExpandCheckerPixel(d, w, h, nb, ck, tol + 8)) {
              d[nb * 4 + 3] = 0; removed++; changed = true;
            }
          }
        }
        if (!changed) break;
      }
    }
    removed += peelCheckerFringe(d, w, h, ck, peelPasses);
    return removed;
  }

  // floodFill.ts floodFillRemoveBackground：四角平均色，角落色差 < 24 才算單色背景
  function removeSolid(d, w, h, tol) {
    const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]
      .map(c => { const i = (c[1] * w + c[0]) * 4; return [d[i], d[i + 1], d[i + 2]]; });
    const avg = [0, 1, 2].map(k => Math.round(corners.reduce((s, c) => s + c[k], 0) / corners.length));
    let spread = 0;
    for (let c = 0; c < corners.length; c++)
      for (let k = 0; k < 3; k++) spread = Math.max(spread, Math.abs(corners[c][k] - avg[k]));
    if (spread >= 24) return 0;                       // 四角不一致 → 不是單色背景，不動
    return floodFromBorder(d, w, h, idx => {
      const i = idx * 4;
      if (d[i + 3] < ALPHA_CUT) return true;
      return colorDist(d[i], d[i + 1], d[i + 2], avg[0], avg[1], avg[2]) < tol;
    });
  }

  /* ---------- 對外 ---------- */

  // px = {w, h, rgba}（就地修改）。opts.kind 可強制指定背景種類，'auto' 為自動判斷。
  // 回傳清掉的格數。
  function removeBackground(px, opts) {
    opts = opts || {};
    const w = px.w, h = px.h, d = px.rgba;
    if (!w || !h) return 0;
    const kind = (opts.kind && opts.kind !== 'auto') ? opts.kind : analyzeBackground(px);
    if (kind === 'none') return 0;
    if (kind === 'transparent') { if (opts.defringe !== false) defringe(d, w, h, 2); return 0; }

    let removed = 0;
    if (kind === 'magenta' || kind === 'green') {
      removed = chromaKey(d, kind,
        opts.castThreshold != null ? opts.castThreshold : 80,
        opts.castSoftness != null ? opts.castSoftness : 30,
        opts.despill != null ? opts.despill : 1);
    } else if (kind === 'checkerboard') {
      removed = removeCheckerboard(d, w, h,
        opts.tol != null ? opts.tol : 52,
        opts.peel != null ? opts.peel : 2);
    } else {
      removed = removeSolid(d, w, h, opts.tol != null ? opts.tol : 78);
    }
    if (opts.defringe !== false) defringe(d, w, h, 2);
    return removed;
  }

  PA.pixelate.analyzeBackground = analyzeBackground;
  PA.pixelate.detectCheckerColors = detectCheckerColors;
  PA.pixelate.defringe = defringe;
  PA.pixelate.removeBackground = removeBackground;

  PA.pixelate.register('clean', {
    id: 'bg',
    label: '移除背景（sprite-lab）',
    credit: {
      project: 'sprite-lab',
      file: 'src/core/analyzeBackground.ts, src/edgeCleanup.ts, src/core/chromaKey.ts, src/core/floodFill.ts',
      license: 'MIT',
      url: 'https://github.com/boona13/sprite-lab',
    },
    cost: 'fast',
    params: [
      { key: 'kind', label: '背景種類', type: 'select',
        options: ['auto', 'checkerboard', 'solid', 'magenta', 'green'], default: 'auto' },
      { key: 'tol', label: '容差', type: 'number', min: 0, max: 128, step: 1, default: 52 },
      { key: 'peel', label: '鑲邊剝除圈數', type: 'number', min: 0, max: 8, step: 1, default: 2 },
    ],
    run: function(small, params) { return removeBackground(small, params || {}); },
  });
})();
