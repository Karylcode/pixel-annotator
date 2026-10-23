**English** | [繁體中文](usage.zh-TW.md) · [Documentation index](README.md)

# Usage

The interface is in Traditional Chinese. This page gives each label with an English gloss.

## Workflow

1. Open an image.
2. Click **✨ 像素化** (Pixelate) to turn an AI image into real pixel art.
3. Fix it up with the drawing tools and crop it.
4. Export it from the **匯出** (Export) tab.

## The screen

- **Header**: the **檔案 ▾** (File) menu, **✨ 像素化**, the current image name (click it to switch images when
  more than one is open), undo / redo / history, zoom, and **？** for the shortcut panel.
- **Left panel**: tools, tool options, **影像** (Image: crop and pixelate) and **檢視** (View: show the image,
  show the grid).
- **Right panel**: the **顏色** (Colors), **圖片** (Images) and **匯出** (Export) tabs. **⟨** or `Tab` collapses it.
- **Status bar** at the bottom, and a small label at the top-left of the canvas. Click the label for the quick
  menu.

## Open images

- Drag PNG, GIF, BMP, WebP or JPEG files anywhere on the page. You can drop several at once.
- **檔案 → 開啟圖片…** (File → Open image).
- `Ctrl+V` pastes an image from the clipboard.
- To load pixel data as text, click the **貼上 JSON / JS** card, use **檔案 → 貼上 JSON / JS…**, or press
  `Ctrl+V` with the text on the clipboard. `Ctrl+Enter` loads it. The formats are in
  [Export formats](export-formats.md#import).

Images can be up to 16384 px on a side and 40 megapixels. When a name is already taken, the new image gets a
`_` suffix.

## Pixelate

Click **✨ 像素化**. The window runs detection as soon as it opens; the preview shows the original until a
result is ready. You can also load a different image here: **選擇圖片…** (choose image), **貼上圖片** (paste image), `Ctrl+V`, or drag an
image into the window. It is added as a new image.

**① 來源** (Source) shows the image name, size and color count.

**② 格線** (Grid):

- **方法** (Method): pick one of the ten methods. **ⓘ** shows what it does and which project it comes from.
  The default is `pixel-perfecter`, and the window remembers your last choice. See
  [Pixelation methods](pixelation-methods.md).
- **目標寬度** (Target width), shown only for the PixelOE and Image-to-Pixel methods: the output width in cells,
  8–512, default 64.
- The status line shows the detected size, cell width and reconstruction error. Clean pixel art is recognized
  and kept 1:1, or reduced exactly when it is a whole-number upscale (all grid-detecting methods except
  `legacy`).
- The vote table lists each detector's cell count, cell width, confidence and status. ⚠ marks a detector that
  is more than one cell off the consensus. Click a row to use that detector's grid; click the
  **共識／仲裁** (consensus) row to go back.
- **手動調整格數／格寬／偏移** (Manual adjustment): cell count (2–512 per side), cell width and offset. The lock
  button keeps the original aspect ratio. **自動吸附格線** (Snap grid lines) only works with `legacy`.
  **重新偵測** (Detect again) reruns detection.

**③ 顏色** (Color):

- **顏色上限** (Color limit): default 48, 0 = no reduction. The maximum is the source's color count, up to 256.
- **減色** (Reduction): OKLab k-means, median cut, or none.
- **抖色** (Dithering): none, Floyd–Steinberg, Bayer 2×2, Bayer 4×4, Ordered 8×8, Clustered 4×4 or Atkinson,
  with a strength slider.

**④ 清理** (Cleanup): **移除背景** (Remove background, on by default), **補洞** (fill holes), **去雜點** (remove
specks), **修鋸齒** (fix jaggies) and **Alpha 二值** (make alpha fully on or off).

**進階：取樣與偵測器** (Advanced: sampling and detectors) changes the sampler, the detectors and
**精確仲裁** (precise arbitration). Changing detectors switches the method to **自訂組合** (custom).

**比對原圖** (Compare) lays the original over the result; drag the slider below to compare them. A progress bar
with **取消** (Cancel) appears during long runs.

**套用 ✓** (Apply) replaces the current image with the result. A notice with an undo button follows.

## Draw and edit

| Tool | Key | What it does |
|---|---|---|
| **繪圖** (Draw) | `D` | Paints with the foreground color |
| **滴管** (Eyedropper) | `I` | Picks a color from the canvas |
| **擦成透明** (Erase to transparent) | `X` | Clears pixels to transparent |
| **裁切** (Crop) | `C` | Keeps a rectangle of the image |

- Brush size is 1–6 px. `[` and `]` make it smaller or larger.
- `Shift`+click draws a straight line from the last point.
- `Alt`+click picks a color without switching tools.
- **鏡射差異** (Mirror difference) marks cells that differ from their mirror image with magenta stripes. Drag
  the dashed axis on the canvas, type its position (it can end in .5, on a grid line), or click **⌖** to find
  the most symmetric axis.
- **Crop**: drag one of the eight handles to resize, drag inside the box to move it, or drag outside to start a
  new box. The crop bar takes exact **X**, **Y**, **寬** (width) and **高** (height) values; **全選** selects the
  whole image. `Enter` applies, `Esc` cancels.

## Colors

The **顏色** tab holds the foreground color (picker plus an editable hex code), the previous color with a swap
button, the image palette and recently used colors. The image palette lists the colors in the current image.
Above 48 colors, it picks the 48 that differ most from each other instead of filling up with near-identical
greys.

## Multiple images

Several images can be open at once. Switch between them in the **圖片** (Images) tab, in the thumbnail strip
(shown with two or more images; it can be collapsed), or from the image name in the header. Close an image with
**檔案 → 關閉圖片…** or the × on its thumbnail.

## Undo and history

- `Ctrl+Z` undoes; `Ctrl+Shift+Z` or `Ctrl+Y` redoes.
- **▾** next to the undo buttons, or a right-click on ↶ ↷, opens the history panel. Click an entry to jump
  several steps at once.
- Each image keeps up to 60 steps within a memory budget.
- Crop and pixelate show a notice with an undo button for at least 6 seconds.

## Autosave

Your images and edits are saved in this browser and restored the next time you open the page. If another tab
saves newer data, this tab pauses autosave so the two don't overwrite each other; click
**以這個分頁為準** (use this tab) to take over. Details are in [Installation](installation.md#where-your-data-goes).

## Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `D` `I` `X` | Draw / eyedropper / erase to transparent | `Ctrl+Z` | Undo |
| `C` | Crop (`Enter` applies, `Esc` cancels) | `Ctrl+Shift+Z`, `Ctrl+Y` | Redo |
| `[` `]` | Smaller / larger brush | `Alt`+click | Pick a color |
| `+` `-` `0` | Zoom in / out / fit to window | `Shift`+click | Straight line from the last point |
| `Space`+drag | Pan the canvas | `Ctrl`+wheel | Zoom around the cursor |
| `Tab` | Collapse / expand the right panel (when no control has focus) | `Ctrl+V` | Paste an image or JSON |
| `?` | Shortcut panel | `Esc` | Cancel, leave a text field |

## Mouse and touch

- Right-click opens the quick menu (tools, foreground color, crop, pixelate, fit). Right-drag or middle-drag
  pans.
- On screens 900 px wide or narrower, a bottom toolbar holds the tools, fit, **⋯** (tool options, image, view)
  and **▤** (colors, images, export). The panels open as drawers.
- On touch screens: drag with one finger on an empty area to pan, pinch with two fingers to zoom and pan, and
  double-tap an empty area to fit the image to the window. The main touch targets are at least 44 px.
- Light and dark themes follow your system setting. Controls have keyboard access and ARIA labels.
