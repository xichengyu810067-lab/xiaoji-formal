# 小吉 VPS 24/7 部署流程

這份流程以 Ubuntu VPS 為主，目標是讓小吉在背景常駐、崩潰自動重啟、VPS 重開機後自動上線。

## 重要安全規則

- 不要把 `.env`、Discord token、API key、伺服器 ID、使用者 ID 貼到聊天室或公開倉庫。
- `.env` 只在 VPS 上手動建立，權限設為 `600`。
- `src/data/*.json` 是執行期資料，可能包含伺服器、頻道或使用者 ID，預設不要提交到 Git。
- `guildAudit.json` 與 `inviterWhitelist.json` 是准入權威資料，正式環境必須透過
  `XIAOJI_AUDIT_DATA_PATH`、`XIAOJI_INVITER_WHITELIST_PATH` 指向不會被更新取代的兩個不同絕對路徑。
- 如果 token 曾經被公開，請到 Discord Developer Portal 立即 reset token。

## 如何取得 SSH 入口

部署腳本需要四個 SSH 資訊：

- `HostName`：VPS 的公開 IPv4、IPv6 或主機名稱，例如 `203.0.113.10`。
- `User`：Linux 登入帳號，常見是 `root`、`ubuntu`、`debian` 或你建立的使用者。
- `Port`：SSH 連接埠，預設通常是 `22`。
- `IdentityFile`：SSH 私鑰路徑，只有使用金鑰登入時需要，例如 `C:\Users\USER\.ssh\id_ed25519`。

取得方式：

1. 到你的 VPS 服務商後台，打開該主機的「連線」、「SSH」、「Access」、「Networking」或「Public IP」頁面。
2. 找到公開 IP，這就是 `-HostName`。
3. 找到預設登入使用者，這就是 `-User`。Ubuntu 映像常見是 `ubuntu`，Debian 映像常見是 `debian`，部分 VPS 直接使用 `root`。
4. 確認 SSH port。沒有特別改過就是 `22`。
5. 確認登入方式。如果後台提供密碼，就先用密碼登入；如果要求 SSH key，就下載或使用你建立時綁定的私鑰。

在 Windows PowerShell 先測試能不能進 VPS：

```powershell
ssh your_linux_user@your.vps.host
```

如果 SSH port 不是 `22`：

```powershell
ssh your_linux_user@your.vps.host -p 2222
```

如果使用 SSH key：

```powershell
ssh your_linux_user@your.vps.host -i "$env:USERPROFILE\.ssh\id_ed25519"
```

能登入並看到 Linux shell 後，代表你已經拿到可用的 SSH 入口。接著就可以把同一組資訊放進本機部署腳本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-to-vps.ps1 `
  -HostName your.vps.host `
  -User your_linux_user `
  -Port 22 `
  -IdentityFile "$env:USERPROFILE\.ssh\id_ed25519" `
  -RemoteDir "~/xiaoji-discord-bot" `
  -UploadEnv `
  -InstallSystemPackages
```

如果你是密碼登入，不要加 `-IdentityFile`。如果你的平台是 Render、Railway、Vercel 這類 PaaS，通常不會提供完整 SSH 入口，部署方式要改用平台的 Git 或 Dashboard 部署流程。

## 第一次部署

```bash
sudo apt update
sudo apt install -y git curl

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo npm install -g pm2
node -v
npm -v
pm2 -v
```

把公開倉庫拉到 VPS。請把下面的網址換成你的公開 repo URL，不要在 URL 裡放 token。

```bash
git clone https://github.com/YOUR_NAME/YOUR_REPO.git
cd YOUR_REPO
npm ci --omit=dev
```

建立 `.env`。請在 VPS 終端機內輸入實際值，不要貼到任何公開地方。

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

確認設定完整，不會輸出任何秘密值：

```bash
npm run prod:check
npm run smoke:login
```

部署 Discord slash commands：

```bash
npm run deploy
```

用 PM2 啟動小吉：

```bash
pm2 startOrRestart ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

`pm2 startup` 會輸出一行 `sudo ...` 指令，把它複製貼上執行一次。完成後再跑：

```bash
pm2 save
pm2 status xiaoji-discord-bot
pm2 logs xiaoji-discord-bot --lines 80
```

看到 ready 訊息後，到 Discord 測試 `/ping` 和 `@小吉 你好`。

## 從本機一鍵部署到 VPS

如果你的 Windows 本機可以用 SSH 登入 VPS，可以直接用這支腳本把乾淨 release 上傳到 VPS，並在遠端執行安裝、`npm run deploy`、PM2 啟動。腳本不會列印 `.env` 的內容。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-to-vps.ps1 `
  -HostName your.vps.host `
  -User your_linux_user `
  -RemoteDir "~/xiaoji-discord-bot" `
  -UploadEnv `
  -InstallSystemPackages
```

如果你使用 SSH key：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-to-vps.ps1 `
  -HostName your.vps.host `
  -User your_linux_user `
  -IdentityFile "$env:USERPROFILE\.ssh\id_ed25519" `
  -RemoteDir "~/xiaoji-discord-bot" `
  -UploadEnv `
  -InstallSystemPackages
```

第一次部署可以加 `-UploadEnv`，之後若 `.env` 沒變，可以拿掉 `-UploadEnv`。

## 更新部署

正式更新前，兩個准入資料環境變數必須已指向 release 目錄外的既有受保護檔案。既有主機第一次升級時，先停止小吉，由操作者辨識並原樣保全目前權威檔，再更新 VPS 上既有的 `.env`；不要執行初始化、不要從舊快照回填，也不要依畫面上的 `unknown` 推測原狀態。

後續 Git 更新只可執行已驗證候選 release 內的新版本腳本。腳本會先把候選展開到暫存目錄並驗證，停止 PM2 寫入者，使用同一收據做更新前後比對；任何檢查失敗都不會啟動新候選：

```bash
cd YOUR_REPO
bash scripts/vps-update.sh
```

從 Windows 上傳 release 時，`scripts\deploy-to-vps.ps1` 會在切換 `current` 前停止寫入者並建立收據，切換後以同一收據驗證，再執行正式檢查與啟動。失敗時會把 `current` 指回原 release 並保持停止，讓操作者先查明原因。舊主機第一次升級不可先用舊版 `vps-update.sh` 拉取程式；請使用已驗證候選 release 的部署腳本，或依私有維運說明執行受保護的主機流程。

若啟動指令在建立程序後才失敗，更新工具會先再次停止並確認沒有執行中的 PM2 PID，成功後才回復原程式或 release 指標。無法確認停止時會保留候選來源與復原證據，避免執行中程序和磁碟上的舊程式混用；此時必須由操作者先安全停機，不能直接重啟或再次覆蓋。

## 常用維運指令

```bash
pm2 status xiaoji-discord-bot
pm2 logs xiaoji-discord-bot
pm2 restart xiaoji-discord-bot --update-env
pm2 stop xiaoji-discord-bot
```

## 發布前清理公開倉庫

如果你的公開倉庫曾經提交過 `.env` 或 `src/data/*.json`，先從 Git 追蹤中移除，但保留 VPS 本機檔案：

```bash
git rm --cached .env src/data/*.json 2>/dev/null || true
git add .gitignore
git commit -m "Remove private runtime files from repository"
git push
```

如果 `.env` 曾經被推上公開 GitHub，單純刪檔不夠，請直接 reset Discord token 和所有 API key。
