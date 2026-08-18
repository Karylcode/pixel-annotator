/* pixelate/lib/colour.js — 色彩空間。toOklab 自 js/pixelate.js 原封搬入。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};
PA.pixelate.lib = PA.pixelate.lib || {};
PA.pixelate._pendingRegs = PA.pixelate._pendingRegs || [];
if (!PA.pixelate.register) {
  PA.pixelate.register = function(stage, def) {
    PA.pixelate._pendingRegs.push([stage, def]);
  };
}

PA.pixelate.lib.colour = (() => {

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

  function srgbToLinear(v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }

  // sRGB → CIELAB（D65）。給 ΔE 與 PixelOE 用。
  function toCielab(r, g, b) {
    const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    let x = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B;
    let y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
    let z = 0.0193339 * R + 0.1191920 * G + 0.9503041 * B;
    x /= 0.95047; z /= 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function deltaE76(a, b) {
    const dL = a[0] - b[0], dA = a[1] - b[1], dB = a[2] - b[2];
    return Math.sqrt(dL * dL + dA * dA + dB * dB);
  }

  function fromCielab(L, a, b) {
    const fy = (L + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const fInv = t => {
      const t3 = t * t * t;
      return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
    };
    const x = 0.95047 * fInv(fx);
    const y = fInv(fy);
    const z = 1.08883 * fInv(fz);
    let R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    let G = -0.9692660 * x + 1.8757279 * y + 0.0415560 * z;
    let B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
    const lin = v => {
      v = Math.max(0, Math.min(1, v));
      return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    };
    return [lin(R) * 255, lin(G) * 255, lin(B) * 255];
  }

  return { toOklab, toCielab, fromCielab, deltaE76 };
})();

PA.pixelate.toOklab = PA.pixelate.lib.colour.toOklab;
PA.pixelate.toCielab = PA.pixelate.lib.colour.toCielab;
PA.pixelate.fromCielab = PA.pixelate.lib.colour.fromCielab;
PA.pixelate.deltaE76 = PA.pixelate.lib.colour.deltaE76;
