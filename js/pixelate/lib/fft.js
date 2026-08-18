/* pixelate/lib/fft.js — 自寫實數 radix-2 FFT，供 autocorr / fft 偵測器共用。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};
PA.pixelate.lib = PA.pixelate.lib || {};

PA.pixelate.lib.fft = (() => {
  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function fftRadix2(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wlenRe = Math.cos(ang), wlenIm = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let wRe = 1, wIm = 0;
        for (let j = 0; j < half; j++) {
          const ur = re[i + j], ui = im[i + j];
          const vr = re[i + j + half] * wRe - im[i + j + half] * wIm;
          const vi = re[i + j + half] * wIm + im[i + j + half] * wRe;
          re[i + j] = ur + vr; im[i + j] = ui + vi;
          re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
          const nw = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nw;
        }
      }
    }
  }

  function ifftRadix2(re, im) {
    const n = re.length;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    fftRadix2(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
  }

  function rfft(x) {
    const n = x.length;
    const nfft = nextPow2(n);
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    const m = n < nfft ? n : nfft;
    for (let i = 0; i < m; i++) re[i] = x[i];
    fftRadix2(re, im);
    const half = (nfft >> 1) + 1;
    const outRe = new Float64Array(half), outIm = new Float64Array(half);
    for (let i = 0; i < half; i++) { outRe[i] = re[i]; outIm[i] = im[i]; }
    return { re: outRe, im: outIm, nfft };
  }

  function acf(x) {
    const n = x.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n || 1;
    const nfft = nextPow2(2 * n);
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < n; i++) re[i] = x[i] - mean;
    fftRadix2(re, im);
    for (let i = 0; i < nfft; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    ifftRadix2(re, im);
    const out = new Float64Array(n);
    for (let lag = 0; lag < n; lag++) {
      out[lag] = re[lag] * (n / Math.max(1, n - lag));
    }
    const a0 = Math.abs(out[0]) > 1e-12 ? out[0] : 1e-12;
    for (let i = 0; i < n; i++) out[i] /= a0;
    return out;
  }

  function interp(arr, pos) {
    if (pos <= 0) return arr[0];
    if (pos >= arr.length - 1) return arr[arr.length - 1];
    const i = pos | 0;
    const f = pos - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  return { nextPow2, rfft, acf, interp, fftRadix2, ifftRadix2 };
})();
