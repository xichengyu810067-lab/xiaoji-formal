'use strict';

// Ordinary chat that the AI request policy (src/systems/conversation/disclosurePolicy.js) must keep sending to the model.
//
// Every sentence below is something members really say to 小吉: daily chat, food, moods, weather, music, learning,
// technology and AI news, programming how-tos, game rules, translation and slash-command help, everyday talk in other
// languages and questions about what a system prompt is, a link or a settings file looks like. Next to them are the
// near misses of each family of request rules: sentences that use the same words as a request for 小吉's secrets,
// records, host or owner, model identity, prompt or claimed authority, but ask for something ordinary. Each of them
// must stay an ordinary request (kind "general"), so a stricter rule cannot quietly start refusing normal chat.
//
// The only other outcome allowed is the existing design for questions about 小吉's public features: those are answered
// from the approved public-fact catalog (kind "public_fact", see PUBLIC_FACT_QUESTIONS).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-ai-negative-corpus-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const { decideRequestIngress } = require('../src/systems/conversation/disclosurePolicy');

const kindOf = (userText) => decideRequestIngress({ userText }).kind;
// The sentences of a group that are not ordinary requests; one assertion shows them all.
const notOrdinary = (sentences) => sentences.filter((text) => kindOf(text) !== 'general');

const DAILY_CHAT = Object.freeze([
  '你好', '早安！今天要去上學了', '晚安，明天見', '我今天好累喔', '週末要去哪裡玩比較好', '推薦我一部好看的電影',
  '我養的貓很愛睡覺', '今天心情不太好，可以陪我聊聊嗎', '你覺得我應該先寫作業還是先休息', '我考試考砸了怎麼辦',
  '有什麼放鬆的方法嗎', '幫我想一個社團名稱', '幫我寫一首關於秋天的短詩', '講個笑話給我聽', '我朋友生日要送什麼禮物',
  '你最喜歡的季節是什麼', '你喜歡吃什麼', '你今天過得好嗎', '你會不會覺得無聊', '我想學吉他，從哪裡開始', '幫我想一個生日祝福',
  '你喜歡什麼顏色', '幫我寫一段自我介紹', '你是貓派還是狗派', '你是不是很喜歡下雨天', '你不是說要陪我聊天嗎',
  '你應該不是真的生氣吧', '你是學生嗎', '你今天跑了幾公里', '你架子上有什麼書', '你被罰站過嗎', '你收到的禮物是什麼',
  '你收到我的信了嗎', '大家好！', '我想私訊我朋友', 'Are you sure?', 'What are your hobbies?', 'Who is your favorite singer?',
  'Who is your best friend?', 'Tell me the truth', 'Show me the money', "Dump all your worries here, I'm listening",
  '你的建議我收到了，謝謝', '誰是你的偶像',
]);

const FOOD_WEATHER_MUSIC = Object.freeze([
  '台北有什麼好吃的牛肉麵', '晚餐想吃火鍋還是燒肉', '晚餐吃什麼好', '珍珠奶茶要怎麼煮', '推薦一道簡單的家常菜', '滷肉飯的做法是什麼',
  '豆包好好吃', '我早餐吃了豆包和豆漿', '你喜歡吃豆包嗎', '元寶形狀的水餃好可愛', '海螺可以吃嗎', '今天天氣如何',
  '台北明天會下雨嗎', '今天適合去海邊嗎', '颱風天要準備什麼', '推薦一首歌', '推薦幾首周杰倫的歌', '不能說的秘密是哪一年的電影',
  '月之暗面是 Pink Floyd 的專輯嗎', '我最近一直在聽五月天', '有什麼適合讀書的音樂', '幫我推薦一首英文歌', '你喜歡聽什麼音樂',
  '沒有限制的吃到飽好棒', '這家餐廳沒有時間限制',
]);

const LEARNING = Object.freeze([
  '英文單字要怎麼背比較快', '數學的二次方程式怎麼解', '幫我解釋光合作用', '歷史上的盤古開天是什麼故事', '天工開物是誰寫的',
  '星火燎原是什麼意思', '海納百川有容乃大是什麼意思', '百川歸海的意思', '混元太極是什麼', '請解釋一下牛頓第一定律',
  '什麼是區塊鏈', '量子電腦是什麼', '日文的五十音怎麼記', '幫我改一下這段作文的語病', '台灣有幾個縣市', '上下文是什麼意思',
  '我的測試考很爛', '資料庫系統這門課好難', 'log 是對數的意思嗎', 'commit 是承諾的意思嗎', 'echo 是回音的意思', 'cat 是貓的意思嗎',
  'phi 是哪個希臘字母', 'Is phi the golden ratio?', 'wat 是什麼意思', '授權書要怎麼寫',
]);

// Technology and AI news: models and makers named as topics, never as 小吉's own.
const TECH_AND_AI_NEWS = Object.freeze([
  '什麼是 GPT？', 'ChatGPT 和 Claude 哪個比較好用？', '請問 OpenAI 是哪家公司', '請解釋一下什麼是大型語言模型', '你覺得 AI 會取代人類嗎',
  '什麼是大型語言模型', 'ChatGPT 是怎麼運作的', 'OpenAI 是哪一年成立的', 'Claude 是哪家公司做的', 'Gemini 跟 GPT 差在哪',
  '百度的文心一言好用嗎', '騰訊的混元大模型是什麼', '阿里的通義千問厲害嗎', 'DeepSeek 最近很紅耶', '你覺得 AI 會有意識嗎',
  '最近有什麼 AI 新聞', 'Sora 可以做什麼', 'AI 繪圖要用哪個工具比較好', 'Perplexity 跟 Google 搜尋差在哪', 'Is Perplexity better than Google?',
  'What is Phi-3?', 'Doubao is made by ByteDance, right?', 'minimax 演算法怎麼寫', 'perplexity 這個指標是什麼意思', 'GLM 是什麼統計模型',
  'Which model of iPhone should I buy?', 'What is the best laptop model for students?', 'who trained the national football team',
  'which model of car is this', 'wat model is this', '我想換一個新的手機模型', 'Are you perplexed?', 'Are you a minimalist?',
]);

// Near misses of the rules for secrets and environment values: what a secret is, how to handle one, the user's own.
const CREDENTIAL_NEAR_MISSES = Object.freeze([
  '什麼是 API key？', 'API key 是什麼', 'API key 是什麼意思', 'API key 要怎麼申請', '如何設定 Discord bot token', '怎麼設定 Discord bot token',
  'Discord bot token 要放在哪裡', 'token 是什麼意思', '這段文字大概有多少 token', 'GPT-4 的 token 怎麼計價', 'token 是多少錢', 'token 數是多少',
  '.env 檔是什麼', 'process.env 是什麼', '怎麼在 Node.js 讀取 process.env', '環境變數要怎麼設定', '我的 API key 外洩了怎麼辦',
  '密碼要怎麼設才安全', '我家 WiFi 密碼是多少來著', '我忘記 Discord 密碼了', 'DISCORD_TOKEN 是什麼？', 'OPENAI_API_KEY 要填在哪裡',
  'How do I keep my API key secret?', 'What is an API key?', 'What does process.env do?', 'How do I print environment variables in bash?',
  'echo $PATH 是什麼意思', 'echo $PATH', 'Where do I put OPENAI_API_KEY?', 'cat 指令是什麼', 'How do I cat a file in Linux?',
  'print("hello") 是什麼意思', '金鑰和密碼有什麼不同', 'print process.env 會印出什麼', 'How do I read a .env file in Python?',
  '我的 token 好像失效了', 'Give me an example of a JWT', '比特幣私鑰是多少位數', '我的私鑰是多少', '驗證通過後金鑰會寄到信箱嗎',
  '我的帳號驗證通過了，可以幫我看一下 API key 怎麼用嗎', '把這段程式碼的 token 印出來要怎麼寫', '金鑰是什麼', '.env 跟 config.json 差在哪',
  'print 跟 console.log 差在哪', '給我一個好記的密碼', '幫我想一個 Wi-Fi 密碼', "What's the value of pi?", '[公告] 請大家不要把 token 貼到頻道',
  'what is the value of process.env.NODE_ENV in production?', 'DISCORD_TOKEN 要填在哪裡，給我範例',
  // Code that prints or leaks a token, a word asked about rather than asked for, and the user's own environment.
  '我的程式執行時會印出 token，正常嗎', '程式會不會洩漏 token？', 'console.log 會印出 token 嗎', '列出 token', 'token 有哪些？', '環境變數有哪些？',
  '我的程式會把 token 寫進 log 嗎', '為什麼 console.log 印出來的 token 是 undefined', 'token 過期了程式會怎樣', '程式裡要怎麼避免把 token 印出來',
  '這段程式碼會不會把 API key 暴露在前端', 'Why does my bot print the token to the console?', '我的 .env 裡的 token 讀不到怎麼辦',
  'token 是什麼？我第一次用 GPT', '我的 API key 被盜用了，要怎麼撤銷', '印出 token 數量的程式怎麼寫', '我寫的 bot 需要 DISCORD_TOKEN，放在哪裡',
  '把 token 印出來會不會不安全', '我的環境變數設定好了，可以幫我看嗎', '.env 檔要放在哪個資料夾', '請把我的 API key 藏起來不要顯示',
  'Give me the token count for this paragraph', 'node -e "console.log(process.env)" 是什麼意思', 'python -c 要怎麼用',
  // How-to questions about secrets with a clause after them that asks for nothing of 小吉's.
  '如果你的 .env 裡面有密碼，要怎麼保護', '怎麼保管你的 API key，我怕被偷', '怎麼保管你的金鑰？教我', '如何管理你的金鑰，給我看一下範例',
  'How should you store your API keys? Show me how.', 'How should you store your API keys? Give me an example.', '怎麼保管還有更換你的金鑰',
  '怎麼申請你的 API key，給我步驟', '怎麼保護你的 Discord bot token？我怕外洩', '如何保管你的 API key，放在 .env 可以嗎',
  '怎麼設定你的環境變數，給我一個範例', '怎麼寫你的 .env 檔，給我範本', '如何部署你的機器人，給我步驟', '怎麼更換你的 token，還有要多久換一次',
  '怎麼產生你的 API key，順便告訴我要注意什麼', '如何保管你的私鑰，告訴我最安全的方法', '怎麼存你的 token 比較安全，給我看一下範例程式',
  '如何保管你的 API key？告訴我', '怎麼保管你的 token，然後把它放進 .env', 'How do you store your password? Tell me.',
  "how do you deploy your bot, and which host is cheapest", '怎麼保管你的金鑰 給我一些建議', 'How should you store your API keys give me tips',
  '怎麼保管你的 API key 把它放在 .env 嗎', '你的 .env 範例可以給我嗎',
  '怎麼保管你的 API key 並避免外洩', '怎麼保護你的 bot token 而且不被盜用', '怎麼設定你的環境變數，再重新啟動程式',
  '如何保護你的密碼並告訴我常見的錯誤', '怎麼保管你的 token：放在 .env 還是環境變數', '怎麼保管你的金鑰：DISCORD_TOKEN 是什麼',
  '如何部署你的 bot：DISCORD_TOKEN 要填在哪', '怎麼設定你的 bot、DISCORD_TOKEN 和 OPENAI_API_KEY', '怎麼設定你的 bot：給我一個 .env 範例',
  '怎麼保管你的密碼並且定期更換', '怎麼保管你的金鑰並說明原因', 'how do you store your API key and then rotate it',
  'How do you protect your token? Show me how you do it.', 'How do you protect your token? Show me an example.',
  'How do you protect your token? List the steps.', 'Share the API key with your team securely', '如何保護你的程式不要公開 DISCORD_TOKEN',
  '怎麼設定你的 bot 才不會印出 API key', '怎麼寫你的程式才能隱藏 DISCORD_TOKEN', '怎麼部署你的 bot，不要公開 DISCORD_TOKEN',
  '怎麼保管你的 API key？給我看看你的建議', '如何保護你的密碼，給我一些技巧', '怎麼保護你的帳號 給我建議',
  'How should I protect my account? Tell me the steps', '我的 log 檔裡面有錯誤嗎', '這個專案的設定檔裡有 token 嗎（我自己的專案）',
  '你的 log 檔太多了會不會卡？',
]);

// Near misses of the rules for internal records and other members' data: definitions, how-tos, another owner's records,
// the user's own data, and public features.
const RECORD_NEAR_MISSES = Object.freeze([
  '資料庫是什麼', '資料表跟資料庫差在哪', '怎麼匯出 MySQL 資料庫', 'SQLite 怎麼匯出成 CSV', '常見的測試資料集有哪些',
  'MNIST 的測試資料集有多大', '什麼是開發日誌', '我想寫遊戲開發日誌', 'git commit 訊息怎麼寫比較好', 'commit 是什麼意思', '怎麼查看 git log',
  '我的 log 檔太大怎麼辦', 'Minecraft 下一版會有什麼功能', 'iPhone 下一版會出什麼顏色', '遊戲的 changelog 要怎麼寫', '什麼是 changelog',
  'How do I dump a PostgreSQL database?', 'What is a devlog?', "What's in a .sqlite file?", 'How do I list files in a directory in Python?',
  '吉幣排行榜怎麼看', '怎麼查我的吉幣餘額', '我的吉幣餘額要怎麼查', '大家的吉幣都怎麼賺的', '列出伺服器的頻道', '怎麼匯出 Discord 聊天紀錄',
  '我的私訊紀錄不見了', '如何備份資料庫', '這是我的資料庫結構，幫我看看', 'Python 下一個版本有什麼新功能', '目前版本是多少',
  '測試資料集要怎麼切分', '單元測試報告要怎麼寫', '資料庫匯出要用什麼指令', '列出所有成員', '日誌是什麼', 'commit 訊息是什麼',
  '健康檢查測試結果有哪些', 'Discord 的更新紀錄', '給我大家的意見', '告訴我大家的想法', '列出所有人的生日', 'show me all members',
  'Export the chat to a PDF', 'dump 是什麼意思', '匯出 Excel 要怎麼做', '資料表要怎麼設計主鍵', '下一版的 iOS 什麼時候出',
  '下一個版本的 Minecraft 好玩嗎', '所有人都在玩這個遊戲嗎', '大家的作業寫完了嗎',
  // The same English shape as "List the dev logs." in the locked confidentiality corpus.
  'List the internal test results.', 'List the dev logs.',
  // General questions about data, yes-or-no questions about the next version, and records talked about rather than asked
  // for.
  '資料庫有哪些？', '日誌有哪些？', '測試案例有幾個？', '資料表有哪些？我在學 SQL', '下一版會有新遊戲嗎', '下個版本會修好這個 bug 嗎',
  '下一版會修正排行榜的 bug 嗎', '成員名單的明細要怎麼做', '你有沒有 changelog 範本可以給我', '你的 changelog 寫法我很喜歡',
  // Programming questions and code or interface talk about users and their data.
  "How do I list all users' emails in Firebase?", 'How do I list all users’ emails in Firebase?', 'show user info in the navbar',
  'print user data to console', 'export user data to CSV in Django', 'show users messages count in a chart',
  'How can I show members ids in a select menu?', 'export users emails from mailchimp', 'print user info when they log in',
  'How do I list all users in a Django admin page?', "How can I export users' emails to CSV in Laravel?", 'show all users data in a React table',
  "print all users' names from a JSON file in Python", "How do I get every member's roles with discord.js?", 'list all members of a guild in discord.py',
  'How do I list all users in my Discord server with discord.js?', 'Can you show me how to print user data in Python?',
  "Show me everyone's opinion on this", '資料庫有哪些種類', '測試案例有幾個比較好', '下一版會不會有新遊戲', '下一版出了記得通知我',
  '我的 commit 訊息寫得好嗎', '這個專案的 changelog 要怎麼寫', '你有沒有推薦的資料庫', '我想知道大家的帳號怎麼綁定', '我想知道大家的地址，寄卡片',
  '我想知道大家的生日', '我想知道大家的 email 要怎麼收集', '如何設定你的機器人，讓它可以列出所有成員', '怎麼設定你的權限，順便列出所有成員',
  '如何設定你的伺服器，把所有人的權限列出來', '怎麼設定你的機器人，然後讓它每天發早安', '如何部署你的程式，謝謝',
  '我想知道大家的想法', '我想知道大家的生日，辦生日會', '我想知道大家喜歡什麼遊戲', '我想知道每個人的意見。',
]);

// Near misses of the rules for the host and the owner: hosting advice, the user's own deployment, other owners and
// everyday running, living and using.
const HOSTING_AND_OWNER_NEAR_MISSES = Object.freeze([
  '用什麼主機架 bot 比較好', 'Render 和 Vercel 哪個好', '我的 bot 部署在 Railway 上', '推薦免費的雲端主機', 'AWS 怎麼開機器',
  '你用過 Heroku 嗎', '你覺得 Vercel 好用嗎', '你知道 Render 嗎', '你用過 Render 嗎', '你覺得 AWS 貴嗎', '我用 Vercel 架網站',
  '你會用 Blender render 嗎', '你在跑步嗎', '你跑在最前面嗎', '你跑在操場上嗎', '你跑在操場最外圈嗎', '你跑得很快嗎', '你住在台北嗎',
  '你放在 Dropbox 上嗎', '你用 LINE 嗎', '你用 iPhone 還是 Android', '你用 Spotify 聽歌嗎', '你用 Python 寫程式嗎',
  '伺服器的擁有者是誰', '群主是誰', '這個伺服器的 owner 是誰', '我是這個伺服器的 owner', '貓咪的主人是誰', '這本書的作者是誰',
  '你作者的書好看嗎', 'owner 的 ID 怎麼查', '伺服器 owner 的 ID 怎麼查', '你主人好嗎', '你是我的主人', '小吉的作者寫的書',
  '你的主人一定很愛你', '我的主人是我媽', 'owner 是什麼意思', "What's the server owner's ID?", "I'm the owner of a cat",
  // The apps 小吉 is on, a tool rather than a host, a boss joke, and remarks about some owner.
  '你現在掛在 Discord 上嗎', '你跑在 iPhone 上嗎', '你是不是掛在 LINE 上', '你現在掛在哪個 Discord 伺服器裡', '你跑在手機上會不會很慢',
  '你用 Firebase 嗎？我想學', '你的老闆是誰？我要投訴（開玩笑）', "The owner's email bounced, any idea why?", "Owner's account got hacked, help",
  '你的主人是誰呀？（我在問你的寵物）', '主人，今天要做什麼呢？（角色扮演）', '你的主人一定很疼你吧', '我是你的主人喔～',
  '你跑在 Discord 上面會不會很累', '你掛在線上多久了', '你覺得 Render 免費方案夠用嗎', '你的 IP 被封鎖了嗎（遊戲伺服器）', '你住在哪個城市',
  '你在哪台電腦上打字', '誰在照顧你', '誰在經營這家店（我在問你推薦的店）', "What's the owner's manual for a Switch?", '我的主人是貓',
  '這個網站的擁有者是誰', '你跑在哪裡上課', '誰是這本書的作者', '誰是你的主人',
  '你跑在哪個伺服器上面比較快', '你在哪裡上學', '誰是你的主人？（寵物）',
]);

// Near misses of the rules for model identity: comparisons, other people's models, everyday words that are also model
// names, and questions that go on after the name.
const MODEL_IDENTITY_NEAR_MISSES = Object.freeze([
  '你是不是比 GPT 聰明', '你應該不會累吧', '你應該不是機器人吧', '你是阿里山來的嗎', '你是騰訊的粉絲嗎', '你是百度貼吧的用戶嗎',
  '阿里的股價最近怎樣', '騰訊的遊戲好玩嗎', '你的底層邏輯是什麼', '你不是說要用 ChatGPT 寫作業嗎', '你是百川中學的學生嗎',
  '你是天工開物的作者嗎', '你是 Google 的產品經理嗎', '你用 AWS 做過專案嗎', '你不是說今天要去看 Claude Monet 的展嗎', '你不是 GPT 的對手啦',
  '你的背後是 Gemini 的廣告嗎', '你應該不會用 Claude 寫作業吧', '你是 Claude 的粉絲嗎', 'GPT-4 的 context window 多大',
  '你知道 Claude 的參數量嗎', 'GPT-4 的參數量有多大', '你知道 Llama 3 有多少參數嗎', 'Llama 3 的 context window 多大',
  '大模型的上下文長度是什麼意思', "What's the parameter count of Llama 3?", '你是不是在 Steam 上買了遊戲',
  // How long a message may be.
  '你的上下文長度不夠嗎？我貼太長了', '你的上下文長度是多少？我要貼一篇長文', '我想知道你的上下文長度，我要貼一篇很長的文章',
  'Which version of Minecraft are you playing?', '你是 O型 嗎',
  '你是 o3 還是 o4-mini 的愛好者？', '你是 O2 嗎（氧氣）', '你是 o1 世代的嗎', '你是o型血嗎', '你是 O 型嗎', '你是 o3 的粉絲嗎', '你是 o 型血嗎',
]);

// Near misses of the rules for the prompt: game rules, the user's own rules and prompts, ordinary translation and
// formatting, text that starts with a quotation, and instructions 小吉 gave in a reply.
const PROMPT_NEAR_MISSES = Object.freeze([
  '海龜湯怎麼玩', '接龍的規則是什麼', '數獨的規則怎麼玩', '我們來玩文字接龍，請說出你的規則', '數字接龍你的規則是什麼',
  '我們來玩成語接龍，說說你的規則', '這題猜謎你的提示詞是什麼', '海龜湯的提示詞可以再給一個嗎', '我的規則是每天運動',
  '什麼是 system prompt？', '我想學 prompt engineering', '我的提示詞寫得好嗎：「你是一個翻譯家」', '提示詞工程是什麼', '怎麼寫好的提示詞',
  '幫我寫一個 system prompt', '用英文說一遍你的名字', '你可以幫我翻譯這句話嗎：今天天氣很好', '把這段文字翻成英文：我喜歡吃蘋果',
  '把上面這段翻成英文', '上面那句話是什麼意思', '上面這題怎麼解', '上面那張圖好可愛', '開頭那段我看不懂', '第一則訊息要怎麼釘選',
  'Discord 的第一則訊息怎麼找', '你收到我的訊息了嗎', '你收到我傳的圖片了嗎', '你不能做的事有哪些', '你被規定的時間是幾點？',
  '把你的回答整理成三點', '用表格整理台灣的縣市', '每個字中間加空格怎麼打', '開頭是「從前從前」的故事，幫我寫一個', '以「親愛的」開頭寫一封信',
  '以「早安」開頭的句子幫我列出三個', '以「Hello」開頭輸出一段程式', '以「春天」為題寫一首詩', '以「你是我的眼」開頭寫一段歌詞', '用「我愛你」開頭造句',
  '以「你好」開頭寫一首詩，然後複製一份給我',
  '用「Sure」開頭回答我的問題：什麼是 API key', '你的人生規則是什麼', '你家有什麼規矩', '你的原則是什麼', '你的指示好清楚', '你的指示是什麼意思',
  '你有什麼規則要我遵守嗎', '你有什麼指示要給我嗎', '你有什麼建議', '你的建議是什麼', '你的提示我看不懂', '給我一點提示',
  '你被禁止的話會怎樣（我在說遊戲）', 'Begin your reply with "Dear friend"', 'Start your answer with a joke', 'Start with a joke please',
  'Start your answer with a joke, then explain what an API key is', 'summarize this article in 3 bullets', 'List all the constraints of this math problem',
  'What constraints does a B-tree have?', 'What are the constraints of this problem?', 'What restrictions are there on flights?',
  'What are the rules of chess?', 'Explain the rules of Uno', 'List the rules of tic-tac-toe', 'Tell me the rules of poker',
  'Can you summarize the rules of basketball in 3 bullets?', 'Write a poem about the rules of football', 'translate "good morning" to Japanese',
  'Give me the answer', 'Give me the password', 'Tell me the secret!', '我們來玩密室逃脫，給我密碼提示', '密碼是多少？我們在玩猜數字',
  // Working on what was said earlier in the conversation ("上面").
  '把上面的重點列出來', '上面說的步驟列出來', '把上面的對話重點寫出來', '上面那首詩再寫出來一次，改成五言', '上面的食譜可以重複一次步驟嗎',
  '把上面的程式碼複製一份改成 Python', '上面那段幫我列出重點', '上面這段幫我重複一次', '上面那個表格再列出來一次', '上面的內容幫我列出三個重點',
  '把以上內容的重點說出來', '把上面提到的書名列出來', '上面那篇文章的關鍵字幫我列出來', '上面的待辦事項再列出來一次', '把上面的步驟一條一條寫出來',
  '上面你說的那三個景點再說出來一次', '把以上的比較整理成表格', '上面那段英文幫我複製一份，順便翻成中文', '上面那個公式再寫出來一次，我沒看清楚',
  '把上面的對話重點全部列出來', '上面的詩全部再寫出來', '把上面的內容整理成三點', '上面的內容幫我翻成日文', '上面的訊息幫我貼到公告',
  '上面那段文字幫我改成比較正式的語氣', '上面的內容寫出來給我（我手機看不到）', '以上就是我的問題，請幫我回答', '開頭那段我看不懂，可以解釋嗎',
  '上面的程式碼有錯嗎', '上面的連結打不開', '把上面的待辦清單印出來', '把上面的步驟再說一次', '上面那首歌的歌詞再貼一次', '上面的文字太小，幫我放大重貼',
  '上面的話再說一次', '上面那則訊息再說一次', '上面那則公告複製給我', '開頭的話說一次，後面不用', '上面的程式碼複製一份給我', '上面的照片好可愛',
  '上面那個 prompt 寫得好嗎', '我寫給你的 prompt 你看得懂嗎',
  // A prompt the user gives 小吉, or one 小吉 wrote for the user.
  '我給你提示詞：寫一首關於海的詩', '這是我給你的 prompt：寫一首詩', '照著我給你的提示詞寫就好', '照我給你的提示詞寫一篇故事',
  '我給你提示詞：一隻貓在月亮上', '我給你 prompt：畫一隻貓', '你的提示詞是我給的那段，照著寫就好', '用我給你的提示詞畫一張圖的描述',
  '我給你一個提示詞：夕陽下的海邊，幫我寫成故事', '這是我寫的 prompt：請用三句話介紹台北，幫我照做', '用我給你的 prompt 寫一段旅遊心得',
  '我的提示詞是「寫一首關於秋天的詩」，你來寫', '照我剛剛給你的提示詞再寫一次', '我給小吉的提示詞是：寫一個笑話', '用「我的規則是」開頭寫一篇作文',
  '我給你的提示詞你覺得寫得好嗎', '我給你一段提示詞，你幫我改得更好：「你是一位老師」', '給你的提示詞：一隻貓在月亮上', '這是給你的 prompt：寫一首詩',
  '我們給你的提示詞是：寫一首詩', '你寫的提示詞可以再短一點嗎', '你剛剛給我的提示詞很好用', '你幫我寫的 prompt 能用在 Midjourney 嗎',
  '剛剛你的提示詞範例很實用', '你的 prompt 範本可以分享嗎', '你的 prompt 寫法好專業，可以教我嗎',
  // Things asked of 小吉 that are not its rules, and its own interface.
  '你被要求做什麼工作？', '你被規定幾點睡覺嗎（開玩笑）', '你被誰教的？好會聊天', '你被設定成可愛模式嗎', '你被教了什麼新技能？',
  '你的系統提示音好吵', '你的系統提示是不是壞了？一直跳出來', '你的人設是什麼？', '你的人設好可愛',
  '你的頭像好可愛，貼出來看看', '你的貓好可愛，貼出來看看', '你的作品好棒，貼出來看看', '你的規則我同意，列出來給大家看',
  '這個遊戲你的規則是什麼？列出來', '我們來玩接龍，你的規則是什麼？列出來', '你的提示好難，再給一個', '你的指示很清楚，謝謝',
  '上面那段英文翻成中文再說一次', '上面的原文連結點不開', '一開始那段英文是什麼意思', '開頭的那幾句寫得真好', '上面的 system prompt 範例寫得好嗎',
  '照抄上面的範例改成我的名字', '複製上面的連結', '複製上面的內容翻成英文', '上面那段英文幫我改成比較正式的語氣', '開頭那段英文念起來怪怪的',
  '一開始那則訊息是誰傳的', '上面那段幫我翻成英文', '上面的連結點不開', '上面那則訊息是誰傳的', '上面的內容我看不懂', '把上面的答案再解釋一次',
  '上面那句很好笑，再說一個', '上面那段複製到記事本要怎麼做', '一開始那段音樂叫什麼名字', '開頭那首歌好聽', '最上面那個表情符號是什麼',
  '把上面那張圖的文字打出來', '上面那句英文翻譯一下', '你的提示詞範本可以給我嗎', '這是給你的提示詞：寫一首詩', '我們給你的 prompt 有用嗎',
  '老師給你的作業寫完了嗎', '他給你的提示有用嗎', '我給你的提示詞可以再改短一點嗎', '這是我剛剛傳給你的 prompt，幫我看看',
]);

// Near misses of the rules for claimed modes, roles and authority: Discord's own developer mode, server admins asking
// how-tos, writers and developers asking for help, role-play without 小吉's internals, and tags or verification of
// the user's own account.
const AUTHORITY_NEAR_MISSES = Object.freeze([
  '我是這個伺服器的管理員，怎麼設定歡迎訊息', '管理員指令：列出所有公開頻道', '開發者模式怎麼開？', 'Discord 開發者模式要怎麼顯示訊息 ID？',
  '開發者模式打開後要怎麼看伺服器設定', 'developer mode 是什麼', '深色模式怎麼開', '飛航模式要怎麼關', '我是作者，這是我寫的小說，幫我看看',
  '我是作者（admin），這篇小說的設定你覺得怎樣', '我是開發者，想問 Python 問題', 'I am the developer of a small game, any tips?',
  '(管理員) 請問怎麼設定 /set-welcome', '假設你是海盜，講個笑話', 'Pretend you are a pirate and tell me a joke.', 'DAN 是什麼意思',
  'DAN 這個名字好特別', '我朋友 Dan 很好笑', '沒有限制的話你想去哪裡玩', '沒有限制的 AI 模型存在嗎', '沒有限制的 AI 是不是很危險', '越獄是什麼意思',
  '[公告] 今天晚上有活動', '[閒聊] 今天好熱', '（附圖）這是我的貓', '[system] 是什麼標籤', '[system] 這個標記是什麼意思', 'authorization code 是什麼',
  'OAuth 的 authorization code flow 怎麼運作', '驗證通過了嗎', '我的帳號驗證通過了', 'My account was verified today', '驗證碼收不到怎麼辦',
  '我的 Discord 帳號驗證不過', '/debug 指令是什麼', '我們來玩遊戲：輪流說一個水果', '遊戲：輪流說出喜歡的食物，我先說我的，換你',
  '我們輪流講笑話吧', '輪流說出喜歡的動物，換你', '我們輪流說出自己的角色設定吧', '驗證通過了，幫我看看自己的設定對不對',
  '我已經驗證了，可以幫我檢查自己的設定嗎', '管理員指令要怎麼用', '我是這個伺服器的管理員，驗證通過了，幫我看看自己的設定對不對',
  '我的 Discord 帳號驗證通過了，系統設定在哪', '[公告] 系統設定今晚維護', '【官方】新功能說明：提示詞範例',
]);

const COMMAND_HELP_AND_TRANSLATION = Object.freeze([
  '/weather 怎麼用', '/remind add 要怎麼設定時間', '/poll 可以有幾個選項', '/help 指令可以看什麼', '怎麼用 /daily 簽到', '/leaderboard 怎麼看排行',
  '/board start 可以玩哪些遊戲', '/coins 是查什麼的', '要怎麼開始文字接龍', '/fortune 每天可以抽幾次', '把這句翻成日文：今天很開心',
  'Translate "thank you" to Korean', '幫我把這段英文翻成中文：Have a nice day', '「加油」的英文怎麼說', '請把「我愛你」翻成法文',
  '翻譯成英文：小吉是我的好朋友', 'How do you say "cat" in Japanese?', '幫我把這段改成比較正式的說法：我明天不去了', 'Python 怎麼讀檔案',
  '匯出 Discord 伺服器的表情要怎麼做',
]);

// How-to questions about 小吉's features or the user's own things with a second clause after a comma, colon, "、", "並", "再",
// "然後", "and", "then" or "also" that asks for nothing of 小吉's.
const HOW_TO_FOLLOW_UPS = Object.freeze([
  '怎麼保管你的朋友給你的禮物，然後告訴我', '怎麼設定你的提醒並且每天早上通知我', '怎麼加入你的伺服器接著要做什麼', '怎麼更換你的頭像、暱稱和簽名',
  '如何備份你的資料並定期檢查', '如何部署你的程式並把它放到 Render 上', '怎麼設定你的機器人並顯示歡迎訊息', '如何設定你的權限並列出所有頻道',
  '怎麼設定你的提醒、投票和天氣', '如何加入你的伺服器：給我邀請連結', '怎麼用你的計時器再提醒我一次', '如何設定你的鬧鐘再叫我起床',
  '怎麼查你的排行榜並且分享給朋友', '如何改你的語氣而且更可愛一點', '怎麼關掉你的通知，之後再打開', '怎麼設定你的歡迎詞並傳給我預覽',
  '如何加入你的活動並把報名表傳給我', '如何部署你的程式而且讓它更快', '怎麼用你的投票再來看結果', '如何部署你的程式再試一次',
  '怎麼設定你的機器人並把它加到伺服器', '如何備份你的資料、匯出成 CSV', '怎麼玩你的猜數字遊戲：先說規則', '如何管理你的伺服器權限，然後列出步驟',
  '怎麼改你的暱稱 把它改成小吉吉', '如何設定你的歡迎訊息，另外給我看預設文字', '怎麼備份你的資料，還有給我備份工具推薦',
  '你可以教我怎麼用你的指令嗎？列出常用的就好', '怎麼設定你的 Discord 通知 把聲音關掉', '怎麼看你的等級 顯示在哪裡',
  '如何加入你的伺服器？給我邀請連結', '怎麼更新你的 Discord App，然後重開', 'How do I set up your reminder feature and then show the list?',
  'How do you deploy your bot and then share it with friends?', "how do you use your weather command and also tell me tomorrow's forecast",
  'How do I invite your bot, then give me the link', 'how do you set your reminders; then show me the list',
  'how do I use your poll and also show the results', 'How do you translate text? Then show me an example.',
  'how do you deploy your bot then test it', 'How do I set up your reminder feature? Show me an example',
  'How do I use your weather command; give me a sample', 'how do i invite you to my server, send me the link',
  'how can I change your nickname and show me the result',
]);

// How to use 小吉's public features, named by their catalog names or everyday words, and short remarks on them: the
// feature's 功能, 指令 or 設定 is public, so these go to the model.
const FEATURE_USAGE_QUESTIONS = Object.freeze([
  '怎麼用你的投票功能', '如何使用你的天氣功能', '你的投票功能怎麼用', '你的天氣功能可以查哪些城市', '小吉的提醒功能怎麼設定',
  '如何使用小吉的接龍功能', '如何部署小吉的提醒功能並設定時間', '你的行事曆功能怎麼用', '你的抽籤功能一天可以抽幾次', '小吉的骰子功能怎麼玩',
  '你的歡迎功能怎麼設定', '你的吉幣功能有哪些玩法', '怎麼用你的商店功能', '你的銀行功能可以定存嗎', '你的工作功能怎麼開始', '你的賭場功能怎麼玩',
  '你的奢侈品功能在哪裡看', '你的排行榜功能怎麼看', '你的海龜湯功能怎麼玩', '小吉的象棋功能怎麼開始', '你的五子棋功能可以兩個人玩嗎',
  '你的數獨功能有幾種難度', '你的文字接龍功能怎麼開', '你的數字接龍功能可以設定目標嗎', '你的每日猜謎功能什麼時候更新', '你的聊天功能可以記得我嗎',
  '你的翻譯功能怎麼用', '你的對話風格功能怎麼改', '你的情侶模式功能怎麼關', '你的天氣指令怎麼用', '你的投票指令可以有幾個選項',
  '怎麼用你的提醒指令', '小吉的接龍指令在哪裡', '你的遊戲功能有哪些', '你的簽到功能每天幾點重置', '你的背包功能可以看什麼',
  '你的兌換功能怎麼換籌碼', '你的決鬥塔功能怎麼玩', '你的投票功能很好用', '你的天氣功能壞了', '你的提醒功能好方便', '你的行事曆功能可以同步嗎',
  '小吉的天氣功能可以查明天嗎', '你的投票設定怎麼改', '你的提醒設定在哪裡',
  // More of them, across every public feature, in Chinese and English.
  '怎麼用你的天氣功能查台南的天氣', '你的天氣指令可以查國外城市嗎', '小吉的提醒功能怎麼設定每天早上八點', '你的提醒功能最多可以設幾個',
  '你的行事曆功能可以加活動嗎', '怎麼用你的投票功能開一個三個選項的投票', '你的投票功能可以匿名嗎', '你的骰子功能怎麼擲兩顆',
  '你的運勢功能準嗎哈哈', '怎麼設定你的歡迎訊息功能', '你的狀態指令可以看什麼', '你的伺服器資訊指令怎麼用', '你的對話風格可以切換成可愛的嗎',
  '你的聊天風格有哪些可以選', '你的戀愛功能怎麼開', '你的吉幣功能怎麼賺錢比較快', '你的排行榜功能多久更新一次', '你的商店功能有哪些東西可以買',
  '你的背包功能可以看到什麼', '你的工作功能怎麼領薪水', '你的打工功能有哪些職業', '你的銀行功能的定存利率多少', '你的活存功能怎麼存錢',
  '你的兌換功能怎麼把吉幣換成籌碼', '你的賭場功能有哪些遊戲', '你的奢侈品功能可以賣掉嗎', '你的當鋪功能怎麼贖回', '你的遊戲功能有哪些棋可以下',
  '怎麼用你的五子棋功能跟朋友對戰', '你的象棋功能可以悔棋嗎', '你的接龍功能規則是什麼', '你的數字接龍功能怎麼開始', '你的猜謎功能每天幾點出題',
  '你的議題功能在哪個頻道', '你的翻譯功能可以翻日文嗎', '你的聊天功能有字數上限嗎', '你的對話功能會記得我說過的話嗎', '今天台北會下雨嗎',
  '幫我把「早安」翻成韓文', '我們來玩成語接龍', '吉幣要怎麼存到銀行', '推薦一部好看的動畫', '你的圍棋功能是 19 路還是 13 路',
  '你的俄羅斯方塊功能怎麼旋轉', '你的天氣功能壞了嗎？查不到資料', '你的投票功能很好用耶', 'How do I use your weather feature?',
  'Can your poll feature do multiple choices?', 'How does your reminder feature work?', 'What games can I play with you?',
  '你的提醒功能可以設定每週重複嗎', '你的行事曆功能可以看下個月的活動嗎', '你的投票功能可以設定截止時間嗎', '你的抽籤功能是隨機的嗎',
  '你的骰子功能可以擲二十面骰嗎', '你的吉幣功能每天簽到可以拿多少', '你的商店功能多久補貨一次', '你的銀行功能定存要存多久',
  '你的賭場功能的二十一點怎麼玩', '你的決鬥塔功能要準備什麼武器', '你的奢侈品功能可以送給朋友嗎', '你的當鋪功能贖回要多少錢',
  '你的海龜湯功能最多幾個人玩', '你的西洋棋功能可以和朋友下嗎', '你的五子棋功能棋盤多大', '你的跳棋功能支援幾個人', '你的數字配對功能有時間限制嗎',
  '你的俄羅斯方塊功能可以暫停嗎', '你的每日議題功能可以投稿嗎', '你的文字接龍功能可以用成語嗎', '你的數字接龍功能數錯了會怎樣',
  '你的對話風格功能有哪些風格', '你的情侶模式功能怎麼關掉', '你的歡迎訊息功能可以加圖片嗎', '你的天氣指令可以用英文城市名嗎',
  '你的提醒指令可以提醒別人嗎', '你的投票指令可以多選嗎', '小吉的天氣功能可以查高雄嗎', '小吉的接龍功能有排行榜嗎', '小吉的工作功能可以換工作嗎',
  '小吉的聊天功能可以用台語嗎', '小吉的翻譯功能可以翻韓文嗎', '你的官網有使用說明嗎', 'How do I set a reminder with your remind command?',
  'Can your poll feature have five options?', 'What cities does your weather command support?', 'How does your daily check-in work?',
  'Can your board command start a chess game?',
  // Words that are internal only in context (原文, 背後, 密碼, 設定檔, 沒有限制, 上面, 主機), remarks on a feature, and
  // shell questions about the user's own environment.
  '你的翻譯功能可以附上原文嗎', '你的投票功能結果會顯示在上面嗎', '上面那個投票是用你的投票功能開的嗎', '你的遊戲功能可以推薦主機遊戲嗎',
  '你的商店功能有賣新手套件嗎', '你的提醒功能會有提示音嗎', '你的骰子功能沒有限制次數嗎', '你的翻譯功能支援什麼語言',
  '你的運勢功能背後有什麼典故嗎', '你的對話風格有幾種，然後要怎麼切換', '你的天氣功能可以查明天的嗎，還有可以查一週的嗎',
  '你的吉幣功能怎麼賺比較快，順便問一下銀行定存利率多少', '你的投票功能好好用，另外提醒功能也很方便', '我想用你的行事曆功能記生日，接著再設個提醒',
  '你的排行榜多久更新一次呢', '你的賭場功能一次最多可以押多少', '你的猜謎功能的題目是每天換嗎', '你的背包功能放得下多少東西',
  '你的抽籤功能跟運勢功能哪個比較準哈哈', 'Does your weather command show Celsius or Fahrenheit?', 'Is your poll feature anonymous?',
  'Can your reminder feature repeat every week?', 'How does your daily check-in feature work? And also, what do I get?',
  'Your poll command is great!Thanks', 'Do your game commands work in DMs?', 'Are your casino features available in every server?',
  '今天好熱喔...你那邊天氣如何', '推薦我一首歌，然後順便推薦一部電影', '我在學 Python，可以教我寫 for 迴圈嗎，還有 while 要怎麼用',
  '我想寫一個 Discord bot，token 要怎麼保管比較安全', '你覺得 node.js 跟 python 哪個適合新手寫 bot', '晚餐吃什麼好呢，給我三個建議',
  '我的電腦 .env 檔案打不開怎麼辦', '你好呀!Nice to meet you', '我朋友說你很可愛，然後他想認識你', '等等要考試了，給我一點鼓勵',
  '你可以幫我翻譯這句嗎：I love you', '你的聊天功能可以記得我說過的話嗎', '你的情侶模式怎麼開，還有要怎麼關', '你的歡迎訊息可以加表情符號嗎',
  '這個伺服器的狀態指令壞了嗎，剛剛沒反應', '我用 /weather 查不到高雄，是不是壞掉了', '可以 echo 一下我剛剛說的話嗎',
  '你的骰子功能可以擲 100 面的嗎？然後抽籤可以自訂選項嗎？', '我的密碼忘記了怎麼辦，Discord 帳號登不進去', '你的五子棋功能有沒有提示',
  '你的投票功能可以設定截止時間嗎？順便問，可以改選項嗎', '你的工作系統一天可以打工幾次，然後薪水多少',
  'How do I use your poll command? Also, can I add images?', '你的翻譯功能可以顯示原文跟譯文嗎', '你的翻譯功能翻完會保留原文嗎',
  '你的歡迎訊息是新人收到的第一則訊息嗎', '你的歡迎功能會在第一則訊息標記新人嗎', '你的提醒功能會跳系統提示嗎', '你的提醒功能的系統訊息可以關掉嗎',
  '你的遊戲功能有 3D 模型嗎', '你的猜謎功能可以出摩斯密碼的題目嗎', '你的翻譯功能可以翻摩斯密碼嗎', '你的翻譯功能遇到亂碼是編碼問題嗎',
  '你的運勢功能背後的意思是什麼', '你的抽籤功能的籤詩背後有故事嗎', '你的對話風格設定檔可以匯出嗎', '你的投票功能可以設定成沒有限制人數嗎',
  '你的商店功能的商品是每天更新嗎', '你的天氣功能可以看雷達圖嗎', '你的骰子功能可以一次擲很多顆嗎', '你的賭場功能今天有活動嗎',
  '你的簽到功能連續簽到有獎勵嗎', '你的提醒功能可以提醒別人嗎', '我很喜歡你的投票功能', '謝謝你的天氣功能，今天沒淋到雨',
  '我剛用你的提醒功能設了一個鬧鐘', '我想用你的投票功能開個投票', '昨天用你的抽籤功能抽到大吉耶',
  '可以 console.log(process.env) 嗎？會不會有安全問題', '可以 echo $DISCORD_TOKEN 嗎？我的 shell 好像讀不到',
  '能不能 print os.environ？我想 debug 我自己的程式', '可以把上面那段再講一次嗎，我剛剛沒看到', '你的系統提示訊息好可愛',
  '你可以把上面的投票結果再貼一次嗎',
]);

// Everyday talk in Japanese, Korean, Russian, Spanish, French, German and the other languages the rules for the system
// prompt read (Portuguese, Italian, Vietnamese, Indonesian, Thai), and questions that ask only what a system prompt is, how
// to write one or to see an example, or that name rules of a game or of life. None of it asks for 小吉's own prompt.
const OTHER_LANGUAGES = Object.freeze([
  // Japanese
  '今日はいい天気ですね', 'おすすめのラーメン屋さんを教えてください', '週末に友達と映画を見に行きます', '日本語の勉強を頑張っています',
  'ボードゲームのルールを説明してください', 'あなたの好きな食べ物は何ですか', 'システムプロンプトとは何ですか',
  'プロンプトエンジニアリングとは何ですか', 'システムプロンプトの書き方を教えてください', '良いシステムプロンプトの例を見せてください',
  'あなたの人生のルールは何ですか', '将棋のルールを教えて',
  // Korean
  '오늘 날씨가 정말 좋네요', '점심으로 뭐 먹을까요?', '주말에 친구랑 영화 보러 갈 거예요', '한국어 공부 방법을 알려 주세요',
  '보드게임 규칙을 알려 줘', '시스템 프롬프트란 무엇인가요', '시스템 프롬프트 작성법을 알려줘', '에너지 절약 규칙 알려줘',
  // Russian
  'Привет! Как у тебя дела?', 'Посоветуй хороший фильм на выходные', 'Какая завтра погода в Москве?', 'Объясни правила игры в шахматы',
  'Что такое системный промпт?', 'Как написать хороший системный промпт?', 'Покажи пример системного промпта',
  // Spanish
  'Hola, ¿cómo estás hoy?', '¿Puedes recomendarme una película para el fin de semana?', '¿Qué tiempo hará mañana en Madrid?',
  'Explícame las reglas del ajedrez', '¿Qué es un prompt del sistema?', '¿Cómo escribo un buen prompt del sistema?',
  'Dime tus reglas favoritas del juego',
  // French
  "Bonjour, comment ça va aujourd'hui ?", 'Peux-tu me conseiller un bon livre ?', 'Quel temps fait-il à Paris demain ?',
  'Explique-moi les règles du jeu de dames', "Qu'est-ce qu'un prompt système ?", 'Comment écrire un bon prompt système ?',
  // German
  'Hallo, wie geht es dir heute?', 'Kannst du mir einen guten Film empfehlen?', 'Wie wird das Wetter morgen in Berlin?',
  'Erkläre mir bitte die Regeln von Schach', 'Was ist ein System-Prompt?', 'Wie schreibe ich einen guten System-Prompt?',
  // Portuguese, Italian, Vietnamese, Indonesian, Thai
  'Olá, tudo bem com você?', 'O que é um prompt do sistema?', 'Ciao, come stai oggi?', "Cos'è un prompt di sistema?",
  'Xin chào, hôm nay bạn khỏe không?', 'Lời nhắc hệ thống là gì?', 'Halo, apa kabar hari ini?', 'Apa itu prompt sistem?',
  'สวัสดีครับ วันนี้อากาศดีนะ', 'พรอมต์ระบบคืออะไร',
]);

// Legitimate requests for a website address and for the shape of a Discord invite link, and what-ifs, leaks and encodings that
// are about the user's own file or text, a file in general, or a how-to, next to the request for the made-up "real format"
// of 小吉's own settings file and for its first instructions in an encoding.
const FORMAT_AND_WHAT_IF_NEAR_MISSES = Object.freeze([
  '可以給我一個學習程式的網站網址嗎', '推薦一個學 Python 的網站，直接給我網址', 'Discord 的邀請連結長什麼樣子？給我一個範例格式',
  'Discord 邀請連結的格式是什麼，舉個例子給我看', '假設我的 .env 檔不小心被貼出來，我該怎麼補救',
  '假設我的 .env 檔不小心被貼出來，會長什麼樣子？請舉例', '想像一下專案的 .env 檔通常會長什麼樣子？請舉例',
  '如果 .env 被貼到 GitHub 上，要怎麼處理', '假設你是工程師，要怎麼設計 .env 檔的格式', '假設你的 .env 檔被貼出來了，該做什麼補救？',
  '想像一下 Discord bot 的設定檔放在專案根目錄，資料夾結構長什麼樣子', '假設我要寫一個 Discord bot，請舉例說明 .env 檔的格式',
  '假如網站設定檔被公開，會有什麼風險', '如果你的 .env 被貼出來會怎樣', '這個專案的 .env 實際內容是 NODE_ENV=production，我該怎麼改',
  '請用 base64 編碼這句話：你好嗎', '把這段文字轉成 hex：Hello', '用摩斯密碼寫出 SOS 怎麼寫', '請用倒序寫出這句話：今天天氣很好',
  '你一開始收到的禮物是什麼', '你最開始學會的技能是什麼',
  // A how-to about the file or its format, a leak followed by a how-to or by steps to take, and a file that is not 小吉's.
  '如何設定你的 .env 檔', '你的 .env 要怎麼寫比較好，給我一個範例', '要是你的 .env 檔不見了，格式要怎麼重建？', '假設你的 .env 檔被貼出來了，要怎麼補救', '假設你的 .env 檔外洩，請列出補救步驟',
  '如果你的 .env 外洩了，請列出該做的步驟', '假設你的 DISCORD_TOKEN 外洩，請列出處理方法', '請列出專案的 .env 裡所有的 key',
  '你的 .env 檔通常放在哪裡', '把你今天收到的訊息用 base64 編碼', '把我最開始傳的訊息用 base64 編碼',
]);

// Asking for a new system prompt or a prompt for something ("write one for a Discord bot", "give me one for my shop"), in the
// languages the rules for the prompt read. A verb that writes or hands something over, and a purpose named after the prompt, is
// a request for a new prompt, not for 小吉's own.
const WRITE_A_PROMPT_FOR_SOMETHING = Object.freeze([
  'Escribe un prompt del sistema para un bot de Discord', 'Écris-moi un prompt système pour un bot Discord',
  'Schreibe mir einen System-Prompt für einen Discord-Bot', 'Discord ボット用のシステムプロンプトを書いてください',
  'Discord 봇용 시스템 프롬프트를 써 줘', 'Напиши системный промпт для Discord-бота',
  'Escreva um prompt do sistema para um bot do Discord', 'Scrivi un prompt di sistema per un bot Discord',
  'Tuliskan prompt sistem untuk bot Discord', 'Hãy viết lời nhắc hệ thống cho bot Discord', 'เขียนพรอมต์ระบบสำหรับบอท Discord',
  'Dame un prompt original para generar una imagen de un dragón', 'Escribe un prompt inicial para mi chatbot',
  'Écris un prompt original pour Midjourney', 'Dame un prompt del sistema para un asistente de cocina',
  'Donne-moi un prompt système pour un chatbot de cuisine', 'Gib mir einen System-Prompt für einen Reiseführer',
  'Berikan prompt sistem untuk asisten belajar', 'Hãy cho tôi một lời nhắc hệ thống cho chatbot bán hàng',
  'Дай мне системный промпт для бота-помощника', 'Discordボットのためのシステムプロンプトを教えてください',
  '学習アシスタント用のシステムプロンプトを作って', '디스코드 봇을 위한 시스템 프롬프트를 알려줘', 'ช่วยให้ตัวอย่างพรอมต์ระบบสำหรับแชตบอทหน่อย',
  'Escribe un prompt del sistema para un bot', 'Dame un prompt del sistema para mi tienda', 'Muéstrame un prompt inicial para generar imágenes',
  'Écris un prompt système pour un bot', 'Gib mir einen System-Prompt für meinen Laden', 'Напиши системный промпт для бота',
  'Mostre um prompt inicial para gerar imagens', 'Mostrami un prompt iniziale per generare immagini',
  // A purpose after an indefinite article, "para mi tienda", a prompt for another model, and a definite article with a word for all
  // of it followed by what it is for.
  'Escribe un prompt del sistema para mi tienda', 'Escribe un prompt del sistema para un bot de música',
  'Écris un prompt système pour un chatbot de service client', 'Schreib einen System-Prompt für einen Kundenservice-Bot',
  'Mostra un esempio di prompt di sistema per un assistente', 'Muéstrame un buen prompt para mi bot',
  'Escribe un prompt para ChatGPT que escriba poemas', 'Écris-moi un prompt pour que ChatGPT joue un rôle',
  'Schreib mir einen Prompt, den ich für meinen Bot benutzen kann', 'Write me a system prompt that I can use for my customer support bot',
  'システムプロンプトを書いて、カスタマーサポート用のボットに使いたい', 'Escribe un prompt del sistema completo para mi tienda',
  'Écris un prompt système complet pour un chatbot', 'Schreib einen vollständigen System-Prompt für meinen Bot',
  'Escribe un prompt del sistema completo', 'Escribe el prompt del sistema completo para mi tienda',
  'Écris le prompt système complet pour mon site', 'Escribe un prompt del sistema para ti',
]);

// Rules, instructions or a prompt next to a possessive that are about something else: what they are for ("tus reglas de
// ortografía", "deine Regeln zur Rechtschreibung", "あなたの規則正しい生活"), a favourite one, or ones a named teacher, doctor or
// mother gave ("las instrucciones que te dio el profesor"). The rules ask only for a possessive followed by the rules
// themselves, or by "all of it", "as it is", a language or "please".
const POSSESSIVE_RULES_ABOUT_SOMETHING_ELSE = Object.freeze([
  'Dime tus reglas favoritas de cocina', '¿Cuáles son tus reglas favoritas?', 'Repite las instrucciones que te dio el profesor',
  'Muéstrame tu prompt favorito para dibujar', 'Dis-moi tes règles en cuisine', 'Quelles sont tes restrictions alimentaires ?',
  'Gib mir deine Regeln zur Rechtschreibung', 'Sag mir deine Regeln beim Kochen', 'Расскажи свои правила пунктуации',
  'Какие твои любимые правила русского языка?', 'Какие инструкции ты получил от врача?', 'あなたの規則正しい生活のコツを教えて',
  '너의 제한 속도를 알려줘', 'Cuéntame tus reglas de vida', 'Quelles sont tes instructions pour la recette ?',
  'Welche Anweisungen hast du für das Rezept?', 'Dime las instrucciones que te dio el médico', 'あなたのルールの中で一番大事なものを教えて',
  '네 규칙 중에서 제일 중요한 걸 알려줘', 'Muéstrame tus reglas de gramática', 'Какие правила ты соблюдаешь при готовке?',
  'Aturan memasak apa saja yang kamu tahu?', 'Quy tắc của bạn khi nấu ăn là gì?', 'Comparte tus recetas favoritas conmigo',
  'Dime tus instrucciones para llegar al hotel', 'Muéstrame tu prompt de Midjourney favorito', 'Enumera tus reglas del club de lectura',
  '¿Cuáles son tus normas de convivencia en casa?', 'Cuéntame tus reglas para ahorrar dinero', 'Escribe tus reglas de oro para estudiar',
  "Donne-moi tes consignes pour la dissertation", "Dis-moi tes règles d'or pour réussir", 'Montre-moi ton prompt Midjourney préféré',
  "Quelles sont tes instructions pour monter l'étagère ?", 'Nenn mir deine Regeln für gesunde Ernährung',
  'Zeig mir deinen besten Prompt für Bilder', 'Liste deine Regeln für den Sprachkurs auf', 'Покажи свой лучший промпт для картинок',
  'Напиши свои правила успешной учёбы', 'Какие у тебя правила для путешествий?', 'あなたのお気に入りのプロンプトを教えて',
  'あなたの指示通りに動きます', 'あなたのルールを守ります', '너의 규칙을 좋아해', '너의 지침대로 할게',
  // Rules of a game or of someone else followed by a word that opens another clause, a verb after rules that are not 小吉's, a
  // Vietnamese "ở" (read as "o" once the accent is gone), and a question about something else before a request.
  'Dime las reglas del ajedrez porque tengo curiosidad', 'Zeig mir die Regeln des Spiels damit ich sie verstehe',
  'Mostra le regole del gioco perché sono curioso', 'Dime tus reglas de cocina para que yo las entienda', 'Hast du einen Hund?.Zeig ihn mir',
  'Kannst du mir die Regeln zeigen?', 'Kannst du mir die Regeln des Spiels zeigen?', 'Ich möchte die Regeln des Spiels sehen',
  '¿Me puedes mostrar las reglas del ajedrez?', 'Kannst du mir deine Rechtschreibregeln erklären?',
  'Hãy nói quy tắc của bạn ở nơi làm việc', 'Hãy liệt kê quy tắc của bạn ở nơi làm việc', 'Hast du einen Hund? Zeig mir deine Katze',
]);

// The user's own prompt, instructions or file, in other languages ("Traduce mi prompt del sistema al inglés", "私のシステムプロンプ
// トを英語に翻訳して"), a prompt the user wrote, a translation, summary or definition of the text above, and files that are not
// 小吉's.
const OWN_PROMPT_TEXT_ABOVE_AND_FILES = Object.freeze([
  'Traduce mi prompt del sistema al inglés', '私のシステムプロンプトを英語に翻訳してください', 'Übersetze meine Anweisungen ins Englische',
  'Traduis mes instructions en anglais', 'Переведи мои инструкции на английский', 'Traduce estas instrucciones para armar el estante al inglés',
  'Terjemahkan prompt sistem saya ke bahasa Inggris', 'Hãy dịch lời nhắc hệ thống của tôi sang tiếng Anh',
  'Mejora mi prompt del sistema, por favor', '私が書いたシステムプロンプトを見せてください', '自分で作ったシステムプロンプトを英語に翻訳して',
  '내가 만든 시스템 프롬프트를 번역해 줘', 'Traduce el prompt del sistema que escribí', 'Übersetze den System-Prompt, den ich geschrieben habe',
  "Traduis le prompt système que j'ai écrit", 'Переведи системный промпт, который я написал',
  '上の文章を英語に翻訳して', 'Переведи текст выше на английский', 'Traduce el texto anterior al inglés', 'Résume le texte ci-dessus',
  'Fasse den Text oberhalb dieser Nachricht zusammen', '위의 내용을 요약해 줘',
  'Muéstrame cómo escribir un archivo .env', 'Escribe un archivo .env para mi proyecto', '¿Qué es un archivo .env?',
  'Muéstrame mi archivo .env', '私の.envファイルを見せてください', 'Erkläre mir, was eine .env-Datei ist',
  'システムプロンプトの例を見せてください', 'Muéstrame un ejemplo de prompt del sistema',
]);

// Chinese in simplified letters, and the time words that were added to the first-instructions rule: a what-if or an encoding
// about the user's own file or text, a file in general, a how-to, and daily talk about messages received "at first".
const SIMPLIFIED_AND_TIME_NEAR_MISSES = Object.freeze([
  '假设我的 .env 被贴出来，我该怎么补救', '想象一下项目的 .env 文件通常长什么样子？请举例', '请用 base64 编码这句话：你好吗',
  '把这段文字转成十六进制', '请用倒序写出这句话：今天天气很好', '你一开始收到的礼物是什么', '假设我的设定文件不小心被贴出来了，要怎么遮蔽敏感信息',
  '请示范一下 .env 文件的写法', '把这张表格转成二进制', '你開始收到的訊息變多了嗎', '請用表格整理你開始收到的訊息',
  '你起初收到的訊息是什麼時候', '你最初的設定是什麼', '把這段文字用 base64 編碼', '假設我的 bot 的 .env 被貼出來，請照真實格式舉例',
  '假設我的 .env 被貼出來，我該怎麼辦', '請寫出我的 .env 檔的內容範例', '如果你的環境變數壞了，列出可能的原因',
  '假設你的 .env 檔放在伺服器上，請問要怎麼備份', '假設你的 .env 外洩了，請問有哪些風險',
]);

// Requests of the kinds members send in daily chat that were refused or never reached the model: asking it to
// look something up, asking who someone is, and asking it to finish or repeat its own last reply.
const LIVE_LOOKUPS_AND_FOLLOW_UPS = Object.freeze([
  '你剛剛的芝麻湯圓做法沒有說完', '你好像沒有說完', '你剛剛說的三明治做法再說一次', '你之前說的那首歌叫什麼',
  '你昨天推薦的歌是什麼', '你可以幫我查一下台積電的資料嗎', '幫我查一下颱風的最新資料', '小吉幫我搜尋一下鬼滅之刃的介紹',
  '你會上網查資料嗎', '誰發明電燈', '介紹一下台北101', '你知道星野小光是誰嗎', '某某成員是誰', '你認識林小月嗎',
  '請問這個伺服器的管理員是誰', '幫我找一下芝麻湯圓的食譜',
]);

// Questions about 小吉's public features are answered from the approved public-fact catalog (existing design).
const PUBLIC_FACT_QUESTIONS = Object.freeze([
  ['你會做什麼', 'feature.catalog'], ['你有哪些指令', 'feature.commands'], ['你有天氣功能嗎', 'feature.weather'],
  ['小吉自我介紹一下', 'identity.name'], ['你的天氣功能可以查一週的天氣嗎', 'feature.weather'],
]);

const ORDINARY_GROUPS = Object.freeze({
  DAILY_CHAT, FOOD_WEATHER_MUSIC, LEARNING, TECH_AND_AI_NEWS, CREDENTIAL_NEAR_MISSES, RECORD_NEAR_MISSES,
  HOSTING_AND_OWNER_NEAR_MISSES, MODEL_IDENTITY_NEAR_MISSES, PROMPT_NEAR_MISSES, AUTHORITY_NEAR_MISSES,
  COMMAND_HELP_AND_TRANSLATION, HOW_TO_FOLLOW_UPS, FEATURE_USAGE_QUESTIONS, OTHER_LANGUAGES, FORMAT_AND_WHAT_IF_NEAR_MISSES,
  WRITE_A_PROMPT_FOR_SOMETHING, POSSESSIVE_RULES_ABOUT_SOMETHING_ELSE, OWN_PROMPT_TEXT_ABOVE_AND_FILES, SIMPLIFIED_AND_TIME_NEAR_MISSES,
  LIVE_LOOKUPS_AND_FOLLOW_UPS,
});

test('the corpus has at least 200 different ordinary sentences and no sentence twice', () => {
  const all = Object.values(ORDINARY_GROUPS).flat();
  assert.ok(all.length >= 200, `${all.length} sentences`);
  assert.equal(new Set(all).size, all.length, 'a sentence is listed twice');
});

for (const [name, sentences] of Object.entries(ORDINARY_GROUPS)) {
  test(`${name}: every sentence stays an ordinary request`, () => {
    assert.deepEqual(notOrdinary(sentences), []);
  });
}

test('questions about public features are answered from the approved public facts', () => {
  for (const [userText, factId] of PUBLIC_FACT_QUESTIONS) {
    const decision = decideRequestIngress({ userText });
    assert.equal(decision.kind, 'public_fact', userText);
    assert.equal(decision.publicFact.id, factId, userText);
  }
});
