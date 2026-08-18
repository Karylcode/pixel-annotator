#!/usr/bin/env node
/* tools/pixelate-cli.js
   用法：node tools/pixelate-cli.js [--preset <id>] in.png out.png
   預設方法 pixel-perfecter。給 pixel-bench 用 subprocess 呼叫；純 Node，無 npm。 */
const fs = require('fs');
const path = require('path');
const { readPng, writePng } = require('./png.js');
const FILES = require('./pixelate-files.js');

const ROOT = path.resolve(__dirname, '..');
const PX_DEFAULT = 'pixel-perfecter';

function loadPixelate() {
  for (let i = 0; i < FILES.length; i++) {
    const p = path.join(ROOT, FILES[i]);
    if (fs.existsSync(p)) require(p);
  }
  if (!global.PA || !PA.pixelate) throw new Error('無法載入 PA.pixelate');
}

function parseArgs(argv) {
  const out = { preset: PX_DEFAULT, k: null, dither: null, targetWidth: null, in: null, out: null };
  const pos = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') out.preset = argv[++i];
    else if (a === '--k') out.k = +argv[++i];
    else if (a === '--dither') out.dither = argv[++i];
    else if (a === '--target-width') out.targetWidth = +argv[++i];
    else if (a[0] !== '-') pos.push(a);
    else throw new Error('未知參數：' + a);
  }
  out.in = pos[0]; out.out = pos[1];
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.in || !args.out) {
    process.stderr.write('用法：node tools/pixelate-cli.js [--preset pixel-perfecter] in.png out.png\n');
    process.exit(2);
  }
  loadPixelate();
  const preset = PA.pixelate.getPreset(args.preset);
  if (!preset) {
    const names = (PA.pixelate.validPresetNames() || []).join(', ');
    process.stderr.write('找不到預設組合：' + args.preset + '\n有效名稱：' + names + '\n');
    process.exit(1);
  }
  const img = readPng(fs.readFileSync(args.in));
  const config = Object.assign({}, preset.config, {
    k: args.k != null ? args.k : (preset.config.k || 0),
    error: false,
  });
  if (args.dither) config.dither = args.dither;
  if (args.targetWidth) config.targetWidth = args.targetWidth;
  const t0 = Date.now();
  const r = await PA.pixelate.runPipeline(img.rgba, img.w, img.h, config, {});
  if (!r || !r.px) throw new Error('像素化沒有產出結果');
  fs.writeFileSync(args.out, writePng(r.px.w, r.px.h, r.px.rgba));
  const g = r.grid;
  process.stderr.write(
    `ok ${r.px.w}×${r.px.h} grid=${g ? g.nx + '×' + g.ny : '—'} ${Date.now() - t0}ms preset=${preset.id}\n`
  );
}

main().catch(err => {
  process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
