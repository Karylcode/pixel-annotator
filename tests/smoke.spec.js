const { test, expect } = require('@playwright/test');
const fs = require('fs');

const SPECIAL_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
const ANNOTATE_KEYS = ['b', 'w', 's', 'e', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'F2', 'Delete', 'h'];

function spriteJson(name) {
  return JSON.stringify({
    name,
    w: 4,
    h: 4,
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
  }, null, 2);
}

function listenForErrors(page) {
  const errors = [];
  page.on('pageerror', err => {
    errors.push('pageerror: ' + ((err && err.stack) || String(err)));
  });
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
  });
  return errors;
}

async function openBlank(page) {
  const errors = listenForErrors(page);
  await page.goto('/');
  await expect(page.locator('#card-paste')).toBeVisible();
  return errors;
}

async function importViaPaste(page, json) {
  await page.locator('#card-paste').click();
  await expect(page.locator('#m-text')).toBeVisible();
  await page.locator('#m-text').fill(json);
  await page.locator('#m-ok').click();
  await expect(page.locator('#wrapcv')).toBeVisible();
  await expect(page.locator('#modal')).toHaveClass(/hide/);
  await expect(page.locator('.toast.danger')).toHaveCount(0);
}

async function clickCell(page, x, y, w = 4, h = 4) {
  const box = await page.locator('#cv').boundingBox();
  expect(box, 'canvas bounding box').toBeTruthy();
  expect(box.width).toBeGreaterThan(8);
  await page.locator('#cv').click({
    position: {
      x: (x + 0.5) * box.width / w,
      y: (y + 0.5) * box.height / h,
    },
  });
}

async function exportJson(page) {
  await page.locator('#tabbtn-export').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#b-dl-json').click();
  const download = await downloadPromise;
  return JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
}

async function assertAnnotationHidden(page) {
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'draw');
  await expect(page.locator('body')).toHaveAttribute('data-annotate', 'off');
  await expect(page.locator('.grp-mode')).toBeHidden();
  await expect(page.locator('#dock .modesw')).toBeHidden();
  await expect(page.locator('#tabbtn-parts')).toBeHidden();
  await expect(page.locator('#tab-parts')).toBeHidden();
  await expect(page.locator('.railmini [data-tab="parts"]')).toBeHidden();
  for (const el of await page.locator('.m-annotate').all()) await expect(el).toBeHidden();
  await expect(page.locator('#st-left')).not.toContainText('已標註');
  await expect(page.locator('#st-left')).not.toContainText('部件');
  await expect(page.locator('#hud')).not.toContainText('部件');

  await page.locator('#b-file').click();
  await expect(page.locator('#menulayer .mi').first()).toBeVisible();
  await expect(page.locator('#menulayer')).not.toContainText('匯入標註');
  await expect(page.locator('#menulayer')).not.toContainText('標註');
  await expect(page.locator('#menulayer')).not.toContainText('部件');
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  await expect(page.locator('#keys')).toBeVisible();
  for (const el of await page.locator('#keys .ann-only').all()) await expect(el).toBeHidden();
  await expect(page.locator('#k-alt-hint')).toHaveText('吸取顏色');
  await page.keyboard.press('Escape');
}

async function visiblePageText(page) {
  return page.evaluate(() => globalThis.document.body.innerText);
}

async function assertNoInternalCopy(page) {
  const text = await visiblePageText(page);
  expect(text, text).not.toMatch(/標註/);
  expect(text, text).not.toMatch(/部件/);
  expect(text, text).not.toMatch(/parts\.grid/);
}

test('draw coverage undo redo export', async ({ page }) => {
  const errors = await openBlank(page);
  await importViaPaste(page, spriteJson('smoke4'));
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'draw');
  await expect(page.locator('.toolbtn[data-tool="draw"]').first()).toHaveClass(/on/);

  const before = await page.evaluate(() => PA.store.exportData());
  expect(before.pixels[0][2]).toBe(1);
  expect(before.parts.grid).toEqual([
    [1, 1, 0, 0],
    [1, 1, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  await clickCell(page, 2, 0);
  const painted = await page.evaluate(() => PA.store.exportData());
  expect(painted.pixels[0][2]).not.toBe(before.pixels[0][2]);
  expect(painted.parts.grid).toEqual(before.parts.grid);

  await page.locator('#b-undo').click();
  const undone = await page.evaluate(() => PA.store.exportData());
  expect(undone.pixels[0][2]).toBe(before.pixels[0][2]);
  expect(undone.parts.grid).toEqual(before.parts.grid);

  await page.locator('#b-redo').click();
  const redone = await page.evaluate(() => PA.store.exportData());
  expect(redone.pixels[0][2]).toBe(painted.pixels[0][2]);
  expect(redone.parts.grid).toEqual(before.parts.grid);

  const exported = await exportJson(page);
  expect(exported.name).toBe('smoke4');
  expect(exported.pixels[0][2]).toBe(painted.pixels[0][2]);
  expect(exported.parts.grid).toEqual(before.parts.grid);
  expect(exported.parts.names[1]).toBe('body');

  expect(errors, errors.join('\n\n')).toEqual([]);
});

test('annotation shortcuts stay in draw and keep grid', async ({ page }) => {
  const errors = await openBlank(page);
  await importViaPaste(page, spriteJson('keys4'));
  const before = await page.evaluate(() => Array.from(PA.store.annot().grid));
  await page.locator('#stage').click();
  for (const key of ANNOTATE_KEYS) await page.keyboard.press(key);
  await page.evaluate(() => {
    const d = globalThis.document;
    d.querySelector('.modesw [data-mode="annotate"]').click();
    d.querySelector('#tabbtn-parts').click();
    d.querySelector('[data-tool="brush"]').click();
  });
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'draw');
  const tool = await page.evaluate(() => PA.store.state.tool);
  expect(tool).toBe('draw');
  const after = await page.evaluate(() => Array.from(PA.store.annot().grid));
  expect(after).toEqual(before);
  expect(errors, errors.join('\n\n')).toEqual([]);
});

for (const { name, viewport } of [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  test(`annotation UI hidden (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors = await openBlank(page);
    await importViaPaste(page, spriteJson('hide-' + name));
    await assertAnnotationHidden(page);
    if (await page.locator('#d-panel').isVisible()) await page.locator('#d-panel').click();
    await page.locator('#tabbtn-images').click();
    await expect(page.locator('#imglist')).not.toContainText('已標註');
    await expect(page.locator('#imglist')).not.toContainText('部件');
    expect(errors, errors.join('\n\n')).toEqual([]);
  });
}

for (const name of SPECIAL_NAMES) {
  test('special name ' + name, async ({ page }) => {
    const errors = await openBlank(page);
    await importViaPaste(page, spriteJson(name));
    await expect(page.locator('#info')).toContainText(name);
    await expect(page.locator('#m-err')).toHaveText('');
    await expect(page.locator('.toast.danger')).toHaveCount(0);

    const before = await page.evaluate(() => PA.store.exportData());
    await clickCell(page, 2, 0);
    const exported = await exportJson(page);
    expect(exported.name).toBe(name);
    expect(exported.pixels[0][2]).not.toBe(before.pixels[0][2]);
    expect(exported.parts.grid).toEqual(before.parts.grid);

    expect(errors, errors.join('\n\n')).toEqual([]);
  });
}

test('annotationEnabled true restores annotate UI', async ({ page }) => {
  await page.route(/js\/ui\.js(?:\?|$)/, async route => {
    const res = await route.fetch();
    const body = await res.text();
    const next = body.replace('const annotationEnabled = false;', 'const annotationEnabled = true;');
    if (next === body) throw new Error('annotationEnabled flag not found in js/ui.js');
    await route.fulfill({
      status: res.status(),
      headers: { ...res.headers(), 'content-type': 'application/javascript; charset=utf-8' },
      body: next,
    });
  });
  const errors = listenForErrors(page);
  await page.goto('/');
  await expect(page.locator('#card-paste')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-annotate', 'on');
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'annotate');
  await expect(page.locator('.grp-mode')).toBeVisible();
  await expect(page.locator('.rail .modesw [data-mode="annotate"]')).toHaveClass(/on/);
  await expect(page.locator('.rail .toolbtn[data-tool="brush"]')).toHaveClass(/on/);
  await expect(page.locator('#tabbtn-parts')).toBeVisible();
  await expect(page.locator('#tabbtn-parts')).toHaveClass(/on/);
  await expect(page.locator('#tab-parts')).toBeVisible();
  await expect(page.locator('#tabbtn-colors')).not.toHaveClass(/on/);

  await importViaPaste(page, spriteJson('reopen4'));
  const before = await page.evaluate(() => Array.from(PA.store.annot().grid));
  expect(before[2]).toBe(0);
  await clickCell(page, 2, 0);
  const painted = await page.evaluate(() => Array.from(PA.store.annot().grid));
  expect(painted[2]).not.toBe(0);
  await page.locator('#b-undo').click();
  const undone = await page.evaluate(() => Array.from(PA.store.annot().grid));
  expect(undone).toEqual(before);
  expect(errors, errors.join('\n\n')).toEqual([]);
});

test('incompatible parts.grid uses public copy', async ({ page }) => {
  const errors = await openBlank(page);
  const bad = JSON.stringify({
    name: 'mismatch4',
    w: 4,
    h: 4,
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
      grid: [[1, 1, 0]],
    },
  });
  await importViaPaste(page, bad);
  await expect(page.locator('.toast.warn')).toContainText('附加資料');
  await assertNoInternalCopy(page);
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'draw');
  const before = await page.evaluate(() => PA.store.exportData().pixels[0][2]);
  await clickCell(page, 2, 0);
  const after = await page.evaluate(() => PA.store.exportData().pixels[0][2]);
  expect(after).not.toBe(before);
  expect(errors, errors.join('\n\n')).toEqual([]);
});

test('incompatible saved annotation restore uses public copy', async ({ page }) => {
  const errors = await openBlank(page);
  await importViaPaste(page, spriteJson('restore-mismatch'));
  const corrupted = await page.evaluate(async () => {
    await PA.store.persist();
    const p = JSON.parse(globalThis.localStorage.getItem('pixann.v2'));
    const name = Object.keys(p.ann)[0];
    p.ann[name].grid = [0];
    return JSON.stringify(p);
  });
  await page.addInitScript(data => {
    globalThis.localStorage.setItem('pixann.v2', data);
  }, corrupted);
  await page.reload();
  await expect(page.locator('#wrapcv')).toBeVisible();
  await expect(page.locator('#info')).toContainText('restore-mismatch');
  await expect(page.locator('.toast.warn')).toContainText('附加資料');
  await assertNoInternalCopy(page);
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'draw');
  const before = await page.evaluate(() => PA.store.exportData().pixels[0][2]);
  await clickCell(page, 2, 0);
  const after = await page.evaluate(() => PA.store.exportData().pixels[0][2]);
  expect(after).not.toBe(before);
  expect(errors, errors.join('\n\n')).toEqual([]);
});
