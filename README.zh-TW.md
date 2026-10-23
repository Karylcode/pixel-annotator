[English](README.md) | **繁體中文**

# Pixel Annotator

[![CI](https://github.com/Karylcode/pixel-annotator/actions/workflows/check.yml/badge.svg)](https://github.com/Karylcode/pixel-annotator/actions/workflows/check.yml)
[![Pages](https://github.com/Karylcode/pixel-annotator/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/Karylcode/pixel-annotator/actions/workflows/pages/pages-build-deployment)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把 AI 生成的「假像素圖」還原成真正的像素圖，再直接在畫布上修圖、裁切，匯出成遊戲能直接用的素材。
AI 畫出來的「像素風」圖片，看起來像素塊分明，實際上是一張被放大的高解析度圖：每個「像素」其實是 20 多個真實像素，
邊緣還帶著反鋸齒的漸層，格子寬度甚至逐格抖動。這種圖放進遊戲會糊掉，也不可能一格一格改。
本工具是純 HTML、CSS、JavaScript 寫的靜態網頁，執行時不依賴任何套件，也沒有建置流程。
開網頁就能用，不用安裝、不用註冊，圖片全程留在你的瀏覽器裡，不會上傳到任何地方。

**線上試用：** https://karylcode.github.io/pixel-annotator/

## 可以做什麼

- **像素化 AI 圖**：自動偵測格線週期，把每一格還原成一個像素，並用 OKLab 感知色彩空間減色。
  例如 1024×1024 的 AI 圖 → 32×32 的真像素圖。
- **十種方法可選**：移植自 Pixel Art Fixer、perfectPixel、pixel-perfecter、proper-pixel-art、unfake.js、
  spritegrid、PixelOE、Image-to-Pixel，加上本工具原版引擎（`legacy`）。預設是 `pixel-perfecter`。
  進階區可以逐段換偵測器、取樣、減色、抖色、清理。
- **移除背景**（移植自 sprite-lab）：先分辨背景是已透明、洋紅幕、綠幕、假透明棋盤格還是單色底，再分頭處理。
  角色身上同色的部分不受影響，比棋盤暗的投影也會保留。
- **繪圖與修圖**：畫筆（1–6px）、滴管、擦成透明、裁切（八把手），還有鏡射差異檢查，標出左右不對稱的格子。
- **匯出**：PNG（1×–32×）、SVG、JSON、JS 模組，或把所有開著的圖片打包成 ZIP。
- **多圖、復原、自動保存**：用圖片分頁或縮圖列切換；可以復原、重做，也有歷史面板；
  關掉再開會自動還原上次的工作。
- **手機與平板**：底部工具列、抽屜式面板、雙指縮放。淺色 / 深色主題跟隨系統。
- **隱私**：全部在瀏覽器裡執行。沒有後端、沒有分析、沒有任何網路請求。

## 需求

- 支援 Canvas 2D、Web Worker、IndexedDB、`Path2D`、CSS `color-mix()` 與 `:has()` 的新版瀏覽器。
  CI 用 Chromium 跑端對端測試。
- 一般使用不用安裝任何東西：開線上版，或下載這個 repo 直接開 `index.html`。
- Node.js 和 npm 只有跑開發檢查時才需要（CI 用 Node 22）。

詳細：[安裝](docs/installation.zh-TW.md)。

## 快速開始

1. 打開 **[線上版](https://karylcode.github.io/pixel-annotator/)**（或下載這個 repo，直接用瀏覽器開 `index.html`）。
2. 把圖片拖進畫面，或按 **✨ 像素化** 直接處理 AI 圖。
3. 在像素化視窗確認自動偵測的格數，調整 **顏色上限**，再按 **套用 ✓**。
4. 到右欄 **匯出** 分頁選格式下載。

接著看：[使用方式](docs/usage.zh-TW.md)。

## 疑難排解

- **格數偵測錯了**：換一種方法；在投票表點某個偵測器那一列，改用它的格線；
  或在 **手動調整格數／格寬／偏移** 自己設定。
- **JSON、JS 不能匯出**：只支援 64×64 以內的圖。先裁切或像素化。
- **用 `file://` 開時像素化很慢**：這時會退回主執行緒計算。改用線上版或本機伺服器。
- **出現「瀏覽器儲存空間不足」**：之後的變更不會自動保存。先下載 JSON 備份，或關閉用不到的圖片。

更多：[疑難排解](docs/troubleshooting.zh-TW.md)。

## 文件

- [文件索引](docs/README.zh-TW.md)：所有頁面一覽
- [安裝](docs/installation.zh-TW.md)：線上使用、在本機執行、瀏覽器支援、資料存在哪裡
- [使用方式](docs/usage.zh-TW.md)：開圖、像素化視窗、繪圖工具、復原、自動保存、快捷鍵
- [像素化方法](docs/pixelation-methods.zh-TW.md)：十種方法、管線各階段、移除背景、測試結果
- [匯出格式](docs/export-formats.zh-TW.md)：PNG、SVG、JSON、JS、ZIP，資料結構、匯入格式、尺寸上限
- [疑難排解](docs/troubleshooting.zh-TW.md)：常見問題和訊息
- [開發](docs/development.zh-TW.md)：npm 指令、CI、測試、benchmark、CLI、原始碼結構

## 授權

MIT，詳見 [LICENSE](LICENSE)。

- 第三方演算法的出處、授權與移植範圍：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
