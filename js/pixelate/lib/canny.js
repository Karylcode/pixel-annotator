/* pixelate/lib/canny.js — gaussian → sobel → NMS → 遲滯門檻。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};
PA.pixelate.lib = PA.pixelate.lib || {};

PA.pixelate.lib.canny = (() => {
  function gaussianBlur(src, w, h, sigma) {
    const r = Math.max(1, Math.round(sigma * 2));
    const k = new Float64Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * src[y * w + Math.max(0, Math.min(w - 1, x + i))];
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * tmp[Math.max(0, Math.min(h - 1, y + i)) * w + x];
      out[y * w + x] = v;
    }
    return out;
  }

  function canny(gray, w, h, sigma, lo, hi) {
    const g = gaussianBlur(gray, w, h, sigma || 1.0);
    const mag = new Float32Array(w * h), ang = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const gx = g[y * w + x + 1] - g[y * w + x - 1];
        const gy = g[(y + 1) * w + x] - g[(y - 1) * w + x];
        mag[y * w + x] = Math.hypot(gx, gy);
        ang[y * w + x] = Math.atan2(gy, gx);
      }
    }
    const nms = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const a = ang[y * w + x];
        const dir = Math.round(((a + Math.PI) / (Math.PI / 4))) & 3;
        let d1, d2;
        if (dir === 0 || dir === 4) { d1 = mag[y * w + x - 1]; d2 = mag[y * w + x + 1]; }
        else if (dir === 1) { d1 = mag[(y - 1) * w + x + 1]; d2 = mag[(y + 1) * w + x - 1]; }
        else if (dir === 2) { d1 = mag[(y - 1) * w + x]; d2 = mag[(y + 1) * w + x]; }
        else { d1 = mag[(y - 1) * w + x - 1]; d2 = mag[(y + 1) * w + x + 1]; }
        const m = mag[y * w + x];
        if (m >= d1 && m >= d2) nms[y * w + x] = m;
      }
    }
    let max = 0;
    for (let i = 0; i < nms.length; i++) if (nms[i] > max) max = nms[i];
    const high = (hi || 0.2) * max, low = (lo || 0.08) * max;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < nms.length; i++) if (nms[i] >= high) out[i] = 2;
    else if (nms[i] >= low) out[i] = 1;
    const stack = [];
    for (let i = 0; i < out.length; i++) if (out[i] === 2) stack.push(i);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (out[j] === 1) { out[j] = 2; stack.push(j); }
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = out[i] === 2 ? 1 : 0;
    return out;
  }

  return { gaussianBlur, canny };
})();
