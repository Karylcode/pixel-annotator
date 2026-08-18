/* ui/export — 格式、倍率、單張與 ZIP 匯出。不得呼叫 PA.ui。 */
window.PA = window.PA || {};
PA._ui = PA._ui || {};

PA._ui.createExport = function(host) {
  const $ = id => host.$(id);
  const store = host.store, codec = host.codec, S = host.S;
  const toast = (...a) => host.toast(...a);
  const download = (...a) => host.download(...a);
  const copyText = (...a) => host.copyText(...a);

  const TEXT_FMT_MAX = 64;
  const textFmtOk = () => !store.has() ||
    (store.img().w <= TEXT_FMT_MAX && store.img().h <= TEXT_FMT_MAX);
  const TEXT_FMT_REASON = `圖片大於 ${TEXT_FMT_MAX}×${TEXT_FMT_MAX}，資料量太大 — 先裁切或像素化`;

  const PNG_MAX_SIDE = codec.BITMAP_MAX_SIDE, PNG_MAX_AREA = codec.BITMAP_MAX_AREA;
  const scaleFits = (im, s) => {
    const W = im.w * s, H = im.h * s;
    return W <= PNG_MAX_SIDE && H <= PNG_MAX_SIDE && W * H <= PNG_MAX_AREA;
  };
  let pngScale = 1;

  function syncExport() {
    const has = store.has();
    const ok = textFmtOk();
    for (const f of ['json', 'js']) {
      $(`x-${f}`).classList.toggle('off', !has || !ok);
      $(`${f}-reason`).textContent = has && !ok ? TEXT_FMT_REASON : '';
      $(`b-dl-${f}`).disabled = !has || !ok;
      $(`b-cp-${f}`).disabled = !has || !ok;
    }
    for (const f of ['png', 'svg']) {
      $(`x-${f}`).classList.toggle('off', !has);
      $(`b-dl-${f}`).disabled = !has;
      $(`b-cp-${f}`).disabled = !has;
    }
    const n = S.imgs.length;
    $('x-all').classList.toggle('off', n < 2);
    $('b-dl-all').disabled = n < 2;
    $('all-info').textContent = n < 2
      ? '開兩張以上圖片時，可以一次打包成 zip'
      : `${n} 張圖：每張的 PNG（目前倍率）+ JSON（≤${TEXT_FMT_MAX}×${TEXT_FMT_MAX} 才有）`;
    syncScale();
  }

  let exportingAll = false;
  async function doExportAll() {
    if (S.imgs.length < 2 || exportingAll) return;
    exportingAll = true;
    const btn = $('b-dl-all');
    btn.disabled = true; btn.textContent = '打包中…';
    try {
      const files = [], skipped = [];
      const enc = new TextEncoder();
      for (const im of S.imgs) {
        const s = scaleFits(im, pngScale) ? pngScale : 1;
        const big = codec.scaleBitmap(im, s);
        const blob = await new Promise(r => big.toBlob(r, 'image/png'));
        if (big !== im.cvs) big.width = big.height = 0;
        if (blob) files.push({ name: `${im.name}${s > 1 ? `@${s}x` : ''}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
        else skipped.push(im.name);
        if (im.w <= TEXT_FMT_MAX && im.h <= TEXT_FMT_MAX)
          files.push({ name: `${im.name}.json`, data: enc.encode(codec.toJson(codec.encode(im, S.ann[im.name]))) });
      }
      const stamp = new Date().toISOString().slice(0, 10);
      download(`pixel-export-${stamp}.zip`, codec.zip(files));
      if (skipped.length) toast(`有 ${skipped.length} 張圖的 PNG 編碼失敗（記憶體不足），未放進 zip：${skipped.join('、')}`, { kind: 'warn' });
    } catch (e) {
      toast('打包失敗：' + (e.message || e), { kind: 'danger' });
    } finally {
      exportingAll = false;
      btn.textContent = '下載';
      btn.disabled = S.imgs.length < 2;
    }
  }

  function syncScale() {
    const btns = [...$('scalesegs').querySelectorAll('button')];
    if (!store.has()) {
      btns.forEach(b => { b.disabled = true; });
      $('scaleout').textContent = '';
      return;
    }
    const im = store.img();
    btns.forEach(b => {
      const s = +b.dataset.s, fits = scaleFits(im, s);
      b.disabled = !fits;
      b.title = fits ? `${im.w * s}×${im.h * s}` : '放大後超過記憶體上限';
    });
    if (!scaleFits(im, pngScale)) {
      const usable = btns.map(b => +b.dataset.s).filter(s => scaleFits(im, s));
      pngScale = usable.length ? Math.max(...usable) : 1;
    }
    $('scaleout').textContent = `${im.w * pngScale}×${im.h * pngScale}`;
    btns.forEach(b => b.classList.toggle('on', +b.dataset.s === pngScale));
  }

  const pngBlob = () =>
    new Promise(r => codec.scaleBitmap(store.img(), pngScale).toBlob(r, 'image/png'));

  const EXPORTERS = {
    json: { ext: '.json', get: () => new Blob([codec.toJson(store.exportData())], { type: 'application/json' }) },
    js:   { ext: '.js',   get: () => new Blob([codec.toJs(store.exportData())], { type: 'text/javascript' }) },
    svg:  { ext: '.svg',  get: () => new Blob([codec.toSvg(store.img())], { type: 'image/svg+xml' }) },
  };

  async function doDownload(f) {
    if (!store.has()) return;
    const name = store.img().name;
    if (f === 'png') {
      const suffix = pngScale > 1 ? `@${pngScale}x` : '';
      return download(name + suffix + '.png', await pngBlob());
    }
    download(name + EXPORTERS[f].ext, EXPORTERS[f].get());
  }

  async function doCopy(f) {
    if (!store.has()) return;
    if (f === 'png') {
      try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw 0;
        const item = new ClipboardItem({ 'image/png': await pngBlob() });
        await Promise.race([
          navigator.clipboard.write([item]),
          new Promise((_, rej) => setTimeout(rej, 1500)),
        ]);
        toast('已複製 PNG 圖片', { kind: 'success' });
      } catch { toast('複製圖片失敗，請改用下載 PNG', { kind: 'warn' }); }
      return;
    }
    if (f === 'json') return copyText(codec.toJson(store.exportData()), '已複製 .json');
    if (f === 'js') return copyText(codec.toJs(store.exportData()), '已複製 .js');
    copyText(codec.toSvg(store.img()), '已複製 .svg');
  }

  function bind() {
    for (const f of ['png', 'svg', 'json', 'js']) {
      $(`b-dl-${f}`).onclick = () => doDownload(f);
      $(`b-cp-${f}`).onclick = () => doCopy(f);
    }
    $('b-dl-all').onclick = doExportAll;
    $('scalesegs').querySelectorAll('button').forEach(b => {
      b.onclick = () => { pngScale = +b.dataset.s; syncScale(); };
    });
  }

  return {
    TEXT_FMT_MAX, textFmtOk, TEXT_FMT_REASON, scaleFits,
    syncExport, syncScale, doExportAll, doDownload, doCopy, bind,
    get pngScale() { return pngScale; },
  };
};
