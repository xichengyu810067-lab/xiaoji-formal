(function bootstrapSiteSupport() {
  'use strict';

  const CONTACT_EMAIL = 'xichengyu810067@gmail.com';
  const CONTACT_SUBJECT = '小吉服務詢問';
  // Keep the verified community invite in this one place. Leave blank until an
  // invitation has been created and checked; a blank value never renders a link.
  const COMMUNITY_INVITE_URL = 'https://discord.gg/TqkCx9kYmk';
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
        ['可能處理的資料', '依你使用的功能，小吉可能處理 Discord 提供的帳號識別、顯示名稱、訊息或互動內容、偏好設定、伺服器與頻道脈絡，以及遊戲或功能操作所需資料。請勿在公開頻道或客服欄位輸入密碼、權杖、付款資訊或其他敏感資料。'],
        ['記憶與可見性', '在已通過審核的伺服器中，非機器人、非系統的公開頻道文字訊息可能被記錄為公開頻道記憶，即使未提及小吉；跨頻道查找仍須伺服器明確開啟分享設定。個人記憶僅供本人查詢。不同資料類型依功能需要採用不同保存與清理規則；小吉不宣稱所有記憶都會在 30 天後自動刪除。'],
        ['第三方連線', 'Discord 與依功能啟用的服務供應商可能各自處理必要資料。網站也會載入 Google Fonts 等第三方資源；這些服務的資料處理適用其自身政策。'],
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
        ['更新方式', '公開內容可能隨功能調整而更新；本頁與政策彈窗會顯示相同政策文字與更新日期。'],
      ],
    },
  ]);

  const FAQS = Object.freeze([
    { title: '如何邀請小吉？', keywords: ['邀請', 'bot', '機器人'], answer: '目前沒有可核實的 Bot 邀請連結，因此不提供未驗證的 OAuth 入口。請寄信說明想使用的伺服器與需求，小吉團隊會回覆可用方式。' },
    { title: '人工使用授權是什麼？', keywords: ['授權', '人工', '使用'], answer: '部分功能的可用性取決於服務設定與 Discord 權限。需要人工協助確認使用資格時，請用「小吉服務詢問」寄信，勿附上聊天內容、網址片段或任何權杖。' },
    { title: 'AI 為什麼沒有回覆？', keywords: ['ai', '聊天', '429', '額度', '限制'], answer: 'AI 回覆受服務狀態與速率限制影響，並不保證每次都可用。遇到 429 或額度限制時，小吉會回覆「小吉有點累了，請稍後再跟我聊天」。' },
    { title: '功能無法使用怎麼辦？', keywords: ['無法', '壞', '錯誤', '不能', '狀態'], answer: '先確認你在可使用的 Discord 伺服器、具備該功能需要的權限，並查看狀態頁是否顯示未知或異常。仍無法使用時，可寄信描述時間、功能名稱與不含敏感資料的錯誤摘要。' },
    { title: '如何詢問或刪除個人資料？', keywords: ['隱私', '刪除', '資料', '記憶'], answer: '個人記憶僅供本人查詢；若要詢問資料或要求刪除，請使用下方 Email 聯繫。請勿直接貼出私人對話、密碼、權杖或其他敏感資訊。' },
    { title: '如何領取或取消關注？', keywords: ['領取', '取消', '關注', '訂閱'], answer: '官網目前沒有追蹤或訂閱功能，因此沒有需要取消的網站關注。吉幣、每日簽到或定存等功能請在 Discord 依對應指令操作；不確定時可使用 Email 詢問。' },
    { title: '其他問題', keywords: [], answer: '這個文字客服只提供本機自助說明，不會連線到 AI 或後端，也不會保存你的輸入。若問題尚未解決，請使用下方 Email 聯繫。' },
  ]);

  let modal;
  let modalBody;
  let modalTitle;
  let lastOpener = null;
  let supportView = 'support';

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function policyUrl(id) {
    return `/policies.html#${id}`;
  }

  function makeContactLinks(className = '') {
    const group = make('div', className);
    const gmail = make('a', 'support-contact-link', '用 Gmail 撰寫');
    gmail.href = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(CONTACT_EMAIL)}&su=${encodeURIComponent(CONTACT_SUBJECT)}`;
    gmail.target = '_blank';
    gmail.rel = 'noopener noreferrer';
    const mailto = make('a', 'support-contact-link', '使用預設信箱');
    mailto.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_SUBJECT)}`;
    const copy = make('button', 'support-contact-link', '複製 Email');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(CONTACT_EMAIL);
        copy.textContent = '已複製 Email';
      } catch {
        copy.textContent = CONTACT_EMAIL;
      }
    });
    group.append(gmail, mailto, copy);
    return group;
  }

  function buildPolicyContent(section) {
    const fragment = document.createDocumentFragment();
    const updated = make('p', 'policy-updated', '最後更新：2026 年 9 月 23 日');
    fragment.append(updated);
    section.blocks.forEach(([heading, text]) => {
      const block = make('section', 'policy-block');
      block.append(make('h3', '', heading), make('p', '', text));
      fragment.append(block);
    });
    const contact = make('p', 'policy-contact', `聯繫方式：${CONTACT_EMAIL}（主旨：${CONTACT_SUBJECT}）`);
    fragment.append(contact);
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
    supportView = 'policy';
    modalTitle.textContent = section.title;
    modalBody.replaceChildren();
    const lead = make('p', 'support-lead', section.summary);
    const policy = make('div', 'policy-modal-content');
    policy.append(buildPolicyContent(section));
    const back = make('button', 'support-secondary-button', '返回文字客服');
    back.type = 'button';
    back.addEventListener('click', renderSupport);
    modalBody.append(lead, policy, back);
    focusModal();
  }

  function appendBubble(conversation, side, text) {
    const bubble = make('p', `support-bubble ${side}`, text);
    conversation.append(bubble);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function matchingFaqs(value) {
    const normalized = value.toLowerCase();
    const matches = FAQS.filter((faq) => faq.keywords.some((keyword) => normalized.includes(keyword)));
    return matches.length ? matches.slice(0, 3) : [FAQS.at(-1)];
  }

  function renderSupport() {
    supportView = 'support';
    modalTitle.textContent = '文字客服';
    modalBody.replaceChildren();
    const selfService = make('p', 'support-self-service', '自助說明｜不連線到 AI 或後端，也不保存輸入內容');
    const lead = make('p', 'support-lead', '選擇常見問題，或輸入最多 500 字的文字查詢。未解決的問題可用 Email 聯繫。');
    const quick = make('div', 'support-quick-questions');
    const conversation = make('div', 'support-conversation');
    conversation.setAttribute('aria-live', 'polite');
    appendBubble(conversation, 'agent', '你好，我是小吉的自助文字客服。想先了解哪一件事呢？');
    FAQS.slice(0, -1).forEach((faq) => {
      const button = make('button', 'support-faq-button', faq.title);
      button.type = 'button';
      button.addEventListener('click', () => {
        appendBubble(conversation, 'user', faq.title);
        appendBubble(conversation, 'agent', faq.answer);
      });
      quick.append(button);
    });
    const form = make('form', 'support-form');
    const input = make('textarea', 'support-input');
    input.name = 'support-query';
    input.maxLength = 500;
    input.rows = 3;
    input.placeholder = '輸入你的問題（最多 500 字）';
    input.setAttribute('aria-label', '文字客服查詢');
    const send = make('button', 'support-send-button', '送出');
    send.type = 'submit';
    form.append(input, send);
    const submitQuery = () => {
      const value = input.value.trim();
      if (!value) return;
      appendBubble(conversation, 'user', value);
      const matches = matchingFaqs(value);
      appendBubble(conversation, 'agent', matches[0].answer);
      if (matches.length > 1) {
        const choices = make('div', 'support-suggestions');
        choices.append(make('span', '', '你也可能想知道：'));
        matches.slice(1).forEach((faq) => {
          const button = make('button', 'support-faq-button', faq.title);
          button.type = 'button';
          button.addEventListener('click', () => appendBubble(conversation, 'agent', faq.answer));
          choices.append(button);
        });
        conversation.append(choices);
      }
      input.value = '';
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); submitQuery(); });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      submitQuery();
    });
    const contactTitle = make('h3', 'support-contact-title', '仍需要協助？');
    const contactNote = make('p', 'support-contact-note', `寄信時請使用固定主旨「${CONTACT_SUBJECT}」，不要附上聊天內容、網址片段或權杖。`);
    modalBody.append(selfService, lead, quick, conversation, form, contactTitle, contactNote, makeContactLinks('support-contact-actions'));
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
    modalTitle = make('h2', '', '文字客服');
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

  function appendFooterLinks() {
    document.querySelectorAll('[data-support-footer-links]').forEach((container) => {
      container.replaceChildren();
      POLICY_SECTIONS.forEach((section) => {
        const link = make('a', '', section.title);
        link.href = policyUrl(section.id);
        link.addEventListener('click', (event) => {
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            openPolicy(section.id, link);
          }
        });
        container.append(link);
      });
      const supportButton = make('button', 'footer-support-button', '文字客服');
      supportButton.type = 'button';
      supportButton.addEventListener('click', () => openSupport(supportButton));
      const email = make('a', '', CONTACT_EMAIL);
      email.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_SUBJECT)}`;
      const isVerifiedInvite = /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+\/?$/.test(COMMUNITY_INVITE_URL);
      if (isVerifiedInvite) {
        const community = make('a', '', '加入菇湯集團 Discord');
        community.href = COMMUNITY_INVITE_URL;
        community.target = '_blank';
        community.rel = 'noopener noreferrer';
        container.append(community);
      }
      container.append(supportButton, email);
    });
  }

  function addLaunchButton() {
    const launch = make('button', 'support-launch-button', '文字客服');
    launch.type = 'button';
    launch.setAttribute('aria-haspopup', 'dialog');
    launch.addEventListener('click', () => openSupport(launch));
    document.body.append(launch);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal && !modal.hidden) closeModal();
  });
  document.querySelectorAll('[data-current-year]').forEach((node) => { node.textContent = String(new Date().getFullYear()); });
  appendFooterLinks();
  addLaunchButton();
  window.XiaojiSiteSupport = Object.freeze({ openSupport, openPolicy, POLICY_SECTIONS });
})();
