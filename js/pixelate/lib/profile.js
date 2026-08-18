/* pixelate/lib/profile.js — 邊緣能量剖面。edgeProfiles 自 js/pixelate.js 原封搬入。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};
PA.pixelate.lib = PA.pixelate.lib || {};

PA.pixelate.lib.profile = (() => {

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

  // 特徵圖：|二階差分| + 0.7·|一階差分|（每軸各自）。給 autocorr / selfsim 用。
  function featureMap(rgba, w, h) {
    const fx = new Float32Array(w * h), fy = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 1; x < w; x++) {
        const i = (row + x) * 4, j = i - 4;
        const d1 = Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
        let d2 = 0;
        if (x + 1 < w) {
          const k = i + 4;
          const dNext = Math.abs(rgba[k] - rgba[i]) + Math.abs(rgba[k + 1] - rgba[i + 1]) + Math.abs(rgba[k + 2] - rgba[i + 2]);
          d2 = Math.abs(dNext - d1);
        }
        fx[row + x] = d2 + 0.7 * d1;
      }
    }
    for (let y = 1; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, j = i - w * 4;
        const d1 = Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
        let d2 = 0;
        if (y + 1 < h) {
          const k = i + w * 4;
          const dNext = Math.abs(rgba[k] - rgba[i]) + Math.abs(rgba[k + 1] - rgba[i + 1]) + Math.abs(rgba[k + 2] - rgba[i + 2]);
          d2 = Math.abs(dNext - d1);
        }
        fy[y * w + x] = d2 + 0.7 * d1;
      }
    }
    return { fx, fy, w, h };
  }

  return { smooth1d, edgeProfiles, featureMap };
})();

PA.pixelate.edgeProfiles = PA.pixelate.lib.profile.edgeProfiles;
