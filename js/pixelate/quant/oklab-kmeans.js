/* pixelate/quant/oklab-kmeans.js — 現有 quantize 原封搬入（toOklab 改由 lib/colour.js 提供）。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  function toOklab(r, g, b) { return PA.pixelate.toOklab(r, g, b); }

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

  PA.pixelate.countColours = countColours;
  PA.pixelate.quantize = quantize;

  PA.pixelate.register('quant', {
    id: 'oklab-kmeans',
    label: 'OKLab k-means',
    credit: { project: 'pixel-annotator', file: 'js/pixelate.js', license: 'MIT', url: '' },
    cost: 'medium',
    params: [],
    run: function(small, k, params) {
      return quantize(small, k);
    },
  });
})();
