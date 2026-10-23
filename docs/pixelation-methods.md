**English** | [繁體中文](pixelation-methods.zh-TW.md) · [Documentation index](README.md)

# Pixelation methods

Pixelation turns an upscaled "pixel-style" image back into one pixel per cell. Each method is a preset for the
same pipeline. Sources, licenses and the exact files ported are in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) (Traditional Chinese).

## Pipeline

detect → arbitrate → sample → reduce colors → dither → clean

- Detection and recomputation run in a Web Worker, so the interface does not freeze. When the worker can't
  start (for example under `file://`), the same code runs on the main thread.
- A progress bar shows the current stage. **取消** (Cancel) or closing the window stops the worker.
- Detected and manual grids are capped at 512 cells per side.

### Clean pixel art check

Frequency-based detectors can ruin pixel art that is already clean. In the author's test, a hand-drawn 100×100
sprite came out as 50×50, 25×25 or even 2×2. So before detection, every grid-detecting method except `legacy`
checks the input first:

- **Clean** means at most 512 colors, and at most 2% of neighboring pixel pairs in the anti-aliasing range.
- If every s×s block is one solid color (s from 2 to 64), the image is a whole-number upscale. The original size
  is restored exactly.
- Otherwise it is native pixel art and is kept 1:1 (up to 1024 px per side). You can still reduce colors,
  remove the background or dither.
- AI images, with tens of thousands of colors and 2–3% in-between tones, skip this and go to the detectors.

When detection finds no period at all, the image is also treated as native and handled 1:1.

## Methods

| ID | Menu label | Source | What it does |
|---|---|---|---|
| `pixel-art-fixer` | 三偵測器共識 | Pixel Art Fixer | Three independent detectors (autocorrelation comb, run-length soft GCD, shift self-similarity) reach a consensus. Two-stage reconstruction picks the colors. Old name: `standard`. |
| `pixel-art-fixer-full` | 全偵測器仲裁 | Pixel Art Fixer | Adds perfectPixel's FFT and pixel-perfecter, and turns on the original Stage 2 arbitration: variance contrast and round-trip reconstruction error. Slowest; for hard images. Old name: `precise`. |
| `perfectPixel` | FFT 主週期偵測 | perfectPixel | An FFT finds the main period of the gradient profile, then edge refinement aligns the grid. Fastest and most accurate for whole-number upscales. |
| `pixel-perfecter` (default) | 四路幾何偵測 | pixel-perfecter | Four sub-detectors (exact nearest-neighbor check, Canny projection, autocorrelation, phase-fold scan), scored by "contrast between cells / √variance inside a cell". Colors come from the dominant color. |
| `proper-pixel-art` | 霍夫格線偵測 | proper-pixel-art | A geometric route: Canny edges → morphological closing → axis-aligned Hough lines → clustering → trimmed median spacing. |
| `unfake.js` | 連續同色段偵測 + 清理層 | unfake.js | Same-color run lengths plus dominant-color sampling, with its cleanup layer: fill holes, remove specks, fix jaggies, binary alpha. |
| `spritegrid` | 幾何中位數取色 | spritegrid | Pixel Art Fixer's consensus grid; colors from the Weiszfeld geometric median. It resists outliers better than a per-channel median and snaps to a color already in the cell, so no new colors appear. |
| `PixelOE` | 輪廓感知降採樣 | PixelOE | No grid detection; you set the target width. Outline expansion keeps 1 px lines, then contrast-aware downscaling in LAB space (lightness from local extremes, chroma from the median). |
| `Image-to-Pixel` | 指定寬度 + 抖色 | Image-to-Pixel | No grid detection; you set the target width. Reduces colors, then dithers (Floyd–Steinberg by default). |
| `legacy` | 本工具原版引擎 | this tool | The original difference-energy detector with center-median sampling. Kept as a regression baseline; its output is bit-identical to the version before the rewrite. |

The old names `standard` and `precise` still work in the CLI and the benchmark; output always shows the current
ID. Changing detectors or precise arbitration in the advanced section switches the menu to
**自訂組合** (custom).

## Stages

### Detectors

| ID | Label | Source | Idea |
|---|---|---|---|
| `autocorr` | 自相關 | Pixel Art Fixer | Autocorrelation comb minus anti-comb, with sub-harmonic suppression |
| `runlength` | Run-length | Pixel Art Fixer | Soft GCD of distances between edges |
| `selfsim` | 自相似 | Pixel Art Fixer | Shift self-similarity with multi-harmonic t statistics |
| `fft` | FFT | perfectPixel | Main period from an FFT |
| `perfecter` | pixel-perfecter | pixel-perfecter | Exact-NN, Canny projection, phase fold, contrast score |
| `hough` | 霍夫 | proper-pixel-art | Canny → closing → axis Hough → trimmed median spacing |
| `runs` | Runs | unfake.js | Same-color run lengths |
| `legacy` | legacy | this tool | Difference energy |

With more than one detector, a consensus and arbitration step (from Pixel Art Fixer) picks the grid.
**精確仲裁** (precise arbitration) also runs variance contrast and round-trip reconstruction error; it is slower.
`pixel-art-fixer-full` uses it and aims to finish within 20 seconds.

### Grid snapping (`legacy` only)

AI images can have very different local cell widths in different areas. On one test image, the face measured
35 px per cell while the whole image averaged 26 px. **自動吸附格線** (Snap grid lines) snaps each evenly
spaced grid line to a nearby edge, then adjusts each band so the grid can bend. It overwrites the grid that
other algorithms compute, so it is only available with `legacy`. There it turns on by itself when it lowers the
reconstruction error.

### Sampling

| ID | Label | Notes |
|---|---|---|
| `center-median` | 格心中位數 | Median of each cell's center |
| `two-stage` | 兩階段（結構／顏色） | Pixel Art Fixer: quantized labels vote on each cell's region, then the color is a center-weighted average of that region's original pixels |
| `dominant`, `mode`, `mean`, `median`, `qvote` | 眾數（5-bit 分箱）, 眾數, 平均, 中位數, 分位投票 | unfake.js cell statistics, with an edge trim setting |
| `geomedian` | 幾何中位數 | spritegrid's Weiszfeld geometric median |
| `pixeloe` | PixelOE 對比降採樣 | PixelOE contrast-aware downscaling |

### Color reduction

- **OKLab k-means** (default): weighted by the square root of each color's pixel count, so small but important
  colors such as eye highlights or feet are not eaten by a large background. Chroma counts double, so two colors
  with the same lightness but a different hue stay apart.
- **中位切割** (median cut).
- **不減色** (none).

The color limit defaults to 48; 0 turns reduction off.

### Dithering

Floyd–Steinberg, Bayer 2×2, Bayer 4×4, Ordered 8×8, Clustered 4×4 and Atkinson, from the vendored
Image-to-Pixel library, with a strength setting (default 50%). The adapter never calls Lospec's palette API, so
dithering makes no network request.

### Cleanup

**Background removal** is ported from [sprite-lab](https://github.com/boona13/sprite-lab) (MIT). It first
classifies the background, then handles each kind on its own:

- **Already transparent**: only removes leftover fringe.
- **Magenta or green screen**: chroma key, with spill removal.
- **Fake transparency checkerboard**: finds the checkerboard's two greys, flood-fills from the border, then peels
  checkerboard-colored fringe off the character's edge ring by ring. Shadows darker than the checkerboard are
  kept.
- **Solid color**: flood-fills from the average of the four corners.

Flood fills always start from the image border, so same-colored areas inside the character (a white skirt,
silver armor, a sword blade) are not touched. Three deliberate changes from upstream: mid-grey checkerboards like
ChatGPT exports are detected too; partial alpha matting is left out, because the output alpha is only 0 or 255;
and small neutral islands are not removed, because on an 80×80 sprite that would eat white highlights.

The other four cleanups come from unfake.js: **補洞** fills single-cell holes, **去雜點** removes isolated
specks, **修鋸齒** smooths jagged diagonals, and **Alpha 二值** makes every pixel fully transparent or fully
opaque.

## Test results

> Synthetic tests only measure specific grid-reconstruction cases. They do not rank overall quality on real AI
> images. The default method is chosen by hand-testing real images; it is currently `pixel-perfecter`.
>
> The 24 synthetic cases (`node tools/bench/run.js --method <preset>`) are a regression guard, not a way to pick
> a model automatically. For `pixel-perfecter`, CI only checks the synthetic threshold `--min-hit 13`.

| Preset | Cell count within ±1 | Notes |
|---|---|---|
| `legacy` | 7/24 (29.2%) | Bit-identical to the version before the rewrite |
| `pixel-art-fixer` (old name `standard`) | 22/24 (91.7%) | Fixer three-detector consensus |
| `pixel-art-fixer-full` (old name `precise`) | 23/24 (95.8%) | Adds variance contrast and reconstruction error |
| `pixel-perfecter` (default) | 13/24 (54.2%) | Four-way geometric detection; chosen as default by hand-testing real images |

The cases are 24×24 and 32×32 sprites, scattered and blocky, upscaled by whole and fractional factors, some
smoothed and some blurred. The case generator is `tools/bench/gen.js`.

### pixel-bench proxy

The official [pixel-bench](https://github.com/Retro-Diffusion/pixel-bench) needs your own set of at least 50
native 1× pixel-art images. It calls the CLI as a subprocess; see [Development](development.md#cli). Until that
set is ready, the same 24 cases stand in for its four metrics (higher is better, except ΔE):

| Metric (pixel-bench name) | `pixel-art-fixer` | `legacy` |
|---|---|---|
| resolution `within1` | 91.7% | 29.2% |
| color mean ΔE (hit cases, no extra color reduction) | See the bench output; close to 0 for whole-number upscales without blur | Same (hit cases) |
| placement `pixel_match` (hit, no blur) | Close to 100% (center median / two-stage) | Same |
| `grid_align` (hit cases, \|sx−f\|/f) | Mostly < 1% | Often lands on a harmonic |
