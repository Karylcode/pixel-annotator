/* tools/bench/run.js — 24 例合成測試。--method <preset>；--baseline 存 JSON；--compare 與 baseline 逐位比對。 */
const fs = require('fs');
const path = require('path');
const { makeNative, upscale, blurImg, CASES } = require('./gen.js');

const ROOT = path.resolve(__dirname, '../..');
const FILES = [
  'js/pixelate/lib/colour.js',
  'js/pixelate/lib/profile.js',
  'js/pixelate/grid.js',
  'js/pixelate/detect/legacy.js',
  'js/pixelate/sample/center-median.js',
  'js/pixelate/quant/oklab-kmeans.js',
  'js/pixelate/clean/bg.js',
  'js/pixelate/index.js',
];

function loadPixelate() {
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) require(p);
  }
  if (!global.PA || !PA.pixelate) {
    const legacy = path.join(ROOT, 'js/pixelate.js');
    if (fs.existsSync(legacy)) require(legacy);
  }
  if (!global.PA || !PA.pixelate) throw new Error('無法載入 PA.pixelate');
}

function parseArgs(argv) {
  const out = { method: 'legacy', baseline: false, compare: null, k: 0, bg: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--method') out.method = argv[++i];
    else if (argv[i] === '--baseline') out.baseline = true;
    else if (argv[i] === '--compare') out.compare = argv[++i] || path.join(__dirname, 'baseline-legacy.json');
    else if (argv[i] === '--k') out.k = +argv[++i] || 0;
    else if (argv[i] === '--bg') out.bg = true;
  }
  return out;
}

function hit1(got, truth) {
  return Math.abs(got - truth) <= 1;
}

function rgbaEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function meanDeltaE(px, nat) {
  if (!px || !nat || px.w !== nat.w || px.h !== nat.h) return null;
  const toLab = PA.pixelate.toCielab || PA.pixelate.toOklab;
  if (!toLab) return null;
  const dE = PA.pixelate.deltaE76 || ((a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  let s = 0, n = 0;
  for (let i = 0; i < px.rgba.length; i += 4) {
    const aA = px.rgba[i + 3], bA = nat.rgba[i + 3];
    if (aA === 0 && bA === 0) continue;
    if (aA === 0 || bA === 0) { s += 100; n++; continue; }
    s += dE(toLab(px.rgba[i], px.rgba[i + 1], px.rgba[i + 2]),
            toLab(nat.rgba[i], nat.rgba[i + 1], nat.rgba[i + 2]));
    n++;
  }
  return n ? s / n : 0;
}

async function detectGrid(rgba, w, h) {
  if (PA.pixelate.detectGridAsync) return PA.pixelate.detectGridAsync(rgba, w, h, {});
  throw new Error('沒有 detectGridAsync');
}

async function runOne(c, k, method, colours, removeBg) {
  const nat = makeNative(c.n, 1000 + k * 37, c.blocky);
  const big = blurImg(upscale(nat, c.f, c.smooth), c.blur);
  const preset = (PA.pixelate.presets || []).find(p => p.id === method);
  let grid, px, votes = [], timings = {};
  if (method === 'legacy' || !PA.pixelate.runPipeline || !preset) {
    grid = await detectGrid(big.rgba, big.w, big.h);
    if (grid && PA.pixelate.run) {
      const r = PA.pixelate.run(big.rgba, big.w, big.h, {
        grid, removeBg, colours, error: false,
      });
      px = r.px;
    }
  } else {
    const config = Object.assign({}, preset.config, { k: colours, error: false });
    if (!removeBg) config.clean = (config.clean || []).filter(id => id !== 'bg');
    const r = await PA.pixelate.runPipeline(big.rgba, big.w, big.h, config, {});
    grid = r && r.grid;
    px = r && r.px;
    votes = (r && r.votes) || [];
    timings = (r && r.timings) || {};
  }
  const nx = grid ? grid.nx : 0;
  const ny = grid ? grid.ny : 0;
  const ok = !!(grid && hit1(nx, c.n) && hit1(ny, c.n));
  return {
    k, n: c.n, f: c.f, blur: c.blur, smooth: c.smooth, blocky: c.blocky,
    w: big.w, h: big.h,
    nx, ny,
    sx: grid ? grid.sx : null,
    sy: grid ? grid.sy : null,
    phx: grid ? grid.phx : null,
    phy: grid ? grid.phy : null,
    scoreX: grid ? grid.scoreX : null,
    scoreY: grid ? grid.scoreY : null,
    ok,
    dE: px ? meanDeltaE(px, nat) : null,
    rgba: px ? Array.from(px.rgba) : null,
    votes: votes.map(v => v && ({ id: v.id, sx: v.sx, sy: v.sy, score: v.score })),
    ms: timings.total || null,
  };
}

async function main() {
  loadPixelate();
  const args = parseArgs(process.argv);
  const rows = [];
  let hits = 0;
  for (let k = 0; k < CASES.length; k++) {
    const row = await runOne(CASES[k], k, args.method, args.k, args.bg);
    rows.push(row);
    if (row.ok) hits++;
    const mark = row.ok ? 'OK' : 'miss';
    console.log(
      String(k).padStart(2) + '  truth ' + String(row.n).padStart(2) +
      '  got ' + String(row.nx).padStart(3) + '×' + String(row.ny).padStart(3) +
      '  sx=' + (row.sx == null ? '-' : row.sx.toFixed(3)) +
      '  ' + mark +
      (row.dE != null ? ('  ΔE=' + row.dE.toFixed(2)) : '') +
      (CASES[k].blocky ? '  blocky' : '') +
      (CASES[k].smooth ? '  smooth' : '') +
      (CASES[k].blur ? ('  blur' + CASES[k].blur) : '')
    );
  }
  console.log('hit ±1: ' + hits + '/' + CASES.length + '  (' + (100 * hits / CASES.length).toFixed(1) + '%)  method=' + args.method);

  const slim = rows.map(r => ({
    k: r.k, n: r.n, f: r.f, blur: r.blur, smooth: r.smooth, blocky: r.blocky,
    nx: r.nx, ny: r.ny, sx: r.sx, sy: r.sy, phx: r.phx, phy: r.phy,
    scoreX: r.scoreX, scoreY: r.scoreY, rgba: r.rgba,
  }));

  if (args.baseline) {
    const dest = path.join(__dirname, 'baseline-legacy.json');
    fs.writeFileSync(dest, JSON.stringify(slim));
    console.log('wrote ' + dest);
  }

  if (args.compare) {
    const cmpPath = args.compare === true ? path.join(__dirname, 'baseline-legacy.json') : args.compare;
    const base = JSON.parse(fs.readFileSync(cmpPath, 'utf8'));
    let diffs = 0;
    for (let i = 0; i < slim.length; i++) {
      const a = slim[i], b = base[i];
      const keys = ['nx', 'ny', 'sx', 'sy', 'phx', 'phy'];
      const mismatch = keys.filter(key => a[key] !== b[key]);
      const pix = rgbaEqual(a.rgba, b.rgba);
      if (mismatch.length || !pix) {
        diffs++;
        console.log('DIFF #' + i + '  ' + mismatch.join(',') + (pix ? '' : '  rgba'));
      }
    }
    if (diffs) {
      console.log('compare FAILED: ' + diffs + '/' + slim.length + ' differ');
      process.exitCode = 1;
    } else {
      console.log('compare OK: 24/24 bit-identical to ' + path.basename(cmpPath));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
