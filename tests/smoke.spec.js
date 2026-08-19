const { test, expect } = require('@playwright/test');
const fs = require('fs');

const SPECIAL_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

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

test('annotate coverage undo redo export', async ({ page }) => {
  const errors = await openBlank(page);
  await importViaPaste(page, spriteJson('smoke4'));
  await expect(page.locator('#sum-text')).toContainText('已標註 25%');
  await expect(page.locator('#sum-text')).toContainText('4 / 16');
  await expect(page.locator('#parts .part')).toHaveCount(1);

  await page.locator('#newpart').fill('arm');
  await page.locator('#b-addpart').click();
  await expect(page.locator('#parts .part')).toHaveCount(2);

  await clickCell(page, 2, 0);
  await expect(page.locator('#sum-text')).toContainText('已標註 31%');
  await expect(page.locator('#sum-text')).toContainText('5 / 16');
  await expect(page.locator('#parts .part').nth(1).locator('.n')).toHaveText('1');

  await page.locator('#b-undo').click();
  await expect(page.locator('#sum-text')).toContainText('已標註 25%');
  await expect(page.locator('#sum-text')).toContainText('4 / 16');

  await page.locator('#b-redo').click();
  await expect(page.locator('#sum-text')).toContainText('已標註 31%');
  await expect(page.locator('#sum-text')).toContainText('5 / 16');

  await page.locator('#tabbtn-export').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#b-dl-json').click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const exported = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  expect(exported.name).toBe('smoke4');
  expect(exported.parts.grid[0][2]).toBe(2);

  expect(errors, errors.join('\n\n')).toEqual([]);
});

for (const name of SPECIAL_NAMES) {
  test('special name ' + name, async ({ page }) => {
    const errors = await openBlank(page);
    await importViaPaste(page, spriteJson(name));
    await expect(page.locator('#info')).toContainText(name);
    await expect(page.locator('#m-err')).toHaveText('');
    await expect(page.locator('.toast.danger')).toHaveCount(0);

    await page.locator('#newpart').fill('arm');
    await page.locator('#b-addpart').click();
    await expect(page.locator('#parts .part')).toHaveCount(2);
    await clickCell(page, 2, 0);
    await expect(page.locator('#sum-text')).toContainText('5 / 16');

    await page.locator('#tabbtn-export').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#b-dl-json').click();
    const download = await downloadPromise;
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    expect(exported.name).toBe(name);
    expect(exported.parts.grid[0][2]).toBe(2);

    expect(errors, errors.join('\n\n')).toEqual([]);
  });
}
