#!/usr/bin/env node
/* tools/check.js — 語法、preset、回歸、CLI、RLE／PNG、保存清除、顏色、靜態資源、特殊檔名。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = require('./pixelate-files.js');
let failed = 0, passed = 0;

function ok(name) { passed++; console.log('  ok  ' + name); }
function fail(name, msg) { failed++; console.log('  FAIL  ' + name + (msg ? ': ' + msg : '')); }
function section(title) { console.log('\n== ' + title); }
function assert(name, cond, msg) { if (cond) ok(name); else fail(name, msg || 'assertion failed'); }

function spawnNode(args, opts) {
  return spawnSync(process.execPath, args, Object.assign({
    cwd: ROOT, encoding: 'utf8', timeout: 360000,
  }, opts || {}));
}

function walkJs(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' ||
        ent.name === 'playwright-report' || ent.name === 'test-results') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJs(p, acc);
    else if (ent.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/* ---------- 1. node --check ---------- */
section('syntax (node --check)');
const jsFiles = walkJs(ROOT, []);
for (const f of jsFiles) {
  const r = spawnNode(['--check', f]);
  if (r.status === 0) ok(path.relative(ROOT, f));
  else fail(path.relative(ROOT, f), (r.stderr || r.stdout || '').trim().split('\n').pop());
}

/* ---------- 2. preset resolver ---------- */
section('preset resolver');
function loadPixelate() {
  for (const f of FILES) require(path.join(ROOT, f));
  if (!global.PA || !PA.pixelate) throw new Error('無法載入 PA.pixelate');
}
loadPixelate();
const PX = PA.pixelate;
assert('getPreset exists', typeof PX.getPreset === 'function');
assert('aliases map standard', PX.presetAliases.standard === 'pixel-art-fixer');
assert('aliases map precise', PX.presetAliases.precise === 'pixel-art-fixer-full');
assert('standard → pixel-art-fixer', PX.getPreset('standard') && PX.getPreset('standard').id === 'pixel-art-fixer');
assert('precise → pixel-art-fixer-full', PX.getPreset('precise') && PX.getPreset('precise').id === 'pixel-art-fixer-full');
assert('canonical id', PX.getPreset('pixel-perfecter') && PX.getPreset('pixel-perfecter').id === 'pixel-perfecter');
assert('unknown → null', PX.getPreset('nosuch') === null && PX.getPreset('') === null && PX.getPreset(null) === null);
assert('presets have no aliases', PX.presets.every(p => p.id !== 'standard' && p.id !== 'precise'));
assert('default preset exists', PX.getPreset('pixel-perfecter').config.detectors[0] === 'perfecter');

/* ---------- 3–5. bench + CLI (subprocess) ---------- */
section('legacy baseline bit-identical');
{
  const r = spawnNode(['tools/bench/run.js', '--method', 'legacy', '--compare', 'tools/bench/baseline-legacy.json']);
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 0) ok('legacy compare');
  else fail('legacy compare', 'exit ' + r.status);
}

section('pixel-perfecter synthetic regression (--min-hit 13)');
{
  const r = spawnNode(['tools/bench/run.js', '--method', 'pixel-perfecter', '--min-hit', '13']);
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 0) ok('pixel-perfecter min-hit 13');
  else fail('pixel-perfecter min-hit 13', 'exit ' + r.status);
}

section('unknown preset fails (no legacy fallback)');
{
  const r = spawnNode(['tools/bench/run.js', '--method', 'nosuch']);
  const out = (r.stdout || '') + (r.stderr || '');
  assert('bench unknown exit 1', r.status === 1, 'exit ' + r.status);
  assert('bench unknown message', /找不到預設組合/.test(out), out.trim().split('\n')[0]);
}

section('CLI default + aliases');
{
  const { readPng, writePng } = require('./png.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixann-'));
  try {
    const rgba = Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const inp = path.join(tmp, 'in.png');
    fs.writeFileSync(inp, writePng(2, 2, rgba));
    const defOut = path.join(tmp, 'def.png');
    const r0 = spawnNode(['tools/pixelate-cli.js', inp, defOut]);
    if (r0.stderr) process.stderr.write(r0.stderr);
    assert('CLI default exit 0', r0.status === 0, (r0.stderr || '').trim());
    assert('CLI default canonical id', /preset=pixel-perfecter/.test(r0.stderr || ''), r0.stderr);
    const aliasOut = path.join(tmp, 'alias.png');
    const r1 = spawnNode(['tools/pixelate-cli.js', '--preset', 'standard', inp, aliasOut]);
    if (r1.stderr) process.stderr.write(r1.stderr);
    assert('CLI alias exit 0', r1.status === 0, (r1.stderr || '').trim());
    assert('CLI alias canonical id', /preset=pixel-art-fixer/.test(r1.stderr || ''), r1.stderr);
    const r2 = spawnNode(['tools/pixelate-cli.js', '--preset', 'nosuch', inp, path.join(tmp, 'x.png')]);
    const err2 = (r2.stdout || '') + (r2.stderr || '');
    assert('CLI unknown exit 1', r2.status === 1, 'exit ' + r2.status);
    assert('CLI unknown lists names', /有效名稱/.test(err2) && /pixel-perfecter/.test(err2), err2.trim().split('\n').slice(0, 2).join(' | '));
    if (fs.existsSync(defOut)) {
      const got = readPng(fs.readFileSync(defOut));
      assert('CLI wrote png', got.w >= 1 && got.h >= 1 && got.rgba.length === got.w * got.h * 4);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------- 6. RLE / PNG round-trip ---------- */
section('RLE / PNG round-trip');
global.window = global.window || global;
require(path.join(ROOT, 'js/codec.js'));
{
  const g = new Int16Array(64);
  g[3] = 1; g[4] = 1; g[5] = 1; g[40] = 2;
  const packed = PA.codec.packGrid(g);
  const u = PA.codec.unpackGrid(packed, 64);
  assert('RLE pack prefix', typeof packed === 'string' && packed.startsWith('rle1:'));
  assert('RLE round-trip', !!u && u.length === 64 && [...u].every((v, i) => v === g[i]));
  const { readPng, writePng } = require('./png.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixann-png-'));
  try {
    const rgba = Uint8ClampedArray.from([10, 20, 30, 255, 40, 50, 60, 128, 0, 0, 0, 0, 255, 255, 255, 255]);
    const p = path.join(tmp, 't.png');
    fs.writeFileSync(p, writePng(2, 2, rgba));
    const got = readPng(fs.readFileSync(p));
    assert('PNG round-trip size', got.w === 2 && got.h === 2 && got.rgba.length === 16);
    assert('PNG round-trip pixels', [...got.rgba].every((v, i) => v === rgba[i]));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------- 7. 保存清除（記憶體 localStorage / IndexedDB） ---------- */
section('clearSaved (memory localStorage / IndexedDB)');
{
  const ls = (() => {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: k => { m.delete(String(k)); },
      clear: () => m.clear(),
      key: i => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
  })();
  function memoryIDB() {
    const dbs = new Map();
    const later = fn => queueMicrotask(() => queueMicrotask(fn));
    return {
      open(name) {
        if (!dbs.has(name)) dbs.set(name, new Map());
        const data = dbs.get(name);
        const r = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
        later(() => {
          const db = {
            objectStoreNames: { contains: n => data.has(n) },
            createObjectStore(n) { data.set(n, new Map()); return {}; },
            transaction(storeName) {
              if (!data.has(storeName)) data.set(storeName, new Map());
              const map = data.get(storeName);
              const tx = { oncomplete: null, onerror: null, onabort: null };
              tx.objectStore = () => ({
                put(val, key) { map.set(key, val); },
                delete(key) { map.delete(key); },
                clear() { map.clear(); },
                get(key) {
                  const g = { result: map.get(key), onsuccess: null, onerror: null };
                  later(() => { if (g.onsuccess) g.onsuccess({ target: g }); });
                  return g;
                },
                getAllKeys() {
                  const g = { result: [...map.keys()], onsuccess: null, onerror: null };
                  later(() => { if (g.onsuccess) g.onsuccess({ target: g }); });
                  return g;
                },
              });
              later(() => { if (tx.oncomplete) tx.oncomplete(); });
              return tx;
            },
          };
          r.result = db;
          if (r.onupgradeneeded) r.onupgradeneeded({ target: r });
          if (r.onsuccess) r.onsuccess({ target: r });
        });
        return r;
      },
    };
  }
  if (typeof ImageData === 'undefined') {
    global.ImageData = class ImageData {
      constructor(data, w, h) {
        if (data instanceof Uint8ClampedArray) {
          this.data = data; this.width = w; this.height = h || data.length / 4 / w;
        } else {
          this.width = data; this.height = w;
          this.data = new Uint8ClampedArray(this.width * this.height * 4);
        }
      }
    };
  }
  global.window = global;
  global.localStorage = ls;
  global.indexedDB = memoryIDB();
  if (!global.addEventListener) global.addEventListener = () => {};
  require(path.join(ROOT, 'js/store.js'));
  const store = PA.store;
  ls.setItem('pixann', '{"v":1}');
  ls.setItem('pixann.v2', '{"v":2}');
  ls.setItem('pixann.v2.stale', '1');
  (async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('pixann', 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('bitmaps')) r.result.createObjectStore('bitmaps');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('bitmaps', 'readwrite');
      tx.objectStore('bitmaps').put({ w: 1, h: 1, rgba: new ArrayBuffer(4) }, 'x');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    const r = await store.clearSaved();
    assert('clearSaved ok', r.ok, r.reason);
    assert('removed pixann', ls.getItem('pixann') == null);
    assert('removed pixann.v2', ls.getItem('pixann.v2') == null);
    assert('removed stale', ls.getItem('pixann.v2.stale') == null);
    const keys = await new Promise((res, rej) => {
      const tx = db.transaction('bitmaps', 'readonly');
      const g = tx.objectStore('bitmaps').getAllKeys();
      g.onsuccess = () => res(g.result || []);
      g.onerror = () => rej(g.error);
    });
    assert('idb bitmaps cleared', keys.length === 0, 'left ' + keys.length);

    /* persistence controller: clear then flushSync must not rewrite */
    global.document = { addEventListener() {}, hidden: false };
    require(path.join(ROOT, 'js/ui/persistence.js'));
    let writes = 0;
    const fakeStore = {
      persist: async () => { writes++; return { ok: true }; },
      save: () => { writes++; return { ok: true }; },
      clearSaved: async () => ({ ok: true }),
      onForeignSave: () => {},
      has: () => true,
      hasAnnotation: () => true,
    };
    const p = PA._ui.createPersistence({
      store: fakeStore, S: { imgs: [{}] }, toast() {}, updateStatus() {},
    });
    p.markDirty();
    const cr = await p.clear();
    assert('persistence.clear ok', cr.ok);
    const before = writes;
    p.flushSync();
    assert('flushSync after clear does not save', writes === before, 'writes ' + writes);
    p.markDirty();
    p.flush();
    await new Promise(r => setTimeout(r, 20));
    assert('markDirty after clear resumes save', writes > before, 'writes ' + writes);

    const tick = () => new Promise(r => setTimeout(r, 0));
    function gatedStore() {
      const events = [];
      const pending = [];
      return {
        events,
        pending,
        persist() {
          events.push('persist');
          return new Promise(resolve => {
            pending.push(() => { events.push('persist-end'); resolve({ ok: true }); });
          });
        },
        save() { events.push('save'); return { ok: true }; },
        clearSaved: async () => { events.push('clearSaved'); return { ok: true }; },
        onForeignSave() {},
        has: () => true,
        hasAnnotation: () => true,
      };
    }
    function noWriteAfterClear(events, label) {
      const i = events.indexOf('clearSaved');
      assert(label + ' did clear', i >= 0, events.join(','));
      const after = events.slice(i + 1).filter(e => e === 'persist' || e === 'persist-end' || e === 'save');
      assert(label + ' no rewrite after clear', after.length === 0, events.join(','));
    }

    {
      const g = gatedStore();
      const ctl = PA._ui.createPersistence({
        store: g, S: { imgs: [{}] }, toast() {}, updateStatus() {},
      });
      ctl.markDirty();
      ctl.flush();
      await tick();
      assert('in-flight persist started', g.pending.length === 1, 'pending ' + g.pending.length);
      let settled = false;
      const done = ctl.clear().then(r => { settled = true; return r; });
      await tick();
      assert('in-flight clear waits', !settled && !g.events.includes('clearSaved'), g.events.join(','));
      g.pending[0]();
      await done;
      noWriteAfterClear(g.events, 'in-flight');
    }

    {
      const g = gatedStore();
      const ctl = PA._ui.createPersistence({
        store: g, S: { imgs: [{}] }, toast() {}, updateStatus() {},
      });
      ctl.markDirty();
      ctl.flush();
      ctl.markDirty();
      ctl.flush();
      await tick();
      assert('queued second persist not started', g.pending.length === 1, 'pending ' + g.pending.length);
      g.pending[0]();
      await tick();
      assert('queued persist started after first', g.pending.length === 2, 'pending ' + g.pending.length);
      let settled = false;
      const done = ctl.clear().then(r => { settled = true; return r; });
      await tick();
      assert('queued clear waits', !settled && !g.events.includes('clearSaved'), g.events.join(','));
      g.pending[1]();
      await done;
      noWriteAfterClear(g.events, 'queued');
    }
  })().catch(err => {
    fail('clearSaved async', err && err.message ? err.message : String(err));
  }).then(() => afterAsync());
}

function afterAsync() {
  /* ---------- 8. 顏色 ---------- */
  section('part color normalization');
  const n = PA.store.normalizePartColor;
  assert('#rgb → #rrggbb', n('#AbC', '#000000') === '#aabbcc');
  assert('#rrggbb lower', n('#A1B2C3', '#000000') === '#a1b2c3');
  assert('illegal css keyword', n('red', '#e5484d') === '#e5484d');
  assert('illegal url', n('url(x)', '#e5484d') === '#e5484d');
  assert('illegal #gggggg', n('#gggggg', '#e5484d') === '#e5484d');
  assert('empty uses fallback', n('', '#46a758') === '#46a758');
  PA.codec.bitmapFromRgba = (w, h, rgba) => ({
    w, h, rgba, cvs: {
      getContext() { return { putImageData() {} }; },
      toDataURL() { return 'data:image/png;base64,'; },
    },
  });
  const bmp = { w: 2, h: 2, rgba: new Uint8ClampedArray(16), cvs: { getContext() { return { putImageData() {} }; } } };
  PA.store.addBitmap('color-test', bmp);
  PA.store.select(PA.store.state.imgs.length - 1);
  const applied = PA.store.applyAnnotation({
    w: 2, h: 2,
    parts: {
      names: { 1: '刃' },
      colors: { 1: 'javascript:alert(1)' },
      grid: [[1, 0], [0, 0]],
    },
  });
  assert('applyAnnotation no error', !applied.error, applied.error);
  assert('applyAnnotation warning', applied.warnings && applied.warnings.length > 0, JSON.stringify(applied.warnings));
  const part = PA.store.annot().parts.find(p => p.id === 1);
  assert('illegal import uses palette', part && part.color === PA.store.PART_PALETTE[0], part && part.color);
  PA.store.setPartColor(1, '#0F0');
  assert('setPartColor #rgb', PA.store.partById(1).color === '#00ff00');
  PA.store.setPartColor(1, 'not-a-color');
  assert('setPartColor illegal fallback', /^#[0-9a-f]{6}$/.test(PA.store.partById(1).color));

  /* ---------- 9. 靜態資源 + Worker 版本 ---------- */
  section('static assets + worker version');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\s(?:href|src)="((?!https?:|\/\/|#)[^"?]+\.(?:css|js))(?:\?[^"]*)?"/g)].map(m => m[1]);
  for (const rel of refs) {
    const p = path.join(ROOT, rel);
    assert('html ' + rel, fs.existsSync(p), 'missing');
  }
  const wk = fs.readFileSync(path.join(ROOT, 'js/pixelate-worker.js'), 'utf8');
  assert('worker uses location.search', /location\.search/.test(wk));
  const wkFiles = [...wk.matchAll(/'pixelate\/[^']+\.js'/g)].map(m => m[0].slice(1, -1));
  const algo = FILES.map(f => f.replace(/^js\//, ''));
  assert('worker file count', wkFiles.length === algo.length, wkFiles.length + ' vs ' + algo.length);
  for (let i = 0; i < algo.length; i++) {
    assert('worker ' + algo[i], wkFiles[i] === algo[i], (wkFiles[i] || '—') + ' ≠ ' + algo[i]);
  }
  for (const f of FILES) assert('algo file ' + f, fs.existsSync(path.join(ROOT, f)));
  const cliSrc = fs.readFileSync(path.join(ROOT, 'tools/pixelate-cli.js'), 'utf8');
  const benchSrc = fs.readFileSync(path.join(ROOT, 'tools/bench/run.js'), 'utf8');
  assert('CLI uses shared list', /pixelate-files/.test(cliSrc));
  assert('bench uses shared list', /pixelate-files/.test(benchSrc));

  section('special image names');
  runSpecialNameTests().catch(err => {
    fail('special names async', err && err.message ? err.message : String(err));
  }).then(() => {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  });
}

const SPECIAL_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

function specialSprite(name) {
  return {
    name, w: 4, h: 4,
    palette: [null, '#cc3333', '#33aa55'],
    pixels: [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 2, 2],
      [1, 1, 2, 2],
    ],
    parts: {
      names: { 1: 'body' },
      colors: { 1: '#e5484d' },
      grid: [
        [1, 1, 0, 0],
        [1, 1, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    },
  };
}

function assertNullDict(obj, label, own) {
  assert(label + ' null prototype', Object.getPrototypeOf(obj) === null);
  for (const k of SPECIAL_NAMES) {
    if (k === own) continue;
    assert(label + ' missing ' + k, obj[k] === undefined, typeof obj[k]);
  }
}

async function runSpecialNameTests() {
  const store = PA.store;
  const restoreP = () => new Promise(res => store.restore((ok, info) => res({ ok, info })));

  assert('hist toString not prototype', store.state.hist.toString === undefined);
  assert('ann constructor not prototype', store.state.ann.constructor === undefined);
  assert('sel hasOwnProperty not prototype', store.state.selByImg.hasOwnProperty === undefined);

  for (const name of SPECIAL_NAMES) {
    const { name: got, warning } = store.addDecoded(specialSprite(name));
    assert(name + ' name kept', got === name, got);
    assert(name + ' img.name', store.img().name === name, store.img().name);
    assert(name + ' no warning', !warning, warning);
    assertNullDict(store.state.ann, name + ' ann after import', name);
    assertNullDict(store.state.hist, name + ' hist after import');
    assertNullDict(store.state.selByImg, name + ' sel after import');
    const rec = store.annot();
    assert(name + ' annot record', !!(rec && rec.grid && Array.isArray(rec.parts)), typeof rec);
    assert(name + ' annot not function', typeof rec !== 'function');

    const id = store.addPart('arm');
    assert(name + ' addPart', typeof id === 'number' && id > 0, String(id));
    store.beginStroke('筆刷');
    store.brushAt(3, 3, id);
    store.endStroke();
    assert(name + ' painted', rec.grid[15] === id, String(rec.grid[15]));
    const h = store.state.hist[name];
    assert(name + ' history object', !!(h && Array.isArray(h.past) && h.past.length), typeof h);
    assertNullDict(store.state.hist, name + ' hist after stroke', name);
    assert(name + ' canUndo', store.canUndo());
    store.undoOnce();
    assert(name + ' undo', rec.grid[15] === 0, String(rec.grid[15]));
    assert(name + ' canRedo', store.canRedo());
    store.redoOnce();
    assert(name + ' redo', rec.grid[15] === id, String(rec.grid[15]));

    const exported = store.exportData();
    assert(name + ' export name', exported.name === name, exported.name);
    assert(name + ' export cell', exported.parts.grid[3][3] === id, JSON.stringify(exported.parts.grid[3]));

    const persisted = await store.persist();
    assert(name + ' persist', !!(persisted && persisted.ok), persisted && persisted.reason);
    const saved = JSON.parse(global.localStorage.getItem('pixann.v2'));
    assert(name + ' save v:2', saved.v === 2, String(saved.v));
    assert(name + ' save img name', saved.imgs.some(i => i.name === name));
    assert(name + ' save ann key', Object.entries(saved.ann).some(([k]) => k === name));
    assert(name + ' Object.prototype.past free', !Object.prototype.hasOwnProperty('past'));

    store.closeCurrent();
    assert(name + ' closed ann', store.state.ann[name] === undefined);
    assert(name + ' closed hist', store.state.hist[name] === undefined);
    assert(name + ' closed sel', store.state.selByImg[name] === undefined);
    assertNullDict(store.state.ann, name + ' ann after close');
    assertNullDict(store.state.hist, name + ' hist after close');
    assertNullDict(store.state.selByImg, name + ' sel after close');

    const reloaded = await restoreP();
    assert(name + ' restore ok', reloaded.ok);
    const idx = store.state.imgs.findIndex(i => i.name === name);
    assert(name + ' restore present', idx >= 0, String(idx));
    store.select(idx);
    assert(name + ' restore name', store.img().name === name, store.img() && store.img().name);
    assert(name + ' restore paint', store.annot().grid[15] === id, String(store.annot().grid[15]));
    assertNullDict(store.state.ann, name + ' ann after restore', name);
    store.closeCurrent();
    assert(name + ' closed after restore', store.state.ann[name] === undefined);
  }
}
