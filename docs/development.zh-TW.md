[English](development.md) | **繁體中文** · [文件索引](README.zh-TW.md)

# 開發

執行時不依賴任何套件，也沒有建置流程：瀏覽器直接載入 `index.html`、`css/`、`js/`。
只有開發檢查（lint、回歸、瀏覽器煙霧測試）才需要 Node.js 和 npm。

## 準備

```bash
npm ci
npx playwright install chromium
```

## npm 指令

| 指令 | 內容 |
|---|---|
| `npm run lint` | ESLint 9（flat config）。只開 `no-undef` 規則；`js/vendor/` 不檢查。 |
| `npm run check` | `node tools/check.js`。純 Node，不需要任何 npm 套件。 |
| `npm run test:e2e` | 用 Chromium 跑 Playwright。會自動在 http://127.0.0.1:4173 啟動 `tools/static-server.js`。 |
| `npm test` | 依序跑上面三個。 |

`tools/check.js` 檢查：

- 每個 `.js` 檔的語法（`node --check`）
- preset 名稱解析，包含舊名
- `legacy` 的輸出與 `tools/bench/baseline-legacy.json` 逐位相同
- `pixel-perfecter` 的合成門檻（`--min-hit 13`）
- 未知的 preset 直接失敗，不會退回 `legacy`
- CLI 的預設值與舊名
- RLE 與 PNG 的來回轉換
- 清除保存資料（記憶體版 `localStorage` 與 IndexedDB）
- 附加資料 `parts` 的顏色正規化
- `index.html` 引用的每個 CSS、JS 檔都存在；Worker 載入的演算法檔案和 `tools/pixelate-files.js` 同名同順序
- `__proto__` 這類特殊圖片名稱

`tests/smoke.spec.js` 測試：繪圖、復原、重做和 JSON 匯出；隱藏的標註快捷鍵不會改到資料；
桌面與手機版面都看不到標註介面；特殊圖片名稱；把標註開關打開後介面能恢復；
匯入和還原時 `parts` 尺寸不符的提示。

## CI

`.github/workflows/check.yml` 在每次 push 和 pull request 時執行，環境是 Ubuntu、Node 22：
`npm ci`、lint、`npm run check`、安裝 Chromium，最後跑 E2E 測試。失敗時會上傳 `playwright-report/`。

## Benchmark

**合成測試**（24 例，由 `tools/bench/gen.js` 產生）：

```bash
node tools/bench/run.js --method pixel-perfecter
```

| 參數 | 意思 |
|---|---|
| `--method <id>` | preset 或舊名。預設 `legacy`。名稱不存在就失敗。 |
| `--k <n>` | 顏色上限（預設 0，不減色） |
| `--bg` | 保留移除背景（benchmark 預設會關掉） |
| `--min-hit <n>` | 格數 ±1 命中少於 n 例時 exit 1 |
| `--compare [檔案]` | 與 baseline 逐位比對（預設 `tools/bench/baseline-legacy.json`） |
| `--baseline` | 用這次結果覆寫 `tools/bench/baseline-legacy.json` |

結果和它的限制請看[像素化方法](pixelation-methods.zh-TW.md#測試結果)。

**真實圖片**：

```bash
node tools/bench/images.js --dir <資料夾> [--methods a,b,c] [--only <檔名的一部分>]
```

對資料夾裡每張 PNG 跑每種 preset，印出格數、重建誤差、色數、耗時。幾個已知檔名會標出對錯。
請一定要加 `--dir`，內建的預設路徑是作者電腦上的資料夾。

測試圖片不要進 git。`_testimg/`、`_out/` 已經在 `.gitignore` 裡。

## CLI

```bash
node tools/pixelate-cli.js --preset pixel-perfecter in.png out.png
```

| 參數 | 意思 |
|---|---|
| `--preset <id>` | preset 或舊名。預設 `pixel-perfecter`。 |
| `--k <n>` | 顏色上限。預設用 preset 自己的值（48；`Image-to-Pixel` 是 32）。 |
| `--dither <id>` | `none`、`fs`、`bayer2`、`bayer4`、`ordered`、`clustered4`、`atkinson` |
| `--target-width <n>` | `PixelOE`、`Image-to-Pixel` 的輸出寬度 |

- 輸入必須是 8-bit PNG（RGB、RGBA、灰階或索引色）。純 Node，不需要 npm 套件。
- 會在 stderr 印出 `ok <w>×<h> grid=<nx>×<ny> <ms>ms preset=<id>`。少了檔案參數時 exit 2，其他錯誤（例如未知的 preset）exit 1。
- 正式的 [pixel-bench](https://github.com/Retro-Diffusion/pixel-bench) 就是用 subprocess 呼叫它。
  pixel-bench 需要自備至少 50 張原生 1× 像素圖。原本建議放在 `_ref/bench-images/`、不上 GitHub；
  但 `_ref/` 目前不在 `.gitignore` 裡，放圖片前請先把它加進去。

## 部署

GitHub Pages 直接提供 `main` 分支的根目錄（`.nojekyll` 關掉 Jekyll）。Pages 對靜態資源送
`Cache-Control: max-age=600`，部署後 10 分鐘內，瀏覽器可能拿新的 HTML 配舊的 CSS、JS。每次部署前先跑：

```bash
node tools/bump-assets.js [版本字串]
```

它會幫 `index.html` 裡每個本機 CSS、JS 網址換上新的 `?v=`（不給版本就用當下時間 `YYYYMMDDHHmm`）。
Worker 會把自己的 `?v=` 接到它載入的腳本上。

## 原始碼結構

```
index.html               版面
css/style.css            全部樣式（Design Token 化，含深淺主題與 RWD）
js/codec.js              資料轉換：JSON/JS 解析、點陣圖、PNG 放大、SVG、ZIP
js/pixelate/             像素化管線：偵測 → 仲裁 → 取樣 → 減色 → 抖色 → 清理
  lib/ grid.js index.js  共用數學、格線邊界、階段註冊表、預設組合、Worker 用戶端
  detect/ sample/ quant/ dither/ clean/   每種實作一個檔案
js/pixelate-worker.js    背景執行緒
js/vendor/               Image-to-Pixel 抖色函式庫（MIT）
js/store.js              狀態、復原堆疊、本機保存
js/render.js             畫布繪製
js/ui.js                 DOM 與事件（orchestrator）
js/ui/                   UI 子控制器：overlays / export / persistence / pixelate-dialog / canvas-input
js/main.js               啟動點
tools/check.js           檢查腳本（見上方）
tools/pixelate-cli.js    Node CLI：PNG → 像素化 → PNG（給 pixel-bench 接）
tools/pixelate-files.js  CLI、benchmark、檢查腳本共用的演算法載入清單
tools/png.js             Node 用的最小 PNG 讀寫
tools/static-server.js   開發與 E2E 用的本機靜態伺服器
tools/bump-assets.js     部署前更新資源版本參數
tools/bench/             合成與真實圖片 benchmark、legacy 基準
tests/smoke.spec.js      Playwright 煙霧測試
```

分層規則：`css` 管外觀、`ui.js` 管 DOM 與事件、`render.js` 管繪圖、`store.js` 管狀態。
`codec.js` 只做資料轉換。`js/ui/` 的子控制器不得呼叫 `PA.ui`。`js/pixelate/` 底下的檔案要能在網頁、Worker 和 Node 裡執行。

要新增一個階段實作：用 `PA.pixelate.register(stage, { id, label, run, … })` 註冊，再把檔案依相同順序加進
`index.html`、`tools/pixelate-files.js` 和 `js/pixelate-worker.js` 的清單。預設組合寫在 `js/pixelate/index.js`。

## 暫時隱藏的標註功能

部件標註功能目前隱藏。`js/ui.js` 裡的 `const annotationEnabled = false;` 是唯一的開關。
`parts` 資料照樣會匯入、保存、還原和匯出，E2E 測試兩種設定都有涵蓋。

## 設計筆記

幾個為了大圖能用而做的設計：

- **復原用稀疏 diff**：筆畫只記真的改到的格子。作者實測，1500×1500 的一筆長筆畫佔 74KB，而不是整份複製的 4.4MB。
  歷史堆疊每張圖有記憶體預算（復原加重做估計共 192MB，最多 60 步），不會無限長大。
- **點陣圖存 IndexedDB**：localStorage 只保存元資料與 RLE 壓縮的工作資料，避開約 5MB 的配額。
  保存用的鍵是 `pixann.v2`；舊版 `pixann` 鍵的資料會在第一次啟動時遷移。
  因空間不足存檔失敗時，`pixann.v2.stale` 會記下時間，下次還原時才能說明保存的版本比較舊。
- 泛洪用 scanline fill、繪製用 `Path2D` 合併同色矩形、指標移動的重繪合併到單一影格。
- `legacy` 方法保留，輸出與重寫前逐位相同。
