[English](installation.md) | **繁體中文** · [文件索引](README.zh-TW.md)

# 安裝

## 線上使用

打開 https://karylcode.github.io/pixel-annotator/ 就能用。不用安裝，也不用註冊帳號。
網頁由 GitHub Pages 直接從 `main` 分支提供。

## 在本機執行

1. 下載或 clone 這個 repo：

   ```bash
   git clone https://github.com/Karylcode/pixel-annotator.git
   ```

2. 用瀏覽器開 `index.html`。

一般使用不需要 npm、bundler 或建置步驟。

直接從硬碟開 `index.html`（`file://`）也能跑，只是像素化會退回主執行緒計算，不走 Web Worker。
速度比較慢，計算時畫面可能會卡頓。想保留 Worker，就用 HTTP 提供這個資料夾。有裝 Node.js 的話：

```bash
node tools/static-server.js
```

然後打開 http://127.0.0.1:4173。可以用 `PORT`、`HOST` 環境變數改位址。
這個小伺服器是給開發和瀏覽器測試用的，產品本身不依賴它。用其他靜態檔案伺服器也可以。

## 瀏覽器支援

本工具用到 Canvas 2D、Web Worker、IndexedDB、`Path2D`、CSS `color-mix()` 與 `:has()`。
作者的目標是 Chrome、Edge、Firefox、Safari 近兩年的版本。CI 只在 Chromium 跑端對端測試。

螢幕寬度 900px 以下時，版面會換成底部工具列加抽屜式面板。

## 資料存在哪裡

全部在瀏覽器本機執行，沒有後端、沒有分析、沒有任何網路請求。你的圖片不會離開這台電腦。

自動保存會把工作資料存在這個瀏覽器裡：

- 點陣圖存在 IndexedDB（資料庫 `pixann`）。
- `localStorage` 的 `pixann.v2` 存元資料和壓縮過的工作資料。點陣圖不放這裡，才能避開 localStorage 約 5MB 的配額。
- `localStorage` 的 `pixann.px` 記住上次用的像素化方法和長寬比鎖定。

要刪掉保存的資料，用 **檔案 → 清除瀏覽器裡的保存資料…**。目前開著的圖片不受影響，只是下次開啟時不會自動還原。
之後的變更仍會重新保存。

## 開發工具

只有跑 lint、檢查腳本和瀏覽器測試時才需要 Node.js 和 npm。請看[開發](development.zh-TW.md)。
