/* pixelate/detect/legacy.js — 現有 detectGridAsync 原封搬入，註冊 id 'legacy'。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

PA.pixelate.detect = PA.pixelate.detect || {};
PA.pixelate.detect.legacy = (() => {

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

  return { detectGridAsync };
})();

PA.pixelate.detectGridAsync = PA.pixelate.detect.legacy.detectGridAsync;

PA.pixelate.register('detect', {
  id: 'legacy',
  label: '原版',
  credit: { project: 'pixel-annotator', file: 'js/pixelate.js', license: 'MIT', url: '' },
  cost: 'medium',
  params: [],
  run: async function(rgba, w, h, params, hooks) {
    const t0 = performance.now();
    const g = await PA.pixelate.detectGridAsync(rgba, w, h, hooks);
    if (!g) return null;
    const raw = ((g.scoreX || 0) + (g.scoreY || 0)) / 2;
    return {
      id: 'legacy',
      sx: g.sx, sy: g.sy, phx: g.phx, phy: g.phy,
      score: raw > 0 ? raw / (1 + raw) : 0,
      ms: performance.now() - t0,
      meta: { nx: g.nx, ny: g.ny, scoreX: g.scoreX, scoreY: g.scoreY },
    };
  },
});
