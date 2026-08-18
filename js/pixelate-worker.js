/* pixelate-worker — 偵測 / 重算在背景執行緒。由 pixelate/index.js 的 callAsync 啟動。 */
importScripts(
  'pixelate/lib/colour.js',
  'pixelate/lib/profile.js',
  'pixelate/lib/fft.js',
  'pixelate/lib/morph.js',
  'pixelate/lib/canny.js',
  'pixelate/grid.js',
  'pixelate/detect/legacy.js',
  'pixelate/detect/autocorr.js',
  'pixelate/detect/runlength.js',
  'pixelate/detect/selfsim.js',
  'pixelate/detect/fft.js',
  'pixelate/detect/perfecter.js',
  'pixelate/detect/runs.js',
  'pixelate/detect/arbitrate.js',
  'pixelate/sample/center-median.js',
  'pixelate/sample/two-stage.js',
  'pixelate/sample/stats.js',
  'pixelate/quant/oklab-kmeans.js',
  'pixelate/clean/bg.js',
  'pixelate/clean/morph.js',
  'pixelate/index.js'
);

self.onmessage = (e) => {
  const d = e.data;
  if (!d || d.id == null) return;
  const { id, op } = d;
  const progress = (f, info) => self.postMessage({
    id, type: 'progress', f,
    stage: info && info.stage, detectorId: info && info.detectorId,
  });
  try {
    if (op === 'detect') {
      PA.pixelate.detectGridAsync(d.rgba, d.w, d.h, {
        onProgress: f => progress(f),
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
    if (op === 'pipeline') {
      PA.pixelate.runPipeline(d.rgba, d.w, d.h, d.config || {}, {
        onProgress: progress,
        cancelled: () => false,
        tick: () => new Promise(r => setTimeout(r, 0)),
      }).then(result => {
        const xfer = result && result.px && result.px.rgba ? [result.px.rgba.buffer] : [];
        self.postMessage({ id, type: 'done', result }, xfer);
      }).catch(err => self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) }));
      return;
    }
    if (op === 'detectOne') {
      const def = PA.pixelate.get('detect', d.detectorId);
      if (!def) {
        self.postMessage({ id, type: 'error', message: '找不到偵測器：' + d.detectorId });
        return;
      }
      Promise.resolve(def.run(d.rgba, d.w, d.h, d.params || {}, {
        onProgress: f => progress(f, { stage: 'detect', detectorId: d.detectorId }),
        cancelled: () => false,
        tick: () => new Promise(r => setTimeout(r, 0)),
      })).then(result => self.postMessage({ id, type: 'done', result }))
        .catch(err => self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) }));
      return;
    }
    self.postMessage({ id, type: 'error', message: '未知操作：' + op });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
