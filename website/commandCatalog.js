(function exposeCommandCatalog(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XiaojiCommandCatalog = api;
})(typeof globalThis === 'object' ? globalThis : this, function createCommandCatalog() {
  'use strict';

  // Single official definition of every public slash command. The Discord builders in
  // src/commands own the options; this catalog owns identity, purpose and tombstones.
  // src/loadCommands.js checks the two against each other before deployment.

  // public: ordinary members can use at least part of the command.
  // admin: every path needs a server permission (Manage Server or Administrator).
  // owner: only the bot owner can use it. The public core ships no whole owner command: the owner-only
  // management commands come from the optional extension, deployed to the owner guild alone. An owner
  // audience is therefore only used for subcommands of public and admin commands (RESTRICTED_SUBCOMMANDS).
  // The list runs from the widest audience to the narrowest. A subcommand uses the same words and
  // may only narrow its command, so a command is as wide as its widest subcommand.
  const COMMAND_AUDIENCES = Object.freeze(['public', 'admin', 'owner']);

  const COMMAND_GROUPS = Object.freeze([
    ['general', '一般與個人化'],
    ['economy', '吉幣與遊戲'],
    ['community', '社群活動'],
  ].map(([id, title]) => Object.freeze({ id, title })));

  // name, description, group, audience, subcommands, listInHelp.
  // description must equal the Discord builder description.
  // subcommands lists every leaf; a subcommand inside a group is written "group sub".
  // A subcommand has its command's audience unless RESTRICTED_SUBCOMMANDS narrows it.
  // listInHelp defaults to false for owner commands and true for everything else.
  const commands = [
    // 一般與個人化
    ['ping', '確認小吉目前在線', 'general', 'public'],
    ['fortune', '抽一則小吉籤', 'general', 'public'],
    ['roll', '擲骰子', 'general', 'public'],
    ['weather', '查詢天氣', 'general', 'public'],
    ['poll', '建立按鈕投票', 'general', 'public'],
    ['remind', '管理提醒', 'general', 'public', ['add', 'list', 'delete']],
    ['calendar', '管理自己的跨伺服器個人行事曆', 'general', 'public', ['add', 'list', 'delete']],
    ['set-welcome', '設定新人歡迎頻道', 'general', 'admin'],
    ['release-announcements', '設定小吉正式 GitHub Release 公告頻道', 'general', 'admin', ['set', 'status']],
    ['server', '顯示目前伺服器資訊', 'general', 'public'],
    ['status', '顯示小吉目前狀態', 'general', 'public'],
    ['chat-style', '查看或變更小吉與你的對話風格', 'general', 'public', ['current', 'set']],
    ['romance', '管理小吉與你的跨伺服器文字戀愛模式', 'general', 'public', ['start', 'stop', 'status']],
    ['about', '顯示小吉的公開資訊', 'general', 'public'],
    ['help', '列出小吉可用指令', 'general', 'public'],

    // 吉幣與遊戲
    ['coins', '查詢自己的吉幣餘額', 'economy', 'public'],
    ['daily', '每日簽到領取吉幣', 'economy', 'public'],
    ['leaderboard', '查看吉幣餘額或總資產排行榜', 'economy', 'public'],
    ['shop', '吉幣商店與購買紀錄', 'economy', 'public', ['list', 'buy', 'purchases', 'purchases-user', 'purchases-all']],
    ['inventory', '查看自己的吉幣背包', 'economy', 'public'],
    ['work', '小吉工作賺取吉幣系統', 'economy', 'public', [
      'list', 'start', 'start-venue', 'status', 'status-user', 'status-all', 'cancel', 'submit', 'submissions',
      'edit', 'delete', 'report', 'task-add', 'tasks', 'tasks-all', 'pending', 'review', 'admin-remind',
      'role-sync', 'payroll-preview', 'payroll-history', 'payroll', 'penalties', 'appeal', 'appeal-review',
    ]],
    ['bank', '小吉銀行：活存、定存與利率', 'economy', 'public', [
      'balance', 'balance-user', 'balance-all', 'deposit', 'withdraw', 'interest', 'fixed-create', 'fixed-list',
      'fixed-user', 'fixed-all', 'fixed-claim', 'fixed-cancel', 'fixed-rates', 'rate-list', 'rate-set-demand',
      'rate-set-fixed', 'rate-history',
    ]],
    ['exchange', '籌碼與吉幣兌換區', 'economy', 'public', ['balance', 'buy-chips', 'cashout', 'history']],
    ['casino-lobby', '查看小吉賭場大廳、下注區與住宿', 'economy', 'public', ['guide', 'betting-area', 'stay', 'stays']],
    ['duel-tower', '決鬥塔台的武器、進度與紀錄；開局請用 /board start', 'economy', 'public', ['weapons', 'profile', 'history']],
    ['casino', '賭場借款與紀錄；開局請用 /board start', 'economy', 'public', ['loan-borrow', 'loan-repay', 'loan-status', 'history']],
    ['casino-venue', '小吉賭場餐廳與吧檯服務', 'economy', 'public', [
      'menu', 'add-menu', 'delete-menu', 'order', 'recipe', 'make', 'serve', 'reassign', 'reassign-waiter',
      'cancel', 'history',
    ]],
    ['luxury', '奢侈品商店街', 'economy', 'public', ['list', 'buy', 'inventory', 'history']],
    ['pawn', '奢侈品當鋪', 'economy', 'public', ['quote', 'sell', 'active', 'redeem', 'history']],
    ['board', '小吉的統一遊戲入口', 'economy', 'public', ['start', 'join', 'leave', 'status', 'stop']],
    ['economy', '吉幣經濟總覽與紀錄查詢', 'economy', 'admin', ['overview', 'user', 'audit']],
    ['coin-admin', '管理吉幣系統（全域錢包變更限小吉擁有者）', 'economy', 'admin', [
      'add', 'remove', 'set', 'history', 'reset-user', 'enable', 'disable',
    ]],

    // 社群活動
    ['word-chain', '管理小吉文字接龍', 'community', 'admin', ['stop', 'status']],
    ['number-chain', '管理小吉安全數字接龍', 'community', 'admin', ['stop', 'status']],
    ['daily-riddle', '管理小吉每日猜謎', 'community', 'admin', ['enable', 'disable', 'status']],
    ['daily-discussion', '管理小吉每日議題討論', 'community', 'admin', ['enable', 'disable', 'status', 'run-now']],
  ];

  // Subcommands that need more than their command does, written as command -> audience -> names.
  // Every subcommand that is not listed here has the audience of its command. The permission
  // checks inside src/commands are the source of truth; test/subcommandAccess.test.js runs those
  // checks against these marks, and test/commandCatalog.test.js pins the list.
  const RESTRICTED_SUBCOMMANDS = {
    shop: { admin: ['purchases-user', 'purchases-all'] },
    work: {
      admin: [
        'status-user', 'status-all', 'task-add', 'tasks-all', 'pending', 'review', 'admin-remind',
        'role-sync', 'payroll-preview', 'payroll-history',
      ],
      owner: ['appeal-review'],
    },
    bank: {
      admin: ['balance-user', 'balance-all', 'fixed-user', 'fixed-all', 'rate-history'],
      owner: ['rate-set-demand', 'rate-set-fixed'],
    },
    'casino-venue': { admin: ['delete-menu', 'reassign', 'reassign-waiter', 'cancel'] },
    // history stays admin: only its campaign flow (history with campaign-id) needs the owner.
    'coin-admin': { owner: ['add', 'remove', 'set', 'reset-user'] },
  };

  // Turns the written form into the flat map each entry carries: subcommand -> audience.
  function markSubcommands(name) {
    const marks = {};
    const restricted = RESTRICTED_SUBCOMMANDS[name] || {};
    for (const audience of Object.keys(restricted)) {
      for (const subcommand of restricted[audience]) marks[subcommand] = audience;
    }
    return Object.freeze(marks);
  }

  const COMMAND_CATALOG = Object.freeze(commands.map(
    ([name, description, group, audience, subcommands = [], listInHelp = audience !== 'owner']) =>
      Object.freeze({
        name,
        description,
        group,
        audience,
        listInHelp,
        subcommands: Object.freeze([...subcommands]),
        subcommandAudiences: markSubcommands(name),
      }),
  ));
  const COMMAND_BY_NAME = new Map(COMMAND_CATALOG.map((command) => [command.name, command]));

  // Commands whose purposes overlap. This only declares them; nothing is removed here.
  // Each entry is [id, members, note]; members are command names or "command subcommand" paths.
  // The purchase, leaderboard and quota overlaps were resolved (see REMOVED_COMMANDS), so none is
  // declared now. Paths that share a description must be declared here until one is removed.
  const aliases = [];
  const COMMAND_ALIASES = Object.freeze(
    aliases.map(([id, members, note]) => Object.freeze({ id, members: Object.freeze(members), note })),
  );

  // Tombstones: paths that no longer exist and must not come back in a builder, the
  // catalog or the help output. A bare name is a whole command; "command sub" is one
  // subcommand. The game entries mirror LEGACY_GAME_STARTS in gameCatalog.js.
  const REMOVED_COMMANDS = Object.freeze([
    // /games was replaced by the unified /board entry.
    'games', 'games menu', 'games play', 'games resume',
    // Per-game start entries were replaced by /board start.
    'casino dice', 'casino slots', 'casino blackjack', 'casino roulette', 'casino baccarat', 'casino poker',
    'duel-tower enter', 'word-chain start', 'number-chain start',
    // The owner coin campaign flow was folded into coin-admin add and history.
    'coin-admin campaign-preview', 'coin-admin campaign-apply',
    'coin-admin campaign-history-plan', 'coin-admin campaign-history-review',
    'coin-admin campaign-history-classify', 'coin-admin campaign-history-import',
    // The personal calendar became the only calendar flow.
    'calendar personal-add', 'calendar personal-list', 'calendar personal-delete',
    // /shop buy is the only purchase entry.
    'buy',
    // The assets leaderboard became /leaderboard with type assets.
    'economy leaderboard',
    // The separate quota commands were folded into one owner command.
    'quota-list', 'quota-reset', 'quota-set',
  ]);

  function getCommand(name) {
    return COMMAND_BY_NAME.get(String(name || '')) || null;
  }

  // The audience that can use one subcommand: its own mark, otherwise its command's audience.
  // Works on any entry shaped like a catalog entry, so drafts and clones can use it too.
  function getSubcommandAudience(command, subcommand) {
    if (!command) return null;
    const marks = command.subcommandAudiences;
    if (marks && Object.prototype.hasOwnProperty.call(marks, subcommand)) return marks[subcommand];
    return command.audience;
  }

  // The subcommands of one command that belong to one audience, in catalog order.
  function listSubcommands(command, audience) {
    const subcommands = command && Array.isArray(command.subcommands) ? command.subcommands : [];
    return subcommands.filter((subcommand) => getSubcommandAudience(command, subcommand) === audience);
  }

  return Object.freeze({
    COMMAND_ALIASES,
    COMMAND_AUDIENCES,
    COMMAND_CATALOG,
    COMMAND_GROUPS,
    REMOVED_COMMANDS,
    getCommand,
    getSubcommandAudience,
    listSubcommands,
  });
});
