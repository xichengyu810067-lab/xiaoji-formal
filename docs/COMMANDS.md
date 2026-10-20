# 公開指令

<!-- 此檔由 scripts/render-command-docs.js 依 website/commandCatalog.js 產生；請修改目錄後執行 node scripts/render-command-docs.js，不要直接編輯。 -->

公開指令以 global commands 部署，小吉所在的每個伺服器都能執行。

- 子指令接在指令後面並以 `/` 分隔，例如 `/remind add/list/delete`。
- 標示「需管理權限」的指令或子指令，需具備 Manage Server 或 Administrator 權限（依指令而定）；小吉擁有者只在執行時不受此限，指令選單是否看得到仍取決於擁有者在該伺服器的權限。
- 整個指令都標示「需管理權限」的，一般成員在指令選單看不到。
- 只供小吉擁有者使用的指令與子指令不列在此處。

## 一般與個人化

- `/ping` - 確認小吉目前在線
- `/fortune` - 抽一則小吉籤
- `/roll` - 擲骰子
- `/weather` - 查詢天氣；可查城市或臺灣縣市行政區
- `/poll` - 建立按鈕投票
- `/remind add/list/delete` - 管理提醒
- `/calendar add/list/delete` - 管理自己的跨伺服器個人行事曆
- `/set-welcome` - 設定新人歡迎頻道；需管理權限
- `/release-announcements set/status` - 設定小吉正式 GitHub Release 公告頻道；需管理權限
- `/server` - 顯示目前伺服器資訊
- `/status` - 顯示小吉目前狀態
- `/chat-style current/set` - 查看或變更小吉與你的對話風格；永久變更，跨伺服器共用
- `/romance start/stop/status` - 管理小吉與你的跨伺服器文字戀愛模式
- `/about` - 顯示小吉的公開資訊
- `/help` - 列出小吉可用指令

## 吉幣與遊戲

- `/coins` - 查詢自己的吉幣餘額
- `/daily` - 每日簽到領取吉幣；依台灣日期每日一次，跨伺服器共用
- `/leaderboard` - 查看吉幣餘額或總資產排行榜；用 type 切換；總資產固定顯示前 25 名
- `/shop list/buy/purchases` - 吉幣商店與購買紀錄；購買請用 /shop buy
- `/shop purchases-user/purchases-all` - 管理子指令；需管理權限
- `/inventory` - 查看自己的吉幣背包；跨伺服器共用
- `/work list/start/start-venue/status/cancel/submit/submissions/edit/delete/report/tasks/payroll/penalties/appeal` - 小吉工作賺取吉幣系統；目前不開放辭職（cancel 只顯示說明），工作期滿後自動結算
- `/work status-user/status-all/task-add/tasks-all/pending/review/admin-remind/role-sync/payroll-preview/payroll-history` - 管理子指令；需管理權限
- `/bank balance/deposit/withdraw/interest/fixed-create/fixed-list/fixed-claim/fixed-cancel/fixed-rates/rate-list` - 小吉銀行：活存、定存與利率
- `/bank balance-user/balance-all/fixed-user/fixed-all/rate-history` - 管理子指令；需管理權限
- `/exchange balance/buy-chips/cashout/history` - 籌碼與吉幣兌換區
- `/casino-lobby guide/betting-area/stay/stays` - 查看小吉賭場大廳、下注區與住宿
- `/duel-tower weapons/profile/history` - 決鬥塔台的武器、進度與紀錄；開局請用 /board start
- `/casino loan-borrow/loan-repay/loan-status/history` - 賭場借款與紀錄；開局請用 /board start
- `/casino-venue menu/add-menu/order/recipe/make/serve/history` - 小吉賭場餐廳與吧檯服務
- `/casino-venue delete-menu/reassign/reassign-waiter/cancel` - 管理子指令；需管理權限
- `/luxury list/buy/inventory/history` - 奢侈品商店街
- `/pawn quote/sell/active/redeem/history` - 奢侈品當鋪
- `/board start/join/leave/status/stop` - 小吉的統一遊戲入口；開始或查看遊戲：海龜湯、西洋棋、五子棋、圍棋、六角星跳棋、象棋、俄羅斯方塊、數字配對、數獨、文字接龍、數字接龍、每日猜謎、決鬥塔台、賭場骰子、賭場角子機、賭場 21 點、賭場輪盤、賭場百家樂、賭場五張牌撲克；加入、離開或結束適用的公開桌遊與推理遊戲；/board stop 也能結束你自己的個人遊戲
- `/economy overview/user/audit` - 吉幣經濟總覽與紀錄查詢；需管理權限
- `/coin-admin history/enable/disable` - 管理吉幣系統（全域錢包變更限小吉擁有者）；history 指定 campaign-id 的活動對帳限小吉擁有者；需管理權限

具設定能力的子指令仍會檢查其既有 owner 或伺服器權限。工作資料可在所有伺服器運作；額外 Discord role 副作用由可選擴充決定。

## 社群活動

- `/word-chain stop/status` - 管理小吉文字接龍；開局請用 /board start；需管理權限
- `/number-chain stop/status` - 管理小吉安全數字接龍；開局請用 /board start；需管理權限
- `/daily-riddle enable/disable/status` - 管理小吉每日猜謎；加入或開啟當日題目請用 /board start；需管理權限
- `/daily-discussion enable/disable/status/run-now` - 管理小吉每日議題討論；需管理權限

活動設定沿用各指令既有的 Discord 權限檢查；它們不是私有伺服器管理模組。
