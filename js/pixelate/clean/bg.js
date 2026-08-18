/* pixelate/clean/bg.js — 現有 removeBackground / backgroundColours 原封搬入。 */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {

  /* ---------- 背景:AI 常把「透明棋盤格」直接畫進圖裡 ---------- */

  // 從邊框取樣,佔比夠高的顏色視為背景。計數時先量化,才不會被 ±1 的變體拆散。
  function backgroundColours(px) {
    const { w, h, rgba } = px;
    const buckets = new Map();
    const add = (x, y) => {
      const p = (y * w + x) * 4;
      if (rgba[p + 3] === 0) return;
      const k = ((rgba[p] >> 2) << 16) | ((rgba[p + 1] >> 2) << 8) | (rgba[p + 2] >> 2);
      let b = buckets.get(k);
      if (!b) buckets.set(k, b = { n: 0, r: 0, g: 0, bl: 0 });
      b.n++; b.r += rgba[p]; b.g += rgba[p + 1]; b.bl += rgba[p + 2];
    };
    for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
    for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }

    const border = 2 * w + 2 * h;
    return [...buckets.values()]
      .filter(b => b.n >= border * 0.12)
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map(b => [b.r / b.n, b.g / b.n, b.bl / b.n]);
  }

  // 只清掉「從畫面外緣連得過來」的背景色區域。
  // 全圖比對同色會把角色身上同色的部分(白袍、灰髮)一起清掉 —— 泛洪不會,
  // 因為那些像素被角色本體擋住,連不到邊界。
  function removeBackground(px, tol = 10) {
    const { w, h, rgba } = px;
    const bg = backgroundColours(px);
    if (!bg.length) return 0;

    const isBg = p => {
      for (const c of bg) {
        if (Math.abs(rgba[p] - c[0]) <= tol &&
            Math.abs(rgba[p + 1] - c[1]) <= tol &&
            Math.abs(rgba[p + 2] - c[2]) <= tol) return true;
      }
      return false;
    };

    const seen = new Uint8Array(w * h);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * w + x;
      if (seen[i]) return;
      seen[i] = 1;                                   // 標記過就不再看,非背景的像素等於擋住去路
      if (rgba[i * 4 + 3] === 0 || isBg(i * 4)) stack.push(i);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

    let removed = 0;
    while (stack.length) {
      const i = stack.pop(), p = i * 4;
      if (rgba[p + 3] !== 0) { rgba[p + 3] = 0; removed++; }
      const x = i % w, y = (i / w) | 0;
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    return removed;
  }

  PA.pixelate.backgroundColours = backgroundColours;
  PA.pixelate.removeBackground = removeBackground;

  PA.pixelate.register('clean', {
    id: 'bg',
    label: '移除假透明棋盤格',
    credit: { project: 'pixel-annotator', file: 'js/pixelate.js', license: 'MIT', url: '' },
    cost: 'fast',
    params: [{ key: 'tol', label: '容差', type: 'number', min: 0, max: 64, step: 1, default: 10 }],
    run: function(small, params) {
      return removeBackground(small, params && params.tol != null ? params.tol : 10);
    },
  });
})();
