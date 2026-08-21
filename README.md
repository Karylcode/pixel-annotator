# 像素畫工具（Pixel Annotator）

把 AI 生成的「假像素圖」還原成真正的像素圖，再直接在畫布上修圖、裁切，匯出成遊戲能直接用的素材。

**▶ [線上使用](https://karylcode.github.io/pixel-annotator/)** — 開網頁就能用，不用安裝、不用註冊，圖片全程留在你的瀏覽器裡，不會上傳到任何地方。

---

## 這個工具解決什麼問題

AI 畫出來的「像素風」圖片，看起來像素塊分明，實際上是一張被放大的高解析度圖：每個「像素」其實是 20 多個真實像素，邊緣還帶著反鋸齒的漸層，格子寬度甚至逐格抖動。這種圖沒辦法當素材用——放進遊戲會糊掉，也不可能一格一格改。

這個工具做三件事：

| | |
|---|---|
| **✨ 像素化** | 自動偵測圖片裡的格線週期、逐條吸附到真正的邊界，把每一格還原成一個像素，並用 OKLab 感知色彩空間減色。提供多種偵測方法（Pixel Art Fixer 共識、perfectPixel FFT、pixel-perfecter 幾何、unfake 清理、PixelOE 照片路線）可自由選擇。1024×1024 的 AI 圖 → 32×32 的真像素圖。 |
| **✎ 繪圖** | 還原之後直接在畫布上修：畫筆、滴管、擦成透明、裁切、鏡射對稱檢查。 |

---

## 主要功能

### 像素化

- **自動偵測格線**：可選 Pixel Art Fixer 三偵測器共識、FFT、pixel-perfecter、runs、或保留行為不變的原版（`legacy`）
- **方法預設**（括號內是來源專案，介面上按 ⓘ 可看）：三偵測器共識／全偵測器仲裁（Pixel Art Fixer）、FFT 主週期偵測（perfectPixel）、四路幾何偵測（pixel-perfecter）、霍夫格線偵測（proper-pixel-art）、連續同色段偵測 + 清理層（unfake.js）、幾何中位數取色（spritegrid）、輪廓感知降採樣（PixelOE）、指定寬度 + 抖色（Image-to-Pixel）、本工具原版引擎（legacy）；進階區可逐段改取樣、偵測器、減色、抖色、清理
- **逐帶網格吸附**：AI 圖在不同區域的局部格寬可能差很多（實測同一張圖臉部 35px、整體平均 26px），所以每一列 / 每一行的格線各自微調，不是套一組直線
- **每格取樣**：格心中位數、兩階段重建、眾數／幾何中位數，或 PixelOE 對比感知降採樣
- **減色**：OKLab 空間的加權 k-means，或中位切割；小面積但關鍵的顏色（眼睛高光、腳）不會被大片背景吃掉
- **抖色**：Floyd–Steinberg、Bayer、Ordered、Clustered、Atkinson（Image-to-Pixel）
- **移除背景**（移植自 [sprite-lab](https://github.com/boona13/sprite-lab)，MIT）：先分辨背景是「已透明 / 洋紅幕 / 綠幕 / 假透明棋盤格 / 單色底」再分頭處理。棋盤格會先抓出它的兩個灰階再泛洪，並逐圈剝掉角色邊上的棋盤色鑲邊；比棋盤暗的**投影會被保留**。泛洪一律只從畫面外緣進來，角色身上同色的部分（白裙、銀色盔甲、劍刃）不受影響
- **原圖 / 結果比對滑桿**、重建誤差指標、進度條與取消
- 偵測與重算跑在 Web Worker，介面不會卡住

### 繪圖與編輯

- 畫筆（1–6px）、滴管、擦成透明、裁切（八把手）
- `Shift+點` 從上一點畫直線、`Alt+點` 吸取顏色
- **鏡射差異檢查**：把左右不對稱的格子標成洋紅斑馬紋，對稱軸可以直接在畫布上拖
- 圖片調色盤自動列出目前用到的顏色（超過 48 色時挑彼此差異最大的，不會塞滿一片近似灰）

### 其他

- **多圖**：同時開啟多張圖片，透過圖片分頁或縮圖列快速切換
- **完整復原**：`Ctrl+Z` / `Ctrl+Shift+Z`，可停留的歷史面板能一次跳多步；裁切、像素化等破壞性操作都有 6 秒可復原的提示
- **自動保存**：圖片與編輯結果存在瀏覽器本機，關掉再開會自動還原
- **手機 / 平板**：底部工具列 + 抽屜式面板，雙指縮放平移，觸控目標全部 ≥44px
- **淺色 / 深色主題**跟隨系統；完整鍵盤操作與 ARIA 標記

---

## 匯出格式

| 格式 | 內容 | 用途 |
|---|---|---|
| **PNG** | 1× ~ 32× 整數倍最近鄰放大 | 直接當素材 |
| **SVG** | 同色像素合併成矩形，每色一個 `<path>` | 向量、無限放大 |
| **JSON** | palette + 索引網格（保留既有相容欄位） | 給程式讀 |
| **JS** | 同上，包成 `export const` 模組 | 直接 `import` 進專案 |
| **ZIP** | 所有開著的圖片打包（PNG，64×64 以內的另附 JSON） | 一次帶走 |

JSON / JS 的結構：

```js
export const sprite = {
  w: 16, h: 16,
  palette: [null, "#dfe6ee", "#9aa7b4", "#ffb224"],
  pixels: [                       // 每格一個 palette 索引，0 = 透明
    [0, 0, 1, 1, 0, 0],
    // …
  ],
};
```

匯入也支援同樣的格式，另外接受 hex 字串陣列與扁平 rgba 陣列。

---

## 快速開始

1. 打開 **[線上版](https://karylcode.github.io/pixel-annotator/)**（或下載這個 repo，直接用瀏覽器開 `index.html`）
2. 把圖片拖進畫面 —— 或按 **✨ 像素化** 直接處理 AI 圖
3. 像素化：確認自動偵測的格數 → 調顏色上限 → **套用**
4. 右欄「匯出」分頁選格式下載

## 快捷鍵

| 鍵 | 功能 | | 鍵 | 功能 |
|---|---|---|---|---|
| `D` `I` `X` | 繪圖 / 滴管 / 擦成透明 | | `Ctrl+Z` | 復原 |
| `C` | 裁切（`Enter` 套用 / `Esc` 取消） | | `Ctrl+Shift+Z` | 重做 |
| `[` `]` | 筆刷縮小 / 放大 | | `Alt+點` | 吸取顏色 |
| `+` `−` `0` | 放大 / 縮小 / 貼合視窗 | | `Shift+點` | 從上一點畫直線 |
| `Space` 拖曳 | 平移畫布 | | `Ctrl+滾輪` | 以游標為中心縮放 |
| `?` | 快捷鍵面板 | | | |

按右鍵可以叫出快選選單（拖曳右鍵則是平移）。

---

## 技術說明

**執行期零依賴、無建置流程。** 一般使用只要用瀏覽器開 `index.html`（或 GitHub Pages），圖片全程留在本機，不需要 npm、bundler 或建置步驟。開發檢查（lint、回歸、瀏覽器煙霧測試）才需要 Node / npm。

```
index.html          版面
css/style.css       全部樣式（Design Token 化，含深淺主題與 RWD）
js/codec.js         資料轉換：JSON/JS 解析、點陣圖、PNG 放大、SVG、ZIP
js/pixelate/        像素化管線：偵測 → 仲裁 → 取樣 → 減色 → 抖色 → 清理
js/pixelate-worker.js  背景執行緒
js/vendor/          Image-to-Pixel 抖色函式庫（MIT）
js/store.js         狀態、復原堆疊、本機保存
js/render.js        畫布繪製
js/ui.js            DOM 與事件（orchestrator）
js/ui/              UI 子控制器：overlays / export / persistence / pixelate-dialog / canvas-input
tools/pixelate-cli.js  Node CLI：PNG → 像素化 → PNG（給 pixel-bench 接）
tools/check.js      零依賴檢查入口（語法、preset、回歸、保存、顏色、靜態資源）
```

分層規則：`css` 管外觀、`ui.js` 管 DOM 與事件、`render.js` 管繪圖、`store.js` 管狀態。

第三方演算法出處見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本專案授權見 [LICENSE](LICENSE)（MIT，Karylcode 2026）。`legacy` 方法保留，輸出與重寫前逐位相同。

### 合成測試與 pixel-bench 代理量測

> **合成測試只衡量特定格線重建案例，不代表真實 AI 圖的整體品質排名。預設方法依人工真圖測試決定，目前為 `pixel-perfecter`。**
>
> 附錄 A 的 24 例（`node tools/bench/run.js --method <preset>`）是回歸護欄，不是自動選模型的依據。CI 對 `pixel-perfecter` 只檢查 `--min-hit 13` 這道合成門檻。

| 預設 | 格數 ±1 命中 | 備註 |
|---|---|---|
| `legacy` | 7/24（29%） | 與重寫前逐位相同 |
| `pixel-art-fixer`（舊名 `standard`） | 22/24（91.7%） | Fixer 三偵測器共識 |
| `pixel-art-fixer-full`（舊名 `precise`） | 23/24（95.8%） | 另加變異數對比／重建誤差 |
| `pixel-perfecter`（預設） | 13/24（54%） | 四路幾何偵測；人工真圖評估選為預設 |

正式 [pixel-bench](https://github.com/Retro-Diffusion/pixel-bench) 需要自備 ≥50 張 native 1× 像素圖（建議放 `_ref/bench-images/`，不上 GitHub），以 subprocess 呼叫：

```
node tools/pixelate-cli.js --preset pixel-perfecter in.png out.png
```

在尚未備齊該語料前，用同一套 24 例代理四個指標（越高越好，ΔE 除外）：

| 指標（pixel-bench 對應） | `pixel-art-fixer` | `legacy` |
|---|---|---|
| resolution `within1` | 91.7% | 29.2% |
| color mean ΔE（命中例、無額外減色） | 見 bench 表；整數倍無模糊例接近 0 | 同左（命中例） |
| placement `pixel_match`（命中且無模糊） | 接近 100%（格心中位數／兩階段） | 同左 |
| `grid_align`（命中例 \|sx−f\|/f） | 多數 < 1% | 常偏諧波 |

`pixel-art-fixer-full` 在 Worker 內可取消（關閉視窗／取消鈕會 `terminate`）；仲裁多了變異數對比與 round-trip 誤差，目標 20 秒內完成。舊別名 `standard`／`precise` 在 CLI 與 benchmark 仍可用，輸出一律顯示正式 ID。

幾個為了大圖能用而做的設計：

- **復原用稀疏 diff**：筆畫只記真的改到的格子，1500×1500 的一筆長筆畫佔 74KB 而不是 4.4MB；歷史堆疊有記憶體預算，不會無限長大
- **點陣圖存 IndexedDB**，localStorage 保存元資料與壓縮的工作資料，避開 5MB 配額
- 泛洪用 scanline fill、繪製用 `Path2D` 合併同色矩形、指標移動的重繪合併到單一影格

**瀏覽器需求**：Chrome / Edge / Firefox / Safari 近兩年的版本（用到 Canvas 2D、Web Worker、IndexedDB、`Path2D`、CSS `color-mix()` 與 `:has()`）。用 `file://` 直接開也能跑，只是像素化會退回主執行緒計算。

**隱私**：全部在瀏覽器本機執行，沒有後端、沒有分析、沒有任何網路請求。你的圖片不會離開這台電腦。
