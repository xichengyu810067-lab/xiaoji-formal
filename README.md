# 小吉 Discord 機器人

小吉是以 `discord.js` v14 製作的聊天與社群機器人。公開功能包含 AI 對話、提醒、行事曆、投票、新人歡迎、台灣每日簽到、商店、棋盤與推理遊戲，以及既有的瀏覽器小遊戲。

## 安裝

需求：Node.js 20.18.1 以上。

```powershell
npm install
copy .env.example .env
npm run deploy
npm start
```

`.env`、SQLite、執行期 JSON、cookies 與控制報告都不得提交。至少設定：

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_client_id
BOT_OWNER_ID=your_discord_user_id
```

Discord Developer Portal 需開啟 Server Members Intent 與 Message Content Intent；OAuth2 scopes 使用 `bot` 與 `applications.commands`。

## 公開指令

- 實用：`/help`、`/ping`、`/status`、`/weather`、`/poll`、`/remind`、`/calendar`、`/set-welcome`
- 聊天：`/chat-style`、`/romance`、提及小吉
- 社群：`/word-chain`、`/number-chain`、`/daily-riddle`、`/daily-discussion`
- 吉幣與商店：`/coins`、`/daily`、`/leaderboard`、`/shop`、`/buy`、`/inventory`。每日簽到依台灣日期計算，每人每天一次；普通與精品商品、背包和限購會跟著帳號跨伺服器共用。
- 遊戲：`/board start/join/leave/status/stop` 可在同一頻道建立棋盤或推理遊戲；`/games play` 仍保留俄羅斯方塊、數字配對與數獨的既有入口。
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
