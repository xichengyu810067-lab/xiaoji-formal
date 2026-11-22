// Source of truth: src/platform/catalogs/publicFeatureCatalog.js, loaded by the bot with require(). website/publicFeatureCatalog.js is a byte-for-byte
// copy that the status page loads with a <script> tag; `npm run site:render` writes it and `npm run check` refuses a stale
// copy. Edit this file, never the copy.
(function exposePublicFeatureCatalog(root, factory) {
  const gameCatalog = typeof module === 'object' && module.exports
    ? require('./gameCatalog')
    : root.XiaojiGameCatalog;
  const api = factory(gameCatalog);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.XiaojiPublicFeatureCatalog = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function createPublicFeatureCatalogApi(gameCatalog) {
  'use strict';

  const unifiedGameNames = (gameCatalog?.GAME_CATALOG || []).map((game) => game.name.replace(/（.*$/u, '')).join('、');
  const unifiedGameCount = (gameCatalog?.GAME_CATALOG || []).length;

  // This is editorial, public-facing content rather than live status data.
  // Keeping it separate means an unavailable or stale status snapshot cannot
  // hide, add, or reintroduce private features in the public feature list.
  const PUBLIC_SYSTEM_CATALOG = Object.freeze([
    {
      name: 'AI 與聊天',
      features: [
        { name: '@小吉聊天', purpose: '被提及時提供一般對話、簡單回覆與可安全降級的 AI 回應。', howTo: '@小吉 後輸入想聊的內容。', limitation: '一般使用者可用。只 @小吉 時回「我在，有什麼事嗎？」（每人 10 分鐘一次）。沒有文字、10 分鐘內第 3 次說相同的話、同一伺服器 60 秒超過 5 次或 10 分鐘超過 20 次、同一頻道 60 秒合計超過 10 次的訊息不會回覆；10 分鐘內被擋 3 次會暫停 AI 對話 10 分鐘，再犯延長為 30 分鐘、2 小時。伺服器的 AI 額度用完時，小吉會請你晚點再試。' },
        { name: '個人化對話風格', purpose: '查看或保存自己的對話風格。', howTo: '使用 /chat-style current 或 /chat-style set。', limitation: '一般使用者可用；偏好依使用者帳號保存。' },
        { name: '情侶模式', purpose: '明確開啟、關閉或查看親暱文字語氣。', howTo: '使用 /romance start、/romance stop 或 /romance status。', limitation: '一般使用者可用，且必須由本人明確選擇開啟。' },
        { name: '聊天記憶', purpose: '記住你說過的喜好與在伺服器裡聊過的內容，讓小吉記得剛剛聊了什麼、知道你是誰。', howTo: '第一次聊天時選擇是否公開；用 /memory 查看、補充、刪除或停止記憶。', limitation: '私訊不會被記住；每人每天最多記 30 則，每月 1 號中午 12:00 重新計算並刪除上個月的內容；其他成員不能查詢你的記憶。' },
        { name: '好奇寶寶 /student', purpose: '小吉開一個討論串問你問題，接著你的回答繼續問。', howTo: '使用 /student 開始，用文字或圖片回答。', limitation: '每一輪最多 3 題；10 分鐘沒回答就結束。' },
        { name: '看圖', purpose: '聊天時附上圖片，小吉可以描述與討論圖片內容。', howTo: '@小吉、叫小吉或回覆小吉時附上圖片。', limitation: '每則最多 3 張、每張 5MB 以內（png、jpg、gif、webp）；不辨識照片中的人、不讀出個人資料；每張圖另算 10 次伺服器 AI 額度。' },
        { name: '上網搜尋', purpose: '問到新聞、比賽結果等即時資訊時，小吉會自己上網查。', howTo: '直接問小吉即可。', limitation: '引用時只寫網站名稱；搜尋結果可能過時或有誤；每次搜尋另算 1 次伺服器 AI 額度。' },
      ],
    },
    {
      name: '實用工具',
      features: [
        { name: '美食地圖', purpose: '查食譜、請小吉推薦某個地區的美食，或把推薦的店加入伺服器自己的美食地圖。', howTo: '使用 /food recipe、/food nearby、/food add、/food list 或 /food remove。', limitation: '食譜與附近美食由 AI 產生，每次另算 1 次伺服器 AI 額度，資訊可能有誤或過時；推薦只列店名與地址，請自行在地圖 App 搜尋；伺服器美食地圖（/food add、list、remove）目前是測試中的功能，只有授權的伺服器可以使用，每個伺服器最多 300 家店。' },
        { name: '股票報價', purpose: '查詢台股（上市、上櫃）、台灣與美國 ETF、美股與加密貨幣的報價、近一個月走勢圖，並保存自己的自選股清單。', howTo: '使用 /stock quote、/stock chart、/stock watchlist、/stock watch-add 或 /stock watch-remove；聊天時直接問小吉「台積電現在多少」也可以。', limitation: '報價可能延遲，僅供參考，不構成投資建議；美股與加密貨幣查詢有次數上限；自選股每人最多 10 檔。' },
        { name: '天氣查詢', purpose: '查詢指定地點或自然語言的天氣問題。', howTo: '使用 /weather，或向小吉詢問天氣。', limitation: '一般使用者可用；即時查詢需要已設定天氣服務。' },
        { name: '跨伺服器個人提醒', purpose: '新增、列出與刪除自己的提醒，並在重啟後恢復排程。', howTo: '使用 /remind add、/remind list 或 /remind delete。', limitation: '提醒會發送到建立時的伺服器文字頻道；本人可跨伺服器管理自己的提醒，不能管理他人的提醒。' },
        { name: '個人全域行事曆', purpose: '建立只有自己可查詢的個人事件，並在可使用小吉的不同伺服器共用。', howTo: '使用 /calendar add 新增、/calendar list 查詢、/calendar delete 刪除自己的事件。', limitation: '事件依 Discord 帳號隔離；管理員與機器人擁有者也不能跨讀或刪除他人的事件。所有回覆只有本人可見，操作需在伺服器文字頻道內進行。' },
        { name: '抽籤與擲骰', purpose: '抽取一則小吉籤，或擲出骰子與總和。', howTo: '使用 /fortune 或 /roll。', limitation: '骰子面數可設為 2–1000 面，數量可設為 1–20 顆。' },
      ],
    },
    {
      name: '社群互動',
      features: [
        { name: '投票', purpose: '建立投票並以按鈕收集互動。', howTo: '使用 /poll 建立投票。', limitation: '一般使用者可用；按鈕互動由小吉處理。' },
        { name: '文字接龍', purpose: '在頻道中進行文字接龍並驗證接續內容；教育部辭典查不到的詞，會請 AI 判斷是不是真的詞語。', howTo: '使用 /board start 開局；使用 /word-chain stop 或 /word-chain status 管理現存局。', limitation: '一般成員可參與；啟動與停止受伺服器適當權限限制。' },
        { name: '數字接龍', purpose: '在頻道中進行數字接龍並驗證數字流程。', howTo: '使用 /board start 開局；使用 /number-chain stop 或 /number-chain status 管理現存局。', limitation: '一般成員可參與；啟動與停止受伺服器適當權限限制。' },
        { name: '每日猜謎', purpose: '依每日週期發布謎題並收集參與者。', howTo: '使用 /board start 加入或開啟當日題目；排程設定使用 /daily-riddle enable、disable 或 status。', limitation: '一般成員可參與；設定受伺服器適當權限限制。' },
        { name: '每日議題', purpose: '依每日週期發布議題、收集回覆並結算活動。', howTo: '使用 /daily-discussion enable、/daily-discussion disable、/daily-discussion status 或 /daily-discussion run-now。', limitation: '一般成員可參與；設定與立即執行受伺服器適當權限限制。' },
      ],
    },
    {
      name: '吉幣、工作與銀行',
      features: [
        { name: '吉幣與台灣每日簽到', purpose: '查看跨伺服器帳號餘額、簽到、排行榜與經濟摘要。', howTo: '使用 /coins、/daily，或用 /leaderboard 選擇吉幣餘額或總資產排行榜。', limitation: '每日簽到依台灣日期計算；每位玩家一天一次，於可使用小吉的伺服器間共用。一般使用者可查詢自己的餘額與公開排行榜；總資產排行榜固定顯示前 25 名。涉及他人帳務或設定的操作仍需適當權限。' },
        { name: '全域商店與背包', purpose: '瀏覽普通或精品商品、購買商品，並查看自己的背包與購買紀錄。', howTo: '使用 /shop list、/shop buy、/shop purchases、/inventory，或 /luxury list、/luxury buy、/luxury inventory、/luxury history。', limitation: '普通與精品商品、庫存、限購與背包在可使用小吉的伺服器間共用；購買紀錄會保留來源伺服器。新商品不能附 Discord 身分組；商品上架與調整僅限小吉擁有者。' },
        { name: '銀行與定存', purpose: '查看跨伺服器帳號的錢包、活存、定存與利率，並進行存提款及到期處理。', howTo: '使用 /bank balance、/bank deposit、/bank withdraw、/bank interest、/bank rate-list 或各項 fixed 子命令。', limitation: '帳務與利率依帳號全域共用，但操作仍受目前伺服器的吉幣功能狀態限制；一般使用者可查看自己的帳務與目前利率。查看他人或全體帳務與查閱利率調整紀錄，僅限小吉擁有者或 Administrator；設定利率僅限小吉擁有者。' },
        { name: '工作系統', purpose: '查看職業、選擇下一期唯一全域主職、提交產出、查看薪資與提出扣薪申訴。', howTo: '使用 /work list、/work start、/work status、/work submit、/work payroll 或 /work appeal。', limitation: '每個帳號同一時間只有一個全域主職；目前不開放辭職，工作會在選定的天數期滿後自動結算。部分任務流程受伺服器權限與工作條件限制。' },
        { name: '小吉農場與廚房', purpose: '經營跨伺服器共用的個人農場：買種子播種、澆水、收成並出售作物，再用作物下廚做料理。', howTo: '使用 /farm view 打開農場面板（也可從 /board start 選「小吉農場」），/farm plant 播種、/farm shop 查看價格與規則；下廚使用 /kitchen cook、/kitchen recipes、/kitchen eat、/kitchen gift 或 /kitchen sell。', limitation: '作物與料理每人每天（台灣日期）合計最多賣 500 吉幣。作物超過 14 天沒澆水會枯死並休耕 14 天；化肥每格最多 5 包，用滿後下一次收割那格地就荒廢，需花吉幣重新開墾。料理吃掉只加成農場本身；每天最多送出 5 道，收到的料理只能吃、不能賣或再送。' },
        { name: '籌碼兌換', purpose: '查看帳號的吉幣與籌碼餘額，並進行兌換與查閱流水。', howTo: '使用 /exchange balance、/exchange buy-chips、/exchange cashout 或 /exchange history。', limitation: '帳號資料在可使用小吉的伺服器間共用；交易仍需符合帳務與場館條件。' },
      ],
    },
    {
      name: '賭場、場館與奢侈品',
      features: [
        { name: '賭場遊戲', purpose: '遊玩骰子、角子機、21 點、輪盤、百家樂與撲克，並查閱個人紀錄。', howTo: '使用 /board start 開始遊戲；借款、還款與紀錄仍使用 /casino。', limitation: '一般使用者可借款、還款並查看自己的賭場借款；查看他人債務、降息或徵收僅限小吉擁有者，且賭場貸款與一般吉幣帳務分開。' },
        { name: '賭場大廳與住宿', purpose: '查看場館導覽、下注區，使用籌碼住宿與查看紀錄。', howTo: '使用 /casino-lobby guide、/casino-lobby betting-area、/casino-lobby stay 或 /casino-lobby stays。', limitation: '一般使用者可用；須符合場館與籌碼條件。' },
        { name: '餐廳與吧檯', purpose: '查看菜單、下單、製作、送餐與查閱個人紀錄。', howTo: '使用 /casino-venue menu、add-menu、order、recipe、make、serve 或 history。', limitation: '刪除菜單、重新指派與取消訂單項目僅限小吉擁有者或 Administrator；只有被指派的製作者可查詢做法與提交製作，只有被指派的服務生可送達訂單。' },
        { name: '決鬥塔', purpose: '查看技能道具、個人進度、進入挑戰與查閱紀錄。', howTo: '使用 /board start 進入挑戰；武器、進度與紀錄仍使用 /duel-tower。', limitation: '一般使用者可用；須符合道具與賭注條件。' },
        { name: '奢侈品與典當', purpose: '瀏覽、購買、查看庫存、典當與贖回奢侈品。', howTo: '使用 /luxury 的 list、buy、inventory、history，或 /pawn 的 quote、sell、active、redeem、history。', limitation: '一般使用者可用；公開購買流程以外的商品調整受權限限制。' },
      ],
    },
    {
      name: 'Discord 遊戲（舊網頁 token 局僅過渡保留）',
      features: [
        { name: '統一遊戲目錄', purpose: `集中提供目前 ${unifiedGameCount} 款遊戲：${unifiedGameNames}。`, howTo: '使用 /board start 開局，或使用 /board status 查看目錄與自己可見的現存遊戲。', limitation: '只會顯示目前頻道的公開遊戲，以及查詢者自己的個人遊戲。' },
        { name: '俄羅斯方塊', purpose: '在 Discord 面板操作個人俄羅斯方塊；行動與獎勵由伺服器驗證。', howTo: '使用 /board start 選擇俄羅斯方塊與難度。', limitation: '個人遊戲只由建立者在原伺服器文字頻道操作；面板遺失時使用 /board status。新局不使用網頁入口。' },
        { name: '數字配對', purpose: '在 Discord 面板操作個人數字配對；行動與獎勵由伺服器驗證。', howTo: '使用 /board start 選擇數字配對與難度。', limitation: '個人遊戲只由建立者在原伺服器文字頻道操作；面板遺失時使用 /board status。新局不使用網頁入口。' },
        { name: '數獨', purpose: '在 Discord 面板操作個人數獨；行動與獎勵由伺服器驗證。', howTo: '使用 /board start 選擇數獨與難度。', limitation: '個人遊戲只由建立者在原伺服器文字頻道操作；面板遺失時使用 /board status。新局不使用網頁入口。' },
      ],
    },
    {
      name: '棋盤與推理遊戲',
      features: [
        { name: '開局與共通限制', purpose: '在同一文字頻道建立、加入與進行一局棋盤或推理遊戲。', howTo: '建立者使用 /board start 選擇遊戲，其他人使用 /board join；建立者按遊戲訊息的開始按鈕後進行。使用 /board status 查看進度。', limitation: '每個頻道同時只能有一局。等候超過 10 分鐘，或進行中超過 24 小時沒有有效走棋或判題進展時，遊戲會結束；查看或重新整理不延長時間。沒有電腦對手、投注或新的吉幣獎勵。' },
        { name: '五子棋', purpose: '兩位玩家在 15×15 棋盤輪流落子，連成至少五子獲勝。', howTo: '建立者使用 /board start 選擇五子棋；輪到自己時按落子按鈕並在座標視窗輸入位置。', limitation: '自由連線規則下超過五子同樣算勝。開始後使用 /board leave 視為認輸或退賽。' },
        { name: '西洋棋', purpose: '兩位玩家依標準西洋棋規則對弈。', howTo: '建立者使用 /board start 選擇西洋棋；以走棋按鈕的座標視窗選擇起點、終點，必要時選擇升變。', limitation: '支援王車易位、吃過路兵與兵升變。三次同局面或 50 步可主張和棋；五次同局面或 75 步自動和棋；將死優先。開始後使用 /board leave 視為認輸或退賽。' },
        { name: '圍棋', purpose: '兩位玩家在 9×9 棋盤輪流落子，採中國面積計分，白方貼目 7.5。', howTo: '建立者使用 /board start 選擇圍棋；按落子按鈕輸入座標。雙方都停一手後，依提示標記並確認死子。', limitation: '不能自殺落子或造成重複局面。雙方共同確認完整死子群才計分；有歧見時可恢復對弈。開始後使用 /board leave 視為認輸或退賽。' },
        { name: '六角星跳棋', purpose: '支援 2、3、4 或 6 人；每位玩家有 10 顆棋子，最先全部移入目標營地者獲勝。', howTo: '建立者使用 /board start 選擇六角星跳棋；按移動／連跳按鈕，依序輸入棋盤圖上標示的點位名稱（例如 E5 F5，連跳要寫出每個落點）。面板會列出每位玩家的棋色與出發、目標位置。', limitation: '連跳不可只填起點與終點；多人局請等待自己的回合。開始後使用 /board leave 視為認輸或退賽。' },
        { name: '象棋', purpose: '兩位玩家在 9×10 棋盤依象棋走法對弈。', howTo: '建立者使用 /board start 選擇象棋；以走棋按鈕的座標視窗選擇起點與終點。', limitation: '將帥不得照面；馬受蹩馬腿限制、象不能過河，砲吃子時須隔一子。相同局面第三次出現即和棋；不提供競賽規則的長將、長捉裁判。開始後使用 /board leave 視為認輸或退賽。' },
        { name: '海龜湯', purpose: '1–20 人的多人問答推理遊戲，由小吉擔任主持與裁判。', howTo: '建立者使用 /board start 選擇海龜湯；參與者只可按遊戲訊息的提問或猜答案按鈕，並在開啟的輸入視窗輸入內容。', limitation: '不可直接在聊天訊息中提問或作答。無意義的提問、10 分鐘內第 3 次問相同的問題，或同一人 60 秒超過 6 次、10 分鐘超過 40 次的提問不會判題，只回給本人看的說明，棋局保留。只有本局結束後，曾參與該局的玩家才能查看答案；開始後只有建立者可使用 /board stop 結束海龜湯。' },
        { name: '狼人殺', purpose: '6–12 人的陣營推理遊戲，由小吉擔任法官主持；依人數自動分配狼人、預言家、女巫、獵人、守衛與平民。', howTo: '建立者使用 /board start 選擇狼人殺，並可在等候室按鈕調整節奏、勝利條件（屠邊或屠城）、出局是否公開身分與角色數量。開始後在面板下方的討論串討論；按「查看身分」看自己的角色，夜晚技能、投票與獵人開槍都按「行動」。', limitation: '身分、夜晚結果與查驗結果只用只有本人看得到的回覆告知。存活玩家連續兩次該行動或投票時沒有回應，會被判定離席出局；使用 /board leave 立即出局。房主可使用 /board stop 結束（記為平手）。沒有吉幣獎勵。' },
      ],
    },
    {
      name: '網站與公開資訊',
      features: [
        { name: '小吉官網', purpose: '提供公開產品介紹、功能分類與公開說明。', howTo: '直接瀏覽小吉官網，或在 Discord 使用 /about、/help。', limitation: '公開網站不顯示 Discord 個人或伺服器識別資料。' },
        { name: '即時狀態網站', purpose: '顯示公開、去識別化的整體狀態；資料不足時會如實顯示未知。', howTo: '使用 /status、/ping 或開啟狀態網站。', limitation: '/ping 只確認小吉有回應，不能代表其他功能均正常；網站公開讀取。' },
        { name: '公開版本資訊', purpose: '閱讀小吉的公開版本資訊與 Release。', howTo: '使用官網的「公開版本資訊」連結，前往 GitHub 上 xiaoji-formal 的 Release 頁閱讀。', limitation: '公開閱讀；不包含其他控制功能。' },
      ],
    },
    {
      name: '新人歡迎',
      features: [
        { name: '新人歡迎訊息', purpose: '新成員加入時，在可發送的歡迎候選頻道送出招呼。', howTo: '在伺服器使用 /set-welcome 設定歡迎頻道。', limitation: '頻道設定須有伺服器適當權限，小吉也需要檢視與發送訊息權限。' },
      ],
    },
  ].map((system) => Object.freeze({
    ...system,
    features: Object.freeze(system.features.map((feature) => Object.freeze(feature))),
  })));

  return { PUBLIC_SYSTEM_CATALOG };
});
