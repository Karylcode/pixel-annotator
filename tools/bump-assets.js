#!/usr/bin/env node
/* bump-assets — 幫 index.html 裡的 css / js 網址換上新的版本參數（?v=…）。
   GitHub Pages 對靜態資源送 Cache-Control: max-age=600，部署後 10 分鐘內
   瀏覽器會繼續用舊的 CSS / JS，配上剛更新的 HTML 就會版面錯亂。
   每次要部署前跑一次 `node tools/bump-assets.js`，所有資源網址就會一起換版本。

   用法：node tools/bump-assets.js [版本字串]   （不給就用當下時間 YYYYMMDDHHmm） */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const file = path.join(root, 'index.html');
const p = n => String(n).padStart(2, '0');
const d = new Date();
const ver = process.argv[2] ||
  `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;

let html = fs.readFileSync(file, 'utf8');
let n = 0;
// 只動本機相對路徑的 .css / .js；http(s):// 開頭的外部資源不碰
html = html.replace(/(\s(?:href|src)=")((?!https?:|\/\/)[^"?]+\.(?:css|js))(\?v=[^"]*)?(")/g,
  (_, pre, url, _old, post) => { n++; return `${pre}${url}?v=${ver}${post}`; });

fs.writeFileSync(file, html);
console.log(`已更新 ${n} 個資源網址 → ?v=${ver}`);
