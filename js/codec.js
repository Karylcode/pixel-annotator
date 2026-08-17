/* codec — 純資料轉換:文字 <-> 像素 <-> 匯出格式。
   這一層不碰畫面、不碰應用狀態,每個函式都是輸入什麼就回傳什麼。 */
window.PA = window.PA || {};

PA.codec = (() => {

  /* ---------- 解析貼上的 JS / JSON ---------- */

  // 容錯解析器,支援匯出器會產生的語法:裸鍵、單引號、結尾逗號、// 與 /* */ 註解。
  // 不是 eval —— 貼進來的文字永遠不會被當程式執行。
  function parseLoose(s) {
    let i = 0;
    const err = m => { throw new Error(m + `（第 ${s.slice(0, i).split('\n').length} 行附近）`); };

    function ws() {
      for (;;) {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (s[i] === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (s[i] === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
        break;
      }
    }
    function str() {
      const q = s[i++]; let out = '';
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') {
          i++; const e = s[i++];
          if (e === 'u') { out += String.fromCharCode(parseInt(s.substr(i, 4), 16)); i += 4; }
          else out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' })[e] ?? e;
        } else out += s[i++];
      }
      if (i >= s.length) err('字串沒有結束引號');
      i++;
      return out;
    }
    function num() {
      const st = i;
      if (s[i] === '-' || s[i] === '+') i++;
      while (i < s.length && /[\d.eE]/.test(s[i])) i++;
      const v = Number(s.slice(st, i));
      if (!Number.isFinite(v)) err(`數字 "${s.slice(st, i)}" 無法解析`);
      return v;
    }
    function arr() {
      i++; const a = [];
      for (;;) {
        ws();
        if (s[i] === ']') { i++; return a; }
        if (i >= s.length) err('陣列沒有結束的 ]');
        a.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return a; }
        err('陣列裡少了逗號或 ]');
      }
    }
    function obj() {
      i++; const o = {};
      for (;;) {
        ws();
        if (s[i] === '}') { i++; return o; }
        if (i >= s.length) err('物件沒有結束的 }');
        let k;
        if (s[i] === '"' || s[i] === "'") k = str();
        else {
          const st = i;
          while (i < s.length && /[\w$]/.test(s[i])) i++;
          if (i === st) err(`無法解析物件的鍵 "${s.slice(i, i + 10)}"`);
          k = s.slice(st, i);
        }
        ws();
        if (s[i] !== ':') err(`鍵 "${k}" 後面少了冒號`);
        i++;
        o[k] = value();
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return o; }
        err('物件裡少了逗號或 }');
      }
    }
    function value() {
      ws();
      const c = s[i];
      if (c === '{') return obj();
      if (c === '[') return arr();
      if (c === '"' || c === "'") return str();
      if (c === '-' || c === '+' || /\d/.test(c)) return num();
      if (s.startsWith('true', i)) { i += 4; return true; }
      if (s.startsWith('false', i)) { i += 5; return false; }
      if (s.startsWith('null', i)) { i += 4; return null; }
      if (s.startsWith('undefined', i)) { i += 9; return null; }
      err(`無法解析的值 "${s.slice(i, i + 12)}"`);
    }

    // 略過 "export const NAME =" 前綴,同時不會被註解裡的括號騙到
    for (;;) {
      if (s[i] === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (s[i] === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
      if (i >= s.length) throw new Error('找不到 { 或 [，這看起來不是 JSON / JS 物件');
      if (s[i] === '{' || s[i] === '[') break;
      i++;
    }
    return value();
  }

  // 從 "export const fa1441 =" 或開頭註解 "// fa1441.png" 取名稱
  function extractName(src) {
    const m = src.match(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)
           || src.match(/\/\/\s*([\w.-]+?)\.png/);
    return m ? m[1] : null;
  }

  /* ---------- 顏色 ---------- */

  function hex2rgba(h) {
    if (h === null || h === undefined) return [0, 0, 0, 0];
    let t = String(h).trim().replace(/^#/, '');
    if (t.length === 3) t = [...t].map(c => c + c).join('');
    if (t.length === 6) t += 'ff';
    if (t.length !== 8 || /[^0-9a-fA-F]/.test(t)) throw new Error(`顏色格式不正確："${h}"`);
    return [0, 2, 4, 6].map(k => parseInt(t.substr(k, 2), 16));
  }

  const rgba2hex = (r, g, b, a) =>
    '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('') +
    (a === 255 ? '' : a.toString(16).padStart(2, '0'));

  /* ---------- palette / hex / rgba -> RGBA 位元組 ---------- */

  function decodePixels(d) {
    if (Array.isArray(d)) d = { pixels: d };
    if (!d || typeof d !== 'object') throw new Error('內容不是物件或陣列');
    let { w, h, palette, pixels, rgba } = d;

    if (rgba && !pixels) {
      if (!w || !h) throw new Error('rgba 格式需要 w 和 h');
      if (rgba.length !== w * h * 4)
        throw new Error(`rgba 長度 ${rgba.length} 與 ${w}×${h} 不符（應為 ${w * h * 4}）`);
      return { w, h, rgba: Uint8ClampedArray.from(rgba) };
    }
    if (!Array.isArray(pixels) || !Array.isArray(pixels[0]))
      throw new Error('找不到 pixels（需要二維陣列）');

    h = h || pixels.length;
    w = w || pixels[0].length;
    if (pixels.length !== h) throw new Error(`pixels 有 ${pixels.length} 列，但 h = ${h}`);
    if (w < 1 || h < 1 || w > 512 || h > 512) throw new Error(`尺寸 ${w}×${h} 不合理`);

    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const row = pixels[y];
      if (!Array.isArray(row) || row.length !== w)
        throw new Error(`pixels 第 ${y} 列有 ${Array.isArray(row) ? row.length : '非陣列'} 格，應為 ${w}`);
      for (let x = 0; x < w; x++) {
        const v = row[x];
        let c;
        if (v === null || v === undefined) c = [0, 0, 0, 0];
        else if (typeof v === 'number') {
          if (!Array.isArray(palette)) throw new Error('pixels 是數字索引，但沒有 palette');
          if (v < 0 || v >= palette.length)
            throw new Error(`第 ${y} 列第 ${x} 格的索引 ${v} 超出 palette 範圍（0–${palette.length - 1}）`);
          c = hex2rgba(palette[v]);
        }
        else if (typeof v === 'string') c = hex2rgba(v);
        else throw new Error(`第 ${y} 列第 ${x} 格的值無法辨識`);
        out.set(c, (y * w + x) * 4);
      }
    }
    return { w, h, rgba: out };
  }

  /* ---------- 點陣圖:離螢幕 canvas 只當作解碼容器,不是畫面的一部分 ---------- */

  function bitmapFromImage(el) {
    const c = document.createElement('canvas');
    c.width = el.naturalWidth || el.width;
    c.height = el.naturalHeight || el.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = false;
    cx.drawImage(el, 0, 0);
    return { w: c.width, h: c.height, rgba: cx.getImageData(0, 0, c.width, c.height).data, cvs: c };
  }

  function bitmapFromRgba(w, h, rgba) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    const im = cx.createImageData(w, h);
    im.data.set(rgba);
    cx.putImageData(im, 0, 0);
    return { w, h, rgba: cx.getImageData(0, 0, w, h).data, cvs: c };
  }

  // 整數倍最近鄰放大:原圖 1 格 -> N×N 格實心方塊。
  // 刻意不用 drawImage + imageSmoothingEnabled=false —— 那仍要看瀏覽器的取樣規則;
  // 直接逐格複製才能保證每個輸出格精確等於某個輸入格,連 alpha 都原樣搬。
  function scaleBitmap(img, n) {
    const s = Math.max(1, Math.floor(n) || 1);
    if (s === 1) return img.cvs;
    const { w, h, rgba } = img;
    const W = w * s, H = h * s;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4;
        const r = rgba[si], g = rgba[si + 1], b = rgba[si + 2], a = rgba[si + 3];
        for (let dy = 0; dy < s; dy++) {
          let di = ((y * s + dy) * W + x * s) * 4;
          for (let dx = 0; dx < s; dx++) {
            out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = a;
            di += 4;
          }
        }
      }
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
    return c;
  }

  /* ---------- 匯出 ---------- */

  // img: {name,w,h,rgba}  a: {parts,grid} -> 可序列化的純物件
  function encode(img, a) {
    const { w, h, rgba, name } = img;
    const palette = [null], look = new Map(), pixels = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const al = rgba[i + 3];
        if (al < 128) { row.push(0); continue; }
        const hx = rgba2hex(rgba[i], rgba[i + 1], rgba[i + 2], al);
        if (!look.has(hx)) { look.set(hx, palette.length); palette.push(hx); }
        row.push(look.get(hx));
      }
      pixels.push(row);
    }
    const grid = [];
    for (let y = 0; y < h; y++) grid.push(Array.from(a.grid.slice(y * w, y * w + w)));
    const names = {}, colors = {};
    a.parts.forEach(p => { names[p.id] = p.name; colors[p.id] = p.color; });
    return { name, w, h, palette, pixels, parts: { names, colors, grid } };
  }

  const toJson = d => JSON.stringify(d, null, 2);

  // 像素圖轉向量:同色像素併成大矩形,再依顏色收成每色一個 <path>。
  // 座標系固定是像素格(viewBox),width/height 只是預設顯示尺寸,放大不失真。
  // crispEdges 是必要的,否則相鄰形狀之間會出現反鋸齒造成的接縫。
  const SVG_TARGET = 512;   // 預設顯示尺寸取最長邊約這麼大,取整數倍以免半格對不齊

  function toSvg(img, target) {
    const { w, h, rgba } = img;
    const scale = Math.max(1, Math.round((target || SVG_TARGET) / Math.max(w, h)));
    const key = i => rgba[i] + ',' + rgba[i + 1] + ',' + rgba[i + 2] + ',' + rgba[i + 3];

    const used = new Uint8Array(w * h);
    const byColour = new Map();

    // 貪婪合併:先往右吃到底,再把整條往下延伸,能吃多大算多大
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (used[p]) continue;
        if (rgba[p * 4 + 3] === 0) { used[p] = 1; continue; }
        const k = key(p * 4);

        let rw = 1;
        while (x + rw < w && !used[p + rw] && key((p + rw) * 4) === k) rw++;

        let rh = 1;
        grow:
        while (y + rh < h) {
          const q = (y + rh) * w + x;
          for (let dx = 0; dx < rw; dx++)
            if (used[q + dx] || key((q + dx) * 4) !== k) break grow;
          rh++;
        }

        for (let yy = 0; yy < rh; yy++)
          for (let xx = 0; xx < rw; xx++) used[(y + yy) * w + x + xx] = 1;

        if (!byColour.has(k)) byColour.set(k, []);
        byColour.get(k).push(`M${x} ${y}h${rw}v${rh}h${-rw}z`);
      }
    }

    // 同色的所有矩形收進同一個 <path>,一個顏色一個圖形
    const paths = [];
    for (const [k, segs] of byColour) {
      const [r, g, b, a] = k.split(',').map(Number);
      const fill = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
      const op = a === 255 ? '' : ` fill-opacity="${+(a / 255).toFixed(3)}"`;
      paths.push(`  <path fill="${fill}"${op} d="${segs.join('')}"/>`);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" ` +
           `viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">\n${paths.join('\n')}\n</svg>\n`;
  }

  function toJs(d) {
    const rows = a => a.map(r => '    [' + r.join(', ') + '],').join('\n');
    const q = o => Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
    const safe = d.name.replace(/[^A-Za-z0-9_$]/g, '_');
    return `// ${d.name} — ${d.w}x${d.h}\n` +
      `export const ${safe} = {\n` +
      `  w: ${d.w},\n  h: ${d.h},\n` +
      `  palette: [${d.palette.map(c => c === null ? 'null' : JSON.stringify(c)).join(', ')}],\n` +
      `  pixels: [\n${rows(d.pixels)}\n  ],\n` +
      `  parts: {\n    names: { ${q(d.parts.names)} },\n    colors: { ${q(d.parts.colors)} },\n` +
      `    grid: [\n${d.parts.grid.map(r => '      [' + r.join(', ') + '],').join('\n')}\n    ],\n  },\n};\n`;
  }

  /* ---------- ZIP（只封裝不壓縮）：「匯出全部」用，純手寫避免外部依賴 ---------- */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // files: [{name, data: Uint8Array}] -> Blob（application/zip）。檔名以 UTF-8 存（旗標 bit 11）。
  function zip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true); cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true); cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  return { parseLoose, extractName, hex2rgba, rgba2hex, decodePixels,
           bitmapFromImage, bitmapFromRgba, scaleBitmap, encode, toJson, toJs, toSvg, zip };
})();
