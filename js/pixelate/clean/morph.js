/* pixelate/clean/morph.js
   移植自 unfake.js 的形態學／鋸齒／alpha 清理。MIT，未使用 wasm。
   https://github.com/jenissimo/unfake.js
   id: holes | specks | jaggies | alpha */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  function keyAt(rgba, i) {
    return (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2] | (rgba[i + 3] << 24);
  }
  function setAt(rgba, i, k) {
    rgba[i] = (k >> 16) & 255; rgba[i + 1] = (k >> 8) & 255; rgba[i + 2] = k & 255; rgba[i + 3] = (k >>> 24) & 255;
  }
  function neighborColor(rgba, w, h, x, y, seen) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let d = 0; d < 4; d++) {
      const nx = x + dirs[d][0], ny = y + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (seen[j]) continue;
      return keyAt(rgba, j * 4);
    }
    return keyAt(rgba, (y * w + x) * 4);
  }

  function components(small, pred) {
    const { w, h, rgba } = small;
    const seen = new Uint8Array(w * h);
    const groups = [];
    const stack = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (seen[i] || !pred(i * 4, x, y)) continue;
        const cells = [];
        stack.length = 0; stack.push(i); seen[i] = 1;
        while (stack.length) {
          const c = stack.pop();
          cells.push(c);
          const cx = c % w, cy = (c / w) | 0;
          const nbs = [c + 1, c - 1, c + w, c - w];
          const ok = [cx + 1 < w, cx > 0, cy + 1 < h, cy > 0];
          for (let t = 0; t < 4; t++) {
            if (!ok[t] || seen[nbs[t]]) continue;
            const ni = nbs[t];
            if (!pred(ni * 4, ni % w, (ni / w) | 0)) continue;
            seen[ni] = 1; stack.push(ni);
          }
        }
        groups.push(cells);
      }
    }
    return groups;
  }

  function holes(small, params) {
    const maxHole = params && params.maxHole != null ? params.maxHole : 2;
    const { w, h, rgba } = small;
    const groups = components(small, p => rgba[p + 3] < 128);
    let n = 0;
    for (let g = 0; g < groups.length; g++) {
      const cells = groups[g];
      if (cells.length === 0 || cells.length > maxHole) continue;
      let touches = false;
      for (let i = 0; i < cells.length; i++) {
        const x = cells[i] % w, y = (cells[i] / w) | 0;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { touches = true; break; }
      }
      if (touches) continue;
      const mark = new Uint8Array(w * h);
      for (let i = 0; i < cells.length; i++) mark[cells[i]] = 1;
      const col = neighborColor(rgba, w, h, cells[0] % w, (cells[0] / w) | 0, mark);
      for (let i = 0; i < cells.length; i++) { setAt(rgba, cells[i] * 4, col); n++; }
    }
    return n;
  }

  function specks(small, params) {
    const minSpeck = params && params.minSpeck != null ? params.minSpeck : 2;
    const { w, h, rgba } = small;
    const seen = new Uint8Array(w * h);
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (seen[i] || rgba[i * 4 + 3] === 0) continue;
        const k = keyAt(rgba, i * 4);
        const cells = [];
        const stack = [i]; seen[i] = 1;
        while (stack.length) {
          const c = stack.pop(); cells.push(c);
          const cx = c % w, cy = (c / w) | 0;
          const tryPush = (nx, ny) => {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
            const j = ny * w + nx;
            if (seen[j]) return;
            if (keyAt(rgba, j * 4) !== k) return;
            seen[j] = 1; stack.push(j);
          };
          tryPush(cx + 1, cy); tryPush(cx - 1, cy); tryPush(cx, cy + 1); tryPush(cx, cy - 1);
        }
        if (cells.length > 0 && cells.length <= minSpeck) {
          const mark = new Uint8Array(w * h);
          for (let t = 0; t < cells.length; t++) mark[cells[t]] = 1;
          const col = neighborColor(rgba, w, h, cells[0] % w, (cells[0] / w) | 0, mark);
          for (let t = 0; t < cells.length; t++) { setAt(rgba, cells[t] * 4, col); n++; }
        }
      }
    }
    return n;
  }

  function jaggies(small) {
    const { w, h, rgba } = small;
    let n = 0;
    const at = (x, y) => keyAt(rgba, (y * w + x) * 4);
    const opaque = (x, y) => rgba[((y * w + x) * 4) + 3] > 127;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (opaque(x, y)) continue;
        const n4 = [opaque(x + 1, y), opaque(x - 1, y), opaque(x, y + 1), opaque(x, y - 1)].filter(Boolean).length;
        const d = [opaque(x + 1, y + 1), opaque(x - 1, y + 1), opaque(x + 1, y - 1), opaque(x - 1, y - 1)].filter(Boolean).length;
        if (n4 === 2 && d >= 1) {
          const col = opaque(x + 1, y) ? at(x + 1, y) : opaque(x - 1, y) ? at(x - 1, y) : at(x, y + 1);
          setAt(rgba, (y * w + x) * 4, col);
          n++;
        }
      }
    }
    return n;
  }

  function alphaBin(small, params) {
    const thr = params && params.thr != null ? params.thr : 128;
    const { rgba } = small;
    let n = 0;
    for (let p = 3; p < rgba.length; p += 4) {
      const v = rgba[p] >= thr ? 255 : 0;
      if (v !== rgba[p]) { rgba[p] = v; n++; }
    }
    return n;
  }

  const credit = { project: 'unfake.js', file: 'unfake-core cleanup', license: 'MIT', url: 'https://github.com/jenissimo/unfake.js' };
  PA.pixelate.register('clean', { id: 'holes', label: '補洞', credit, cost: 'fast', params: [{ key: 'maxHole', label: '最大洞面積', type: 'number', min: 1, max: 16, step: 1, default: 2 }], run: holes });
  PA.pixelate.register('clean', { id: 'specks', label: '去雜點', credit, cost: 'fast', params: [{ key: 'minSpeck', label: '雜點面積', type: 'number', min: 1, max: 16, step: 1, default: 2 }], run: specks });
  PA.pixelate.register('clean', { id: 'jaggies', label: '修鋸齒', credit, cost: 'fast', params: [], run: jaggies });
  PA.pixelate.register('clean', { id: 'alpha', label: 'Alpha 二值化', credit, cost: 'fast', params: [{ key: 'thr', label: '門檻', type: 'number', min: 1, max: 255, step: 1, default: 128 }], run: alphaBin });
})();
