/* pixelate/quant/median-cut.js — 經典中位切割減色，輸出格式同 oklab-kmeans。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  function countColours(rgba) {
    return PA.pixelate.countColours(rgba);
  }

  function splitBox(colors) {
    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    let total = 0;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r;
      if (c.g < minG) minG = c.g; if (c.g > maxG) maxG = c.g;
      if (c.b < minB) minB = c.b; if (c.b > maxB) maxB = c.b;
      total += c.n;
    }
    const dr = maxR - minR, dg = maxG - minG, db = maxB - minB;
    let ch = 0;
    if (dg >= dr && dg >= db) ch = 1;
    else if (db >= dr && db >= dg) ch = 2;
    const key = ch === 0 ? 'r' : ch === 1 ? 'g' : 'b';
    colors.sort((a, b) => a[key] - b[key]);
    let acc = 0, cut = colors.length - 1;
    const half = total / 2;
    for (let i = 0; i < colors.length - 1; i++) {
      acc += colors[i].n;
      if (acc >= half) { cut = i; break; }
    }
    return [colors.slice(0, cut + 1), colors.slice(cut + 1)];
  }

  function meanColor(colors) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; n += c.n;
    }
    if (!n) return 0;
    return ((Math.round(r / n) & 255) << 16) | ((Math.round(g / n) & 255) << 8) | (Math.round(b / n) & 255);
  }

  function rangeOf(colors) {
    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r;
      if (c.g < minG) minG = c.g; if (c.g > maxG) maxG = c.g;
      if (c.b < minB) minB = c.b; if (c.b > maxB) maxB = c.b;
    }
    return Math.max(maxR - minR, maxG - minG, maxB - minB);
  }

  function quantize(px, k) {
    const rgba = px.rgba;
    const map = countColours(rgba);
    if (k < 1 || map.size <= k) return map.size;

    const colors = [];
    map.forEach((n, key) => {
      colors.push({ key, n, r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255 });
    });
    const boxes = [colors];
    while (boxes.length < k) {
      let bi = -1, br = -1;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].length < 2) continue;
        const r = rangeOf(boxes[i]);
        if (r > br) { br = r; bi = i; }
      }
      if (bi < 0) break;
      const parts = splitBox(boxes[bi]);
      if (!parts[0].length || !parts[1].length) break;
      boxes[bi] = parts[0];
      boxes.push(parts[1]);
    }

    const lut = new Map();
    for (let i = 0; i < boxes.length; i++) {
      const mean = meanColor(boxes[i]);
      for (let j = 0; j < boxes[i].length; j++) lut.set(boxes[i][j].key, mean);
    }

    for (let p = 0; p < rgba.length; p += 4) {
      if (rgba[p + 3] === 0) continue;
      const v = lut.get((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]);
      if (v == null) continue;
      rgba[p] = (v >> 16) & 255; rgba[p + 1] = (v >> 8) & 255; rgba[p + 2] = v & 255;
    }
    return new Set(lut.values()).size;
  }

  PA.pixelate.register('quant', {
    id: 'median-cut',
    label: '中位切割',
    credit: { project: 'pixel-annotator', file: 'js/pixelate/quant/median-cut.js', license: 'MIT', url: '' },
    cost: 'fast',
    params: [],
    run: function(small, k) { return quantize(small, k); },
  });
})();
