/* pixelate/lib/morph.js — Uint8Array 標籤圖上的 3×3 形態學。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};
PA.pixelate.lib = PA.pixelate.lib || {};

PA.pixelate.lib.morph = (() => {
  function dilate(src, w, h) {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (src[yy * w + xx]) m = 1;
        }
        out[y * w + x] = m;
      }
    }
    return out;
  }
  function erode(src, w, h) {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(w - 1, x + dx));
          const yy = Math.max(0, Math.min(h - 1, y + dy));
          if (!src[yy * w + xx]) m = 0;
        }
        out[y * w + x] = m;
      }
    }
    return out;
  }
  function close(src, w, h) { return erode(dilate(src, w, h), w, h); }
  function open(src, w, h) { return dilate(erode(src, w, h), w, h); }
  return { dilate, erode, close, open };
})();
