/* tools/bench/images.js — 用真實圖片測所有方法。
   用法：node tools/bench/images.js [--dir <資料夾>] [--methods a,b,c]
   對每張圖跑每個預設，印格數 / 重建誤差 / 色數 / 耗時。
   已知答案的會標 ✓／✗（原生手繪像素圖 = 應維持原尺寸；@32x = 應還原成 1/32）。 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { readPng } = require(path.join(ROOT, 'tools/png.js'));
const FILES = ['lib/colour','lib/profile','lib/fft','lib/morph','lib/canny','grid',
  'detect/legacy','detect/autocorr','detect/runlength','detect/selfsim','detect/fft','detect/perfecter','detect/hough','detect/runs','detect/arbitrate',
  'sample/center-median','sample/two-stage','sample/stats','sample/geomedian','sample/pixeloe',
  'quant/oklab-kmeans','quant/median-cut','dither/adapter','clean/bg','clean/morph','index'];
for (const f of FILES) require(path.join(ROOT, 'js/pixelate', f + '.js'));
const PX = global.PA.pixelate;

// 已知答案：原生手繪像素圖應維持原尺寸；@32x 是 24×24 放大 32 倍
const TRUTH = {
  'Priest.png': 100, 'Wizard.png': 100, 'Swordsman.png': 100, 'Archer.png': 100,
  'image-1786745991461.png': 40,
  'Priest@32x.png': 24,
};

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--dir') args.dir = process.argv[++i];
  else if (process.argv[i] === '--methods') args.methods = process.argv[++i].split(',');
  else if (process.argv[i] === '--only') args.only = process.argv[++i];
}
const DIR = args.dir || 'C:/Users/Karyl/Downloads/GPT PIXEL';

(async () => {
  const hooks = { onProgress: () => {}, cancelled: () => false, tick: () => Promise.resolve() };
  const presets = PX.presets.filter(p => !args.methods || args.methods.includes(p.id));
  const files = fs.readdirSync(DIR).filter(f => /\.png$/i.test(f)).filter(f => !args.only || f.includes(args.only));
  for (const file of files) {
    const img = readPng(fs.readFileSync(path.join(DIR, file)));
    const truth = TRUTH[file];
    console.log('\n■ ' + file + '  ' + img.w + '×' + img.h + (truth ? ('   已知答案 ' + truth + '×' + truth) : '   （AI 圖，無標準答案）'));
    for (const p of presets) {
      const cfg = JSON.parse(JSON.stringify(p.config));
      const t0 = Date.now();
      let r = null, err = null;
      try { r = await PX.runPipeline(img.rgba, img.w, img.h, cfg, hooks); }
      catch (e) { err = e.message; }
      const ms = Date.now() - t0;
      if (err) { console.log('   ' + p.id.padEnd(14) + ' 例外：' + err); continue; }
      const g = r && r.grid;
      // 自我驗證：本測試絕不套用原版的「自動吸附格線」
      if (cfg.snap) throw new Error('測試設定不該有 snap');
      const contaminated = !!(g && (g.mesh || g.xs || g.ys));
      const nx = g ? g.nx : null, ny = g ? g.ny : null;
      const targetW = cfg.targetWidth > 0 && (!cfg.detectors || !cfg.detectors.length);
      const mark = targetW ? '·' : truth == null ? ' ' : (nx === truth && ny === truth ? '✓' : (Math.abs(nx - truth) <= 1 && Math.abs(ny - truth) <= 1 ? '~' : '✗'));
      console.log('   ' + mark + ' ' + p.id.padEnd(14) +
        (g ? (String(nx) + '×' + String(ny)).padStart(9) : '   native') +
        '  s=' + (g ? g.sx.toFixed(2) : '-').padStart(6) +
        '  err=' + (r.err == null ? '-' : r.err.toFixed(1)).padStart(6) +
        '  色=' + String(r.colours || 0).padStart(4) +
        '  ' + String(ms).padStart(6) + 'ms' +
        (g && g.source ? '  ' + g.source : '') +
        (contaminated ? '  ⚠吸附' : ''));
    }
  }
})();
