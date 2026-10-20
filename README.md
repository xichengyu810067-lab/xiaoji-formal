# 小吉：Discord 上的聊天好朋友

陪你聊天、玩遊戲、查天氣、記提醒，還有自己的吉幣小經濟。加入伺服器就能用，不用等審核。

官網：<https://xiaoji-zeta.vercel.app>　|　官方社群：<https://discord.gg/TqkCx9kYmk>　|　[版本更新](https://github.com/xichengyu810067-lab/xiaoji-formal/releases)

## 30 秒看懂 1.2.0 大更新

這次更新，是為了回答大家最擔心的幾件事：

| 你擔心的事 | 現在的做法 |
|---|---|
| 我的吉幣別人看得到嗎？ | **只有你自己看得到。** 連伺服器管理員也不能查別人的。 |
| 小吉會亂管我的伺服器嗎？ | **不會。** 小吉不踢人、不封鎖、不刪你的訊息，只需要最基本的權限，不必給管理員。 |
| 有人貼詐騙連結怎麼辦？ | 小吉發現假 Nitro、仿冒網址這類連結，只會**悄悄通知開發者**，不會公開點名，也不會處罰任何人。 |
| 有人想套小吉的話或洗版？ | 會被擋下，開發者收到固定格式的通知（不含任何人的聊天內容）。 |
| 這次更新有真的測過嗎？ | 有。自動化測試全過、三種電腦系統都通過，也在真的 Discord 伺服器上實際測過；舊資料升級也逐筆核對沒有遺失。 |

## 小吉能做什麼

### 聊天
叫一聲「小吉」或直接 @ 小吉，就能用自然的中文聊天。

![聊天：晚上睡不著時的放鬆建議](docs/images/ai-chat.jpg)

### 查天氣
問一句，或輸入 /weather，馬上知道台灣各地今天的天氣。

![天氣：臺北市今日預報](docs/images/weather.jpg)

### 娛樂與遊戲
抽籤、擲骰子，也能開海龜湯、棋類、俄羅斯方塊、數獨、接龍等遊戲，輸入 /board status 看有哪些可以玩。

![娛樂：抽一則小吉籤](docs/images/entertainment-fortune.jpg)

![遊戲目錄](docs/images/games-catalog.jpg)

### 吉幣
每天簽到領吉幣，可以逛商店、工作賺錢。你的吉幣只有你自己看得到。

![吉幣：只顯示自己的資料](docs/images/coins.jpg)

### 每日議題
管理員開啟後，小吉每天自動發起一個話題，大家在討論串裡聊，認真發言還有吉幣。

![每日議題：到點自動發布](docs/images/community-daily-discussion.jpg)

### 小提醒與行事曆
幫你記事情、排行程，只有你自己看得到。

### 找不到功能？
輸入 /help，小吉會把所有功能整理給你。

![指令總覽](docs/images/help-commands.jpg)

## 想知道更多？

- 小吉需要哪些權限、哪些功能不會出現在你的伺服器：[管理功能隔離說明](docs/MANAGEMENT_ISOLATION.md)
- 隱私政策與服務條款：見[官網](https://xiaoji-zeta.vercel.app)
- 這次更新的完整內容：[1.2.0 版本說明](docs/releases/1.2.0.md)
- 使用說明：[使用指南](docs/USER_GUIDE.md)

### 給想深入研究的人（技術文件）

- 自己架設、安裝、備份、升級與故障處理：[安裝與維運](docs/OPERATIONS.md)
- 程式怎麼分層、怎麼新增功能與測試：[架構說明](docs/ARCHITECTURE.md)
- 全部指令的完整清單：[指令清單](docs/COMMANDS.md)
- 程式擴充的規則：[擴充介面](docs/EXTENSION_CONTRACT.md)
- 選用的 AI 第二意見怎麼設定：[AI 第二意見設定](docs/JEV_SETUP.md)

以上截圖都來自實機測試伺服器，截圖前已遮蔽所有成員的名稱、頭像與識別碼。
