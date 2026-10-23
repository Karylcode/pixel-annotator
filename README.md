**English** | [繁體中文](README.zh-TW.md)

# Pixel Annotator

[![CI](https://github.com/Karylcode/pixel-annotator/actions/workflows/check.yml/badge.svg)](https://github.com/Karylcode/pixel-annotator/actions/workflows/check.yml)
[![Pages](https://github.com/Karylcode/pixel-annotator/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/Karylcode/pixel-annotator/actions/workflows/pages/pages-build-deployment)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Pixel Annotator turns AI-generated "fake pixel art" back into real pixel art. You can then fix it up and crop it
on the canvas, and export assets a game can use directly. AI "pixel-style" images are really upscaled
high-resolution pictures: each "pixel" is 20-plus real pixels, the edges carry anti-aliasing gradients, and the
cell width even drifts from cell to cell. Such an image blurs in a game and can't be edited cell by cell.
Pixel Annotator is a static web page in plain HTML, CSS and JavaScript, with no runtime dependencies and no build
step. Open the page and use it: nothing to install, no sign-up, and your images stay in your browser the whole
time. They are never uploaded anywhere. The interface is in Traditional Chinese.

**Live demo:** https://karylcode.github.io/pixel-annotator/

## What it does

- **Pixelate AI images**: detects the grid period, turns each cell back into one pixel, and reduces colors in
  the OKLab color space. For example, a 1024×1024 AI image becomes a 32×32 sprite.
- **Ten methods**: ports of Pixel Art Fixer, perfectPixel, pixel-perfecter, proper-pixel-art, unfake.js,
  spritegrid, PixelOE and Image-to-Pixel, plus this tool's original engine (`legacy`). The default is
  `pixel-perfecter`. Advanced options swap the detectors, sampling, color reduction, dithering and cleanup.
- **Background removal** (ported from sprite-lab): tells transparent, magenta-screen, green-screen, fake
  checkerboard and solid backgrounds apart. Same-colored parts of the character are kept, and so are shadows
  darker than a checkerboard.
- **Draw and edit**: pencil (1–6 px), eyedropper, erase to transparent, crop with eight handles, and a mirror
  check that marks cells that break left-right symmetry.
- **Export**: PNG at 1×–32×, SVG, JSON, a JS module, or a ZIP of all open images.
- **Multiple images, undo, autosave**: switch images with tabs or the thumbnail strip, undo and redo with a
  history panel, and get your work back when you reopen the page.
- **Phone and tablet**: bottom toolbar, drawer panels and pinch zoom. Light and dark themes follow the system.
- **Private**: everything runs in your browser. No backend, no analytics, no network requests.

## Requirements

- A recent browser with Canvas 2D, Web Workers, IndexedDB, `Path2D`, and CSS `color-mix()` and `:has()`.
  CI runs the end-to-end tests in Chromium.
- Nothing to install for normal use: open the live demo, or open `index.html` from a copy of this repo.
- Node.js and npm only for the development checks (CI uses Node 22).

Details: [Installation](docs/installation.md).

## Quick start

1. Open the **[live demo](https://karylcode.github.io/pixel-annotator/)** (or download this repo and open
   `index.html` in your browser).
2. Drag an image onto the page, or click **✨ 像素化** (Pixelate) to process an AI image right away.
3. In the pixelate window, check the detected grid size, set **顏色上限** (color limit), then click
   **套用 ✓** (Apply).
4. In the right panel, open the **匯出** (Export) tab, pick a format and download.

Next: [Usage](docs/usage.md).

## Troubleshooting

- **Wrong grid size**: pick another method, click a detector's row in the vote table to use its grid, or set
  the cell count by hand under **手動調整格數／格寬／偏移** (manual adjustment).
- **JSON and JS export are disabled**: they only work for images up to 64×64. Crop or pixelate first.
- **Pixelation is slow when opened from `file://`**: it falls back to the main thread there. Use the live demo
  or a local server.
- **"Browser storage is full" warning**: later changes are not autosaved. Download a JSON backup or close
  images you don't need.

More: [Troubleshooting](docs/troubleshooting.md).

## Documentation

- [Documentation index](docs/README.md): all pages at a glance
- [Installation](docs/installation.md): online use, running a local copy, browser support, where data is stored
- [Usage](docs/usage.md): opening images, the pixelate window, drawing tools, undo, autosave, shortcuts
- [Pixelation methods](docs/pixelation-methods.md): the ten methods, pipeline stages, background removal,
  test results
- [Export formats](docs/export-formats.md): PNG, SVG, JSON, JS and ZIP, the data layout, import formats, limits
- [Troubleshooting](docs/troubleshooting.md): common problems and messages
- [Development](docs/development.md): npm scripts, CI, tests, benchmark, CLI, source layout

## License

MIT. See [LICENSE](LICENSE).

- Algorithm sources, their licenses and what was ported: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
  (Traditional Chinese).
