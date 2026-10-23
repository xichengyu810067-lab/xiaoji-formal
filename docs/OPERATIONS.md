# 小吉：安裝、維運與技術說明

> 這份文件給「要自己架設、維運或研究小吉」的人。只想知道小吉能做什麼，請看[首頁介紹](../README.md)。

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

先在專案外建立本機的實體資料夾，再編輯 `.env`。`.env`、SQLite、執行期 JSON、cookies 與控制報告都不得提交。至少設定：

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_client_id
BOT_OWNER_ID=your_discord_user_id
COIN_DB_PATH=<專案外的絕對路徑>/xiaoji.sqlite
XIAOJI_REMINDERS_PATH=<專案外的絕對路徑>/reminders.json
XIAOJI_CALENDAR_PATH=<專案外的另一個絕對路徑>/calendarEvents.json
XIAOJI_AUDIT_DATA_PATH=<專案外的絕對路徑>/guild-audit.json
XIAOJI_INVITER_WHITELIST_PATH=<專案外的另一個絕對路徑>/inviter-whitelist.json
```

- `COIN_DB_PATH` 必須是程式資料夾外的絕對路徑。小吉會在同一個資料夾自動建立安全帳本（見「受保護的副作用與安全帳本」），所以這個資料夾必須在本機磁碟上，不能是網路磁碟、junction 或同步資料夾。
- 吉幣資料庫的每一次寫入都是耐久寫入：先把整份資料庫寫進同一個資料夾的 `xiaoji.sqlite.tmp` 並強制寫入磁碟（fsync），再用改名取代原檔，最後對資料夾做 fsync，讓改名本身也寫進磁碟。Windows 不能對資料夾做 fsync，改為把取代後的檔案再寫入磁碟一次，屬於盡力而為。記憶體的內容和上一次成功寫入的內容相同時，不會寫檔。
- 斷電或系統當機時，磁碟上只會留下某次寫入前或寫入後的完整檔案，不會留下寫到一半的檔案；已經回覆成功的吉幣操作，重新開機後仍然存在。前提是磁碟確實照 fsync 寫入，這也是資料夾必須在本機磁碟上的原因。唯一的例外是第一次初始化：新檔直接建立（確保絕不覆蓋既有資料庫），建立途中斷電可能留下不完整的新檔，下次啟動會拒絕載入，這時檔案裡還沒有任何資料。以下情況，重新開機後可能退回上一次寫入的版本：
  - 改名後對資料夾的 fsync 失敗：這筆操作仍算成功（檔案已經包含它），log 會記 `[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_FAILED` 與 `[COIN_DB] code=COIN_DB_ESCALATION`，下一次寫入會再做一次 fsync。停止時還會記一行 `[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=coin-database cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=open|runtime`，並以結束碼 3 結束（見「通知、狀態頁與結束碼」）。
  - 檔案系統不支援對資料夾做 fsync（回應 `EINVAL` 之類）：寫入照常完成，只記一次 `[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_UNSUPPORTED`。安全帳本的登記寫入也照這個規則處理，這是登記寫入原本行為的變更：以前在這種檔案系統上，登記會寫入失敗，相關用途因而停用（`LEDGER_REGISTRATION_WRITE_FAILED`）。遇到真正的 I/O 錯誤時，登記寫入仍照原本的規則失敗並停用。不過安全帳本本身需要資料夾 fsync，在這種檔案系統上受保護的副作用仍會在啟動時全部停用，所以不能用來正式執行（status 會以 `DIRECTORY_SYNC_UNSUPPORTED`、結束碼 2 提醒）。
  - Windows 上取代後那次寫入磁碟失敗：不會通報。
- 開發時的測試在 Windows 上執行；Linux 等 POSIX 系統上的寫入順序與錯誤處理，由模擬檔案系統的測試涵蓋。
- `XIAOJI_REMINDERS_PATH` 與 `XIAOJI_CALENDAR_PATH` 是兩個不同、位於專案外的絕對路徑。`XIAOJI_AUDIT_DATA_PATH` 與 `XIAOJI_INVITER_WHITELIST_PATH` 也必須是不同、位於專案外的絕對路徑，且不能與其他執行期資料重疊。這兩份是舊版的伺服器審核紀錄與邀請者白名單：小吉不再審核伺服器，檔案裡的內容（核准、拒絕、未知）全部視同可用，只保留供查閱，不會被改寫，也不再影響任何功能。
- `XIAOJI_DATA_ROOT` 會同時改變個人提醒、個人行事曆與安全帳本的位置。已經在使用中的小吉不要新設這個變數，原因見「升級與資料位置」。
- 受保護的副作用預設開啟，不需要任何開關或離線初始化；總開關 `XIAOJI_PROTECTED_EFFECTS` 的用法見「受保護的副作用與安全帳本」。

首次安裝的公開資料初始化讀取 `.env`，只在舊版審核紀錄、白名單、提醒與行事曆四份 JSON 都不存在時建立空資料與 provenance 收據（小吉已不審核伺服器，前兩份只保留舊紀錄的讀取，但仍會建立）。它會輸出 `XIAOJI_REMINDERS_PROVENANCE_SHA256` 與 `XIAOJI_CALENDAR_PROVENANCE_SHA256`；請直接將輸出兩行貼回 `.env`，不需要自行計算雜湊。已有或只建立部分資料時，初始化會拒絕覆寫；請保留所有檔案並人工查明，不要重跑當成修復。

吉幣資料庫也必須先在 `.env` 設定絕對 `COIN_DB_PATH`，但 `init-coin-db.js` 只讀當次程序環境。因此執行指令的路徑值必須和 `.env` 完全相同；已有資料庫時它會拒絕覆寫。建立之後若對資料夾的 fsync 失敗，資料庫雖已建立，它仍會印出一行 `[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=coin-database cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=open`，並以結束碼 3 結束；先查明磁碟，再啟動小吉。

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

第一次 `npm start` 時，小吉會在 `COIN_DB_PATH` 所在的資料夾自動建立 8 份安全帳本，Owner 會收到一則建立通知（見「受保護的副作用與安全帳本」）。

若已有舊版 `src/data/reminders.json` 或 `src/data/calendarEvents.json`，不要使用首次初始化。先停止 Bot、所有提醒計時器與所有可能寫入資料的程序，並在仍保有舊 `src/data` 的版本中逐一執行：

```sh
node scripts/migrate-personal-data.js reminders --writers-stopped
node scripts/migrate-personal-data.js calendar --writers-stopped
```

每一項遷移都會輸出對應的 provenance SHA-256；把輸出值貼回 `.env`，並保留舊來源、受保護快照與目標檔案。若舊來源已有完整且可驗證的 `.legacy-v1.bak` 與 `.migration-v1.receipt.json`，遷移會把兩份證據一併複製到受保護目標，日後舊 release 移除仍可驗證；缺件、內容不一致或發現未知側檔時會保留證據並停止。`--writers-stopped` 只代表操作者已確認停止寫入，腳本不會自行停止 Bot 或計時器。這是本機遷移能力，不代表任何環境已完成遷移。

Discord Developer Portal 需開啟 Server Members Intent 與 Message Content Intent；OAuth2 scopes 使用 `bot` 與 `applications.commands`。

## 受保護的副作用與安全帳本

下列 8 個「用途」會在 Discord 上留下無法收回的結果。小吉替每個用途各保留一份安全帳本，記下每個事件是否已開始送出與送出的結果，讓當機、重新啟動或網路中斷之後既不重送，也不會把沒送出的事件當成已送出。

| 用途 | 功能 |
|---|---|
| `owner-safety` | Owner 安全通知：AI 安全提示與帳本通知的私訊（升級後預設開啟，見「舊版設定」） |
| `welcome` | 新人歡迎 |
| `work.penalty.announce` | 扣薪公告 |
| `work.reminder.dm.prepare` | 工作提醒的私訊頻道準備 |
| `work.reminder.dm.send` | 工作提醒私訊 |
| `audit.guild.leave` | 自動離開伺服器（休眠：小吉不再審核伺服器，沒有任何程式會送出離群請求；用途與帳本保留） |
| `word-chain.reaction` | 文字接龍的 ✅ |
| `number-chain.reaction` | 數字接龍的 ✅ |

這些功能預設開啟，不需要任何設定或離線初始化：第一次啟動時，小吉會自動建立帳本。某個用途的帳本有問題時，只有那個用途停用：它的事件回報為暫時無法使用，不會被當成已處理，也不會改走未受保護的發送路徑；聊天、吉幣、指令與其他用途照常運作。

### 總開關 `XIAOJI_PROTECTED_EFFECTS`

- 未設定或空白時為開啟。值只有 `on` 與 `off`，不分大小寫，前後空白不計。
- 其他任何值都當作 `off`，並在啟動時記一行 `[SAFETY_LEDGER] code=LEDGER_PROTECTED_EFFECTS_INVALID treated=off`。
- `off` 時 8 個用途全部停用，包括新人歡迎與 Owner 安全通知（含 AI 安全提示）：
  - 不建立、不開啟、不讀取任何帳本檔案或資料夾，也不讀寫吉幣資料庫裡的帳本登記；
  - 不送任何受保護的 Discord 請求，緊急私訊也不送；
  - 狀態頁的新人歡迎、文字接龍與數字接龍顯示維護中；
  - 聊天、AI 對話、吉幣、指令與其他功能照常。文字接龍與數字接龍維持現狀：進行中的一局照常接受答案，只是不加 ✅；新的一局不能開始（用 /board start 開局時，小吉會回覆公開回應安全狀態無法建立）。
- `off` 期間的新人歡迎與 Owner 通知不會補送。扣薪公告、工作提醒與 ✅ 不會被用掉，改回 `on` 之後，仍在期限內的照各自規則送出（扣薪公告最晚到申訴期限，✅ 最多到訊息送出後 24 小時）。若帳本是在改回 `on` 時才第一次建立，cutover 就是建立的時間，之前的事件一律不補送。
- 適用時機：帳本出現需要人工處理的異常，又必須先讓小吉上線時（例如見到 `LEDGER_QUARANTINE_UNPERSISTED`，見「執行規則與異常處理」）。

### 資料位置

- 帳本放在「資料根」底下的兩個資料夾：`safety/` 放帳本本體、旁邊的 witness 與 provenance 收據；`safety-witness/` 放另一份 continuity witness。檔名是用途的固定名稱，例如 `safety/welcome.sqlite`。
- 資料根是 `XIAOJI_DATA_ROOT`；沒有設定時，就是 `COIN_DB_PATH` 所在的資料夾。建議不設 `XIAOJI_DATA_ROOT`，讓帳本跟著吉幣資料庫。
- 選填 `XIAOJI_SAFETY_LEDGER_DIR`、`XIAOJI_SAFETY_WITNESS_DIR` 可以改用其他既有的資料夾。
- 兩個資料夾都必須是本機的實體資料夾（不能是網路磁碟、junction 或其他連結），不能相同或互相包含，都要在程式資料夾外；正式環境也不能用到 test-control 的測試資料根。
- 沒有設定 `XIAOJI_DATA_ROOT`、而吉幣資料庫又在程式資料夾內時（包括沒設 `COIN_DB_PATH`，使用預設的 `data/xiaoji.sqlite`），8 個用途全部以 `LEDGER_PATH_IN_PROJECT` 停用，程式資料夾內不會建立任何帳本檔案，Owner 會收到一則緊急私訊。處理方式見下方「升級與資料位置」。
- `COIN_DB_PATH` 請一律使用絕對路徑。相對路徑會以程式資料夾為基準解析：`data\xiaoji.sqlite` 在程式資料夾內，`..\xiaoji-data\xiaoji.sqlite` 則在程式資料夾外；但維運腳本 status 一律拒絕相對路徑（結束碼 1）。
- 吉幣資料庫、`safety/` 與 `safety-witness/` 必須一起備份、一起還原（見「停止、備份與還原」）。
- 小吉的身分以 Bot token 呼叫 `GET /users/@me` 取得，不需要新變數。讀不到時（最多試 3 次、合計 10 秒內）改用 `DISCORD_CLIENT_ID`（或舊名 `CLIENT_ID`），並記一行 `[SAFETY_LEDGER] code=LEDGER_BOT_IDENTITY_FALLBACK source=configured`，不會印出 token。
  - 改用 `DISCORD_CLIENT_ID` 時，這個 ID 可能填錯，所以只開啟已經存在的帳本，不建立、不完成建立、也不處理 reinit 請求；帳本還沒建立、建立未完成或有 reinit 請求的用途以 `LEDGER_IDENTITY_UNVERIFIED` 停用並通報，下次能用 token 讀到身分的啟動才會處理，不需要另外 reinit。
  - 兩者都不可用時，8 個用途全部以 `LEDGER_IDENTITY_INVALID` 停用。登入完成時，若登入的身分和開啟帳本時用的不同，8 個用途全部以 `LEDGER_BOT_MISMATCH` 停用。
  - 登入前的身分查詢（最多 10 秒）加上帳本被另一個程序占用時的等候（`LEDGER_IN_USE`，最多 30 秒），最壞會讓小吉晚約 40 秒上線。

### 升級與資料位置

從 1.1.2 之前的版本升級時，若吉幣資料庫還在程式資料夾內（例如 `data\xiaoji.sqlite`），只要把這一個檔案搬到程式資料夾外，再在 `.env` 設定 `COIN_DB_PATH` 即可；其他資料都不用動。下列步驟以 PowerShell 為例，`<程式資料夾>`、`<備份資料夾>`、`<新資料夾>` 請換成實際路徑：

1. **先跑唯讀檢查。** 換上新版程式後，在程式資料夾執行 `npm run safety:ledger -- status`，再用 `$LASTEXITCODE` 看結束碼。這個指令只讀取，不會建立或修改任何檔案。
   - 顯示 `帳本目錄無法使用：LEDGER_PATH_IN_PROJECT (base)`、結束碼 2：吉幣資料庫在程式資料夾內，照第 2 步以後搬移。
   - 顯示「吉幣資料庫路徑必須是絕對路徑」、結束碼 1：`COIN_DB_PATH` 是相對路徑（小吉以程式資料夾為基準解析它）。先把它改成指向同一個檔案的絕對路徑，再跑一次 status，依結果處理。
   - 列出 8 個用途、全部是 `absent`、結束碼 0：資料庫（或既有的 `XIAOJI_DATA_ROOT`）已在程式資料夾外，不需要搬移；**先停止小吉（第 2 步）**，再跳到第 8 步。新舊版本不可同時執行。
   - 顯示 `資料夾同步：code=DIRECTORY_SYNC_FAILED` 或 `DIRECTORY_SYNC_UNSUPPORTED`、結束碼 2：**不要啟動**。`DIRECTORY_SYNC_FAILED` 表示資料所在的檔案系統無法確實寫入資料夾（`errno=ENOENT` 表示資料夾不存在）。`DIRECTORY_SYNC_UNSUPPORTED` 表示吉幣資料庫所在的檔案系統不支援資料夾 fsync：吉幣資料庫在這種檔案系統上仍會寫入（盡力而為），但安全帳本需要資料夾 fsync，受保護的副作用會在啟動時全部停用。請改用本機磁碟上的資料夾，再跑一次 status。Windows 上一律是 `DIRECTORY_SYNC_NOT_APPLICABLE`，結束碼不變。
   - 結束碼不是 0 時，npm 會多印幾行錯誤訊息，這是正常的。
2. **停止小吉**，以及其他所有可能寫入吉幣資料庫的程式。若 `data\xiaoji.sqlite.tmp` 存在，表示之前有寫入中斷，先停下來查明，不要繼續。
3. **備份並記下雜湊。** 把資料庫複製到程式資料夾外的備份資料夾，並記下雜湊值：

   ```powershell
   Copy-Item '<程式資料夾>\data\xiaoji.sqlite' '<備份資料夾>\xiaoji.sqlite'
   Get-FileHash '<備份資料夾>\xiaoji.sqlite'
   ```

4. **建立新資料夾。** 在程式資料夾外建立本機的實體資料夾，例如 `New-Item -ItemType Directory '<新資料夾>'`。不可使用 junction 或其他連結、網路磁碟，或 OneDrive 之類的同步資料夾；也不可與 test-control 的測試資料根互相包含。
5. **搬移並比對雜湊。** 用 `Move-Item` 搬，不要用複製：舊檔若留在原處，日後被誤用會讓吉幣資料回到舊狀態。搬完確認雜湊和第 3 步相同：

   ```powershell
   Move-Item '<程式資料夾>\data\xiaoji.sqlite' '<新資料夾>\xiaoji.sqlite'
   Get-FileHash '<新資料夾>\xiaoji.sqlite'
   ```

6. **設定 `COIN_DB_PATH`。** 在 `.env` 寫入 `COIN_DB_PATH=<新資料夾>\xiaoji.sqlite`，必須是絕對路徑。
7. **再跑一次檢查。** 執行 `npm run safety:ledger -- status`：帳本目錄應顯示 `<新資料夾>\safety`，8 個用途都是 `absent`，結束碼 0。
8. **啟動並確認。** 確認舊版已停止後，執行 `npm start`。log 應出現 8 行含 `code=LEDGER_CREATED` 的 `[SAFETY_LEDGER]` 記錄（每個用途一行）；Owner 會收到一則「小吉安全帳本通知（本次啟動）」列出已建立的用途，**不會**收到「小吉緊急安全提示」。狀態頁的新人歡迎與接龍顯示正常。

完成後：

- 之後備份時，`<新資料夾>` 裡的吉幣資料庫、`safety` 與 `safety-witness` 要一起備份。自己的備份或重置腳本若寫死 `data\xiaoji.sqlite`，也要改成新位置。
- 沒搬就啟動，或搬回程式資料夾內：受保護功能以 `LEDGER_PATH_IN_PROJECT` 停用，Owner 收到一則緊急私訊（6 小時內不重複），程式資料夾內不會建立任何帳本；聊天與其他功能照常。之後照上面步驟補做即可：帳本還沒建立過，或搬回當初建立帳本的同一個資料夾時，不需要 reinit。帳本建立後若改搬到另一個資料夾，登記的位置不符，所有用途會以 `LEDGER_PATH_MISMATCH` 停用，需要 reinit（新的 cutover，舊位置的檔案請人工歸檔）。
- 回滾：停止小吉，把 `.env` 的 `COIN_DB_PATH` 改回原本的設定（原本沒有就移除），再把檔案搬回原處。`<新資料夾>` 裡已建立的 `safety` 與 `safety-witness` 留著，不要刪除。

**不要新設 `XIAOJI_DATA_ROOT`。** 這個變數不只決定帳本的位置，也決定個人提醒與個人行事曆的位置。新設之後，小吉會改從那個資料夾以受保護模式讀取提醒與行事曆；資料還沒遷移過去，或 `.env` 缺少對應的 provenance SHA-256 時，小吉會拒絕登入（`DATA_FILE_MISSING`、`PERSONAL_DATA_PROVENANCE_REQUIRED`），比受保護功能停用更嚴重。安全帳本只需要吉幣資料庫在程式資料夾外，所以只搬吉幣資料庫就夠了。

### 第一次啟動

- 某個用途的帳本、`safety-witness/` 裡的 witness，以及吉幣資料庫裡的登記三者都不存在時，小吉才會自動建立帳本，並為每個用途記一行 `[SAFETY_LEDGER] purpose=<用途> code=LEDGER_CREATED`。只要其中任何一樣存在，就不會自動建立（見「每次啟動的檢查」）。
- **cutover**：新人歡迎、扣薪公告、工作提醒的兩個用途，以及兩種接龍 ✅ 的 cutover 是帳本建立的時間。在這之前發生的事件一律不補送：升級前建立的扣薪不發公告；升級前建立的工作任務不會收到提醒私訊（提醒次數照常計入）；升級前加入的成員不發歡迎；升級前送出的接龍訊息不加 ✅。判斷依據是事件本身的時間（扣薪與任務的建立時間、Discord 的加入時間、訊息的 snowflake 時間）；重試或恢復的時間不會讓舊事件變成新事件。
- 離群用途（休眠）與 Owner 安全通知沒有 cutover。小吉不再審核伺服器，也不再自動離開任何伺服器：升級前留下的審核紀錄（核准、拒絕、未知）全部保留、只供查閱，不影響任何功能，升級後第一次啟動也不會有任何伺服器被離開。
- Owner 會收到一則合併的「小吉安全帳本通知（本次啟動）」，列出已建立的用途與各自的 cutover。
- 建立途中被中斷（當機、停電）時，下次啟動會接著完成（`LEDGER_CREATION_RESUMED`），cutover 不變。

### 每次啟動的檢查

每次啟動、登入 Discord 之前，小吉會為每個用途比對三樣紀錄：帳本檔案（本體、旁邊的 witness、provenance 收據）、`safety-witness/` 裡的 continuity witness，以及吉幣資料庫裡的登記（含上次停止時寫下的 lastSeen）。只要有一樣不一致，該用途就停用（fail closed），不會自動重建或修復，也不影響其他用途。每個停用的用途在 log 記一行 `[SAFETY_LEDGER] purpose=<用途> code=<代碼> reason=<原因>`，只記代碼，不記路徑、ID 或內容。

| 代碼 | 意思 | 處置 |
|---|---|---|
| `LEDGER_PATH_IN_PROJECT` | 帳本位置在程式資料夾內 | 照「升級與資料位置」搬移吉幣資料庫 |
| `LEDGER_PATH_INVALID`、`LEDGER_PATH_LINKED`、`LEDGER_PATH_REMOTE`、`LEDGER_PATH_OVERLAP` | 資料夾不存在、經過 junction 或連結、位於網路磁碟，或兩個資料夾重疊 | 改用本機的實體資料夾 |
| `LEDGER_TEST_ROOT_IN_PRODUCTION` | 正式環境用到了測試資料根 | 把 `COIN_DB_PATH` 改回正式吉幣資料庫的位置 |
| `LEDGER_IDENTITY_INVALID` | 無法確認小吉或 Owner 的身分 | 確認 Bot token、`DISCORD_CLIENT_ID` 與 `BOT_OWNER_ID` |
| `LEDGER_IDENTITY_UNVERIFIED` | 無法用 Bot token 讀取身分，改用 `DISCORD_CLIENT_ID`；為了不讓帳本綁到錯的 ID，只開啟既有帳本，這個用途的帳本不建立 | 確認網路與 Bot token；下次讀得到身分的啟動會自動建立 |
| `LEDGER_BOT_MISMATCH` | 登入完成時的身分和開啟帳本時用的身分不同（8 個用途全部停用）；通常是讀不到身分時改用的 `DISCORD_CLIENT_ID` 填錯 | 確認 `DISCORD_CLIENT_ID` 是這個機器人的應用程式 ID |
| `LEDGER_IN_USE` | 另一個程序持有帳本，等候 30 秒仍未釋放 | 可能有第二個小吉在執行；只保留一個 |
| `LEDGER_REGISTRATION_MISSING` | 有帳本檔案，吉幣資料庫卻沒有登記（例如換了吉幣資料庫，或只還原了吉幣資料庫） | 不可刪除或重建；用 status 查明後 reinit |
| `LEDGER_FILES_MISSING`、`LEDGER_PARTIAL` | 有登記，帳本檔案卻全部或部分不見 | 先設法找回檔案；確定找不回才 reinit |
| `LEDGER_TEMP_PRESENT` | 留有建立中斷或來源不明的暫存檔 | 用 status 查看，保留複本後 reinit |
| `LEDGER_PATH_MISMATCH` | 帳本位置和登記不同（搬過資料夾或吉幣資料庫） | 搬回原位置，或 reinit |
| `LEDGER_RECEIPT_MISMATCH`、`LEDGER_IDENTITY_MISMATCH` | 收據被改動或換掉，或帳本屬於另一個 bot、Owner、用途或模式 | 保留現況查明；確認後 reinit |
| `LEDGER_ROLLBACK` | 帳本比 witness 或登記舊，或是分叉出去的副本（被還原成舊版） | 不可重建帳本或刪除 witness；查明後 reinit |
| `LEDGER_CORRUPT`、`LEDGER_FORMAT_OUTDATED`、`LEDGER_FORMAT_UNKNOWN` | 帳本損毀，或格式不是這一版 | 保留完整複本後 reinit |
| `LEDGER_QUARANTINED` | 帳本被隔離 | 查明後 release-quarantine（見「執行規則與異常處理」） |
| `LEDGER_REGISTRATION_INVALID`、`LEDGER_REGISTRATION_READ_FAILED`、`LEDGER_REGISTRATION_WRITE_FAILED` | 吉幣資料庫裡的登記無法解析、讀取或寫入 | 檢查吉幣資料庫與磁碟；登記無法解析時用 reinit |
| `LEDGER_CREATE_FAILED`、`LEDGER_OPEN_FAILED` | 建立或開啟失敗（磁碟、權限） | 修復後重新啟動 |
| `LEDGER_BOOTSTRAP_FAILED` | 整個檢查意外失敗，8 個用途全部停用 | 看 log，修復後重新啟動 |

其他代碼（例如 `LEDGER_WITNESS_INVALID`、`LEDGER_MISSING`）一律先執行 status 並保留完整複本，不要刪除或重建任何檔案。啟動途中收到停止要求而放棄等候鎖（`LEDGER_IN_USE`，原因 `stopping`）不算異常。

### 通知、狀態頁與結束碼

- **Owner 私訊**：經由 Owner 帳本送出，文字固定，只有用途名稱、代碼、cutover 時間與處置說明，不含路徑或確認碼。新伺服器加入通知與成員退出通知附上伺服器 ID、伺服器名稱與各自相關的 ID（都見下方），其他通知都不含任何 ID。
  - 每次啟動最多一則合併通知，列出已建立的用途、停用的用途（包括帳本已交付、卻被功能本身拒收的用途）、維運提示，以及 lastSeen 沒能寫入。
  - 執行中某個用途停用時，每個用途送一則；同一用途 10 分鐘內只送一則。
  - 這些通知與其他安全事件共用 Owner 通知的預算：每分鐘 1 則、每小時 6 則、每天 24 則。預算用完時那則通知不送，之後也不補送，所以短時間內反覆重啟時，後面幾次啟動的通知可能看不到；請以 log 為準。
  - 安全事件只在需要 Owner 知道或處理時私訊，開頭依事件種類固定：審核事件（`AUDIT_*`）與其他異常（例如 `ARCHIVE_UNAVAILABLE`）。所有 `AI_*` 與 `EGRESS_*` 代碼都不再各自私訊（下方各項說明），攻擊與誤用改由「安全警示」通知。`AUDIT_GUILD_JOINED` 與 `AUDIT_AUTO_LEFT` 兩個舊的伺服器審核代碼仍留在固定目錄與通知器，但小吉不再審核伺服器，沒有任何程式送出它們。伺服器名稱只當參考，放在最後並用「」括起來：提及、Markdown 符號、看不見的控制字元與「；」「：」這類分隔符號會先拿掉；以 `http://` 或 `https://` 開頭的連結整段刪除，`www.` 開頭的網址、Discord 邀請連結（例如 `discord.gg/…`）與沒有 `https://` 的網址（例如 `example.com/xxx`）換成「[連結已移除]」；仍清不乾淨時不附名稱。
  - 成員退出（`OWNER_EVENT_MEMBER_LEFT`）、新伺服器加入（`OWNER_EVENT_GUILD_JOINED`）與恢復營運（`OWNER_EVENT_RECOVERED`）是三種各自獨立的事件，不屬於上面任何一類，也不經過 AI 對話。通知器支援這三種事件。三種事件的來源都已接上（見下兩項「成員退出通知的來源」「新伺服器加入通知的來源」，以及「突發停運恢復後的通知」一節）。開頭各自固定：「小吉成員退出通知」「小吉新伺服器加入通知」「小吉恢復營運通知」。欄位與順序固定，缺少的值寫「未知」：固定代碼、伺服器 ID（有才附）、成員 ID（退出）或邀請者 ID（加入）、退出時間或加入時間（Discord 的時間戳記）、成員數、停運起訖與類型（恢復營運通知，類型只用固定詞彙：程式異常結束後重新啟動、與 Discord 連線中斷後恢復、手動還原後恢復）、「另有 N 則同類事件已合併」。成員名稱、成員帳號與伺服器名稱放在最後，各自用「」括起來，清理規則同上；仍清不乾淨的不附。ID 只寫數字，不用提及的寫法，也不會提及任何人。
  - 這三種事件各有自己的預算，不占用、也不被上面共用的 Owner 通知預算占用：成員退出每分鐘 2 則、每小時 12 則、每天 48 則；新伺服器加入每分鐘 1 則、每小時 6 則、每天 24 則；恢復營運每分鐘 1 則、每小時 2 則、每天 4 則。同一個成員 10 分鐘內重複退出只算一則，不同成員各算各的；同一伺服器 10 分鐘內重複的加入，與同一次停運的重複恢復，也各合併成一則。超過預算的事件不送，之後也不補送。被擋下的事件與已合併的重複事件，會計入下一則同類通知的「另有 N 則同類事件已合併」；這個計數只存在記憶體，重新啟動後歸零。每日預算依帳本計算，重新啟動不會歸零，但記憶體裡的額度會：重新啟動後進來的事件先通過記憶體額度，再由帳本的額度擋下。安全事件與這三種事件被記憶體額度擋下，或被帳本額度擋下時（包含沒有重新啟動、與其他通知共用 Owner 通知預算的情況），log 記 `[OWNER_SAFETY] code=OWNER_NOTICE_BUDGET_EXCEEDED category=<類別> skipped=<略過的則數>`（每個類別每分鐘最多一行，`skipped` 是上一行之後略過、沒有記的則數，不含事件內容），被帳本擋下的也計入上述計數。這個計數最後一次累計後只保留 24 小時；已累計的數字若隨一則通知被領走、而那則通知被帳本的合併時間窗合併、送出前失敗或佇列已滿而沒有送出，只有「被帳本額度擋下」的情況會補回，其他情況會遺失（計數偏少，不會偏多）。重新啟動後 10 分鐘內，被帳本的合併時間窗合併的重複事件不算額度擋下，不記 log，也不計入。帳本通知（啟動、停用用途）沒有類別，不在此列。
  - **成員退出通知的來源**：只有「擁有者伺服器」（`XIAOJI_OWNER_GUILD_ID`，見「擁有者伺服器」一節）裡的成員退出會私訊 Owner；其他伺服器的退出完全不通知，未設定或格式不合時整個停用，不會退回任何預設伺服器。退出、被踢出與被封鎖無法區分，一律算退出；機器人帳號不通知。通知附上成員的顯示名稱與帳號、ID、退出時間，以及加入時間（小吉沒有這位成員的資料時寫「未知」，名稱也寫「未知」）。同一個 Discord ID 從它的第一次退出起算 7 × 24 小時的固定窗口：窗口內最多通知 3 次，第 4 次起不通知；窗口過期後，該 ID 的下一次退出重新開窗（不是滾動窗口，也不是日曆週）。計數在退出事件交給通知器時就算：先記數、再交出。**實際收到的 DM 可能少於 3 則**：同一成員 10 分鐘內連續退出會被通知器合併成一則（仍用掉窗口的次數），超過成員退出預算的、沒能送出的也一樣用掉次數。窗口與次數存在 `src/data/leaveNotices.json`，重新啟動後仍有效；窗口過期後就不再有用：載入時剔除，寫出的檔案也不含已過期的窗口（時鐘被往回調而還沒開始的窗口不算過期，照常寫出）；同時追蹤最多 5,000 個窗口，滿了先清過期的，再淘汰開窗最早的（被淘汰的 ID 下一次退出會重新開窗）。要依請求移除某人的記錄，停止小吉後手動編輯（或刪除）這個檔案，**以及同一個資料夾裡的 `leaveNotices.json.corrupt`**（檔案損毀時留下的副本，也含成員 ID，只留最近一份）。檔案內容損毀時從空白開始，原檔改名為 `leaveNotices.json.corrupt`（只留最近一份）供事後查驗，並記一行固定代碼（`[RETAINED_DATA] code=MEMBER_LEAVE_NOTICES_FILE_INVALID kept=corrupt`）；暫時讀不到（Windows 上掃毒或備份程式占用）時會先重試 3 次，仍讀不到就不覆蓋舊檔（`..._FILE_UNREADABLE`、`..._WRITE_DEFERRED`），等讀得到時把這段期間的新窗口併進舊檔再寫入（併入失敗記 `..._FILE_MERGE_FAILED`，仍不寫入、30 秒後重試）。寫入失敗記 `..._WRITE_FAILED`，30 秒後重試。窗口用完而略過的通知記 `[MEMBER_LEAVE] code=MEMBER_LEAVE_NOTICE_CAPPED skipped=<略過的則數>`（每分鐘最多一行），交給通知器時失敗記 `[MEMBER_LEAVE] code=MEMBER_LEAVE_NOTICE_HANDOVER_FAILED`。寫入是合併的（變更後約 2 秒一次，停止時補寫），小吉異常結束前最後約 2 秒的記錄可能遺失。小吉的 client 設了 `partials: [Partials.GuildMember]`：沒有它，discord.js 不會為快取裡沒有的成員（較大的伺服器裡多數在小吉啟動前就加入的成員）送出退出事件；這樣收到的成員是「部分成員」，沒有加入時間，伺服器暱稱也可能不在。這個設定也讓 discord.js 在小吉自己的成員不在快取時，把 `guild.members.me` 換成一個沒有身分組的部分成員；取得小吉權限的地方（歡迎、管理權限檢查、提醒、版本公告、接龍反應、加入伺服器）因此一律改用 `src/utils/botMember.js`，部分成員視為沒有，並改向 Discord 取得完整成員。test-control 下這個事件要列在允許的事件裡才會處理，而且 test-control 不送任何私訊。
  - **新伺服器加入通知的來源**：小吉加入任何新伺服器，都會私訊 Owner 一則 `OWNER_EVENT_GUILD_JOINED`，文字固定，不經過 AI。小吉不審核伺服器：通知只告知，不需要任何批准，沒有拒絕名單，也沒有任何加入限制，不會離開那個伺服器，也不留下任何伺服器紀錄；通知不依賴審核資料檔，檔案讀不到或寫不了也照常送出。邀請者 ID 取自伺服器稽核日誌裡「機器人加入」的最新一筆，且那一筆必須是最近 2 分鐘內、對象是小吉；小吉沒有檢視稽核日誌的權限、紀錄太舊、對象不符或查不到時寫「未知」，不影響通知。成員數與加入時間用 Discord 給的值，沒有就寫「未知」。同一個伺服器同一次加入被重複收到（重新連線）只通知一次，10 分鐘內重複的加入也合併成一則；額度見上一項（每分鐘 1 則、每小時 6 則、每天 24 則，與其他通知各自獨立）。
  - 出口防護層清理對外文字後照常送出的兩個事件不私訊，也不占預算：連結被取代（`EGRESS_LINK_REWRITTEN`）與提及被移除（`EGRESS_MENTION_STRIPPED`）。成員的話被引用時就會發生，不需要處理；只在 log 記 `[EGRESS] outbound content was normalized.`（每分鐘最多一行）。出口防護層擋下請求的所有 `EGRESS_*` 代碼也不再各自私訊：它們保留 log 與 test-control 觀察計數，並改以「出口護欄阻擋」安全警示通知（群組取自請求要送往的伺服器，沒有時取小吉正在處理的那個伺服器）。
  - AI 呼叫限制擋下聊天請求的五個事件也不私訊、不占預算：同一人已有一個 AI 呼叫在進行（`AI_GUARD_USER_BUSY`）、15 秒內相同內容（`AI_GUARD_DUPLICATE`）、同時呼叫數已滿（`AI_GUARD_GLOBAL_BUSY`）、呼叫逾時（`AI_GUARD_TIMEOUT`）、同一人 20 秒內超過 4 次（`AI_GUARD_USER_RATE`）。任何成員都可能造成，只在 log 記 `[AI_GUARD] code=<代碼>`（每個代碼每分鐘最多一行），test-control 下計入 `TEST_OBS_<代碼>`。
  - 被拒答的 AI 請求（`AI_REQUEST_REFUSED`、`AI_PROMPT_INJECTION_BLOCKED`）本身不再私訊，也不占共用的通知預算：它們只在 log 記 `[AI_SAFETY] code=<代碼>`（每個代碼每分鐘最多一行，沒記的次數寫在下一行的 `suppressed=`），test-control 下計入 `TEST_OBS_<代碼>`。這類攻擊改由「安全警示」通知 Owner（見下一項）。
  - **安全警示**（`OWNER_EVENT_SECURITY_ALERT`）是第四種獨立的 Owner 事件，通知小吉遭到的攻擊或誤用。文字固定、不經過 AI：`【群組名稱】小吉遭受攻擊(類別)`，不含使用者寫的內容、使用者 ID、頻道 ID、訊息 ID 與伺服器 ID。群組名稱先去掉【】、提及、Markdown、連結與分隔符號，所以無法在名稱裡偽造類別；私訊寫「私訊」，查不到名稱寫「未知群組」。類別只有八種固定標籤：提示詞注入（要求小吉扮演開發者或權威後忽略規則）、套取開發資訊（被拒答的內部資訊請求）、索取個資或跨群資料（管理員查詢不在本伺服器的成員）、洗版（頻道被洗版，或某人被防洗頻機制暫停 AI 對話）、輸出護欄觸發（AI 回覆被改成固定拒答，或回覆裡的連結、提及被清掉）、出口護欄阻擋（對外請求被出口防護層擋下，例如轉發訊息）、權限被拒（沒有權限的人使用管理或 Owner 專用指令）、釣魚或惡意連結（伺服器裡的成員訊息含有仿冒品牌網域、同形網域、IP 位址、帳密手法、誘餌用語加外部連結、直接下載執行檔，或 `@everyone` 加外部連結時；只通知，不刪訊息、不禁言、不回覆，規則表見 docs/ARCHITECTURE.md）。單純的無意義訊息、一次重複與「小吉」單獨呼叫都不通知。
    - 同一個群組（或私訊）的同一類別：第一次偵測立刻私訊；之後一小時內只累計次數，不再私訊；一小時後的下一次私訊會附上「（過去一小時共 N 次）」（N 是開啟那一小時的那一則加上被合併的次數，只在有合併時才附）。不同群組、不同類別各算各的。記憶體與帳本都用一小時的合併時間窗，所以重新啟動後一小時內也不會重複私訊；但次數只存在記憶體，重新啟動後歸零。
    - 預算獨立：每分鐘 3 則、每小時 20 則、每天 60 則（帳本目標後綴 `:security`），不占用、也不被其他通知占用。被擋下的警示會計入同一個群組同一類別的下一則（只存在記憶體），並依上面的規則記 `OWNER_NOTICE_BUDGET_EXCEEDED`。
    - 警示一定要從小吉處理某個 Discord 訊息或指令的流程裡發出，通知器才知道它的來源；沒有來源的（例如背景工作）會被丟棄並記 `OWNER_SAFETY_SOURCE_UNAVAILABLE`。啟動保護暫停期間、通知停用期間丟棄的警示不補送，也不開一小時的合併時間窗。擁有者自己觸發的警示不略過。
    - 這樣做的代價：每一則警示只說「哪個群組、哪一類」，要查原因請看 log 與該伺服器的紀錄；被拒答的請求或被擋下的對外請求原本附的固定代碼（例如具體的 `EGRESS_*` 代碼）不再放進私訊，只留在 log 與 test-control 觀察計數。
  - AI 回覆送出前另有一層清理，清理後的回覆照常送出：未核准的連結（沒有 `https://` 的網址，例如 `example.com/xxx`，也算）換成「[連結已移除]」（`AI_OUTPUT_URL_BLOCKED`），提及換成「[提及已移除]」（`AI_OUTPUT_MENTION_BLOCKED`）。成員只要請 AI 複述連結或提及就會發生，所以這兩個事件本身不私訊 Owner，也不占上述共用的通知預算（它們仍會以「輸出護欄觸發」安全警示計入，一小時合併）；只在 log 記 `[AI_OUTPUT] code=<代碼>`（每個代碼每分鐘最多一行，這段期間沒記的次數寫在下一行的 `suppressed=`），test-control 下另計入觀察計數 `TEST_OBS_AI_OUTPUT_URL_BLOCKED`、`TEST_OBS_AI_OUTPUT_MENTION_BLOCKED`。
- **緊急私訊**：有異常要通知，但 Owner 帳本本身不能用時（Owner 用途停用或帳本被拒收、登入身分不符、整個檢查失敗），改送一則不經任何帳本的固定提示，開頭是「小吉緊急安全提示」。啟動時若同時建立了帳本，這則提示也會列出它們與各自的 cutover。
  - 每 6 小時（主機時鐘）最多一則。時間戳記存在吉幣資料庫（`coin_metadata` 的 `safety_alert:owner-emergency`）；先把新戳記寫入磁碟，成功後才送出，送到 Discord 卻失敗時不重試。
  - 請求根本沒離開小吉時（例如被本機的私訊次數上限或出口檢查擋下），記 `[SAFETY_LEDGER] code=LEDGER_EMERGENCY_NOTICE_NOT_SENT`，戳記改回原本的值，不占用這 6 小時；同一次執行中再有異常要通知時，連同沒送出的內容一起再送（下次啟動時則送該次啟動發現的異常），距離上次嘗試至少 1 分鐘（被擋下時若有指定等待時間，取較長者）。戳記改不回去時記 `LEDGER_ALERT_STAMP_RELEASE_FAILED`，6 小時照常計算。
  - 戳記無法讀取或格式不對時不送，改以結束碼通報。戳記的時間比主機時鐘晚超過 5 分鐘（時鐘被往回調，或戳記損毀）時不採信：照常覆寫並送出，並記一行 `[SAFETY_LEDGER] code=LEDGER_ALERT_STAMP_FUTURE`。
  - 總開關為 `off` 或在 test-control 時不送。
- **連續啟動失敗 3 次後暫停 Owner 私訊**：避免小吉反覆啟動失敗、被自動重新啟動時一直私訊 Owner。
  - 一次「啟動」從程式開始執行算起，登入 Discord（ready）之後再持續運作滿 10 分鐘，才算啟動成功。在這之前程式就結束（啟動失敗、以非 0 的結束碼結束、當掉或被強制終止），都算一次啟動失敗。用 Ctrl+C（SIGINT）或 SIGTERM 要求停止，不算失敗也不算成功，次數維持原樣。
  - 連續失敗 3 次之後的啟動，送往 Owner 私訊的通知一律不送：安全提示、帳本通知、第一次建立帳本的通知與緊急私訊都包括在內。啟動時 log 記一行 `[OWNER_DM_GUARD] code=OWNER_DM_GUARD_SUPPRESSING reason=start-failures failures=<次數> threshold=3`；被擋下的通知記 `[OWNER_SAFETY] code=OWNER_DM_GUARD_BLOCKED kind=<safety-event 或 ledger-notice> category=<類別> skipped=<略過的則數>`，`category=` 只有安全事件才有（`ai-egress`、`audit`、`critical`、`member-leave`、`guild-join`、`recovery` 或 `security-alert`）；緊急私訊那一行的前綴是 `[SAFETY_LEDGER]`，記成 `[SAFETY_LEDGER] code=OWNER_DM_GUARD_BLOCKED kind=emergency skipped=<略過的則數>`。同一種通知每分鐘最多一行，`skipped` 是上一行之後略過、沒有記的則數，都不含通知內容。被擋下的通知之後也不補送，而且不占用任何一種通知的預算、不會讓恢復後的第一則同類通知被合併掉，緊急私訊的 6 小時戳記也不會被占用。
  - 安全警示在啟動保護暫停期間被擋下時，同樣不補送，也不開一小時的合併時間窗：保護解除後，同一群組同一類別的第一則警示照常立刻送出，不帶次數。
  - 直到某一次啟動成功（ready 後滿 10 分鐘），次數才歸零，同一次執行中的 Owner 私訊也從這時恢復，log 記 `OWNER_DM_GUARD_RESUMED`。
  - 次數存在資料根（`XIAOJI_DATA_ROOT`，沒設定時是吉幣資料庫所在的資料夾）裡的 `owner-dm-start-guard.json`，每次啟動一開始就先加一，所以不管程式怎麼結束都算得到。這個資料夾的規則和安全帳本相同：必須是程式資料夾外、沒有經過 junction 或捷徑的本機資料夾。
  - 資料夾不能用時（例如吉幣資料庫還在程式資料夾內），不計次數、私訊照常，log 記一行 `OWNER_DM_GUARD_UNAVAILABLE`；這種情況 Owner 帳本也開不了，本來就只剩每 6 小時最多一則的緊急私訊。檔案讀不到、內容損毀或寫不進去時，為了不漏算，這次啟動當作已達門檻、不送 Owner 私訊（log 記原因，寫入失敗另記 `OWNER_DM_GUARD_WRITE_FAILED`），但啟動照常進行；之後任何一次成功的啟動都會把次數改回 0。
  - 查看次數：`npm run safety:ledger -- status` 會印一行「Owner 私訊啟動保護：連續啟動失敗 N 次（門檻 3）」，已達門檻或紀錄無法使用時結束碼 2。手動歸零：先停止小吉，再執行 `npm run safety:ledger -- reset-start-failures --bot-stopped`（小吉還在執行時歸零，之後以 SIGINT／SIGTERM 停止會把原本的次數寫回去）。
  - test-control 不讀也不寫這個次數；test-control 本來就不送任何私訊。
- **Owner 私訊頻道準備失敗 3 次後停止**：送出通知前要先開啟與 Owner 的私訊頻道。這個請求在送出前就被擋下（例如出口檢查）時，1 分鐘後與 5 分鐘後各再試一次；第 3 次仍失敗就停止，直到下次啟動前都不再嘗試，之後的 Owner 通知直接結案、不補送。停止時 log 只記一行 `[OWNER_SAFETY] code=OWNER_SAFETY_DM_PREPARATION_STOPPED failures=3`，不會每則通知各記一次；私訊本身已經送不出去，所以不會另外改送緊急私訊。被限流而等待的那幾次不算失敗。
- **Owner 私訊頻道的請求已送到 Discord 卻失敗**：開啟私訊頻道的請求一旦可能已經到達 Discord，就和其他受保護的請求一樣不會再送第二次。Discord 拒絕（4xx，記為 rejected）或結果不明（5xx、逾時、連線中斷，或請求途中小吉停止，記為 unknown）時，這筆結果會留在 Owner 帳本裡，之後**每次啟動**的 Owner 通知都會被擋下，直到重建 Owner 帳本為止。
  - 每次啟動在檢查 Owner 帳本時記一行 `[OWNER_SAFETY] code=OWNER_SAFETY_DM_PREPARATION_BLOCKED state=unknown|rejected`；執行中才發生時，當下記這一行。每個程序只記一次。
  - `npm run safety:ledger -- status` 會把 `owner-safety` 標為 `anomaly`，附 `owner-dm-preparation-unknown` 或 `owner-dm-preparation-rejected`，結束碼 2。
  - 恢復步驟：(1) 停止小吉。(2) 執行 `npm run safety:ledger -- status`，確認上述異常並記下 `owner-safety` 的 8 碼確認碼。(3) 若是 `rejected`，先確認 `.env` 的 `BOT_OWNER_ID` 正確、Owner 仍能收到小吉的私訊；`unknown` 通常是當時的網路或 Discord 問題。(4) 執行 `npm run safety:ledger -- reinit --purpose owner-safety --bot-stopped --confirm owner-safety=<8 碼>`。(5) 啟動小吉：會建立新的 Owner 帳本，下一則 Owner 通知會重新開啟私訊頻道。Owner 安全通知沒有 cutover，舊帳本裡的通知不會補送；新帳本也從頭計算 Owner 通知的每日預算。
- **狀態頁**：新人歡迎、文字接龍與數字接龍三張功能卡跟著對應的用途。總開關為 `off` 時顯示維護中；用途停用（啟動檢查失敗、執行中停用、登入身分不符）時顯示故障，整體狀態是 degraded，不會變成 outage。其他用途沒有公開功能卡，改由私訊與結束碼通報。
- **結束碼 3**：下列情況會在停止時以結束碼 3 結束；原本就以其他非零結束碼結束時，維持原結束碼。
  - 啟動檢查發現異常而停用某個用途（總開關、test-control 的政策停用，以及上述 `stopping` 的情況都不算）；
  - 登入身分不符；
  - lastSeen 寫不進去；
  - reinit 或 release-quarantine 的請求處理後沒能收走（`LEDGER_REQUEST_NOT_CONSUMED`）；
  - 緊急私訊的戳記無法讀取、格式不對或寫不進去；
  - 執行中隔離標記與戳記都寫不進去（`SIDE_EFFECT_QUARANTINE_PERSIST_FAILED`），或停止時三個隔離位置都沒有寫成（`LEDGER_QUARANTINE_UNPERSISTED`）；
  - Owner 安全通知拒收啟動時交付的 Owner 帳本（`OWNER_SAFETY_LEDGER_UNAVAILABLE`）；
  - 吉幣資料庫取代檔案之後，對資料夾的 fsync 失敗（`COIN_DB_DIRECTORY_SYNC_FAILED`，`purpose=coin-database`）。

  功能本身拒收已交付的帳本，不會讓結束碼變成 3，只透過私訊與狀態頁通報；Owner 帳本是唯一的例外。其他通知都要經過 Owner 帳本，它被拒收時只剩每 6 小時最多一則的緊急私訊能告訴 Owner，所以另外列入升級通報；拒收的原因都出在 Owner 帳本本身（已故障或被隔離、綁定的身分不符、與其他資料共用路徑，或保存的私訊頻道證明驗證不過）。

  停止時會為每一項記一行 `[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=<用途、all 或 coin-database> cause=<代碼> stage=open|runtime|close`（必要時附 `reason=`）；啟動檢查、登入身分、lastSeen 與緊急私訊相關的項目在發生當下也會先記一行。選擇結束碼，是因為它不依賴可能同樣故障的 Owner 帳本、吉幣資料庫或網路，test-control 與服務管理程式都看得到。收到結束碼 3 時，先保留完整複本，再依 log 的代碼處理。

  關機時若有步驟失敗（log 記 `[SHUTDOWN] code=SHUTDOWN_STEP_FAILED`）、但沒有任何升級通報，以結束碼 1 結束；有升級通報時仍是 3。

  服務管理程式若設定成在結束碼 1 或 3 時自動重新啟動，反覆失敗的啟動不會一直私訊 Owner：連續 3 次啟動失敗之後，依上面「連續啟動失敗 3 次後暫停 Owner 私訊」的規則暫停，直到某次啟動成功；結束碼與 log 照常。
- **test-control**：其他日誌會被遮蔽，帳本事件只以固定代碼回報：`TEST_LEDGER_ANOMALY`（用途停用）、`TEST_LEDGER_ESCALATION`（升級通報）、`TEST_LEDGER_NOTICE`（維運提示）、`TEST_LEDGER_POLICY_DISABLED`（政策停用的用途）、`TEST_LEDGER_PROTECTED_EFFECTS_OFF`（總開關為 `off`）。test-control 不送任何私訊，只建立 4 份帳本（新人歡迎、扣薪公告與兩種接龍 ✅）；Owner 安全通知、工作提醒的兩個用途與（休眠的）離群用途由政策停用。非零結束碼回報為 `TEST_CHILD_EXIT_NONZERO` 與 `TEST_RUNTIME_EXITED_FAILED`。

### 停止、備份與還原

- 停止時，小吉先停止接收新事件，並等進行中的送出完成（每筆最多 15 秒），再把每份帳本目前的位置（lastSeen）寫回吉幣資料庫的登記並等隔離旗標寫完，這段最多 5 秒（test-control 為 3 秒），最後關閉帳本。這段逾時或寫不進去都以結束碼 3 通報。執行中每小時也會寫一次 lastSeen。下次啟動時，帳本若落後於 lastSeen，就判定為被還原成舊版（`LEDGER_ROLLBACK`）。
- 帳本開啟期間由小吉獨占。執行中不可直接複製帳本檔案，也不可用任何資料庫工具開啟。
- 執行中不可替換、還原或編輯吉幣資料庫檔案，必須先停止小吉。小吉把整個吉幣資料庫放在記憶體，只在記憶體和上一次成功寫入的內容不同時才寫檔：執行中被換掉或改過的檔案不會被察覺，之後的寫入也會用記憶體的內容把它整個蓋掉。
- 備份前必須先停止小吉，再把吉幣資料庫、`safety/` 與 `safety-witness/` 整組一起複製；帳本旁若有 `-wal` 檔，也要一起複製。
- 只還原其中一部分（例如只還原吉幣資料庫，或少了 `safety-witness/`）會被偵測到，並停用對應的用途。三者一起還原到同一份舊備份則**偵測不到**：還原後的帳本已經忘了備份之後送出的事件，直接啟動可能重送。所以還原整個資料夾的備份之後、啟動之前，必須先跑 status，再對所有用途 reinit；新的 cutover 之前的事件不補送。
- status 回報某份帳本的 integrity 不是 `ok` 時，不得直接啟動；先保留完整複本並查明原因。

### 突發停運恢復後的通知

小吉因為意外狀況（程式被強制結束或崩潰、主機斷線或當機、資料遺失）無法運作，恢復正常之後，會把這件事告訴使用者與 Owner。這是程式固定的文字，不經過 AI 對話，不是安全帳本的用途（用途數量、資料表與格式版本都不變）。

- **什麼情況會通知**：只有「不是你要求的停止」。
  - 程式沒有收到停止訊號就結束（被 kill、崩潰、斷電、主機重開），下次啟動 ready 時，距離上一次確認健康的時間達 **10 分鐘**以上。
  - 程式一直在，但 Discord 閘道斷線（例如主機網路斷線）達 **10 分鐘**以上，連線恢復後的第一個心跳發現。**閘道健不健康不能只看 `client.isReady()`**：discord.js 只在第一次 ready 時把它設成真，之後分片斷線（例如關閉碼 1006）它仍然回傳 true，只有分片自己的狀態會變成 Connecting、Identifying 或 Resuming。所以小吉每分鐘檢查的是「用戶端 ready，而且每個分片的狀態都是 Ready」（沒有任何分片也算不健康）。從最後一次健康的心跳，到恢復後第一次健康的心跳，**單調時鐘**（不受校時影響）過了 10 分鐘，才算連線中斷；停運有多長也以單調時鐘為準，牆鐘只用來標出它在什麼時候結束。
  - 吉幣資料庫與帳本被還原成舊版的跡象（見下方「資料還原」）：只通知 Owner，不管有沒有間隙。
- **什麼情況不通知**：Ctrl-C、關閉主控台視窗、SIGINT、SIGTERM 的停止與接著的重啟（計畫性，見下方「限制」）；停運不到 10 分鐘；紀錄不存在、讀不出來或無法信任（第一次啟動、紀錄檔被刪、損毀，記一行 `OUTAGE_PREVIOUS_ABSENT`、`OUTAGE_PREVIOUS_INVALID` 或 `OUTAGE_PREVIOUS_UNREADABLE`，當作未知，不通知）；系統時鐘被調回（`OUTAGE_CLOCK_BEHIND`）；執行中牆鐘比單調時鐘多走了超過 5 分鐘（時間校正、虛擬機還原）：只記 `OUTAGE_CLOCK_JUMP`，不算停運，也不會讓同時發生的連線中斷變長（真的斷線 13 分鐘、同時牆鐘被往前撥 3 小時，記的是 13 分鐘）；test-control（不讀不寫）。**不會私訊每一位成員。**
- **何時發**：恢復後（ClientReady，或連線恢復）穩定運作 **10 分鐘 + 30 秒**（以單調時鐘計，牆鐘被往前撥不會縮短它），與 Owner 私訊啟動保護的「恢復正常」同一個標準，而且保護沒有擋下 Owner 私訊、閘道是健康的。所以連續崩潰重啟時，要等某次啟動穩定下來才發一輪；啟動保護擋下的那次啟動，等保護解除後才發，也不會重複。連續崩潰會合併成一件停運：起點是最後一次確認健康的時間，終點隨每次啟動往後移。
- **公開公告**：每個「停運起點之前就已經在」的伺服器一則，固定文字（N 是停運的整數分鐘）：
  「小吉剛才因為意外狀況暫停運作了約 N 分鐘，現在已經恢復。停運期間發生的事件原則上不會補發，已經排進排程的操作會照原本的規則接續處理。」
  - 文字不含連結、提及，也沒有任何成員或伺服器寫的內容；不寫原因、不寫代碼。
  - 頻道：該伺服器的歡迎頻道（`/set-welcome`）；沒有或不存在時用系統頻道；兩者都沒有，或小吉在那裡沒有檢視與發言權限，就略過並記 log（`OUTAGE_NOTICE_SKIPPED reason=no-channel` 或 `no-permission`）。**與歡迎訊息不同：沒有「第一個文字頻道」的後備。**
  - 每個伺服器 24 小時最多一則（以送出前記下的時間計；比現在時鐘超前 5 分鐘以上的紀錄不採信）；伺服器之間至少間隔 1.5 秒；停運期間離開的伺服器不在名單裡，停運起點之後才加入的（加入時間不早於起點，或 Discord 沒給加入時間）也不發。
  - 一則只送一次、不重試：先經出口限流（20 則 / 10 秒 / 頻道）與出口檢查，在請求進入網路的那一刻把「已送出」寫進紀錄檔，之後 Discord 回覆 2xx 記 `sent`、4xx（例如 403 沒有權限）記 `rejected`、5xx、逾時或連線中斷記 `unknown`，三者都不再送。只有「沒有離開小吉」（被出口限流、被已知的限流擋下）和 Discord 自己回 429（沒有生效）會放回、在下一個心跳重試，每個伺服器最多 3 次（`skipped:retry-limit`）。重新啟動時發現「已送出、沒有結果」的記錄視為 `unknown`，不會補送。
  - 小吉不審核伺服器，所以所有伺服器都適用；這個條件是一個可替換的函式（`createOutageNotice` 的 `isEligible`），預設全部。
  - 一件停運在紀錄檔裡最多記 200 個伺服器的結果（所有狀態合計）；超過的伺服器不通知，記 `OUTAGE_NOTICE_STATE_UNWRITABLE`。小吉不會真的在那麼多伺服器裡，這只是紀錄檔大小的上限。
- **Owner 私訊**：每次停運一則 `OWNER_EVENT_RECOVERED`（「小吉恢復營運通知」），欄位是停運開始、恢復時間與類型（程式異常結束後重新啟動、與 Discord 連線中斷後恢復、手動還原後恢復）。用恢復營運自己的預算（每分鐘 1、每小時 2、每天 4），與啟動時的帳本合併通知各發各的，不會合併。Owner 帳本不可用（用途停用或被拒收）時，只記 log（`OUTAGE_OWNER_NOTICE_UNAVAILABLE`），不改送緊急私訊；這份待通知的紀錄（這時伺服器已經通知過了，只剩 Owner 的部分）留到下次啟動再試，72 小時內都有效，這個程序不再重試。已經交給通知器的不會再交第二次：先寫下「已交出」才送出事件，所以中間崩潰最多是 Owner 沒收到，不會收到兩則。
  - **延續或取代**：一件還沒通知過的停運（沒有任何伺服器有結果，Owner 也還沒交出），之後的啟動不管間隙多短都延續它（起點不變、終點往後移）；等待期（連線恢復或 ready 之後的 10 分 30 秒）內程序被殺、再停運 10 分鐘以上，也是同一件，兩段合併成一件，不會丟掉前一段。已經通知過一部分（有伺服器有結果，或 Owner 已交出），或者那次執行在它被記下之後連線穩定滿 10 分 30 秒才結束，這份紀錄就只剩 Owner 的部分：之後再發生 10 分鐘以上的停運是另一件，取代它、自己通知伺服器（記 `OUTAGE_PENDING_SUPERSEDED`），以免一則永遠送不出的 Owner 通知讓之後的停運都沒有公告；短於 10 分鐘的間隙只是重啟，不延伸它，也不新建。
- **停運期間的事件**：原則上不補發，小吉沒有任何程式去回收停運期間的事件。已經進入排程的操作（例如工作發薪、提醒、公告重送、逾期處理）照原本的規則接續處理：啟動時每個排程立即跑一次，並依資料庫裡的狀態接續。
- **總開關**：`XIAOJI_PROTECTED_EFFECTS=off` 時整個通知不送（待通知的紀錄丟棄，記 `OUTAGE_NOTICE_DISABLED`）。沒有新增環境變數。

**資料還原**。只有下列跡象會被當成還原：安全帳本啟動檢查的 `LEDGER_ROLLBACK`（reason 為 `database-behind`、`gap`、`fork`、`registration-ahead`、`registration-fork`）、`LEDGER_REGISTRATION_MISSING`、`LEDGER_FILES_MISSING`、`LEDGER_PARTIAL`，以及 `LEDGER_REINIT_APPLIED`、`LEDGER_REINIT_CONSUMED` 兩個維運提示（不看儲存層的 `LEDGER_MISSING`）。有跡象時私訊 Owner 一則類型為「手動還原後恢復」的通知，**公開公告不提還原**，也不因為還原跡象單獨公告；只有真的停運達 10 分鐘才公告，而且公告的文字一樣。

這些跡象在 reinit 之前每次啟動都會再出現（受影響的用途維持關閉），所以**同一組跡象不會每次啟動都通知**：紀錄檔記下上一次通知的那一組跡象與時間（`restoreSeen`），同一組（或較小的一組）在 **7 天**內不再通知，記 `OUTAGE_RESTORE_REPEATED`；只要多出一個先前沒有的跡象就算新事件，立刻通知；滿 7 天後同一組再通知一次。計畫性重啟（SIGINT、SIGTERM）也一樣。跡象的識別包含是哪個用途（同一個代碼出現在另一個用途，是新的跡象）；舊版紀錄裡不含用途的識別，與現在的都不相同，最壞是同一組多通知一次。紀錄檔裡時間比時鐘超前超過 5 分鐘的「上一次通知」不採信，照常通知。**還沒送到 Owner 的還原不會被抑制 7 天**：它被之後的停運取代、過期（72 小時）或被總開關丟棄時，那組跡象的記憶一併清掉，下一次啟動再顯示時照常通知（Owner 通知器不可用的那次啟動留下的還原，等 Owner 恢復後的停運就會一起通知，類型是「手動還原後恢復」）。`LEDGER_REINIT_APPLIED` 與 `LEDGER_REINIT_CONSUMED` 是一次性事件，以它讓哪一份帳本重新開始（用途與帳本 ID）為識別：同一次 reinit 先後以「已套用」與「已消耗」出現只算一次，之後另一次 reinit 才是新事件。真正的停運不受影響：同樣的跡象還在時發生的停運，是它自己的待通知紀錄、類型是「程式異常結束後重新啟動」，各自獨立計算預算。已知偵測不到的情況：

- 吉幣資料庫、`safety/`、`safety-witness/` 與 `outage-state.json` 一起還原成同一份舊備份（安全帳本自己也偵測不到這件事，見「停止、備份與還原」）。冷備份還原回來的 `outage-state.json` 帶著當時「SIGTERM 停止」的標記，會被當成計畫性停止。
另一種是**誤報**：備份是在小吉執行中複製的，紀錄檔的 `stop` 仍是 `running`。還原整個資料夾後第一次啟動，會從那份紀錄的最後一次健康時間算起，把整段時間當成停運，並照常公告。所以備份前要先停止小吉（本來就是備份的規則）。

**限制**

- 什麼算計畫性停止，看小吉收得到什麼訊號：
  - Linux 與多數面板：「停止」是 SIGTERM（Ctrl-C 是 SIGINT），算計畫性，不通知；如果面板先停止、很久之後才開機，這段時間不算停運。被 kill -9、崩潰、斷電、主機當機或重開，沒有訊號，算停運。
  - Windows 本機：在主控台按 Ctrl-C（SIGINT）、關閉主控台視窗（SIGHUP，視窗關閉後約 10 秒會被強制結束，紀錄是同步寫入的，來得及）與 Ctrl-Break（SIGBREAK）算計畫性。`taskkill`、工作管理員「結束工作」、Node 的 `child.kill()`、面板的「強制停止」都是強制結束，Windows 不會把訊號交給程式，一律算非計畫性（停運 10 分鐘以上就會通知）。
  - 啟動的前幾秒（模組同步載入的期間，之後才有正式的停止處理）收到的 SIGINT 與 SIGTERM（Windows 還有 SIGHUP 與 SIGBREAK）：因為載入期間 Node 的事件迴圈不轉，這時收到的訊號不會立刻處理；但程式一開始就註冊了一個停止處理，所以 Node 不會照預設當場結束（那會留下「崩潰」的紀錄）。訊號會等載入完成、正式的停止處理建立之後，由它記成計畫性停止並正常關閉。要等載入完，通常是數秒。SIGKILL 或強制結束不是訊號，落在載入期間仍是非計畫性。
- 計畫性停止之後，第一次啟動重新計算：它如果在 ready 之前失敗（反覆啟動失敗），停運從那次啟動的開始時間算起，不含計畫性停止的那段時間。
- 主機睡眠不算停運：睡眠期間單調時鐘不走（Linux 的 CLOCK_MONOTONIC、一般的 Windows 都是如此），牆鐘卻走了，無法和「時鐘被撥動」分開，所以只記 `OUTAGE_CLOCK_JUMP`，不通知；醒來後閘道若又斷線 10 分鐘以上才算連線中斷。程序被凍結（單調時鐘走了 10 分鐘以上，睡眠不算）算連線中斷。

**檔案**。`<資料根>/outage-state.json`，與 `owner-dm-start-guard.json` 同一個資料夾、同一組規則（程式資料夾外、本機實體資料夾、沒有 junction 或連結、不是 test-control 資料根）。內容是 schema 1 的一份小 JSON（上限 32 KiB）：`bootId`、`startedAtMs`、`readyAtMs`、`lastHealthyAtMs`（每分鐘只在閘道健康時更新）、`stop`（`running` 或 `signal`）、待通知的停運（`pending`：起訖時間、類型、還原跡象代碼、Owner 是否已交出、各伺服器的結果）、各伺服器最後一則公告的時間（保留 48 小時、最多 200 個），以及上一次通知的還原跡象（`restoreSeen`：跡象的識別，含用途的短雜湊，最多 16 個，與時間；沒有這個欄位的舊檔照常讀，視為沒有）。寫入先寫 `.tmp`、fsync 再 rename；停止訊號的標記是同步寫入的，不等關機流程。資料夾不能用（例如吉幣資料庫還在程式資料夾內）時，整個功能停用，記一行 `OUTAGE_MONITOR_UNAVAILABLE`。這個檔案不是帳本：刪掉或損毀只會讓下一次啟動當作「未知」，不通知。備份時可以一起複製，也可以不複製。

**log 代碼**（`[OUTAGE_MONITOR] code=…` 與 `[OUTAGE_NOTICE] code=…`，只有固定代碼與數字，不含路徑或內容）：

| 代碼 | 意義 |
| --- | --- |
| `OUTAGE_PREVIOUS_ABSENT`、`OUTAGE_PREVIOUS_INVALID`、`OUTAGE_PREVIOUS_UNREADABLE`、`OUTAGE_PREVIOUS_UNKNOWN` | 上一份紀錄不存在、無法信任、讀不出來，或從沒健康過：這次不通知 |
| `OUTAGE_CLOCK_BEHIND stage=start\|ready\|heartbeat` | 系統時鐘比上一份紀錄早超過 5 分鐘：這次不通知 |
| `OUTAGE_CLOCK_JUMP seconds=N` | 執行中牆鐘比單調時鐘多走了 N 秒（超過 5 分鐘）：只記錄，不算停運，也不算進同時發生的連線中斷的長度 |
| `OUTAGE_DETECTED kind=crash\|connection minutes=N` | 發現一件達 10 分鐘的停運 |
| `OUTAGE_RESTORE_DETECTED signs=N` | 發現資料還原的跡象，而且是新的一組 |
| `OUTAGE_RESTORE_REPEATED signs=N` | 還原的跡象與 7 天內通知過的相同（或更少）：不再通知 |
| `OUTAGE_STATE_WRITE_FAILED stage=… cause=…` | 紀錄寫不進去（每 10 分鐘最多一行） |
| `OUTAGE_MONITOR_UNAVAILABLE` | 沒有可用的資料夾、時鐘無效，或啟動時發生意外：整個功能停用 |
| `OUTAGE_PENDING_EXPIRED` | 待通知的停運過了 72 小時仍沒送，丟棄 |
| `OUTAGE_PENDING_SUPERSEDED stage=ready\|heartbeat` | 又發生了新的停運，而舊的待通知紀錄已通知過一部分，或那次執行已穩定過：取代它，不延伸 |
| `OUTAGE_NOTICE_DISABLED reason=protected-effects-off` | 總開關為 `off`，丟棄 |
| `OUTAGE_NOTICE_SENT`、`OUTAGE_NOTICE_SKIPPED reason=…`、`OUTAGE_NOTICE_DEFERRED reason=…`、`OUTAGE_NOTICE_REJECTED`、`OUTAGE_NOTICE_UNKNOWN`、`OUTAGE_NOTICE_FAILED`、`OUTAGE_NOTICE_STATE_UNWRITABLE`、`OUTAGE_NOTICE_UNAVAILABLE` | 各伺服器的公告結果（`[OUTAGE_NOTICE]`，`guild=` 之後是伺服器 ID）；最後一個是 `client.rest` 不能承載受保護的請求 |
| `OUTAGE_NOTICE_CLAIM_UNSETTLED guilds=N` | 上一次執行留下 N 個「已送出、沒有結果」的伺服器，一律視為 `unknown`，不補送（`[OUTAGE_MONITOR]`） |
| `OUTAGE_OWNER_NOTICE_HANDED`、`OUTAGE_OWNER_NOTICE_UNAVAILABLE reason=notifier\|state`、`OUTAGE_OWNER_NOTICE_FAILED` | Owner 私訊已交給通知器、不能交出（通知器不可用，或紀錄寫不進去，後者不會交出）、交出時發生意外（`[OUTAGE_NOTICE]`） |
| `OUTAGE_NOTICE_COMPLETE`、`OUTAGE_NOTICE_FAILED cause=…`、`OUTAGE_MONITOR_TICK_FAILED` | 這件停運該通知的都通知完了；整個通知步驟丟出意外（連續 5 次後本次執行不再嘗試）；心跳發生意外（`[OUTAGE_MONITOR]`） |

**已知事項（只寫現況，沒有改行為）**：停運之後的第一輪排程，會把停運期間已經滿期限的項目一次處理，使用者在停運期間無法提交或操作，也一樣算。

- 工作任務與場館訂單：任務與訂單項目以建立時間起算 24 小時（`WORK_AUTO_COMPLETE_HOURS`、`NPC_TIMEOUT_MS`）為期限。重啟後的第一輪逾期處理（`processExpiredWorkTasks`、`processExpiredPrimaryTasks`、`processExpiredVenueOrderItems`，啟動時立即執行，之後每 15 分鐘）會把期限在停運期間到的任務與訂單項目一次判為逾期、由系統接手，並依各自的規則扣當日薪水；工作任務每輪最多處理 50 筆，其餘在之後的輪次處理。
- 賭場貸款：利息按日複利，每日從 `last_interest_date` 的隔天算起、逐日複利（`projectLoanInterest`），重啟後的第一輪（`processCasinoLoanInterest`）一次補齊停運期間錯過的每一天。停運越久，一次補上的天數越多。
- 這些是既有行為。是否要在長時間停運後順延期限、暫停計息，由擁有者另行決定；目前沒有任何程式碼在停運後調整它們。

### 維運腳本 `npm run safety:ledger`

```powershell
npm run safety:ledger -- status
npm run safety:ledger -- status --json
npm run safety:ledger -- reinit --purpose welcome --bot-stopped --confirm welcome=<status 顯示的 8 碼>
npm run safety:ledger -- release-quarantine --purpose word-chain.reaction --bot-stopped --confirm word-chain.reaction=<status 顯示的 8 碼>
npm run safety:ledger -- reset-start-failures --bot-stopped
```

- `status`：唯讀。讀 `.env` 的 `COIN_DB_PATH`（或 `--coin-db`）與資料根（`--data-root` 或 `XIAOJI_DATA_ROOT`，都沒有時用吉幣資料庫所在的資料夾），列出每個用途的登記、檔案、暫存檔、隔離狀態、待處理的請求、收據、帳本檢查結果，以及 reinit 需要的 8 碼確認碼。
  - 每個用途的結論是 `ok`、`absent`（還沒建立）、`pending`（建立中）、`anomaly`（附異常項目）或 `in-use`（小吉正在使用）。Owner 帳本裡私訊頻道的請求已送到 Discord 卻失敗時，`owner-safety` 是 `anomaly`，附 `owner-dm-preparation-unknown` 或 `owner-dm-preparation-rejected`，處理方式見「通知、狀態頁與結束碼」。
  - 另外印一行 `資料夾同步：code=<代碼>`，檢查資料夾能不能做 fsync：吉幣資料庫所在的資料夾一定檢查，帳本與 witness 資料夾若已存在、又是別的資料夾，也一起檢查。每個資料夾只開啟、fsync、關閉，不寫任何資料。吉幣資料庫的資料夾照小吉寫入時的方式判斷；帳本與 witness 資料夾照安全帳本的規則，任何錯誤都算失敗。代碼有四種：
    - `DIRECTORY_SYNC_OK`：支援。
    - `DIRECTORY_SYNC_UNSUPPORTED errno=<代碼> folder=coin-database`：吉幣資料庫所在的檔案系統不支援資料夾 fsync。吉幣資料庫在這種檔案系統上仍會寫入（盡力而為），但安全帳本需要資料夾 fsync，受保護的副作用會在啟動時全部停用。結束碼 2；請改用本機磁碟，不要啟動。
    - `DIRECTORY_SYNC_FAILED errno=<代碼> folder=<資料夾>`：失敗，結束碼 2，不要啟動。`errno=ENOENT` 表示資料夾不存在。
    - `DIRECTORY_SYNC_NOT_APPLICABLE`：Windows，不適用，結束碼不變。

    `folder` 是 `coin-database`、`ledger` 或 `witness`，不印路徑；幾個資料夾結果不同時，只印最嚴重的一個。`--json` 的報告裡是 `directorySync`。
  - 再印一行「Owner 私訊啟動保護：連續啟動失敗 N 次（門檻 3）」，說明下次啟動會不會送 Owner 私訊（見「通知、狀態頁與結束碼」）。達到 3 次，或紀錄讀不到、內容損毀（印 `state=invalid` 或 `state=unreadable`）時，下次啟動不送 Owner 私訊，算需要處理的項目。test-control 的資料根印「test-control 不使用」。`--json` 的報告裡是 `ownerDmStartGuard`。
  - 沒有需要處理的項目時結束碼 0，否則 2；帳本目錄本身不能用時印出 `帳本目錄無法使用：<代碼> (<原因>)`，結束碼 2；參數錯誤時結束碼 1。
- `reinit`：必須先停止小吉並加上 `--bot-stopped`，每個用途都要附 `--confirm <用途>=<8 碼>`；`--purpose` 可以重複，也可以改用 `--all`。它把舊的帳本檔案移到 `retired-*` 資料夾（附清單，永不刪除），寫下 reinit 請求，不寫吉幣資料庫。小吉下次啟動時核對請求，把舊登記標為退役，建立新帳本與新的 cutover。
- `release-quarantine`：參數相同。把隔離標記與戳記移到 `retired-*` 資料夾，並寫下解除請求；小吉下次啟動時核對後清除登記上的隔離旗標。
- `reset-start-failures`：必須先停止小吉並加上 `--bot-stopped`，不接受 `--purpose`、`--all` 或 `--confirm`。把連續啟動失敗的次數歸零，下次啟動就照常送 Owner 私訊；內容損毀的紀錄也一併改回 0。沒有紀錄時什麼都不寫；那個檔名被資料夾之類的東西占用時拒絕（結束碼 1），請人工檢查。test-control 的資料根不使用這項紀錄，也會拒絕。
- 請求都在下次啟動時才處理。寫到一半中斷而留下的 `<請求>.tmp` 會被忽略（`LEDGER_REQUEST_TEMP_IGNORED`），status 會列出，下次為同一用途寫請求時會取代它。請求處理後若沒能收走，會記 `LEDGER_REQUEST_NOT_CONSUMED` 並以結束碼 3 通報；下次啟動會認出它已處理過。
- 確認碼只由 status 在主機上顯示，私訊不會附上。這是刻意的：執行 reinit 的人必須能進入主機，也知道小吉已經停止。

### 各功能的語意

- **只有請求真的送往 Discord 的那一刻才寫入帳本。** 功能確認可以送出之後，請求還要在 discord.js 裡排隊、等待限流；「開始送出」的紀錄是在請求真正送往 Discord 的同一步寫入。在這之前就沒送出的（停止中、排隊到逾時、等不到的限流、被 test-control 擋下）一筆也不寫：扣薪公告、工作提醒私訊與接龍 ✅ 之後可以用同一個事件再送；新人歡迎與 Owner 通知則直接結案，不補送。以前這筆紀錄在排隊之前就寫入，排隊中逾時或被限流的送出因此會被記成結果不明，之後再也不送。送出前就決定不送的事件只存在記憶體，重新啟動後就會忘記。
- **新人歡迎**：只歡迎加入時間晚於 cutover 的成員。小吉登入後、ready（ClientReady）之前收到的加入事件，先在記憶體排隊，最多 32 筆；超過上限的不送也不補送，並記一行 `[WELCOME_SAFETY] code=WELCOME_PRE_ARM_QUEUE_FULL`。ready 時若登入身分不符，佇列直接結束，一筆都不送。Owner 通知在 ready 之前的佇列規則相同（`OWNER_SAFETY_PRE_ARM_QUEUE_FULL`）。ready 之後的佇列上限是 128 筆，滿了的事件不送。
- **新人歡迎只歡迎一次**：同一個 Discord ID 在同一個伺服器只歡迎一遍，之後再次加入（退出後重新加入、被移除後重新加入）不再歡迎；每個伺服器各自計算，同一個 ID 在另一個伺服器仍會各歡迎一次，換歡迎頻道也不會重置。小吉在私有掛鉤之後、處理歡迎之前先為（伺服器、成員）保留一筆；歡迎被接受（排進送出佇列）才記下，沒有可用頻道、沒有權限、佇列已滿或處理失敗時退回保留，下一次加入仍會歡迎。機器人帳號不歡迎也不記。已歡迎過的成員仍照常執行私有掛鉤。**「已歡迎」以小吉接受歡迎請求為準，不是訊息已送達**：被接受之後因限流而丟棄、或被 Discord 拒絕的歡迎不會補送，也不會因為重新加入而補歡迎。記錄存在 `src/data/welcomedMembers.json`（只含伺服器 ID、成員 ID 與時間，不放進 `guildConfig.json`），重新啟動後仍有效。**升級前已經歡迎過的人沒有記錄**：這個功能上線之前的歡迎沒有留下紀錄，所以這些人第一次重新加入時仍會被歡迎一次，之後才不再歡迎。記錄沒有保存期限，只會被上限淘汰：每個伺服器最多記 20,000 人、全部合計最多 50,000 人、最多 1,000 個伺服器，滿了先淘汰最舊的（伺服器超過 1,000 個時，整個最舊的伺服器連同它的成員一起淘汰，所以寫出的檔案不會超過讀取的上限），**被淘汰的人日後再加入可能再被歡迎一次**；檔案裡的伺服器超過 1,000 個、或總筆數超過 100,000 時，視為不是這個程式寫的檔案，不讀取（改名保留，見下）。要依請求移除某人的記錄，停止小吉後手動編輯（或刪除）這個檔案，**以及同一個資料夾裡的 `welcomedMembers.json.corrupt`**（檔案損毀時留下的副本，也含成員 ID，只留最近一份）。檔案內容損毀時從空白開始（之前記過的人可能再被歡迎一次），原檔改名為 `welcomedMembers.json.corrupt`（只留最近一份）供事後查驗，並記一行固定代碼（`[RETAINED_DATA] code=WELCOMED_MEMBERS_FILE_INVALID kept=corrupt`）；暫時讀不到（Windows 上掃毒或備份程式占用）時會先重試 3 次，仍讀不到就不覆蓋舊檔（`..._FILE_UNREADABLE`、`..._WRITE_DEFERRED`），等讀得到時把這段期間的新記錄併進舊檔再寫入（併入失敗記 `..._FILE_MERGE_FAILED`，仍不寫入、30 秒後重試；同一位成員在新舊兩邊都有時保留較早的時間）。寫入失敗記 `..._WRITE_FAILED`，30 秒後重試；暫存檔寫完整才會取代舊檔。寫入是合併的（變更後約 2 秒一次，停止時補寫），小吉異常結束前最後約 2 秒的記錄可能遺失（最壞多歡迎一次）。**測試時**：test-control（Chrome 實測）的測試資料根與 attack-launcher（打正式小吉，寫在正式的 `src/data/`）都會持久化這個檔案，同一個測試帳號重複加入不會再被歡迎；要重測時，停止小吉後刪除該檔（或改用新的測試帳號）。
- **扣薪公告**：最晚只送到該筆扣薪的申訴期限（以帳本的時鐘判斷），過了期限就不再送。期限之前，遇到頻道無法發送或佇列已滿，都只是延後。
- **工作提醒私訊**：私訊頻道準備與訊息傳送是兩個獨立的用途，也不使用 Owner 通知的預算或模板。
  - 找不到伺服器或成員時，該次提醒記為 `recipient_not_found` 並用掉一次提醒次數；Discord 暫時性錯誤（例如 5xx）造成讀取失敗時也是如此。
  - 帳本紀錄的清理以伺服器為單位：同一伺服器較新的提醒紀錄在終止 30 天後被清理時，比它更早建立、還沒送出的提醒會直接視為已處理，不再送出。
  - 送達結果不明的提醒保留固定冷卻，`/work admin-remind force` 也不會提前補送下一次提醒。
  - 工作提醒同一時間只執行一輪；單筆失敗只在本機 log 記錄任務 ID 與錯誤代碼，並繼續處理其他提醒。失敗的任務在同一行程內暫緩重試：從 90 分鐘起，每再失敗一次加倍，最多 24 小時（第一次到達上限時記一次警告）；這些暫緩只存在記憶體，重新啟動後清空，`/work admin-remind force` 則會立即重試。
- **離群用途 `audit.guild.leave`（休眠）**：小吉不再審核伺服器，也不再自動離開任何伺服器。沒有任何程式會為這個用途送出離群請求，也沒有任何程式能為它簽發授權；`audit.guild.leave` 的帳本與用途照舊建立、檢查與回報（帳本固定 8 個），執行環境裡的自動離群上限（每小時最多 3 個、每 24 小時最多 10 個）也照舊留著，只是不會被用到。
- **接龍 ✅**：答案的 ✅ 事件先存在吉幣資料庫的 outbox，最多保留到訊息送出後 24 小時；更舊的直接結案，不會遲到地加上 ✅。✅ 用途不可用時，進行中的一局照常接受答案，只是不加 ✅；新的一局不能開始。✅ 帳本可用、但某一局保存的 ✅ 授權驗證不過時（例如 reinit 後帳本 ID 改變，或圍欄 generation 已前進），答案仍會照常接受，只是不加 ✅；每個伺服器在同一行程內只記一次 `[CHAIN_REACTION] purpose=<用途> code=CHAIN_REACTION_AUTHORITY_INACTIVE reason=LEDGER_CHANGED|FENCE_CHANGED|AUTHORITY_MISSING|AUTHORITY_REVOKED` 警告（只記代碼，不記訊息內容），`/board status` 與接龍狀態會顯示「✅ 未啟用，請在同頻道重新 /board start」；管理員在同一頻道重新開局即可接續同一局並恢復 ✅。帳本停用時不顯示這個提示。
  - 狀態頁的接龍卡是所有伺服器共用的一張。只關係到單一伺服器或單一則訊息的狀況，只會讓那則 ✅ 結案，不會讓接龍卡顯示故障：小吉已不在伺服器、頻道被刪或權限被改，或那一局在送出前結束或換了圍欄；Discord 以權限不足、訊息已不存在或限流拒絕那則 ✅ 也一樣。結案原因寫在 outbox 的 dead letter（例如 `reaction_scope_unavailable`、`reaction_scope_revoked`、`reaction_source_unproven`、`reaction_source_revoked`、`reaction_effect_rejected_permission`、`reaction_effect_rejected_not_found`、`reaction_effect_rate_limited`）；寫成 `reaction_unknown`、`reaction_terminal` 或 `max_attempts` 的（結果不明、Discord 認為請求本身有誤，或內部錯誤）才會讓接龍卡顯示故障。
- **reinit 的影響**：
  - 新人歡迎、扣薪公告、工作提醒與接龍 ✅：新的 cutover 是 reinit 後那次啟動建立帳本的時間，之前的事件不補送。
  - 離群帳本（休眠）與 Owner 安全通知沒有 cutover。
  - 對建立中（`pending`）的登記做 reinit，也會換新的 cutover，建立期間沒送出的事件不補送；只想完成建立，直接啟動即可。
  - 搬移資料根或吉幣資料庫之後做 reinit，不會處理舊位置的檔案；舊檔請人工歸檔，不要刪除。

### 執行規則與異常處理

- 已開始（請求已送往 Discord）但結果不明的送出，下次啟動時一律標為 unknown，絕不重送。程序崩潰或主控台被直接關閉時，作業系統會釋放帳本的鎖，不會留下鎖檔。
- 每次送出最多只會到達 Discord 一次，每筆最多等 15 秒，其中最後 5 秒留給 Discord 回應：discord.js 自己的重試，以及在佇列或限流中等到剩不到 5 秒的請求，都不會再送出。discord.js 已知的限流（包括整個小吉每秒最多 50 個請求的上限）若在這 5 秒之前解除，就原地等候後送出；等不到的就放棄這次送出，不寫帳本：扣薪公告、工作提醒私訊與接龍 ✅ 稍後再送，新人歡迎與 Owner 通知則不補送。結果依 Discord 的回應記錄：成功記為已確認；Discord 拒絕（4xx，包括送出後才收到的 429 限流）記為被拒絕，那件事沒有發生，也不會重送；伺服器錯誤（5xx）、逾時或連線中斷記為結果不明，同樣不重送。小吉的其他訊息（聊天回覆、公告等）不會自動重送：discord.js 的重試次數設為 0。
- 每次開啟都會比對帳本與兩份 witness：帳本最多只能比 witness 多一步（代表一次寫入被中斷），而且雜湊鏈必須接得上；帳本比 witness 或登記的 lastSeen 舊、相差超過一步，或是分叉出去的副本，都視為回退而拒絕（`LEDGER_ROLLBACK`）。開啟帳本時若看到 `-wal` 或上次未完成的送出紀錄，會先做一次完整性快速檢查，未通過就停用該用途。
- 資料表觸發器與沒有金鑰的 SHA-256 只能擋住意外、外部工具與部分還原，擋不住能直接寫入這些檔案的人；請以資料夾權限保護帳本與 witness。
- 送出前就決定不送的事件（新人歡迎與 Owner 通知的佇列已滿、被合併、被預算壓下、送出前取消、準備失敗、請求沒送出）只存在記憶體；新人歡迎與 Owner 通知沒送出就直接結案，不補送，Owner 通知用掉的預算會退回。扣薪公告、工作提醒私訊與接龍 ✅ 沒送出時：遇到等不到的限流，等限流解除後再試，不算一次準備失敗；排隊到逾時或被 test-control 擋下，算一次準備失敗。扣薪公告、工作提醒私訊與接龍 ✅ 的佇列已滿時不記任何決定，事件回報為稍後可重試。準備失敗的事件要等 30 秒後才能再次認領，同一事件第二次準備失敗就定案為不送；只因帳本容量已滿而被拒絕的那次準備不計入。同一個程序內每份帳本最多記住 4,096 筆認領；滿了以後依序淘汰最舊的已定案紀錄、最舊的準備失敗紀錄、租約已過期超過 10 分鐘的認領。被淘汰或被忘記的事件，之後可能再被認領並送出一次（晚送，但不會重複送）。若剩下的全是仍有效的認領，新的認領會被拒絕（`SIDE_EFFECT_CAPACITY_EXCEEDED`）。
- 帳本軟上限為 512 MiB，限制會讓帳本變大的寫入：開始一次送出、寫入一筆「不送」的決定（例如工作提醒的記帳）、寫入接龍 ✅ 的圍欄。超過時，這次寫入會先以 7 天保留期做一次最多 32 批的加速清理並記警告日誌，再試一次；仍超過就拒絕（`SIDE_EFFECT_CAPACITY_EXCEEDED`）。加速清理每份帳本每 10 分鐘（帳本時鐘）最多一次，這段期間超過上限的寫入直接被拒絕，不再清理，也不再記加速清理的警告。被拒絕時：
  - 扣薪公告、工作提醒私訊與接龍 ✅ 的送出當成稍後可重試，用途不停用；
  - 工作提醒的記帳寫入回報為暫時無法使用，用途不停用，由之後的批次再記帳；
  - 新人歡迎與 Owner 安全通知則停用該用途，直到重新啟動。
  - 已經開始的送出永遠可以記錄結果。
- 帳本不會在固定筆數或固定天數到達時整份重置，也沒有可用環境變數任意調高容量。已終止的紀錄會依下列保留期壓縮成不可回退的來源水位線；容量保護只拒絕會讓帳本繼續變大的新寫入，絕不覆寫既有紀錄或把未送出的事件改記成已送出。
- 已終止的紀錄在終止 30 天後可被清理；清理時其來源時間併入同一來源的水位線（只增不減），之後該來源不晚於水位線的事件一律視為已處理，不會再送。每筆紀錄都帶有事件本身的時間；只有私訊頻道的準備紀錄（工作提醒與 Owner 通知）沒有，這些紀錄不會被清理。
- 執行中只要帳本讀寫發現檔案損毀、I/O 錯誤或寫入失敗，或帳本被隔離，該用途立即停用，之後的事件一律回報為暫時無法使用，絕不會被當成已終止；例如工作提醒不會在沒有送出私訊的情況下增加提醒次數。執行中停用時，log（`[PUBLIC_EFFECT]`、`[WELCOME_SAFETY]`、`[OWNER_SAFETY]`）在 `cause=` 後記錄 `SIDE_EFFECT_*` 代碼，SQLite 讀寫錯誤另附 `sqlite=IOERR` 之類的結果碼；Owner 也會收到一則通知。
- **隔離**：文字接龍或數字接龍 ✅ 的反應圍欄寫入或關閉失敗時，該用途當下停用，並把隔離寫進三個位置：帳本旁的隔離標記（`safety/<名稱>.sqlite.retained.lock`）、witness 旁的戳記（`safety-witness/<名稱>.witness.quarantine.json`），以及吉幣資料庫登記上的隔離旗標。之後每次啟動都會以 `LEDGER_QUARANTINED` 停用該用途。開啟圍欄時因容量已滿或參數不合法而被拒絕（圍欄沒有任何改變）只讓這次開局失敗，記 `REACTION_FENCE_OPEN_REJECTED`，不會隔離。處理步驟：
  1. 停止小吉，保留吉幣資料庫、`safety/` 與 `safety-witness/` 的完整複本。
  2. 依 log 的代碼確認原因，並核對對應功能（例如接龍設定與場次）的狀態是否一致。
  3. 確認無誤後，用 `npm run safety:ledger -- release-quarantine` 解除；不要手動刪除、覆寫或重建帳本、`-wal`、witness 或隔離標記。
- **`LEDGER_QUARANTINE_UNPERSISTED`**：隔離三個位置都沒有寫成，自動重新啟動會讓該用途重新啟用。下次啟動前，先在 `.env` 設定 `XIAOJI_PROTECTED_EFFECTS=off`，修復磁碟問題並查明原因後，再改回 `on`。
- **`LEDGER_IN_USE`**：通常表示有第二個小吉正在執行。只保留一個，再重新啟動。
- **`LEDGER_ROLLBACK`、`LEDGER_REGISTRATION_MISSING`、`LEDGER_FILES_MISSING`**：不得刪除、重建帳本或 witness。先執行 status、保留完整複本，查明原因後才依 status 的確認碼 reinit。

### 舊版設定

- **Owner 的 AI 安全提示私訊改為預設開啟。** 升級前，這項私訊由 `XIAOJI_OWNER_SAFETY_DM_ENABLED` 控制，預設關閉；升級後這個變數不再有作用，私訊預設開啟。它和帳本通知共用 Owner 通知的預算：每分鐘 1 則、每小時 6 則、每天最多 24 則。總開關 `XIAOJI_PROTECTED_EFFECTS=off` 會一併關閉它。
- 下列舊變數一律忽略：`XIAOJI_OWNER_SAFETY_DM_ENABLED`、`XIAOJI_SIDE_EFFECT_LEDGER_PATH`、`XIAOJI_SIDE_EFFECT_LEDGER_PROVENANCE_SHA256`、`XIAOJI_WELCOME_LEDGER_*`，以及扣薪、工作提醒、離群、接龍各用途的 `*_LEDGER_ENABLED`、`*_LEDGER_PATH`、`*_LEDGER_PROVENANCE_SHA256`。有設定時，每次啟動只記一行 `[SAFETY_LEDGER] code=LEDGER_LEGACY_VARIABLES_IGNORED names=<變數名稱>`，不讀取它們的值；`*_ENABLED=false` 不再停用任何功能，請改用總開關。可以從 `.env` 移除。
- 舊版用來離線建立帳本的三個 npm 指令已移除。用它們建立的舊帳本不會被遷移，也不會被開啟或修改；小吉會在資料根建立新的帳本。舊檔請人工歸檔。
- `XIAOJI_REMINDERS_PROVENANCE_SHA256` 與 `XIAOJI_CALENDAR_PROVENANCE_SHA256` 屬於個人資料，仍在使用，不是舊變數。

## 公開指令

- 實用：`/help`、`/ping`、`/server`、`/status`、`/about`、`/weather`、`/poll`、`/fortune`、`/roll`、`/remind`、`/calendar`、`/set-welcome`、`/release-announcements`。提醒的新增會送到建立時的文字頻道，但本人可跨伺服器列出或刪除自己的提醒；`/calendar add/list/delete` 依 Discord 帳號管理個人全域行事曆，在不同伺服器仍可查詢或刪除，所有回覆只有本人可見。
- 聊天：`/chat-style`、`/romance`、`/student`、`/memory`、提及小吉
  - **AI 供應商**：設了 `ANTHROPIC_API_KEY` 時用 Claude（`claude-opus-5-5`，思考深度 low，伺服器端備援模型開啟），否則照舊用 Groq，再來是 OpenAI。Claude 可以上網搜尋（每則最多 3 次，每次搜尋另扣 1 單位伺服器 AI 額度）、提出投票（成員按「確認」才開出，限制與 `/poll` 相同），以及記住喜好。
  - **看圖**：只在設了 `ANTHROPIC_API_KEY`（Claude）時開啟。@小吉、叫小吉、回覆小吉，或在 `/student` 用圖片回答時，訊息附的圖片會一起送給模型：只接受 Discord 上傳的附件（png、jpg、gif、webp，每張 5MB 內、每則最多 3 張，網址必須是 `cdn.discordapp.com` 或 `media.discordapp.net`），下載時 10 秒逾時，並用檔頭確認真的是這四種格式之一（以實際格式送出，不採信 Discord 標示的類型）；文字裡的圖片連結、貼圖與預覽不會被讀取。每張圖另扣 10 單位伺服器 AI 額度（與該次呼叫的 1 單位一起扣，不夠就不呼叫）。圖片不保存，對話紀錄只記「附圖 N 張」；讀過圖的那次回覆不寫入喜好記憶。沒設 Claude 時只傳圖會收到固定說明。只是延續對話（沒有 @小吉、叫小吉或回覆小吉）的訊息，圖片不會被讀取。
  - **`/student`**：小吉在公開討論串裡當好奇寶寶，一輪最多問 3 題，依上一個回答追問；只有開始的人的回答算數，10 分鐘沒回答就結束。在自己的討論串再用一次就接著問新的一輪。需要「建立公開討論串」與「在討論串中傳送訊息」權限；每題都經過防洗頻、請求檢查、AI 呼叫限制、伺服器額度與輸出檢查。
  - **喜好記憶與 `/memory`**：設了 `TURSO_DATABASE_URL` 與 `TURSO_AUTH_TOKEN`（Turso 雲端 SQLite）才開啟。成員第一次聊天時用按鈕選擇是否公開：公開時所有伺服器共用一份，不公開（含沒選）時每個伺服器與私訊各自一份。不記敏感資料；一年沒用到的喜好自動刪除。`/memory` 可查看、取得複本、補充、刪除單條、停止或恢復蒐集、全部刪除與改公開設定，回覆只有本人看得到。Turso 連不上時這次聊天不讀也不寫記憶。
  - **AI 對話防洗頻**：所有人一體適用，小吉擁有者與每個伺服器（私人伺服器也一樣）都沒有例外，私有擴充也無法略過。下列訊息在送給 AI 之前就擋下：不呼叫 AI、不計入任何 AI 額度，也不寫入對話紀錄、統計與頻道記憶。
    - 沒有文字：拿掉提及、空白、標點、表情符號與 Discord 自訂表情後什麼都不剩，例如「。。。。」、只有表情符號或貼圖。@小吉 或叫「小吉」時只加標點或表情符號（沒有貼圖、沒有檔案）不算這種，見下方「只 @小吉」；直接回覆小吉、內容只有標點或表情符號（沒有貼圖、沒有檔案）時當作反應，不回覆、不算違規、不呼叫 AI；加上貼圖的仍算。@小吉、叫小吉或回覆小吉時附了小吉看得懂的圖片，不算這種（圖片本身就是內容），照常計入下面的次數限制；只附小吉看不懂的檔案時回一句固定說明。沒有叫小吉、只是延續對話的訊息，附件不算內容。重複檢查會把圖片一起比對，同一句話配不同的圖不算重複。只有一到三個問號（例如「？」「??」）算是提問，照常回覆。
    - 整句只是同一個字重複 6 次以上，或同一小段（2～4 個字）重複 4 次以上，例如「aaaaaa」「哈哈哈哈哈哈」「666666」「哈囉哈囉哈囉哈囉」。「嗨」「哈哈」「哈哈哈哈哈」「謝謝」「早安」「在嗎」這類短句照常回覆。算式符號（`+ - * / = ^ % < > × ÷`）兩邊都有數字的算式不算，例如「111×111=?」「1212+1212」「1+1=?」；只有數字的「666666」，或符號只在一邊的「-666666」「88888888+」「666666 :-)」仍算。
    - 重複洗頻：10 分鐘內在同一伺服器第 3 次說相同或幾乎相同的話（空白、標點、大小寫與表情符號不算差別）。「相同」比的是整段內容；「幾乎相同」要 6 個字以上，而且開頭與結尾各 60 個字都大約九成相同，例如只在句尾多一個字；所以長訊息只差結尾的一段不算。數字與算式符號會保留，所以「1*1=?」和「1-1=?」不算相同。拿掉空白、標點與表情符號後只剩 1～2 個字的短回覆（例如「好」「嗯」「哈哈」「ok」）不算重複，但仍受下一條的次數限制。通過防洗頻、卻沒有得到 AI 回覆的請求（AI 呼叫失敗、3 秒冷卻、額度用完、被 AI 呼叫限制擋下、回覆沒能送出）不算進重複紀錄，重送不會被當成說過了。
    - 太快：同一人在同一伺服器 60 秒內第 6 次、10 分鐘內第 21 次（私訊算一個獨立的伺服器）。對話進行中、不 @ 小吉的接話也算在內。
    - 頻道太擠：同一頻道所有人合計 60 秒內第 11 次。這是大家一起造成的，不算個人違規。
  - **只 @小吉 或只叫「小吉」**（後面沒有文字，或只有標點、表情符號，例如「小吉！」「小吉～」「小吉...」「@小吉 ~」；沒有貼圖或檔案）：不呼叫 AI，也不算違規。「小吉？」這類一到三個問號仍算提問，照一般訊息處理。小吉回一句「我在，有什麼事嗎？」並開始一段對話，接下來的訊息不必再 @；同一人 10 分鐘內最多回一次，其餘不回覆。暫停中照暫停處理。
  - **暫停**：同一人在同一伺服器 10 分鐘內被擋 3 次（頻道太擠不算），在那個伺服器的 AI 對話暫停 10 分鐘；暫停結束後再犯，依序暫停 30 分鐘、2 小時，最長 2 小時。只被擋一兩次只會收到說明，不會暫停。最後一次暫停結束後 24 小時內沒有再被暫停，下一次就從 10 分鐘重新算起。暫停中連正常的訊息也不回覆；說「閉嘴」「安靜」這類話仍會讓小吉安靜，只是不回「好，我先安靜。」。這些紀錄只存在記憶體，重新啟動後歸零；同時記錄的成員與頻道數有上限，過期的紀錄會定期清掉。
  - **被擋時的回覆**：小吉最多回一則簡短的固定說明，不會 @ 本人：每人在同一段暫停期間最多一則（沒有暫停時每 10 分鐘最多一則），頻道太擠的說明每個頻道 5 分鐘最多一則，同一頻道所有說明（包括「我在，有什麼事嗎？」）合計每分鐘最多 3 則；其餘被擋的訊息不回覆。沒有 @小吉、沒有以「小吉」開頭、也不是回覆小吉，只是在對話進行中接著說的訊息，被擋時一律不回覆，也不算違規。說明一樣經過出口防護與輸出限流。
  - **紀錄**：被擋時只在 log 記 `[AI_SPAM] code=AI_SPAM_BLOCKED reason=<meaningless|repeat|user_rate|channel_flood|cooldown>`，開始暫停時記 `[AI_SPAM] code=AI_SPAM_COOLDOWN_STARTED level=<第幾段> minutes=<分鐘> guild=<伺服器 ID> user=<使用者 ID>`；同一種紀錄每分鐘最多一行，沒記的次數寫在下一行的 `suppressed=`。不記訊息內容或使用者名稱，也不私訊 Owner。test-control 下另計入觀察計數 `TEST_OBS_AI_SPAM_BLOCKED`、各原因的 `TEST_OBS_AI_SPAM_<原因>` 與 `TEST_OBS_AI_SPAM_PRESENCE`。
  - **伺服器 AI 額度**（限小吉擁有者設定）：預設不限。設了額度的伺服器，聊天每真的呼叫一次 AI 才扣 1；被防洗頻或 AI 呼叫限制擋下、固定回覆（例如公開資訊、天氣、記憶查詢、拒答）、沒有設定 AI 供應商時都不扣，AI 供應商自己的重試也不另扣，呼叫失敗仍算一次。用完時不呼叫 AI，回「小吉現在有點忙，請晚點再試。」，在 log 記 `[AI_QUOTA] code=AI_GUILD_QUOTA_EXHAUSTED guild=<伺服器 ID>`（每分鐘最多一行）。用量不會自動歸零，要由小吉擁有者重設。私訊不計額度；海龜湯裁判不計入這個額度。這項扣用是本版才接上的：以前設過的額度從這版開始真的會扣，部署前請先由擁有者確認各伺服器的 limit 與 used。
  - **AI 回覆的第二意見（可選，預設關閉）**：擁有者可以接上 TypeSafe AI 的 Jev 判斷服務，只用來救回「被軟規則誤擋」的正當回覆；硬規則永遠照常檢查，逾時或失敗一律維持原本的擋下。啟用前必須先更新隱私政策與條款（成員文字會送到第三方），並設 `JEV_POLICY_ACK=yes`、`JEV_GUILD_IDS` 與 `JEV_API_KEY`。另外還有一個獨立的同意開關 `JEV_LINK_RISK=yes`（預設關）：設了才會讓 Jev 對「規則沒判定有風險、但含連結」的伺服器訊息提供連結風險的第二意見（`shadow` 只記 log，`enforce` 判有風險時發出「釣魚或惡意連結」警示；沒設時完全不送出任何成員訊息；不會刪訊息或處置成員，且會把該則訊息文字去識別化後送到第三方，啟用前同樣要更新隱私政策）。步驟、費用與故障排除見 [docs/JEV_SETUP.md](JEV_SETUP.md)。
  - 防洗頻之後，原有的限制照常生效：同一頻道同一人 3 秒內只回一次，以及 AI 呼叫本身的每人頻率（20 秒 4 次）、重複內容（15 秒）、同時呼叫數與逾時上限。
- 社群：`/word-chain`、`/number-chain`、`/daily-riddle`、`/daily-discussion`
- 吉幣與商店：`/coins`、`/daily`、`/leaderboard`、`/shop`、`/inventory`、`/luxury`、`/pawn`、`/bank`、`/exchange`、`/work`、`/economy`、`/coin-admin`。每日簽到依台灣日期計算，每人每天一次；吉幣帳務、商店／背包、銀行帳務與籌碼依帳號在可使用小吉的伺服器間共用。工作每人同一時間只有一個全域主職；目前不開放辭職，`/work cancel` 只會顯示這項說明，工作會在選定的天數期滿後自動結算。`/leaderboard` 以 `type` 選擇吉幣餘額（預設）或總資產排行榜，總資產只顯示前 25 名；購買商品只有 `/shop buy` 一個入口。`/economy` 與 `/coin-admin` 是管理指令，全域錢包變更限小吉擁有者。
- 遊戲：在 Discord 使用 `/board start` 從統一目錄開始個人、接龍、每日猜謎、決鬥塔台、賭場、棋盤或推理遊戲；使用 `/board status` 查看目錄與自己可見的現存遊戲。多人棋盤與推理遊戲仍可使用 `/board join/leave/stop`。賭場借款與紀錄使用 `/casino`，賭場大廳、場館與決鬥塔台的資料使用 `/casino-lobby`、`/casino-venue` 與 `/duel-tower`。不為新使用者建立網頁遊戲局。
- 公開版本資訊：請由 [GitHub 上 `xiaoji-formal` 的 Release 頁](https://github.com/xichengyu810067-lab/xiaoji-formal/releases)閱讀。

完整的玩家功能、玩法與限制會列在官網狀態頁的公開功能清冊。

## 部署與驗證

`npm run deploy` 將公開指令註冊為 global commands；公開核心不含任何擁有者專用的指令（擁有者伺服器見下一節）。未設定本機私有擴充時，程式仍可載入並啟動公開核心。部署送出後會再讀一次 Discord 上的註冊結果，只回報差異，不會自動修正；回讀失敗也不會讓部署變成失敗。

`AUTO_DEPLOY_COMMANDS=true` 時，啟動會在登入前先部署。部署失敗或被拒絕時（例如指令目錄與 builder 不一致、`XIAOJI_PROTECTED_GUILD_IDS` 格式錯誤，或部署會清空某個伺服器的指令卻不被受保護清單允許），啟動會以非 0 結束，小吉不會登入上線；先修正問題再重新啟動。

### 擁有者伺服器（`XIAOJI_OWNER_GUILD_ID`）

公開核心不含任何擁有者專用的指令，也不含資料庫管理指令。擁有者專用的管理功能由可選的私有擴充提供：它們只部署到「擁有者伺服器」，不會部署到全域；執行時指令會再檢查一次伺服器，擁有者身分不能代替伺服器範圍。在 `.env` 設定擁有者伺服器：

```text
XIAOJI_OWNER_GUILD_ID=<擁有者伺服器的 ID>
```

伺服器 ID 不是憑證，必須是單一的 16 到 22 位數字。公開檔案不要寫入真實的伺服器 ID。

- 未設定或格式不合：擴充的擁有者專用指令不會部署到任何地方，也不會退回全域部署，執行時一律拒絕；公開指令照常部署。
- `--public-only` 不碰伺服器層級的路由，所以不部署任何擁有者專用指令；全域指令同樣不含它們。
- `AUTO_DEPLOY_COMMANDS` 與 `npm run deploy` 使用同一份部署計畫，也讀同一個變數。`--test-control` 部署不受影響，只部署到測試群。
- 公開核心裡仍有兩處讀這個變數：`src/utils/env.js` 用它決定「成員退出通知」的來源（見上方）；`deploy-commands.js` 用它放置「公開目錄標成擁有者專用」的指令，但目前公開目錄沒有這種指令，所以它不部署任何東西。
- 擁有者專用管理功能的清單、用法、部署順序與檢查項目，記在私有擴充自己的文件裡，不在公開倉庫。

哪些功能只存在於私有擴充、哪些指令其他伺服器看得到，以及公開功能所需的最小機器人權限，見 [docs/MANAGEMENT_ISOLATION.md](MANAGEMENT_ISOLATION.md)。

### 稽核與清理已註冊的指令

先用唯讀稽核確認 Discord 上實際註冊的指令：

```powershell
node deploy-commands.js --audit
node deploy-commands.js --audit --all-guilds
```

- `--audit` 只讀取 Discord，不新增、修改或刪除任何指令。預設只讀全域指令、部署計畫中的私有群、擁有者伺服器（有設定 `XIAOJI_OWNER_GUILD_ID` 時）與清理目標群；加上 `--all-guilds` 才會另外讀取小吉已加入的所有伺服器。
- 比對來源是指令目錄與 builder，私有群依部署計畫。差異分成缺少（missing）、多出（extra）、變更（changed）、全域與群組同名遮蔽（shadow）、已移除指令殘留（tombstone），每一項都附上範圍與 command ID。「變更」以正規化 JSON 的 SHA-256 比對，不看 Discord 回傳的 `id`、`version`、`application_id` 等欄位。
- 輸出最後一行是摘要碼：差異清單連同讀取範圍與應用程式 ID 的 SHA-256。輸出只含伺服器 ID、指令 ID 與指令名稱，不含 Token 或其他憑證。

看過差異後，再用與稽核相同的選項和摘要碼清理：

```powershell
node deploy-commands.js --cleanup <摘要碼>
node deploy-commands.js --cleanup <摘要碼> --yes
```

- 清理會重新讀取並重算差異；摘要碼不一致就拒絕，並印出新的摘要碼。
- 只刪除全域多出的指令，以及非私有群（清理目標群、`--all-guilds` 讀到的其他伺服器）裡的殘留，逐一以 command ID 刪除。部署計畫中的私有群與擁有者伺服器一律不刪，也不改任何指令權限。缺少、變更與子指令層級的殘留不會刪除，請用 `npm run deploy` 重新部署修正。
- 沒有 `--yes` 時只列出將刪除的清單，不發出任何刪除請求。刪除後會再讀一次，確認殘留已清除並輸出結果；仍有殘留或刪除失敗時以失敗結束。
- 刪除伺服器層級的指令必須同時載入私有擴充並設定 `XIAOJI_PROTECTED_GUILD_IDS`；缺一項時，清理會拒絕刪除任何伺服器層級的指令。只要清理全域指令時，稽核與清理都加上 `--public-only`。
- `--test-control` 模式只讀取測試應用程式的測試群，也只刪測試群的殘留，同樣需要摘要碼與 `--yes`。目前 `npm run test-control:deploy` 啟動器只會執行部署，還不會轉交這兩個選項。

#### 受保護伺服器（`XIAOJI_PROTECTED_GUILD_IDS`）

建議在 `.env` 設定 `XIAOJI_PROTECTED_GUILD_IDS`，列出所有私有群的伺服器 ID，以逗號分隔。伺服器 ID 不是憑證；只要有一項不是有效 ID，稽核、清理、一般部署（含 dry run）與 `AUTO_DEPLOY_COMMANDS` 啟動都會在連線 Discord 前失敗，不論部署計畫內容為何。

- `--cleanup` 一律不刪受保護伺服器裡的指令，不論部署計畫怎麼宣告、範圍怎麼分類。即使私有擴充漏列了某個私有群，加上 `--all-guilds` 清理時也不會刪到它；這些指令會以 `skip` 列出。
- `--audit` 會在受保護伺服器的範圍與差異項目後標示 `protected=true`。部署計畫中的私有群若不在清單內，稽核會印出警告。
- `npm run deploy` 不會清空受保護伺服器：清理目標群（`deployment.cleanupGuildIds`）或沒有私有指令的部署目標群若在清單內，部署會在送出任何 Discord 請求前拒絕執行，dry run 與 `AUTO_DEPLOY_COMMANDS` 也一樣；請從 `deployment.cleanupGuildIds` 移除該伺服器。稽核也會先警告這種情況。
- 受保護狀態也納入摘要碼。稽核後若改了清單，而影響到這次讀取的伺服器，原本的摘要碼就不再相符，必須重新稽核。
- 未設定時，`--cleanup` 一律不刪任何伺服器層級的指令，只能用 `--public-only` 清理全域指令；`--audit` 與 `--cleanup`（含加了 `--yes`）都會提醒建議設定。一般部署只要會清空任何伺服器的指令（清理目標群，或對沒有私有指令的部署目標群送出空清單），就會在送出任何 Discord 請求前拒絕執行，dry run 與 `AUTO_DEPLOY_COMMANDS` 也一樣；請先設定 `XIAOJI_PROTECTED_GUILD_IDS`（列出所有私有群）。不會清空任何伺服器的部署，未設定清單也照常執行。稽核會先警告這種情況。

### 出口防護

執行中的 Bot 送往 Discord 的每一筆請求都會先檢查。公開功能只能使用已知的訊息、互動、私訊、✅ 與討論串路由；無法檢查的內容、未驗證附件、非正規路由及破壞性路由一律不送出。使用者輸入、投票、提醒與其他文字中的未核准網址會改為「[連結已移除]」：沒有 `https://` 的網址（例如 `example.com/xxx`，Discord 可能把它顯示成連結）也算，`https://` 後面緊跟表情符號、符號或看起來像英文字母的特殊字元（例如 `https://🎁.ws/x`）的寫法也一併移除：這一段用瀏覽器自己的網址解析規則判斷，解得出主機就整段移除：IP，或兩段以上、最後一段是網域結尾的名稱（英文字母與數字，或 `台灣`、`рф` 這類非英文的網域名稱，或寫成 `xn--` 的）；圈起來或全形的字母與數字、中文句號 `。`、全形句點、看不見的字元都會照瀏覽器的方式換算（例如 `https://ⓔⓥⓘⓛ。ⓒⓞⓜ`、`https://０x7f000001`、`https://９３。１８４。２１６。３４`、`https://「a@evil.com` 都移除）。瀏覽器因為看不見的字元（零寬連接符、標籤字元、方向記號）而拒收的，會去掉它們再讀一次，較舊的用戶端就是這樣開的（`https://` 後面接零寬連接符再接 `evil。com`、家庭表情符號加 `.ws` 都移除）。瀏覽器解不出主機的（只有一段沒有點，例如「網址要以https://開頭」，或含瀏覽器不收的字元）、在中文標點處斷開後不成主機的（例如「要用https://開頭，版本v1.1.2以後都支援」）、最後一段是整句話或一個詞而不是網域結尾的（例如「請記得網址要以https://開頭。這樣比較安全，也比較不會被釣魚網站騙。另外記得檢查網域。」：句號在瀏覽器眼裡是點，但「另外記得檢查網域」不是網域結尾）、最後一段是英文與中文混雜的（例如「要用https://開頭.不要用http」）不受影響。最後一段剛好是英文字或網域名稱的（例如「以https://開頭。OK」「請看https://開頭。公司」），分不出與 `https://領獎。台灣` 的差別，會整段移除；已核准的連結包在粗體、底線或刪除線裡（例如 `**https://discord.gg/TqkCx9kYmk**`）照樣保留，標記留在連結外面；版本號與電子郵件不算，檔名只有結尾不在連結結尾清單內的（`README.md`、`main.py`、`data.json`）不算，結尾剛好也是網域結尾的（`requirements.in`、`model.pt`、`book.mobi`、`logo.ai`）會被改寫，名稱前面整段都是中文、日文或韓文字（例如 `謝謝.Life`）時要帶連接埠、路徑、查詢或片段（`領獎.com/x`）才算。元件識別碼（`custom_id`）、選單選項與自動完成選項的值只是小吉自己讀回的資料，不看沒有 `https://` 的名稱，裡面的有 `https://` 網址與邀請連結一樣會移除。`@everyone` 與身分組提及也會移除；回覆不會再 ping 原訊息作者；轉傳訊息（forward）的請求一律不送出（`EGRESS_FORWARD_BLOCKED`，和其他被拒絕的對外請求一樣處理），因為轉傳的內容是 Discord 在送出後才帶入的，無法先檢查。

已驗證的本機私有擴充只可在 `XIAOJI_PROTECTED_GUILD_IDS` 所列伺服器使用非公開寫入路由。這些私有伺服器內，擴充明確設定的 `@everyone` 與身分組提及會保留，但網址仍依相同規則改寫。無論來源為何，小吉都不會透過程式離開清單中的伺服器，也不會送出批量封鎖、清除成員或刪除伺服器的請求。擁有者在受保護伺服器裡用私有擴充指令（包含該指令的自動完成）讓小吉離開其他伺服器時，小吉會先確認執行這個指令的人就是設定的擁有者；這類離群每小時最多 3 個、每 24 小時最多 10 個（在執行中的程式內計算）。小吉自己不審核伺服器，也不會自動離開任何伺服器。私有擴充送出的請求原則上不能附帶檔案，唯一的例外是：受保護伺服器裡的私有擴充指令回覆自己這一次的互動（第一次回覆、後續訊息，或編輯這些回覆）時，可以附上 1 個 1 MiB 以內的 UTF-8 文字檔，例如設定匯出。檔名必須以英文字母或數字開頭，最長 128 個字元，只能用英文字母、數字、`_`、`-` 與 `.`（可以有好幾個 `.`，但不能兩個連在一起），副檔名必須是小寫的 `.json`、`.txt` 或 `.csv`；回覆內容要改附件檔名時也照同一規則。檔案裡有 `https://` 的未核准網址與 Discord 邀請連結一樣會改寫；沒有 `https://` 的名稱不改（設定匯出檔裡的 `announcement.channel.id` 這類鍵名與沒有 `https://` 的網站名稱會原樣送出，因為改寫會弄壞檔案）。其他帶有檔案的請求一律不送出。

私有擴充在受保護伺服器裡做管理操作時，使用較寬鬆但仍有上限的額度（在執行中的程式內計算，擴充無法調高）：

- 成員懲處（封鎖、解除封鎖、踢出、禁言等）：每個伺服器每小時 30 次。
- 身分組加減（包含同步）：每個伺服器每小時 300 次，而且每分鐘最多 30 次。同步跑得太快時，多出來的部分會被延後、不會排隊，需要稍後再同步一次。
- 刪除單則訊息：每個伺服器每小時 200 次。
- 批次刪除訊息：每個頻道每 10 分鐘 10 次（每次 2 到 100 則）。
- 刪除頻道、建立頻道：各為每個伺服器每天 20 次。
- 其他私有寫入：每個伺服器每小時 60 次。

在受保護伺服器裡，自動防護發出的懲處與擁有者用指令手動做的懲處共用同一組上限，擁有者也不能繞過；其他額度同樣不分是誰觸發。其他伺服器，以及不是由私有擴充發出的請求，規則都不變。

### 本機檢查

```powershell
npm test
npm run check
npm run site:check
```

這些檢查使用合成案例，不會登入 Discord 或啟動正式 bot；`site:check` 檢查公開頁面可見的版本、功能與未知狀態。公開狀態資料缺失時維持未知／維護狀態，不以零值或健康狀態替代。

`npm run check` 也會檢查程式的分層規則與資料表擁有權；程式怎麼分層、規則怎麼讀、新增功能要改哪些檔案，見 [docs/ARCHITECTURE.md](ARCHITECTURE.md)。

## 本機隔離測試（test-control）

test-control 只用來在本機執行測試用 Bot。獨立的信任檔（trust JSON）限定測試應用程式 ID（`expectedApplicationId`）、伺服器、頻道、操作者、指令與測試資料根目錄（`dataRoot`）；超出範圍的 Discord 請求、事件或資料路徑一律拒絕，只輸出 `[TEST_CONTROL] code=...` 固定代碼。含 `..`、`%2e`、`%2f`、`%5c`、`%uXXXX`、反斜線、控制字元、過長 UTF-8 或多層編碼等可能被網址正規化改寫的請求路徑，也會以 `TEST_ROUTE_NORMALIZATION_DENIED` 拒絕。

`dataRoot` 必須是只給測試用的實體目錄，而且不能位於任何 Git 工作目錄之內，主 checkout 與所有 worktree 都算（`TEST_DATA_ROOT_IN_REPOSITORY`）。目錄內要直接放有測試專用標記檔 `.xiaoji-test-root.json`；標記記錄測試應用程式 ID，以及這個目錄本身的身分（磁碟區與檔案編號）。遇到下列情況，launcher、owner 啟動與部署都會在讀寫任何資料前停止：

- 缺少標記：`TEST_DATA_ROOT_MARKER_MISSING`
- 標記的應用程式 ID 和信任檔的 `expectedApplicationId` 不同：`TEST_DATA_ROOT_MARKER_MISMATCH`
- 標記屬於另一個目錄（例如整包複製、從備份還原或跨磁碟搬移）：`TEST_DATA_ROOT_MARKER_IDENTITY_MISMATCH`
- 標記格式錯誤，或不是該目錄內的一般單一檔案（例如連結、硬連結或資料夾）：`TEST_DATA_ROOT_MARKER_INVALID`

標記只用來防止設定錯誤（例如信任檔誤指到正式資料目錄），不是權限控制；能修改這些檔案的人仍可自行建立標記。

標記由下列指令依信任檔的 `dataRoot` 與 `expectedApplicationId` 建立，且只寫入空目錄：目錄只有相同標記時視為已完成，有其他任何檔案時拒絕（`TEST_DATA_ROOT_NOT_EMPTY`）且不寫入；信任檔把 `expectedApplicationId` 也列在 `forbiddenApplicationIds` 時，會先以 `TEST_EXPECTED_APP_FORBIDDEN` 拒絕。

```powershell
New-Item -ItemType Directory '<Git 工作目錄以外的全新測試資料目錄>'
node scripts/test-control.js init-data-root --trust '<信任檔絕對路徑>'
```

建立標記後再放入測試資料檔，然後部署測試指令並啟動；啟動後在同一個終端機輸入 `STOP` 結束：

```powershell
npm run test-control:deploy -- --config '<測試設定檔>' --trust '<信任檔>'
npm run test-control:owner -- --config '<測試設定檔>' --trust '<信任檔>'
```

在本機 NTFS 磁碟上，於同一個磁碟內改名或搬移資料目錄，目錄身分不變，標記仍然有效（信任檔的 `dataRoot` 要同步改成新路徑）。從備份還原或跨磁碟搬移後，目錄身分會改變，必須依下列步驟重新建立標記。ReFS／Dev Drive、FAT／exFAT、網路磁碟與同步資料夾（例如 OneDrive）尚未驗證；在這些位置若出現 `TEST_DATA_ROOT_MARKER_IDENTITY_MISMATCH`，同樣依下列步驟重建。

升級到這個版本後，原本沒有標記的測試資料目錄會回報 `TEST_DATA_ROOT_MARKER_MISSING`；以較早測試版建立、缺少 `dataRootIdentity` 的標記則會回報 `TEST_DATA_ROOT_MARKER_INVALID`。兩者處理方式相同：已有檔案的目錄不能直接補標記，請依下列步驟新建空目錄、建立標記，再搬入資料：

1. 停止 test-control。
2. 在 Git 工作目錄以外建立一個全新的空目錄。
3. 把信任檔的 `dataRoot` 改成這個新目錄。
4. 執行 `node scripts/test-control.js init-data-root --trust '<信任檔絕對路徑>'`。
5. 把舊目錄的測試資料檔搬進新目錄，但不要搬舊的 `.xiaoji-test-root.json`。
6. 照常部署與啟動。

test-control 的安全帳本放在測試資料根的 `safety/` 與 `safety-witness/`，吉幣資料庫裡的登記記著它們的位置。換到新目錄後，這 4 個用途會因位置不符（`LEDGER_PATH_MISMATCH` 或 `LEDGER_FILES_MISSING`）而停用，其他測試照常；停止 test-control 後，用 `npm run safety:ledger -- status --data-root '<新目錄>' --coin-db '<新目錄內的吉幣資料庫>'` 檢查，再依 status 顯示的確認碼 reinit。舊目錄的帳本檔案不會被處理。

## 擴充介面

公開核心提供可選的本機擴充介面，契約見 [docs/EXTENSION_CONTRACT.md](EXTENSION_CONTRACT.md)。公開匯出工具只接受 allowlist，拒絕環境檔、資料檔、私有模組、正式維運腳本與內部報告。
