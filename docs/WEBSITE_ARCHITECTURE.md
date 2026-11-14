# 官網架構與維護說明

這份文件寫給之後維護小吉官網的人與 AI：只要讀這份文件，就知道每一頁有哪些區塊、顏色與動畫從哪裡來、要改什麼該動哪個檔案，不需要先截圖才看得懂網站。改了網站結構、配色或互動，就同步改這份文件；`test/websiteArchitecture.test.js` 會比對本文件的區塊表與配色表和實際檔案，不一致時測試失敗。

## 1. 定位

- 對象：已經在 Discord 伺服器裡遇到小吉的成員，想知道「小吉能做什麼、怎麼用」；其次是第一次聽說小吉的訪客。
- 風格：可愛的角色介紹頁。小吉是溫柔、細心、有原則的聊天夥伴，畫面以粉色、薰衣草紫、蜜桃與薄荷綠為主，圓角、柔和陰影、少量會動的小細節。
- 原則：公開網站只放公開功能與整體狀態，不放使用者 ID、伺服器名稱或私密對話；不寫私有擴充的指令名稱、私有伺服器 ID 或私有模組路徑（見 `docs/EXTENSION_CONTRACT.md`）。資料拿不到時如實顯示「未知」，不用猜的數字代替。

## 2. 檔案地圖

| 檔案 | 用途 |
|---|---|
| `website/index.html` | 首頁：角色介紹、即時概況、關於小吉、功能亮點（由清冊產生）。 |
| `website/guide.html` | 功能與指令頁：所有公開功能與指令，可搜尋、依分類與可用對象篩選。清單由程式寫入。 |
| `website/status.html` | 即時狀態頁：整體服務狀態與公開功能數量，功能說明連到功能與指令頁。 |
| `website/policies.html` | 使用者政策、隱私權政策與公開資料聲明。內容與 `website/siteSupport.js` 的政策文字必須一致（`test/policyPublication.test.js`）。 |
| `website/styles.css` | 所有頁面共用的設計變數、頁首、按鈕、首頁區塊、動畫。 |
| `website/guide.css` | 功能與指令頁專用樣式。 |
| `website/status.css` | 狀態頁專用樣式。 |
| `website/support.css` | 自助客服彈窗、小吉陪伴泡泡、政策區塊、頁尾連結。遊戲頁也會載入它。 |
| `website/theme.js` | 白天／夜晚配色。放在 `<head>`、不加 `defer`，在畫面繪製前決定配色，避免閃爍。 |
| `website/siteChrome.js` | 共用互動：選單按鈕、配色切換、頁首捲動變化、目前區塊、背景色調、陪伴泡泡台詞、淡入。要在 `siteSupport.js` 之後載入。 |
| `website/siteSupport.js` | 自助客服、政策彈窗、右下角的小吉陪伴按鈕與泡泡（`say()`）。 |
| `website/app.js` | 首頁專用：即時概況資料、頭像互動。 |
| `website/guideSearch.js` | 功能與指令頁的搜尋與篩選；只負責隱藏不符合的項目。 |
| `website/status.js`、`website/statusData.js` | 狀態頁的即時資料讀取與顯示。 |
| `website/publicFeatureCatalog.js` | 公開功能清冊（系統 → 功能的用途、使用方式、使用限制）。功能說明的唯一來源。 |
| `website/commandCatalog.js` | 公開指令目錄。指令清單的唯一來源，`/help` 與 `docs/COMMANDS.md` 也用它。 |
| `scripts/render-website-guide.js` | 把清冊與指令目錄寫進 `website/guide.html` 與 `website/index.html` 的產生區塊。 |

遊戲頁（`website/games/`）有自己的 `game.css`，不使用本文件的設計變數；它們只共用 `support.css` 與 `siteSupport.js`。

## 3. 頁面與區塊

每一頁的 `<section id>` 依序列在下表。「底色」是該區塊捲到畫面中間時，背景要換成的色調（`data-scene`，見第 5 節）；「—」表示不換。「陪伴台詞」是 `data-companion`，捲到該區塊時右下角的小吉會說這句話。

### `website/index.html`

| 區塊 id | 底色 | 內容 | 陪伴台詞 |
|---|---|---|---|
| `top` | pink | 標語、按鈕、可互動的小吉頭像與對話卡 | — |
| `live-overview` | mint | 公開功能、公開版本、目前狀態三張卡（`app.js` 讀 `/api/public/overview`） | 這裡看得到小吉今天的狀態！ |
| `about` | lavender | 小吉檔案卡與三張價值卡 | 想多認識小吉一點嗎？嘿嘿 |
| `features` | peach | 搜尋框（送出到 `guide.html?q=`）、功能亮點卡（產生區塊 `home-highlights`） | 想找特定功能？用搜尋框問小吉～ |

### `website/guide.html`

| 區塊 id | 底色 | 內容 | 陪伴台詞 |
|---|---|---|---|
| `guide-top` | pink | 標題、搜尋表單（產生區塊 `guide-filters`） | 輸入關鍵字，小吉幫你找！ |
| `guide-features` | lavender | 功能清單，依系統分組（產生區塊 `guide-features`） | 點一下功能名稱，就能看怎麼用喔 |
| `guide-commands` | mint | 指令清單，依 `/help` 的分組（產生區塊 `guide-commands`） | 斜線指令在 Discord 輸入 / 就會跳出來～ |

### `website/status.html`

| 區塊 id | 底色 | 內容 | 陪伴台詞 |
|---|---|---|---|
| `status-top` | mint | 標題與整體服務卡（`status.js` 讀 `/api/public/status`） | 小吉會如實回報狀態，不會亂猜喔 |
| `status-summary` | lavender | 公開系統數、公開子功能數、逐項即時狀態 | — |
| `status-unavailable` | — | 狀態資料拿不到時才顯示的說明 | — |
| `status-guide` | peach | 公開功能清冊的入口，連到功能與指令頁 | 想知道功能怎麼用？到功能與指令頁找找～ |

### `website/policies.html`

| 區塊 id | 底色 | 內容 | 陪伴台詞 |
|---|---|---|---|
| `terms` | — | 使用者政策 | — |
| `privacy` | — | 隱私權政策 | — |
| `public-data` | — | 公開資料聲明 | — |

每一頁的頁首結構相同：品牌（`.brand`）、主要導覽（`nav#site-nav[data-nav]`，目前頁面的連結加 `aria-current="page"`）、配色切換鈕（`[data-theme-toggle]`）與手機選單鈕（`[data-nav-toggle]`）。

## 4. 由程式產生的區塊

HTML 裡夾在 `<!-- generated:名稱:start -->` 與 `<!-- generated:名稱:end -->` 之間的內容由 `scripts/render-website-guide.js` 寫入，不要手動編輯：

| 產生區塊 | 頁面 | 來源 |
|---|---|---|
| `guide-filters` | `website/guide.html` | 清冊的系統名稱（分類）與固定的可用對象（一般成員、需管理權限） |
| `guide-features` | `website/guide.html` | `website/publicFeatureCatalog.js` 的每一項功能 |
| `guide-commands` | `website/guide.html` | `src/commands/help.js` 的 `buildHelpSections()`，與 Discord 的 `/help` 相同；擁有者專用的指令與子指令不會出現 |
| `home-highlights` | `website/index.html` | 腳本裡的 `HOMEPAGE_HIGHLIGHTS`（挑哪些系統、圖示、一句介紹）＋該系統在清冊裡的全部功能名稱 |

修改清冊、指令目錄或首頁亮點設定後，執行 `npm run site:render`。`npm run check` 會比對頁面與產生結果，沒有重新產生時會失敗。

分類與可用對象的判斷方式：

- 功能的分類就是它所在的系統。
- 指令的分類是「哪些功能的使用方式提到它」；沒有功能提到的指令，先看 `UNMENTIONED_COMMAND_CATEGORY`，再依 `/help` 分組套用 `GROUP_FALLBACK_CATEGORY`。這兩張表的值必須是清冊裡的系統名稱。
- 功能的可用對象由它提到的指令決定：提到某個子指令就用那個子指令的對象；只提到指令名稱時，只要指令有一般成員能用的部分就算一般成員；完全沒提到指令（例如「@小吉」）算一般成員。

## 5. 配色

兩套配色共用同一組設計變數，元件只讀變數、不寫死顏色：

- 白天「草莓牛奶」：奶油白底、草莓粉、蜜桃點綴。
- 夜晚「晚安小夜燈」：暖梅子色深底、粉色字、暖燈黃按鈕。

`website/theme.js` 決定使用哪一套，寫在 `<html data-theme="day|night">`：

- 預設跟著台北時間：08:00–17:59 白天，其餘夜晚；頁面開著時每 5 分鐘重新判斷一次。
- 頁首的配色鈕依序切換「跟著台北時間 → 白天 → 夜晚」，選擇存在這個瀏覽器的 `localStorage`（鍵名 `xiaoji-theme`），存不了就只維持到關閉頁面。
- 沒有 JavaScript 時沒有 `data-theme`，改依系統的淺色／深色偏好。
- `theme.js` 同時把 `<meta name="theme-color">` 改成目前配色的底色。

設計變數（`website/styles.css` 的 `:root` 是白天，`html[data-theme="night"]` 是夜晚；沒有 JavaScript 且系統偏好深色時，`@media (prefers-color-scheme: dark)` 內有一份相同的夜晚值）：

| 變數 | 白天 | 夜晚 |
|---|---|---|
| `--bg` | `#fff7f2` | `#1f151f` |
| `--surface` | `rgba(255, 255, 255, 0.84)` | `rgba(48, 34, 47, 0.8)` |
| `--surface-strong` | `rgba(255, 250, 246, 0.92)` | `rgba(36, 25, 35, 0.9)` |
| `--surface-soft` | `rgba(255, 255, 255, 0.58)` | `rgba(255, 235, 245, 0.045)` |
| `--ink` | `#3a2a35` | `#fbeff3` |
| `--ink-soft` | `#6f5867` | `#d9bfcb` |
| `--ink-faint` | `#8f7885` | `#b39aa7` |
| `--line` | `rgba(140, 90, 110, 0.16)` | `rgba(255, 220, 235, 0.14)` |
| `--line-strong` | `rgba(140, 90, 110, 0.3)` | `rgba(255, 220, 235, 0.28)` |
| `--accent` | `#e8789f` | `#ff9ec4` |
| `--accent-text` | `#b8487a` | `#ffb3d1` |
| `--accent-2` | `#8c7ad6` | `#c3b1ff` |
| `--accent-2-text` | `#6b58bf` | `#d3c6ff` |
| `--mint` | `#3f9c80` | `#7fdcbc` |
| `--mint-text` | `#2c7d65` | `#8fe6c6` |
| `--warn-text` | `#a86a12` | `#ffc46b` |
| `--danger-text` | `#c23d5c` | `#ff8fa6` |
| `--on-accent` | `#ffffff` | `#3d2614` |
| `--button-from` | `#e8789f` | `#ffc98a` |
| `--button-to` | `#f19a84` | `#ff9ec4` |
| `--pink-pale` | `#ffe4ee` | `rgba(255, 158, 196, 0.16)` |
| `--lavender-pale` | `#ece6ff` | `rgba(195, 177, 255, 0.16)` |
| `--mint-pale` | `#daf3ea` | `rgba(127, 220, 188, 0.14)` |
| `--peach-pale` | `#ffe9da` | `rgba(255, 201, 138, 0.16)` |
| `--scene-pink` | `rgba(255, 196, 216, 0.62)` | `rgba(255, 120, 175, 0.16)` |
| `--scene-lavender` | `rgba(222, 211, 255, 0.62)` | `rgba(170, 140, 255, 0.16)` |
| `--scene-mint` | `rgba(200, 238, 222, 0.62)` | `rgba(110, 220, 180, 0.11)` |
| `--scene-peach` | `rgba(255, 215, 186, 0.66)` | `rgba(255, 190, 120, 0.15)` |
| `--dot` | `rgba(160, 100, 120, 0.2)` | `rgba(255, 220, 235, 0.16)` |
| `--shadow` | `0 24px 60px rgba(150, 90, 100, 0.14)` | `0 28px 70px rgba(0, 0, 0, 0.36)` |
| `--shadow-soft` | `0 12px 32px rgba(150, 90, 100, 0.1)` | `0 14px 36px rgba(0, 0, 0, 0.24)` |
| `--focus` | `#b8487a` | `#ffc98a` |

用法：`--ink` 一般文字、`--ink-soft` 說明文字、`--ink-faint` 次要標記；`--accent-text`／`--accent-2-text` 是放在底色上的強調文字（對比足夠）；`--accent` 是填色；按鈕與徽章用 `--button-from` → `--button-to` 漸層，上面的字用 `--on-accent`；`*-pale` 是淡色底；`--scene-*` 是背景色調。改顏色時兩套都要改，並更新上表。

`support.css` 讀的是 `--support-ink` 與 `--support-line`（在 `styles.css` 指向 `--ink`、`--line`），因為遊戲頁的 `game.css` 也定義了 `--ink`，直接共用會讓客服彈窗在遊戲頁變成深底深字。

## 6. 動畫與互動

系統開啟「減少動態效果」（`prefers-reduced-motion: reduce`）時，下列動畫一律停用，內容直接顯示。

| 效果 | 實作 | 觸發 |
|---|---|---|
| 區塊淡入 | `.reveal`；只有 `html.js` 時才先隱藏，`siteChrome.js` 捲到時加 `.is-visible` | 區塊進入畫面 |
| 背景色調漸變 | `html[data-scene]` 切換 `--scene`（以 `@property` 註冊，可以平滑過渡），`body::before` 的光暈讀它 | 區塊捲到畫面中間，讀該區塊的 `data-scene`（pink、lavender、mint、peach） |
| 頁首變化 | 頁面頂端時頁首透明；捲動超過 24px 加 `.is-scrolled`，變成較矮的毛玻璃底 | 捲動 |
| 目前區塊 | 導覽中指向該區塊的連結加 `.is-active` 與 `aria-current="location"` | 同背景色調 |
| 陪伴泡泡 | `siteSupport.js` 的 `say(text)` 在右下角小吉按鈕上方顯示約 5 秒；泡泡設 `aria-hidden`，只重複頁面已有的資訊 | 區塊捲到畫面中間，讀該區塊的 `data-companion` |
| 頭像看向游標 | `app.js` 依游標在頭像框內的位置設定 `--look-x`、`--look-y`（-1～1）：頭像框 3D 微轉、插畫反向位移，眼珠圖層往游標方向移動 | 游標在頭像框內（只在有滑鼠的裝置） |
| 頭像開心 | 點擊或用鍵盤按頭像（它是按鈕，名稱「摸摸小吉」）：加上 `.is-happy`，笑臉圖層淡入、眼珠圖層淡出，跳一下、冒出 ♡ ✦、對話卡換一句 `HAPPY_LINES` 的台詞，約 1.8 秒後恢復 | 點擊 |
| 配色切換 | 背景與文字顏色 0.5 秒過渡 | 配色鈕或台北時間到點 |

### 頭像圖層

底圖 `website/assets/xiaoji-hero.png`（1254×1254，HTML 標示 1024×1024）永遠保持原樣。其餘圖層都是同尺寸、只有局部不透明的 PNG，疊在底圖上方，並跟底圖使用同一個位移：

| 圖層 | 檔案 | 作用 |
|---|---|---|
| 眼白補丁 | `website/assets/xiaoji-hero-eyes-white.png` | 只有兩個眼眶不透明，用眼白蓋住原本畫上的虹膜。 |
| 眼珠 | `website/assets/xiaoji-hero-eyes.png` | 從底圖剪下的兩個虹膜與瞳孔，跟著游標移動：左右最多為頭像寬度的 0.72%，上下最多 0.16%（原圖虹膜上緣藏在眼皮下，往下移太多會露出切邊）。 |
| 眼眶遮罩 | `website/assets/xiaoji-hero-eyes-mask.png` | 只當 CSS `mask` 用，讓眼珠只出現在眼眶裡。 |
| 笑臉 | `website/assets/xiaoji-hero-smile.png` | 只有臉部不透明（邊緣柔化），開心時淡入。 |

眼珠沒有移動時，這幾層疊起來跟底圖幾乎一模一樣，所以載入失敗或沒有 JavaScript 時只會看到原圖。眼珠圖層（`[data-eye-layer]`）預設是 `hidden`：只有在有滑鼠、沒有開「減少動態效果」，而且眼白和眼珠兩張圖都載入成功時，`app.js` 才會顯示它，避免畫面出現只有眼白、沒有眼珠的情況。

素材的做法（換插畫時照做）：

1. 用圖片編輯 AI（例如 Nano Banana）以底圖為輸入，各產生一張「只把表情改成閉眼開心笑」與「只把虹膜和瞳孔塗成眼白、其他完全不變」的圖。產生的圖必須跟底圖對齊（沒有位移），否則重做。
2. 把產生的圖縮放成底圖的尺寸。笑臉圖只保留臉部的橢圓範圍（羽化約 28px）。
3. 用「底圖與去眼珠圖的差異」找出眼眶與虹膜：眼眶等於去眼珠圖裡的亮白區域加上差異區域；虹膜等於眼眶裡不是原圖眼白的部分。眼白補丁取去眼珠圖的眼眶範圍；眼珠圖層取底圖的虹膜範圍；遮罩取眼眶範圍並往內縮 1px。
4. 透明像素的顏色要清成 0，檔案才會小（眼睛相關的三張各約 10–25 KB）。
5. 用瀏覽器確認：眼珠在原位時跟底圖看不出差別；往四個方向看時，眼珠不會跑出眼皮外。

## 7. 搜尋與篩選

- 網址保存條件：`guide.html?q=關鍵字&cat=分類&who=public|admin`。打開網址會套用條件；之後每次修改都用 `history.replaceState` 更新網址，可以直接分享。不認得的分類或對象會被忽略。
- 關鍵字：比對整個項目的文字（名稱、用途、使用方式、限制、指令與子指令），不分大小寫與全形半形；空白分開的每個詞都要出現。以 `/` 開頭的詞（例如 `/remind`）只比對指令本身。
- 有關鍵字時，符合的功能會自動展開「如何使用」與「使用限制」。
- 首頁的搜尋框是普通的 GET 表單，送出到 `guide.html?q=`，沒有 JavaScript 也能用。

## 8. 沒有 JavaScript 時

搜尋引擎、連結預覽、閱讀模式與大多數 AI 讀網頁的工具都不執行 JavaScript，所以：

- 功能與指令清單事先寫在 HTML 裡，沒有 JavaScript 也能完整閱讀；搜尋表單在 JavaScript 啟動前是 `hidden`，不會出現一個不能用的搜尋框。
- `.reveal` 只在 `html.js` 時才先隱藏。
- 手機寬度下，沒有 JavaScript 時導覽連結直接排在頁首下方，不需要選單鈕。
- 配色依系統的淺色／深色偏好。
- 即時資料（版本、狀態）沒有 JavaScript 時不會更新，維持「讀取中」。

## 9. 常見修改

- 新增或修改功能說明：改 `website/publicFeatureCatalog.js` → `npm run site:render`。
- 新增指令：照 `docs/ARCHITECTURE.md` 第 6.1 節，最後執行 `npm run site:render`。
- 換首頁功能亮點：改 `scripts/render-website-guide.js` 的 `HOMEPAGE_HIGHLIGHTS` → `npm run site:render`。
- 新增一個頁面區塊：在 HTML 加 `<section id="…" data-scene="…" data-companion="…">`，在本文件第 3 節的表補一列；需要導覽連結就加在 `nav#site-nav`。
- 調整顏色：改 `website/styles.css` 兩套變數（夜晚值在兩個地方），更新第 5 節的表。
- 新增頁面：沿用頁首結構與 `theme.js`（`<head>`、不加 `defer`）、`siteSupport.js`、`siteChrome.js`（依序 `defer`），並在第 2、3 節補上。

## 10. 驗證

```
npm run site:render
npm run check
npm run site:check
node --test test/commandDocs.test.js test/statusData.test.js test/policyPublication.test.js
```

本機預覽：`npm run site:preview`（預設 http://localhost:4173）。本機預覽讀不到正式狀態 API（跨來源限制），即時資料會顯示「未知」，這是正常的。
