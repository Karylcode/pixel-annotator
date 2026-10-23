**English** | [繁體中文](installation.zh-TW.md) · [Documentation index](README.md)

# Installation

## Use it online

Open https://karylcode.github.io/pixel-annotator/. There is nothing to install and no account to create.
GitHub Pages serves the page straight from the `main` branch.

## Run a local copy

1. Download or clone this repo:

   ```bash
   git clone https://github.com/Karylcode/pixel-annotator.git
   ```

2. Open `index.html` in your browser.

Normal use needs no npm, bundler or build step.

Opening `index.html` straight from disk (`file://`) works, but pixelation then falls back to the main thread
instead of a Web Worker. It is slower and the page can lag while it runs. To keep the worker, serve the folder
over HTTP. With Node.js installed:

```bash
node tools/static-server.js
```

Then open http://127.0.0.1:4173. The `PORT` and `HOST` environment variables change the address. This small
server exists for development and the browser tests; the app itself does not depend on it. Any other static
file server works too.

## Browser support

The app uses Canvas 2D, Web Workers, IndexedDB, `Path2D`, and CSS `color-mix()` and `:has()`. The author's
target is Chrome, Edge, Firefox and Safari releases from the last two years. CI runs the end-to-end tests in
Chromium only.

On screens 900 px wide or narrower, the layout switches to a bottom toolbar and drawer panels.

## Where your data goes

Everything runs in your browser. There is no backend, no analytics and no network request. Your images never
leave your computer.

Autosave keeps your work in this browser:

- Bitmaps go to IndexedDB (database `pixann`).
- The `localStorage` key `pixann.v2` holds metadata and compressed working data. Keeping bitmaps out of it
  avoids the `localStorage` quota of about 5 MB.
- The `localStorage` key `pixann.px` remembers the last pixelation method and the aspect-ratio lock.

To delete the saved copy, use **檔案 → 清除瀏覽器裡的保存資料…** (File → Clear saved data in this browser).
Images that are open stay open; they are just not restored next time. Later changes are saved again.

## Development tools

Node.js and npm are only needed for lint, the check script and the browser tests. See
[Development](development.md).
