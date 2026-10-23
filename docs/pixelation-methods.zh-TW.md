[English](pixelation-methods.md) | **繁體中文** · [文件索引](README.zh-TW.md)

# 像素化方法

像素化會把放大過的「像素風」圖片，還原成每格一個像素。每種方法都是同一條管線的一組預設。
各方法的出處、授權和移植的檔案，請看 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 管線

偵測 → 仲裁 → 取樣 → 減色 → 抖色 → 清理

- 偵測與重算跑在 Web Worker，介面不會卡住。Worker 啟動不了時（例如用 `file://` 開），同一套程式改在主執行緒跑。
- 進度條會顯示目前的階段。按 **取消** 或關閉視窗，會直接停掉 Worker。
- 偵測和手動設定的格數，每邊上限都是 512。

### 乾淨像素圖判定

頻域偵測器可能會毀掉本來就乾淨的像素圖。作者實測，100×100 的手繪像素圖被各方法降成 50×50、25×25，甚至 2×2。
所以除了 `legacy`，會偵測格線的方法都會先檢查輸入：

- **乾淨** 的定義：顏色不超過 512 色，而且相鄰像素落在反鋸齒範圍的比例不超過 2%。
- 如果每個 s×s 區塊都是同一色（s 從 2 到 64），就是整數倍放大，直接精確還原原始尺寸。
- 否則就是原生像素圖，維持 1:1（邊長 1024px 以內）。仍然可以減色、去背、抖色。
- AI 圖有數萬色、2–3% 的中間色，不會命中這條，照常交給偵測器。

偵測器完全找不到週期時，也會當成原生像素圖，以 1:1 處理。

## 方法

| ID | 選單名稱 | 來源 | 做法 |
|---|---|---|---|
| `pixel-art-fixer` | 三偵測器共識 | Pixel Art Fixer | 三個獨立偵測器（自相關梳狀、run-length soft-GCD、位移自相似）取共識，再用兩階段重建上色。舊名 `standard`。 |
| `pixel-art-fixer-full` | 全偵測器仲裁 | Pixel Art Fixer | 再加上 perfectPixel 的 FFT 和 pixel-perfecter，並開啟原專案 Stage 2 的變異數對比與 round-trip 重建誤差仲裁。最慢，給難圖用。舊名 `precise`。 |
| `perfectPixel` | FFT 主週期偵測 | perfectPixel | FFT 抓梯度剖面的主週期得到格寬，再用邊緣精修對齊。整數倍放大時最快最準。 |
| `pixel-perfecter`（預設） | 四路幾何偵測 | pixel-perfecter | 四路子偵測：精確最近鄰檢查、Canny 投影、自相關、phase-fold 掃描，再用統一分數「格間對比 / √格內變異」挑選，用眾數取色。 |
| `proper-pixel-art` | 霍夫格線偵測 | proper-pixel-art | 幾何路線：Canny 邊緣 → 形態學閉合 → 軸向霍夫取線 → 分群 → 修剪中位間距。 |
| `unfake.js` | 連續同色段偵測 + 清理層 | unfake.js | 同色 run 長度偵測加眾數取色，並套用它的清理層：補洞、去雜點、修鋸齒、alpha 二值化。 |
| `spritegrid` | 幾何中位數取色 | spritegrid | 格線用 Pixel Art Fixer 的共識，取色改用 Weiszfeld 幾何中位數。比逐通道中位數更抗離群，而且會吸附回格內既有的顏色，不會冒出原圖沒有的色。 |
| `PixelOE` | 輪廓感知降採樣 | PixelOE | 不偵測格線，由你指定目標寬度。先做輪廓擴張保住 1px 細線，再做對比感知降採樣（LAB 空間，亮度取局部極值、色度取中位數）。 |
| `Image-to-Pixel` | 指定寬度 + 抖色 | Image-to-Pixel | 不偵測格線，由你指定目標寬度。減色後套用抖色（預設 Floyd–Steinberg）。 |
| `legacy` | 本工具原版引擎 | 本工具 | 原本的差分能量偵測加格心中位數取色。保留作為回歸基準，輸出與重寫前逐位相同。 |

舊名 `standard`、`precise` 在 CLI 和 benchmark 仍然可用，輸出一律顯示正式 ID。
在進階區改了偵測器或精確仲裁，選單就會變成 **自訂組合**。

## 各階段

### 偵測器

| ID | 名稱 | 來源 | 做法 |
|---|---|---|---|
| `autocorr` | 自相關 | Pixel Art Fixer | 自相關梳狀 − 反梳狀，加上次諧波抑制 |
| `runlength` | Run-length | Pixel Art Fixer | 邊界距離的 soft-GCD |
| `selfsim` | 自相似 | Pixel Art Fixer | 位移自相似加多諧波 t 統計 |
| `fft` | FFT | perfectPixel | FFT 主週期 |
| `perfecter` | pixel-perfecter | pixel-perfecter | exact-NN、Canny 投影、phase-fold、對比評分 |
| `hough` | 霍夫 | proper-pixel-art | Canny → 閉合 → 軸向霍夫 → 修剪中位間距 |
| `runs` | Runs | unfake.js | 同色 run 長度 |
| `legacy` | legacy | 本工具 | 差分能量 |

有兩個以上的偵測器時，由共識／仲裁步驟（來自 Pixel Art Fixer）決定格線。
**精確仲裁** 會多跑變異數對比與 round-trip 重建誤差，比較慢。`pixel-art-fixer-full` 會開啟它，目標是 20 秒內完成。

### 自動吸附格線（只有 `legacy`）

AI 圖在不同區域的局部格寬可能差很多。實測同一張圖，臉部 35px，整體平均 26px。
**自動吸附格線** 會把等距格線逐條吸附到附近的邊緣，再逐帶微調成不等距網格。
它會蓋掉其他演算法算出來的格線，所以只在 `legacy` 方法可用。在 `legacy` 下，如果吸附能降低重建誤差，就會自動開啟。

### 取樣

| ID | 名稱 | 說明 |
|---|---|---|
| `center-median` | 格心中位數 | 取每格中心區域的中位數 |
| `two-stage` | 兩階段（結構／顏色） | Pixel Art Fixer：先用量化標籤投票決定每格屬於哪一區，再取該區原始像素的中心加權平均 |
| `dominant`、`mode`、`mean`、`median`、`qvote` | 眾數（5-bit 分箱）、眾數、平均、中位數、分位投票 | unfake.js 的格內統計，可設邊緣修剪 |
| `geomedian` | 幾何中位數 | spritegrid 的 Weiszfeld 幾何中位數 |
| `pixeloe` | PixelOE 對比降採樣 | PixelOE 的對比感知降採樣 |

### 減色

- **OKLab k-means**（預設）：以每個顏色像素數的平方根加權，所以面積小但關鍵的顏色（眼睛高光、腳）
  不會被大片背景吃掉。色度權重加倍，亮度相同、只差在色相的兩色不會被併成一色。
- **中位切割**。
- **不減色**。

顏色上限預設 48，0 = 不減色。

### 抖色

Floyd–Steinberg、Bayer 2×2、Bayer 4×4、Ordered 8×8、Clustered 4×4、Atkinson，來自 vendor 進來的
Image-to-Pixel 函式庫，可以調強度（預設 50%）。adapter 不會呼叫 Lospec 的調色盤 API，所以抖色不會發出網路請求。

### 清理

**移除背景** 移植自 [sprite-lab](https://github.com/boona13/sprite-lab)（MIT）。先分辨背景種類，再分頭處理：

- **已透明**：只清掉殘留的鑲邊。
- **洋紅幕、綠幕**：chroma key，並去除溢色。
- **假透明棋盤格**：先抓出棋盤的兩個灰階，從邊界泛洪，再逐圈剝掉角色邊上的棋盤色鑲邊。比棋盤暗的投影會被保留。
- **單色底**：用四角平均色泛洪。

泛洪一律只從畫面外緣進來，角色身上同色的部分（白裙、銀色盔甲、劍刃）不受影響。
和上游有三處刻意的差異：認得出 ChatGPT 匯出的中灰棋盤；不移植半透明的 alpha matting，因為輸出的 alpha 只有 0 或 255；
不移除小塊中性色島，因為在 80×80 的像素圖上會把白色高光吃掉。

其他四種清理來自 unfake.js：**補洞** 補回單格小洞，**去雜點** 移除孤立雜點，**修鋸齒** 把斜線上的鋸齒平滑掉，
**Alpha 二值** 讓每個像素都變成全透明或全不透明。

## 測試結果

> 合成測試只衡量特定格線重建案例，不代表真實 AI 圖的整體品質排名。預設方法依人工真圖測試決定，目前為 `pixel-perfecter`。
>
> 24 例合成測試（`node tools/bench/run.js --method <preset>`）是回歸護欄，不是自動選模型的依據。
> CI 對 `pixel-perfecter` 只檢查 `--min-hit 13` 這道合成門檻。

| 預設 | 格數 ±1 命中 | 備註 |
|---|---|---|
| `legacy` | 7/24（29.2%） | 與重寫前逐位相同 |
| `pixel-art-fixer`（舊名 `standard`） | 22/24（91.7%） | Fixer 三偵測器共識 |
| `pixel-art-fixer-full`（舊名 `precise`） | 23/24（95.8%） | 另加變異數對比／重建誤差 |
| `pixel-perfecter`（預設） | 13/24（54.2%） | 四路幾何偵測；人工真圖評估選為預設 |

這 24 例是 24×24 和 32×32 的像素圖，有散點和色塊兩種，用整數與非整數倍率放大，部分再平滑或模糊。
產生器在 `tools/bench/gen.js`。

### pixel-bench 代理量測

正式的 [pixel-bench](https://github.com/Retro-Diffusion/pixel-bench) 需要自備至少 50 張原生 1× 像素圖，
用 subprocess 呼叫 CLI，請看[開發](development.zh-TW.md#cli)。在備齊之前，先用同一套 24 例代理它的四個指標
（越高越好，ΔE 除外）：

| 指標（pixel-bench 對應） | `pixel-art-fixer` | `legacy` |
|---|---|---|
| resolution `within1` | 91.7% | 29.2% |
| color mean ΔE（命中例、無額外減色） | 見 bench 輸出；整數倍無模糊例接近 0 | 同左（命中例） |
| placement `pixel_match`（命中且無模糊） | 接近 100%（格心中位數／兩階段） | 同左 |
| `grid_align`（命中例 \|sx−f\|/f） | 多數 < 1% | 常偏諧波 |
