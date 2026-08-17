/* pixelate-worker — 偵測 / 重算在背景執行緒。由 pixelate.js 的 callAsync 啟動。 */
importScripts('pixelate.js');

self.onmessage = (e) => {
  const d = e.data;
  if (!d || d.id == null) return;
  const { id, op } = d;
  try {
    if (op === 'detect') {
      PA.pixelate.detectGridAsync(d.rgba, d.w, d.h, {
        onProgress: f => self.postMessage({ id, type: 'progress', f }),
        cancelled: () => false,
      }).then(result => self.postMessage({ id, type: 'done', result }))
        .catch(err => self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) }));
      return;
    }
    if (op === 'run') {
      const result = PA.pixelate.run(d.rgba, d.w, d.h, d.opts || {});
      const xfer = result.px && result.px.rgba ? [result.px.rgba.buffer] : [];
      self.postMessage({ id, type: 'done', result }, xfer);
      return;
    }
    if (op === 'score') {
      const small = PA.pixelate.resample(d.rgba, d.w, d.h, d.grid);
      const result = PA.pixelate.reconstructError(d.rgba, d.w, d.h, d.grid, small);
      self.postMessage({ id, type: 'done', result });
      return;
    }
    self.postMessage({ id, type: 'error', message: '未知操作：' + op });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
