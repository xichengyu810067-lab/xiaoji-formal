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
        ['AI 回覆', 'AI 回覆可能不完整或不正確，僅供一般互動參考。若 AI 服務暫時受到速率或額度限制，小吉會固定回覆「小吉有點累了，請稍後再跟我聊天」。'],
        ['服務異常', '功能可能因 Discord、網路、第三方服務或維護而暫時無法使用。請先查看狀態頁；仍無法排除時可透過下方聯繫方式說明情況。'],
      ],
    },
    {
      id: 'privacy',
      title: '隱私權政策',
      summary: '小吉只在提供功能、維持安全與回應使用者需求所需的範圍內處理資料。',
      blocks: [
        ['可能處理的資料', '依你使用的功能，小吉可能處理 Discord 提供的帳號識別、顯示名稱、訊息或互動內容、偏好設定、伺服器與頻道脈絡，以及遊戲或功能操作所需資料。與小吉 AI 的互動包含私訊；請勿在公開頻道、私訊或客服欄位輸入密碼、權杖、付款資訊或其他敏感資料。'],
        ['記憶與保存', '在已通過審核的伺服器中，非機器人、非系統的公開頻道文字訊息可能被記錄為公開頻道記憶，即使未提及小吉；跨頻道查找仍須伺服器明確開啟分享設定。資料沒有固定保存期限，會依服務目的、資料類型與本政策的刪除流程處理及刪除；小吉不宣稱所有記憶都會在 30 天後自動刪除，也不宣稱提供無限儲存容量。'],
        ['對話可見性', '為改善對話品質、維護服務及處理必要問題，小吉擁有者（原作者）可在職責範圍內查看與小吉的對話內容，包括符合前述條件的公開頻道記憶與私訊互動。這不表示對話會被用來訓練模型。'],
        ['第三方連線', 'Discord 與依功能啟用的服務供應商可能為提供、維護或保護服務而處理必要的對話與相關資料。網站也會載入 Google Fonts 等第三方資源；這些服務的資料處理適用其自身政策。'],
        ['查詢與刪除', '若要詢問個人資料、要求刪除或回報隱私疑慮，請寄信至 xichengyu810067@gmail.com，主旨使用「小吉服務詢問」，並只提供處理案件所需的最少資訊。'],
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
    { title: '功能或遊戲無法使用怎麼辦？', keywords: ['無法', '壞', '錯誤', '不能', '狀態', '遊戲'], answer: '請先確認所在伺服器可使用小吉、具備該功能所需權限，並查看狀態頁是否顯示未知或異常。個人遊戲請在 Discord 使用 /games menu 或 /games play，面板遺失可在同一頻道使用 /games resume；棋盤與推理遊戲使用 /board。新局不從官網建立，舊網頁局只保留給既有過渡流程。', needsGmail: true },
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

  function buildPolicyContent(section) {
    const fragment = document.createDocumentFragment();
    fragment.append(make('p', 'policy-updated', policyPublication.displayText));
    section.blocks.forEach(([heading, text]) => {
      const block = make('section', 'policy-block');
      block.append(make('h3', '', heading), make('p', '', text));
      fragment.append(block);
    });
    fragment.append(make('p', 'policy-contact', `聯繫方式：${CONTACT_EMAIL}（主旨：${CONTACT_SUBJECT}）`));
    return fragment;
  }

  function focusModal() {
    window.setTimeout(() => modal?.querySelector('button, a, textarea')?.focus(), 0);
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('support-modal-open');
    lastOpener?.focus?.();
    lastOpener = null;
  }

  function renderPolicy(sectionId) {
    const section = POLICY_SECTIONS.find((item) => item.id === sectionId) || POLICY_SECTIONS[0];
    modalTitle.textContent = section.title;
    modalBody.replaceChildren();
    const lead = make('p', 'support-policy-lead', section.summary);
    const policy = make('div', 'policy-modal-content');
    policy.append(buildPolicyContent(section));
    const back = make('button', 'support-secondary-button', '返回小吉自助客服');
    back.type = 'button';
    back.addEventListener('click', renderSupport);
    modalBody.append(lead, policy, back);
    focusModal();
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
    intro.append(make('p', '', '你好，我是小吉的自助客服。想先了解哪一件事呢？'));
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

    const submitQuery = () => {
      const value = input.value.trim();
      if (!value) return;
      beginSupportConversation();
      appendHistory('user', value);
      const faq = matchingFaq(value);
      appendHistory('agent', faq.answer, Boolean(faq.needsGmail));
      input.value = '';
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

  function addLaunchButton() {
    const launch = make('button', 'support-launch-button', '小吉自助客服');
    launch.type = 'button';
    launch.setAttribute('aria-haspopup', 'dialog');
    launch.addEventListener('click', () => openSupport(launch));
    document.body.append(launch);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal && !modal.hidden) closeModal();
  });
  document.querySelectorAll('[data-current-year]').forEach((node) => { node.textContent = String(new Date().getFullYear()); });
  refreshFooterLinks();
  addLaunchButton();
  window.XiaojiSiteSupport = Object.freeze({ openSupport, openPolicy, POLICY_SECTIONS });
})();
