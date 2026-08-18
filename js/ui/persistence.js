/* ui/persistence — 自動保存、清除、跨分頁與 lifecycle。不得呼叫 PA.ui。 */
window.PA = window.PA || {};
PA._ui = PA._ui || {};

PA._ui.createPersistence = function(host) {
  const store = host.store, S = host.S;
  const toast = (...a) => host.toast(...a);
  const updateStatus = () => { if (host.updateStatus) host.updateStatus(); };

  const SAVE_DELAY = 800;
  let saveTimer = 0, quotaWarned = false, saveFlushing = null;
  let savePending = false;
  let saveState = 'ok';
  let clearing = false;
  let clearedUntilDirty = false;

  function applySaveResult(r) {
    if (r.ok) {
      saveState = 'ok'; quotaWarned = false;
    } else if (r.reason === 'foreign') {
      saveState = 'foreign';
    } else {
      saveState = 'fail';
      if (!quotaWarned) {
        quotaWarned = true;
        toast(r.reason === 'quota'
          ? '⚠ 瀏覽器儲存空間不足，這之後的變更不會自動保存 — 建議下載 JSON 備份，或關閉用不到的圖片'
          : '⚠ 未能保存到瀏覽器，建議下載 JSON 備份', { kind: 'warn', duration: 8000 });
      }
    }
    updateStatus();
  }

  function markDirty() {
    if (clearing) return;
    clearedUntilDirty = false;
    savePending = true;
    if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  function flush() {
    if (clearing || clearedUntilDirty) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    if (!savePending && !saveFlushing) return;
    savePending = false;
    const run = () => {
      if (clearing || clearedUntilDirty) return;
      return store.persist().then(applySaveResult, () => applySaveResult(store.save()));
    };
    const job = (saveFlushing || Promise.resolve()).then(run, run);
    saveFlushing = job;
    job.finally(() => { if (saveFlushing === job) saveFlushing = null; });
  }

  function flushSync() {
    if (clearing || clearedUntilDirty) {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      savePending = false;
      return;
    }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    savePending = false;
    applySaveResult(store.save());
  }

  async function clear() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    savePending = false;
    clearing = true;
    try {
      if (saveFlushing) {
        try { await saveFlushing; } catch (e) {}
      }
      savePending = false;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      const r = await store.clearSaved();
      if (r && r.ok) {
        clearedUntilDirty = true;
        saveState = 'ok';
      }
      return r || { ok: false, reason: 'error' };
    } finally {
      clearing = false;
    }
  }

  store.onForeignSave(() => {
    saveState = 'foreign';
    updateStatus();
    toast('另一個分頁保存了較新的資料，這個分頁已暫停自動保存，以免互相覆蓋。', {
      kind: 'warn', duration: 10000, action: '以這個分頁為準',
      onAction: () => { store.takeOver(); saveState = 'ok'; markDirty(); flush(); },
    });
  });

  window.addEventListener('pagehide', flushSync);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('beforeunload', e => {
    flushSync();
    if (saveState !== 'ok' && store.has() && (store.hasAnnotation() || S.imgs.length)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  return {
    markDirty, flush, flushSync, clear, applySaveResult,
    get saveState() { return saveState; },
    get savePending() { return savePending; },
    get clearing() { return clearing; },
  };
};
