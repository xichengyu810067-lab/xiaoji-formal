# 小吉 Discord 機器人

小吉是以 `discord.js` v14 製作的聊天與社群機器人。公開功能包含 AI 對話、提醒、行事曆、投票、新人歡迎、台灣每日簽到、商店，以及在 Discord 面板內操作的個人、棋盤與推理遊戲。新局不從官網建立；既有網頁 token 局只保留給既有過渡流程。

## 安裝

需求：Node.js 24.21.0 以上、未滿 25。

```powershell
npm install
Copy-Item .env.example .env
```

```sh
npm install
cp .env.example .env
```

先建立一個位於專案外的實體資料目錄，再編輯 `.env`。`.env`、SQLite、執行期 JSON、cookies 與控制報告都不得提交。至少設定：

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_client_id
BOT_OWNER_ID=your_discord_user_id
XIAOJI_DATA_ROOT=<專案外的既有絕對資料目錄>
# 若不使用 XIAOJI_DATA_ROOT，改設兩個不同的專案外絕對檔案路徑：
# XIAOJI_REMINDERS_PATH=<專案外的絕對路徑>/reminders.json
# XIAOJI_CALENDAR_PATH=<專案外的另一個絕對路徑>/calendarEvents.json
XIAOJI_AUDIT_DATA_PATH=<專案外的絕對路徑>/guild-audit.json
XIAOJI_INVITER_WHITELIST_PATH=<專案外的另一個絕對路徑>/inviter-whitelist.json
COIN_DB_PATH=<專案外的絕對路徑>/xiaoji.sqlite
```

`XIAOJI_DATA_ROOT` 必須位於專案外；它會放置個人提醒與個人行事曆。若不使用這個根目錄，請改設兩個不同、位於專案外的絕對 `XIAOJI_REMINDERS_PATH` 與 `XIAOJI_CALENDAR_PATH`。`XIAOJI_AUDIT_DATA_PATH` 與 `XIAOJI_INVITER_WHITELIST_PATH` 也必須是不同、位於專案外的絕對路徑，且不能與其他執行期資料重疊。

首次安裝的公開資料初始化讀取 `.env`，只在審核、白名單、提醒與行事曆四份 JSON 都不存在時建立空資料與 provenance 收據。它會輸出 `XIAOJI_REMINDERS_PROVENANCE_SHA256` 與 `XIAOJI_CALENDAR_PROVENANCE_SHA256`；請直接將輸出兩行貼回 `.env`，不需要自行計算雜湊。已有或只建立部分資料時，初始化會拒絕覆寫；請保留所有檔案並人工查明，不要重跑當成修復。

吉幣資料庫也必須先在 `.env` 設定絕對 `COIN_DB_PATH`，但 `init-coin-db.js` 只讀當次程序環境。因此執行指令的路徑值必須和 `.env` 完全相同；已有資料庫時它會拒絕覆寫。

```powershell
New-Item -ItemType Directory -Force '<專案外的資料目錄>'
node scripts/init-public-data.js
# 將腳本輸出的兩個 XIAOJI_*_PROVENANCE_SHA256 值貼回 .env。
$env:COIN_DB_PATH = '<與 .env 完全相同的絕對路徑>'
node scripts/init-coin-db.js $env:COIN_DB_PATH
npm run deploy
npm start
```

```sh
mkdir -p '<專案外的資料目錄>'
node scripts/init-public-data.js
# 將腳本輸出的兩個 XIAOJI_*_PROVENANCE_SHA256 值貼回 .env。
export COIN_DB_PATH='<與 .env 完全相同的絕對路徑>'
node scripts/init-coin-db.js "$COIN_DB_PATH"
npm run deploy
npm start
```

若已有舊版 `src/data/reminders.json` 或 `src/data/calendarEvents.json`，不要使用首次初始化。先停止 Bot、所有提醒計時器與所有可能寫入資料的程序，並在仍保有舊 `src/data` 的版本中逐一執行：

```sh
node scripts/migrate-personal-data.js reminders --writers-stopped
node scripts/migrate-personal-data.js calendar --writers-stopped
```

每一項遷移都會輸出對應的 provenance SHA-256；把輸出值貼回 `.env`，並保留舊來源、受保護快照與目標檔案。若舊來源已有完整且可驗證的 `.legacy-v1.bak` 與 `.migration-v1.receipt.json`，遷移會把兩份證據一併複製到受保護目標，日後舊 release 移除仍可驗證；缺件、內容不一致或發現未知側檔時會保留證據並停止。`--writers-stopped` 只代表操作者已確認停止寫入，腳本不會自行停止 Bot 或計時器。這是本機遷移能力，不代表任何環境已完成遷移。

Discord Developer Portal 需開啟 Server Members Intent 與 Message Content Intent；OAuth2 scopes 使用 `bot` 與 `applications.commands`。

## 公開指令

- 實用：`/help`、`/ping`、`/status`、`/weather`、`/poll`、`/remind`、`/calendar`、`/set-welcome`。提醒的新增會送到建立時的文字頻道，但本人可跨伺服器列出或刪除自己的提醒；`/calendar personal-*` 是只有本人可查詢的跨伺服器個人行事曆。
- 聊天：`/chat-style`、`/romance`、提及小吉
- 社群：`/word-chain`、`/number-chain`、`/daily-riddle`、`/daily-discussion`
- 吉幣與商店：`/coins`、`/daily`、`/leaderboard`、`/shop`、`/buy`、`/inventory`、`/bank`、`/exchange`、`/work`。每日簽到依台灣日期計算，每人每天一次；吉幣帳務、商店／背包、銀行帳務與籌碼依帳號在可使用小吉的伺服器間共用。工作每人同一時間只有一個全域主職。
- 遊戲：先在 Discord 使用 `/games menu` 選擇個人、棋盤或推理遊戲；個人遊戲也可用 `/games play` 開始，並以 `/games resume` 在同一頻道重新顯示面板。多人棋盤與推理遊戲使用 `/board start/join/leave/status/stop`。不為新使用者建立網頁遊戲局。
- 公開版本資訊：請由 [GitHub 上 `xiaoji-formal` 的 Release 頁](https://github.com/xichengyu810067-lab/xiaoji-formal/releases)閱讀。

完整的玩家功能、玩法與限制會列在官網狀態頁的公開功能清冊。

## 部署與驗證

`npm run deploy` 將公開指令註冊為 global commands。未設定本機私有擴充時，程式仍可載入並啟動公開核心。

```powershell
npm test
npm run check
npm run site:check
```

測試不會登入 Discord 或啟動正式 bot。公開狀態資料缺失時維持未知／維護狀態，不以零值或健康狀態替代。

## 擴充介面

公開核心提供可選的本機擴充介面，契約見 [docs/EXTENSION_CONTRACT.md](docs/EXTENSION_CONTRACT.md)。公開匯出工具只接受 allowlist，拒絕環境檔、資料檔、私有模組、正式維運腳本與內部報告。
