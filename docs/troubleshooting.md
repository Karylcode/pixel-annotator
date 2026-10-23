**English** | [繁體中文](troubleshooting.zh-TW.md) · [Documentation index](README.md)

# Troubleshooting

Messages in the app are in Traditional Chinese. They are quoted here as they appear.

## Pixelation

- **Wrong grid size**: try another method; each one detects differently. Click a detector's row in the vote
  table to use its grid, or set the cell count, cell width and offset under **手動調整格數／格寬／偏移**.
  See [Pixelation methods](pixelation-methods.md).
- **"這已經是原生像素圖" (already native pixel art) or "將以 1:1 處理" (handled 1:1)**: the image is clean
  pixel art, or no grid period was found, so it is kept at its size. You can still reduce colors, remove the
  background or dither. If it really is upscaled, set the grid by hand or try `legacy`, which skips this check.
- **Small details or colors are lost**: raise **顏色上限** (color limit), or set it to 0 to skip color reduction.
- **Background removal took part of the sprite or left a fringe**: turn off **移除背景** (Remove background) and
  compare the result.
- **自動吸附格線 (Snap grid lines) is greyed out**: it only works with the `legacy` method. Other methods compute
  their own grid lines, and snapping would overwrite them.
- **Pixelation is slow**: `pixel-art-fixer-full` is the slowest method; click **取消** (Cancel) and pick another.
  For whole-number upscales, `perfectPixel` is the fastest. Opened from `file://`, pixelation runs on the main
  thread; use the live demo or a local server ([Installation](installation.md#run-a-local-copy)).
- **"剪貼簿裡沒有圖片" (no image on the clipboard)** in the pixelate window: copy an image first, or use
  **選擇圖片…** (choose image).

## Opening and importing

- **"圖片太大" (image too large)**: the limit is 16384 px on a side and 40 megapixels. Shrink the image first.
- **"無法取得圖片尺寸（向量圖請先轉成 PNG）"**: the browser could not get a size, which happens with vector images.
  Convert to PNG first.
- **Dropping a `.json` file does nothing**: drag and drop only takes images. Open the file, copy its text and
  paste it with `Ctrl+V` or **檔案 → 貼上 JSON / JS…**.
- **The paste window shows an error**: the message names the problem, and syntax errors include the line
  ("第 N 行附近"). Check the shape against [Export formats](export-formats.md#import). Sizes must be 1–512 per
  side, and numeric `pixels` need a `palette`.
- **"附加資料…不符，已略過" (extra data does not match, skipped)**: the image loaded, but the `parts` data had the
  wrong size and was dropped.

## Export

- **JSON and JS are disabled ("圖片大於 64×64")**: they only work for images up to 64×64. Crop or pixelate first.
- **A PNG scale button is disabled ("放大後超過記憶體上限")**: that scale would pass 16384 px on a side or
  40 megapixels. Pick a smaller one.
- **ZIP is disabled**: it needs two or more open images.
- **"複製圖片失敗" (copying the image failed)**: the browser did not allow writing an image to the clipboard.
  Download the PNG instead.
- **"PNG 編碼失敗（記憶體不足），未放進 zip"**: the browser ran out of memory for some images. Export them on their
  own, or at a smaller scale.

## Saving

- **"瀏覽器儲存空間不足" (browser storage is full)**: later changes are not autosaved. Download a JSON backup, or
  close images you don't need.
- **"未能保存到瀏覽器" (could not save to the browser)**: download a JSON backup.
- **"另一個分頁保存了較新的資料" (another tab saved newer data)**: this tab paused autosave so the two tabs don't
  overwrite each other. Click **以這個分頁為準** (use this tab) to take over, or keep working in the other tab.
- **"已還原 … 保存的版本" (restored the version saved at …)**: an earlier session ran out of storage, so the
  changes after that time were not saved.
- **"上次保存的資料已損毀" (saved data was damaged)**: it could not be restored and has been cleared.
- **"有 N 張圖無法還原" (N images could not be restored)**: those images are missing from the saved data. Open
  them again.
- **Start fresh**: **檔案 → 清除瀏覽器裡的保存資料…** deletes the saved copy. Open images stay open.

## Display

- **The page looks broken right after an update**: GitHub Pages lets browsers cache CSS and JS for up to 10
  minutes. Reload after a short wait, or force a reload.
