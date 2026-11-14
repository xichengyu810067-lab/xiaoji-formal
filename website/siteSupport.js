(function bootstrapSiteSupport() {
  'use strict';

  const CONTACT_EMAIL = 'xichengyu810067@gmail.com';
  const CONTACT_SUBJECT = '小吉服務詢問';
  const policyPublication = window.XiaojiPolicyPublication;
  if (!policyPublication) throw new Error('policy_publication_missing');
  const POLICY_SECTIONS = Object.freeze([
    {
      id: 'terms',
      title: '使用者政策',
      summary: '使用小吉前，請先了解服務用途、合理使用方式與可用性限制。',
      blocks: [
        ['服務範圍', '小吉提供 Discord 互動、公開網站、遊戲與相關自助說明。部分功能須在 Discord 伺服器內使用，並受該伺服器設定、Discord 權限與服務狀態影響。'],
        ['合理使用', '請勿利用小吉騷擾、冒用他人、規避權限、嘗試取得非公開資料，或要求小吉處理緊急、醫療、法律或財務決策。使用者須自行確認內容是否適合實際用途。'],
        ['AI 回覆', 'AI 回覆可能不完整或不正確，僅供一般互動參考；小吉上網搜尋到的內容也可能過時或有誤，重要資訊請以官方來源為準。請小吉開投票時，小吉只會先顯示預覽，由提出的人按「確認」後才會開出。小吉可以看你在聊天或 /student 回答時附上的圖片（每則最多 3 張、每張 5MB 以內，限 png、jpg、gif、webp），對圖片的解讀也可能有誤；小吉被設定為不辨識照片中人物的身分、不讀出圖片裡的個人資料。若 AI 服務暫時受到速率或額度限制，小吉會固定回覆「小吉有點累了，請稍後再跟我聊天」。'],
        ['服務異常', '功能可能因 Discord、網路、第三方服務或維護而暫時無法使用。請先查看狀態頁；仍無法排除時可透過下方聯繫方式說明情況。'],
      ],
    },
    {
      id: 'privacy',
      title: '隱私權政策',
      summary: '小吉只在提供功能、維持安全與回應使用者需求所需的範圍內處理資料。',
      blocks: [
        ['可能處理的資料', '依你使用的功能，小吉可能處理 Discord 提供的帳號識別、顯示名稱、訊息或互動內容、偏好設定、伺服器與頻道脈絡，以及遊戲或功能操作所需資料。與小吉 AI 的互動包含私訊；請勿在公開頻道、私訊或客服欄位輸入密碼、權杖、付款資訊或其他敏感資料。'],
        ['記憶與保存', '在小吉所在的伺服器中，非機器人、非系統的公開頻道文字訊息可能被記錄為公開頻道記憶，即使未提及小吉；跨頻道查找仍須伺服器明確開啟分享設定。資料沒有固定保存期限，會依服務目的、資料類型與本政策的刪除流程處理及刪除；小吉不宣稱所有記憶都會在 30 天後自動刪除，也不宣稱提供無限儲存容量。'],
        ['對話可見性', '為改善對話品質、維護服務及處理必要問題，小吉擁有者（原作者）可在職責範圍內查看與小吉的對話內容，包括符合前述條件的公開頻道記憶與私訊互動。這不表示對話會被用來訓練模型。'],
        ['安全警示與擁有者通知', '小吉偵測到攻擊或濫用（例如提示詞注入、洗版、釣魚或惡意連結）時，會以固定格式私訊擁有者，內容只有遭受攻擊的伺服器名稱與類別，不含成員的文字內容、帳號或任何 ID；同一伺服器、同一類別每小時最多通知一則。輸入端的釣魚與惡意連結偵測使用小吉本機內建的規則，不連網；偵測結果只通知擁有者，不刪除訊息、不禁言、不回覆。'],
        ['回覆被阻擋時的開發者通知', '為了讓開發者找出誤擋並維護小吉，小吉的回覆或你的請求被安全規則阻擋時（例如被判定為打聽內部資料、洗版或回覆含有不能公開的內容），小吉會私訊開發者一則通知，內容包含伺服器與頻道名稱、成員顯示名稱、觸發的規則與類別、你的原始訊息，以及被阻擋的回覆內容。開發者開啟開發者模式（須通過多重身分驗證）時，通知以明文送出；未開啟時，通知內容會先加密成亂碼，只有開發者本人在私訊中要求解密後才會顯示。這類通知只送給開發者本人，數量不設上限，不會傳給其他人，也不用於訓練模型。'],
        ['吉幣帳戶資料', '吉幣帳戶是跨伺服器共用的。擁有者可以用專用指令查詢全體成員的吉幣帳戶資料；成員只能查看自己的吉幣資料。伺服器管理員的管理工具只能查看同一伺服器內成員的吉幣餘額等管理所需資料，看不到該成員在其他伺服器的主職或薪資。'],
        ['資料備份', '開發者主機可能啟用定期資料備份：把小吉的資料（包含各伺服器共用的吉幣帳戶、各伺服器的設定、提醒與行事曆、AI 對話封存與安全帳本等）每天備份到開發者自己的雲端硬碟。這個功能預設關閉，須由開發者完成雲端硬碟授權設定才會運作；備份只有開發者本人可以存取，設定了加密密語時會先加密再上傳，並只保留最近約 30 份。你的資料若已被備份，刪除請求在既有備份到期前，可能無法立刻反映在備份內。'],
        ['第三方連線', 'Discord 與依功能啟用的服務供應商可能為提供、維護或保護服務而處理必要的對話與相關資料。小吉的 AI 對話與 /student 提問由 Anthropic 的 Claude 產生（未設定時改用 Groq 或 OpenAI），你傳給小吉的對話內容、你被記住的喜好與聊天紀錄、同一個頻道最近的對話與必要的上下文會送到該服務以產生回覆；小吉需要即時資訊時，搜尋關鍵字會經由該服務的網路搜尋功能查詢。使用 /food 查食譜或附近美食時，你輸入的菜名、食材、地區與想吃的類型會送到 Claude（附近美食會經由其網路搜尋功能查詢）；推薦到伺服器美食地圖（測試中，只在授權的伺服器開放）的店名、地區、類型與推薦理由，連同推薦人的帳號保存在 Turso 雲端資料庫，同一伺服器的成員都看得到。查詢股票報價時（/stock 或在聊天中詢問），只有股票代號會送到臺灣證券交易所、證券櫃檯買賣中心的公開資料服務，或 Twelve Data（美股、ETF 與加密貨幣）；自選股清單與喜好記憶保存在同一個 Turso 雲端資料庫。文字接龍時，教育部辭典查不到的詞（只有該詞本身，不含玩家資料）會送到 Claude 判斷是不是真的詞語，並計入伺服器的 AI 額度。星火接續時，你報名填的主題會送到 Claude 出任務，你交的文字與圖片會送到 Claude 驗收（都計入伺服器的 AI 額度）；小吉只把主題、任務與完成狀態保存在 Turso 雲端資料庫，不保存你交的文字與圖片，一輪結束 30 天後刪除。在官網客服輸入的問題（以及同一次對話中前幾句）會送到 Claude 產生回答；小吉不保存問題內容，只用每天更換的雜湊位址計算次數上限（每位訪客每小時 10 題、全站每天 300 題）。請勿在官網客服輸入個人資料。你附上的圖片會從 Discord 下載後送到該服務以產生回覆，小吉自己不保存圖片（對話紀錄只留下「附圖 N 張」）；請勿上傳證件、帳單、病歷等含敏感資料的圖片。喜好記憶保存在 Turso 雲端資料庫（東京機房）。這些服務的資料處理也適用其自身政策。網站也會載入 Google Fonts 等第三方資源；這些服務的資料處理適用其自身政策。'],
        ['選用的外部判斷服務', '這是選用功能，預設關閉，須由擁有者明確啟用。擁有者可能啟用第三方外部服務 TypeSafe AI（Jev）的第二意見，且只對擁有者指定的伺服器生效，私訊不會送出。啟用時，被判斷的文字（被標記的 AI 回覆與對應提問，或含連結的伺服器訊息）會送到該服務（託管於美國）；送出前會去除提及、長數字 ID 與密鑰樣式，每段上限約 1500 字，這只是基本的去識別化，無法保證去除所有可辨識資訊。據該服務聲明，送出的內容不用於訓練模型。'],
        ['喜好記憶', '你使用小吉的 AI 對話（包括 /student）時，小吉會記住你親口說出的喜好，例如喜歡的食物、音樂、遊戲、興趣、作品、想被怎麼稱呼與聊天風格，讓之後的對話更貼心。小吉不會記健康、宗教、政治、性傾向、真實姓名、住址、電話、學校、帳號密碼等敏感資料，也不會記其他成員的事；每個記憶範圍最多保存 30 條，超過一年沒有用到的喜好會自動刪除。'],
        ['聊天紀錄記憶', '只要你和小吉聊過天，小吉就會記住你在小吉所在伺服器裡、小吉讀得到的頻道中說過的文字訊息（即使沒有提及小吉），以及小吉在這些頻道的回覆，讓小吉記得同一個頻道裡剛剛聊過什麼，也能回答「你知道我是誰嗎」這類問題。私訊的內容不會被記住；機器人與系統訊息不會被記住；訊息中的密鑰、權杖等敏感字串會先被遮蔽，每則最多保存 300 字。使用範圍依你的公開設定：選擇公開時，你在任何伺服器說過的話會在你和小吉聊天的所有伺服器中使用；選擇不公開時，只在原本的伺服器中使用。同一個頻道最近的對話，只會在同一個頻道裡被小吉參考。其他成員不能查詢你的聊天紀錄。收錄數量：每人每天最多 30 則；當天用完會先借用隔天的額度（隔天可收錄的數量相應減少），沒用完的額度不會累積到之後；整個月的額度用完後就不再收錄，直到下個月重新計算。每月上限為 30 則乘以當月天數（900 或 930 則）。每天與每月都從台北時間中午 12:00 起算；每月 1 號中午 12:00 重新計算額度，並刪除上個月收錄的全部聊天紀錄，因此聊天紀錄最多保存約一個月。聊天紀錄與喜好記憶保存在同一個 Turso 雲端資料庫（東京機房）。你可以用 /memory view 查看本月已記住的數量與剩餘額度，用 /memory off 停止蒐集與使用，用 /memory delete 刪除你的全部記憶（包含聊天紀錄與小吉回覆你的內容）。'],
        ['每週記憶報告', '為了維護小吉並確認記憶功能正常，小吉每 168 小時（7 天）會把這段期間所有成員新增的喜好記憶與聊天紀錄記憶（包含成員說過的話，以及小吉在這些頻道的回覆），依伺服器與成員整理成一份 HTML 檔，私訊給開發者本人。無論你選擇公開或不公開聊天記憶，你的內容都會列入報告。報告包含伺服器名稱與 ID、頻道名稱、成員顯示名稱與 Discord ID，以及新增的喜好、聊天原文與時間；這段期間沒有新資料時，開發者只會收到一則沒有新資料的通知。計時從小吉主機每次啟動後開始，重新啟動就重新起算。報告只送給開發者本人，不會傳給其他人，也不用於訓練模型。用 /memory off 停止蒐集後，報告不會再有你的新內容；刪除記憶無法收回已經送出的報告。'],
        ['查詢、停止蒐集與刪除', '依個人資料保護法，你可以查詢、閱覽、取得複本、補充或更正、要求停止蒐集處理利用，以及刪除小吉保存的你的資料。喜好記憶可直接用 /memory view、export、add、forget、off、on、delete 與 share 處理，回覆只有你自己看得到；其他個人資料或隱私疑慮，請寄信至 xichengyu810067@gmail.com，主旨使用「小吉服務詢問」，並只提供處理案件所需的最少資訊。'],
      ],
    },
    {
      id: 'public-data',
      title: '公開資料聲明',
      summary: '公開網站以去識別化的整體資訊說明功能與服務狀態。',
      blocks: [
        ['公開範圍', '狀態頁與公開功能清冊用於說明整體服務情況、公開功能與使用限制，不公開個別 Discord 使用者、伺服器名稱、頻道內容或私人對話。'],
        ['資料不足時', '當公開狀態資料不足或無法取得時，頁面會顯示未知或暫時無法確認，不會以猜測數字或狀態替代。'],
        ['更新方式', `公開內容可能隨功能調整而更新；本頁與政策彈窗會顯示相同政策文字與更新日期。${policyPublication.displayText}`],
      ],
    },
  ]);

  const FAQS = Object.freeze([
    { title: '如何邀請小吉？', keywords: ['邀請', 'bot', '機器人'], answer: '加入菇湯集團社群與邀請 Bot 到其他伺服器是不同流程。目前沒有公開的 Bot OAuth 入口。', needsGmail: true },
    { title: '人工使用授權是什麼？', keywords: ['授權', '人工', '使用'], answer: '部分功能取決於服務設定與 Discord 權限；需要人工確認使用資格時，請提供最少的必要資訊。', needsGmail: true },
    { title: 'AI 為什麼沒有回覆？', keywords: ['ai', '聊天', '429', '額度', '限制'], answer: 'AI 回覆可能受服務狀態、速率或額度限制影響。遇到 429 或額度限制時，小吉會回覆「小吉有點累了，請稍後再跟我聊天」。' },
    { title: '功能或遊戲無法使用怎麼辦？', keywords: ['無法', '壞', '錯誤', '不能', '狀態', '遊戲'], answer: '請先確認所在伺服器可使用小吉、具備該功能所需權限，並查看狀態頁是否顯示未知或異常。所有新遊戲都在 Discord 使用 /board start；面板遺失或要查看現存遊戲時，在同一頻道使用 /board status。新局不從官網建立，舊網頁局只保留給既有過渡流程。', needsGmail: true },
    { title: '如何詢問或刪除個人資料？', keywords: ['隱私', '刪除', '資料', '記憶'], answer: '個人記憶僅供本人查詢。若要詢問資料、要求刪除或回報隱私疑慮，請使用 Gmail 聯繫。', needsGmail: true },
    { title: '如何領取或取消關注？', keywords: ['領取', '取消', '關注', '訂閱'], answer: '官網沒有追蹤或訂閱功能，因此沒有需要取消的網站關注；Discord 功能請依對應指令操作。' },
    { title: '其他問題', keywords: [], answer: '這個頁面只提供本機自助說明，無法判定你的問題。', needsGmail: true },
  ]);

  let modal;
  let modalBody;
  let modalTitle;
  let lastOpener = null;
  let activeConversation = null;
  let supportStarted = false;
  const supportHistory = [];

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeGmailLink() {
    const gmail = make('a', 'support-inline-gmail', '用 Gmail 聯繫');
    gmail.href = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(CONTACT_EMAIL)}&su=${encodeURIComponent(CONTACT_SUBJECT)}`;
    gmail.target = '_blank';
    gmail.rel = 'noopener noreferrer';
    return gmail;
  }

  function makeFooterIcon(href, label, imageSource) {
    const link = make('a', 'footer-icon-button');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', label);
    const image = document.createElement('img');
    image.src = imageSource;
    image.alt = '';
    image.width = 24;
    image.height = 24;
    link.append(image);
    return link;
  }

  function refreshFooterLinks() {
    document.querySelectorAll('[data-support-footer-links]').forEach((container) => {
      const terms = make('a', '', '使用者政策');
      terms.href = '/policies.html#terms';
      const privacy = make('a', '', '隱私權政策');
      privacy.href = '/policies.html#privacy';
      const publicData = make('a', '', '公開資料聲明');
      publicData.href = '/policies.html#public-data';
      const discord = makeFooterIcon(
        'https://discord.gg/TqkCx9kYmk',
        '加入菇湯集團 Discord',
        'https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/66e3d718355f9c89eb0fd350_Logo.svg',
      );
      const gmail = makeFooterIcon(
        `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(CONTACT_EMAIL)}&su=${encodeURIComponent(CONTACT_SUBJECT)}`,
        '用 Gmail 撰寫小吉服務詢問',
        'https://www.gstatic.com/marketing-cms/assets/images/60/db/3a25579a4b0d87c2a1bfa95c609d/gmail.webp=s80-fcrop64=1,00000000ffffffff-rw',
      );
      container.replaceChildren(terms, privacy, publicData, discord, gmail);
    });
  }

  function focusModal() {
    window.setTimeout(() => modal?.querySelector('button, a, textarea')?.focus(), 0);
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    modal.querySelector('.support-dialog')?.classList.remove('is-policy');
    document.body.classList.remove('support-modal-open');
    lastOpener?.focus?.();
    lastOpener = null;
  }

  // Each policy opens in its own dialog that reads like an Arch Wiki page: numbered headings and, beside them,
  // a numbered table of contents that follows the reader and marks the heading being read.
  function smoothScroll() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  }

  function policyHeadingId(section, blockIndex) {
    return `policy-${section.id}-${blockIndex + 1}`;
  }

  function buildPolicyToc(section, onPick) {
    const nav = make('nav', 'policy-toc');
    nav.setAttribute('aria-label', `${section.title}目錄`);
    const toggle = make('button', 'policy-toc-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const current = make('span', 'policy-toc-current', section.blocks[0]?.[0] || '');
    toggle.append(make('span', 'policy-toc-label', '目錄'), current);
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    const list = make('ol', 'policy-toc-list');
    section.blocks.forEach(([heading], blockIndex) => {
      const item = make('li');
      const link = make('a', 'policy-toc-link', `${blockIndex + 1}　${heading}`);
      link.href = `#${policyHeadingId(section, blockIndex)}`;
      link.dataset.target = policyHeadingId(section, blockIndex);
      item.append(link);
      list.append(item);
    });
    list.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-target]');
      if (!link) return;
      event.preventDefault();
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      onPick(link.dataset.target);
    });
    nav.append(toggle, list);
    return { nav, current };
  }

  function buildPolicyDocument(section) {
    const article = make('article', 'policy-document');
    article.append(make('p', 'policy-updated', policyPublication.displayText), make('p', 'support-policy-lead', section.summary));
    section.blocks.forEach(([heading, text], blockIndex) => {
      const block = make('section', 'policy-block');
      const blockTitle = make('h3', '', `${blockIndex + 1}　${heading}`);
      blockTitle.id = policyHeadingId(section, blockIndex);
      block.append(blockTitle, make('p', '', text));
      article.append(block);
    });
    article.append(make('p', 'policy-contact', `聯繫方式：${CONTACT_EMAIL}（主旨：${CONTACT_SUBJECT}）`));
    return article;
  }

  // Marks, in a table of contents, the last heading that has scrolled past the top of scrollRoot (the
  // element that scrolls, or the window) and reports it to onChange.
  function followHeadings({ scrollRoot, headings, nav, onChange }) {
    const links = new Map([...nav.querySelectorAll('a[data-target]')].map((link) => [link.dataset.target, link]));
    let frame = 0;
    let active = null;
    function update() {
      frame = 0;
      const top = scrollRoot === window ? 0 : scrollRoot.getBoundingClientRect().top;
      const atEnd = scrollRoot === window
        ? window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
        : scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2;
      let current = headings[0];
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top - top <= 96) current = heading;
      }
      if (atEnd) current = headings.at(-1);
      if (!current || current === active) return;
      active = current;
      links.forEach((link) => { link.classList.remove('is-active'); link.removeAttribute('aria-current'); });
      const link = links.get(current.id);
      if (link) {
        link.classList.add('is-active');
        link.setAttribute('aria-current', 'location');
        const list = nav.querySelector('.policy-toc-list');
        const linkTop = link.offsetTop - list.offsetTop;
        if (linkTop < list.scrollTop + 24 || linkTop > list.scrollTop + list.clientHeight - 48) {
          list.scrollTo({ top: Math.max(0, linkTop - list.clientHeight / 3), behavior: smoothScroll() });
        }
      }
      onChange?.(current);
    }
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    (scrollRoot === window ? window : scrollRoot).addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    update();
    return { refresh: update };
  }

  function renderPolicy(sectionId) {
    const section = POLICY_SECTIONS.find((item) => item.id === sectionId) || POLICY_SECTIONS[0];
    modal.querySelector('.support-dialog').classList.add('is-policy');
    modalTitle.textContent = section.title;
    modalBody.replaceChildren();
    const layout = make('div', 'policy-viewer');
    const content = make('div', 'policy-viewer-content');
    content.tabIndex = -1;
    const { nav, current } = buildPolicyToc(section, (id) => {
      const target = content.querySelector(`#${CSS.escape(id)}`);
      if (target) content.scrollBy({ top: target.getBoundingClientRect().top - content.getBoundingClientRect().top - 8, behavior: smoothScroll() });
    });
    content.append(buildPolicyDocument(section));
    layout.append(nav, content);
    modalBody.append(layout);
    content.scrollTop = 0;
    followHeadings({
      scrollRoot: content,
      headings: [...content.querySelectorAll('h3[id]')],
      nav,
      onChange: (heading) => { current.textContent = heading.textContent; },
    });
    focusModal();
  }

  // Footer and page links to the policies open the policy dialog instead of leaving the page; the links keep
  // pointing at /policies.html so they still work without scripts.
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href^="/policies.html#"], a[href^="./policies.html#"], a[href^="policies.html#"]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const id = link.getAttribute('href').split('#')[1];
    if (!POLICY_SECTIONS.some((section) => section.id === id)) return;
    event.preventDefault();
    openPolicy(id, link);
  });

  // Each policy is read in its own dialog over the page the reader is on; closing it leaves them there. The
  // policies page is only the version for browsers without scripts: with scripts it sends the reader to the
  // home page with that policy's dialog open (/policies.html#privacy opens the privacy policy).
  function enhancePolicyPage() {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('policy');
    if (document.querySelector('main .policy-page-section')) {
      const hash = window.location.hash.slice(1);
      const target = POLICY_SECTIONS.some((section) => section.id === hash) ? `/index.html?policy=${hash}` : '/index.html';
      window.location.replace(target);
      return;
    }
    if (!POLICY_SECTIONS.some((section) => section.id === requested)) return;
    params.delete('policy');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    openPolicy(requested, document.body);
  }

  function renderMessage(conversation, entry) {
    const bubble = make('div', `support-bubble ${entry.side}`);
    bubble.append(make('p', '', entry.text));
    if (entry.needsGmail) bubble.append(makeGmailLink());
    conversation.append(bubble);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function appendHistory(side, text, needsGmail = false) {
    const entry = { side, text, needsGmail };
    supportHistory.push(entry);
    if (activeConversation) renderMessage(activeConversation, entry);
  }

  function beginSupportConversation() {
    if (supportStarted) return;
    supportStarted = true;
    activeConversation?.querySelector('.support-intro')?.remove();
  }

  // The AI support of the status worker (cloudflare/status-worker/src/support.mjs). Any failure (no worker address, the
  // worker or Claude unavailable, a limit reached) falls back to the self-help answers below.
  function supportEndpoint() {
    const base = document.querySelector('meta[name="xiaoji-api-base"]')?.content?.trim();
    return base ? `${base.replace(/\/+$/u, '')}/api/public/support` : null;
  }

  async function askAiSupport(question) {
    const endpoint = supportEndpoint();
    if (!endpoint || typeof fetch !== 'function') return null;
    const history = supportHistory.slice(-7, -1).map((entry) => ({
      role: entry.side === 'user' ? 'user' : 'assistant', text: entry.text,
    }));
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 25_000) : null;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ question, history }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.status === 429) return { answer: '問題有點多，小吉客服需要休息一下，請稍後再問，或直接寫信給開發者。', needsEmail: true };
      if (!response.ok) return null;
      const payload = await response.json();
      return typeof payload?.answer === 'string' && payload.answer ? { answer: payload.answer, needsEmail: Boolean(payload.needsEmail) } : null;
    } catch (_error) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function matchingFaq(value) {
    const normalized = value.toLowerCase();
    return FAQS.find((faq) => faq.keywords.some((keyword) => normalized.includes(keyword))) || FAQS.at(-1);
  }

  function answerFaq(faq) {
    beginSupportConversation();
    appendHistory('user', faq.title);
    appendHistory('agent', faq.answer, Boolean(faq.needsGmail));
  }

  function createIntro() {
    const intro = make('div', 'support-bubble agent support-intro');
    intro.append(make('p', '', '你好，我是小吉的客服。可以直接輸入問題（由 AI 回答），或先看看下面的常見問題。'));
    const options = make('div', 'support-faq-options');
    FAQS.forEach((faq) => {
      const button = make('button', 'support-faq-button', faq.title);
      button.type = 'button';
      button.addEventListener('click', () => answerFaq(faq));
      options.append(button);
    });
    intro.append(options);
    return intro;
  }

  function renderSupport() {
    modal.querySelector('.support-dialog')?.classList.remove('is-policy');
    modalTitle.textContent = '小吉自助客服';
    modalBody.replaceChildren();
    const conversation = make('div', 'support-conversation');
    conversation.setAttribute('aria-live', 'polite');
    activeConversation = conversation;
    if (!supportStarted) conversation.append(createIntro());
    supportHistory.forEach((entry) => renderMessage(conversation, entry));

    const form = make('form', 'support-form');
    const input = make('textarea', 'support-input');
    input.name = 'support-query';
    input.maxLength = 500;
    input.rows = 3;
    input.placeholder = '輸入你的問題（最多 500 字）';
    input.setAttribute('aria-label', '小吉自助客服查詢');
    const send = make('button', 'support-send-button', '送出');
    send.type = 'submit';
    form.append(input, send);

    let asking = false;
    const submitQuery = async () => {
      const value = input.value.trim();
      if (!value || asking) return;
      asking = true;
      send.disabled = true;
      beginSupportConversation();
      appendHistory('user', value);
      input.value = '';
      const waiting = make('div', 'support-bubble agent support-waiting', '小吉思考中…');
      activeConversation?.append(waiting);
      const ai = await askAiSupport(value);
      waiting.remove();
      if (ai) {
        appendHistory('agent', ai.answer, ai.needsEmail);
      } else {
        const faq = matchingFaq(value);
        appendHistory('agent', faq.answer, Boolean(faq.needsGmail));
      }
      asking = false;
      send.disabled = false;
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); submitQuery(); });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      submitQuery();
    });
    modalBody.append(conversation, form);
    focusModal();
  }

  function createModal() {
    modal = make('div', 'support-modal');
    modal.hidden = true;
    const dialog = make('section', 'support-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'support-modal-title');
    const header = make('header', 'support-dialog-header');
    modalTitle = make('h2', '', '小吉自助客服');
    modalTitle.id = 'support-modal-title';
    const close = make('button', 'support-close-button', '關閉');
    close.type = 'button';
    close.addEventListener('click', closeModal);
    header.append(modalTitle, close);
    modalBody = make('div', 'support-dialog-body');
    dialog.append(header, modalBody);
    modal.append(dialog);
    modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
    modal.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = [...modal.querySelectorAll('button:not([disabled]), a[href], textarea:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.body.append(modal);
  }

  function openSupport(opener) {
    if (!modal) createModal();
    lastOpener = opener || document.activeElement;
    modal.hidden = false;
    document.body.classList.add('support-modal-open');
    renderSupport();
  }

  function openPolicy(sectionId, opener) {
    if (!modal) createModal();
    lastOpener = opener || document.activeElement;
    modal.hidden = false;
    document.body.classList.add('support-modal-open');
    renderPolicy(sectionId);
  }

  // The support button doubles as 小吉's companion: a small portrait with a speech bubble that the
  // page fills as the reader moves between sections (siteChrome.js calls say()). The bubble only
  // repeats what the page already shows, so screen readers skip it.
  let companionBubble = null;
  let companionTimer = null;

  function addLaunchButton() {
    const companion = make('div', 'support-companion');
    companionBubble = make('p', 'support-companion-bubble');
    companionBubble.setAttribute('aria-hidden', 'true');
    companionBubble.hidden = true;
    const launch = make('button', 'support-launch-button');
    launch.type = 'button';
    launch.setAttribute('aria-haspopup', 'dialog');
    const avatar = document.createElement('img');
    avatar.className = 'support-launch-avatar';
    avatar.src = '/assets/xiaoji-hero.png';
    avatar.alt = '';
    avatar.width = 40;
    avatar.height = 40;
    launch.append(avatar, make('span', 'support-launch-label', '小吉自助客服'));
    launch.addEventListener('click', () => openSupport(launch));
    companion.append(companionBubble, launch);
    document.body.append(companion);
  }

  function say(text) {
    if (!companionBubble || !text || (modal && !modal.hidden)) return;
    companionBubble.textContent = String(text).slice(0, 60);
    companionBubble.hidden = false;
    companionBubble.classList.remove('is-showing');
    void companionBubble.offsetWidth;
    companionBubble.classList.add('is-showing');
    window.clearTimeout(companionTimer);
    companionTimer = window.setTimeout(() => {
      companionBubble.classList.remove('is-showing');
      companionBubble.hidden = true;
    }, 5200);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal && !modal.hidden) closeModal();
  });
  document.querySelectorAll('[data-current-year]').forEach((node) => { node.textContent = String(new Date().getFullYear()); });
  refreshFooterLinks();
  addLaunchButton();
  enhancePolicyPage();
  window.XiaojiSiteSupport = Object.freeze({ openSupport, openPolicy, say, POLICY_SECTIONS });
})();
