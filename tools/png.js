/* tools/png.js — 最小 PNG 讀寫（8-bit RGB / RGBA / 灰階 / 索引）。Node zlib，無 npm。 */
const zlib = require('zlib');

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TAB = (function() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TAB[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, h, rowBytes, bpp) {
  const out = Buffer.alloc(h * rowBytes);
  let src = 0, dst = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[src++];
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src++];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y ? out[dst + x - rowBytes] : 0;
      const c = y && x >= bpp ? out[dst + x - rowBytes - bpp] : 0;
      let r;
      if (ft === 0) r = v;
      else if (ft === 1) r = (v + a) & 255;
      else if (ft === 2) r = (v + b) & 255;
      else if (ft === 3) r = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) r = (v + paeth(a, b, c)) & 255;
      else throw new Error('不支援的 PNG 濾鏡：' + ft);
      out[dst + x] = r;
    }
    dst += rowBytes;
  }
  return out;
}

function readPng(buf) {
  if (buf.length < 8 || !buf.slice(0, 8).equals(SIG)) throw new Error('不是 PNG 檔');
  let i = 8, w = 0, h = 0, depth = 8, ctype = 6, pal = null;
  const idats = [];
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i); i += 4;
    const type = buf.toString('ascii', i, i + 4); i += 4;
    if (i + len + 4 > buf.length) throw new Error('PNG 區塊不完整');
    const data = buf.slice(i, i + len); i += len + 4;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9];
    } else if (type === 'PLTE') pal = data;
    else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
  }
  if (!w || !h) throw new Error('PNG 缺少 IHDR');
  if (depth !== 8) throw new Error('只支援 8-bit PNG');
  const inflated = zlib.inflateSync(Buffer.concat(idats));
  let ch = 4;
  if (ctype === 2) ch = 3;
  else if (ctype === 0) ch = 1;
  else if (ctype === 3) ch = 1;
  else if (ctype === 6) ch = 4;
  else throw new Error('不支援的 PNG 色彩類型：' + ctype);
  const row = w * ch;
  const pixels = unfilter(inflated, h, row, ch);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const p = y * row + x * ch;
      if (ctype === 6) {
        rgba[o] = pixels[p]; rgba[o + 1] = pixels[p + 1]; rgba[o + 2] = pixels[p + 2]; rgba[o + 3] = pixels[p + 3];
      } else if (ctype === 2) {
        rgba[o] = pixels[p]; rgba[o + 1] = pixels[p + 1]; rgba[o + 2] = pixels[p + 2]; rgba[o + 3] = 255;
      } else if (ctype === 0) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[p]; rgba[o + 3] = 255;
      } else {
        const idx = pixels[p] * 3;
        if (!pal || idx + 2 >= pal.length) { rgba[o + 3] = 0; continue; }
        rgba[o] = pal[idx]; rgba[o + 1] = pal[idx + 1]; rgba[o + 2] = pal[idx + 2]; rgba[o + 3] = 255;
      }
    }
  }
  return { w, h, rgba };
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([t, data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, t, data, c]);
}

function writePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + stride);
    raw[o] = 0;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = rgba[y * stride + x];
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { readPng, writePng };
