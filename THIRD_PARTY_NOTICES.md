# 第三方演算法出處

本專案（MIT，Karylcode 2026）移植或 vendor 了下列開源實作。產品程式碼不含 GPL 減色庫、不含任何 `.wasm`。

## 授權全文

### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Apache License 2.0

完整條款見 https://www.apache.org/licenses/LICENSE-2.0 。摘要：可重製、修改、散布，須保留著作權與授權聲明；本專案對 PixelOE 的移植標示如下。

---

## Pixel Art Fixer

- URL：https://github.com/Retro-Diffusion/pixel-art-fixer
- commit：`ef376e57e1c272633ca2dbf5f29ec3fcf6596465`
- 授權：MIT（Copyright (c) 2026 Astropulse, LLC）
- 我們移植：`autocorr.py` → `js/pixelate/detect/autocorr.js`；`runlengths.py` → `detect/runlength.js`；`selfsim.py` → `detect/selfsim.js`；`core.py` 共識／仲裁 + `varcontrast.py` / `reconsearch.py` → `detect/arbitrate.js`；`reconstruct.py` → `sample/two-stage.js`

## pixel-bench

- URL：https://github.com/Retro-Diffusion/pixel-bench
- 授權：MIT
- 只當測試工具，不進產品。CLI 接入口徑：`tools/pixelate-cli.js`

## perfectPixel

- URL：https://github.com/theamusing/perfectPixel
- 授權：MIT
- 我們移植：FFT 主週期偵測 → `js/pixelate/detect/fft.js`

## pixel-perfecter

- URL：https://github.com/alexkorol/pixel-perfecter
- 授權：MIT
- 我們移植：exact-NN、Canny 投影 mesh、對比評分 → `js/pixelate/detect/perfecter.js`；形態學／Canny 輔助 → `js/pixelate/lib/morph.js`、`lib/canny.js`

## proper-pixel-art

- URL：https://github.com/KennethJAllen/proper-pixel-art
- 授權：MIT
- 經 pixel-perfecter 的 Canny→投影→分群鏈一併致謝；未直接複製其原始碼。

## unfake.js

- URL：https://github.com/jenissimo/unfake.js
- 授權：MIT（僅 JS／Rust 原始碼；**不使用其 wasm 產物**）
- 我們移植：runs 尺度 → `js/pixelate/detect/runs.js`；五種格內統計 → `sample/stats.js`；形態學／鋸齒／alpha 清理 → `clean/morph.js`

## PixelOE

- URL：https://github.com/KohakuBlueleaf/PixelOE
- commit：`341aa85048338d4d26c62fba23176e2b70d9f61b`
- 授權：Apache-2.0（Copyright 2024 KohakuBlueLeaf）
- 我們移植：`src/pixeloe/legacy/outline.py` 與 `downscale/contrast_based.py`（numpy/cv2 路線，不碰 torch）→ `js/pixelate/sample/pixeloe.js`

## spritegrid

- URL：https://github.com/marksverdhei/spritegrid
- commit：`64ab6f38b914d8e4bc7db681a541c898b876a1b1`
- 授權：MIT
- 我們移植：`src/spritegrid/utils.py` `geometric_median`（Weiszfeld）→ `js/pixelate/sample/geomedian.js`

## Image-to-Pixel

- URL：https://github.com/Tezumie/Image-to-Pixel
- commit：`b0d5b7422db309dae22c2a69d4ebca0ce8c14b78`
- 授權：函式庫檔 MIT（應用程式部分為 Apache-2.0，未納入）
- 我們 vendor 原檔：`js/vendor/image-to-pixel.js`；抖色 adapter：`js/pixelate/dither/adapter.js`（Worker／Node 走與 vendor 相同的備援核，不呼叫 Lospec 網路 API）

## sprite-lab

- URL：https://github.com/boona13/sprite-lab
- commit：`ed666b4d4d5f520056261c37e6b6a4a733d24b85`
- 授權：MIT（Copyright (c) 2026 Sprite Lab contributors）
- 我們移植 → `js/pixelate/clean/bg.js`：
  - `src/core/analyzeBackground.ts` 的 `analyzeBackgroundFromRgba` / `borderHasCheckerPattern` / `borderIsSolidLight`
  - `src/edgeCleanup.ts` 的 `detectCheckerColors` / `matchesChecker` / `foregroundAffinity` /
    `isCheckerFringePixel` / `shouldExpandCheckerPixel` / `peelCheckerFringeInPlace` /
    `removeCheckerboardInPlace` / `defringeInPlace`
  - `src/core/chromaKey.ts` 的 `chromaKeyInPlace`（含 despill 與 `GREEN_KEY`）
  - `src/core/floodFill.ts` 的 `floodFillRemoveBackground`（四角平均色、角落色差 < 24、容差 78）
- 我們對上游的三處刻意差異（`js/pixelate/clean/bg.js` 檔頭有完整說明）：
  1. 新增 `borderHasTwoToneNeutral()`。上游的棋盤判定寫死「白（max>225）+ 淺灰」，
     認不出 ChatGPT 匯出的 128／190 中灰棋盤，會誤判成 solid 而只清掉一半背景。
  2. 不移植 `refineEdgeMatteInPlace()`（反鋸齒 alpha matting）——本工具輸出 alpha 只有 0/255。
  3. 不移植 `removeNeutralIslandsInPlace()`——其面積上限在 80×80 的像素圖上會吃掉白色高光。
