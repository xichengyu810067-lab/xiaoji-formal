const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { BoardCoreError, BoardRuleError } = require('../core/contracts');
const { buildBoardCustomId } = require('../discord/boardCustomId');
const engine = require('../engines/werewolf');
const {
  AUTO_SETUPS,
  GOD_ROLES,
  MAX_WOLVES,
  PACES,
  PACE_ORDER,
  ROLE_LABELS,
  ROLE_TIPS,
  WIN_MODES,
  WIN_ORDER,
  describeSetup,
  nextInOrder,
  resolveRoleSetup,
} = require('./rules');
const { defaultGodsFor, lobbySettings } = require('./werewolfPresentation');

// Every werewolf button and menu is answered in a reply only the presser sees. Panel buttons open a new private
// reply; menus inside that reply update it in place. Secret facts (roles, the wolves' choice, seer results) only ever
// leave this module through those private replies.

const PANEL_VERBS = new Set(['act.role', 'act.action', 'act.ready', 'act.start-vote']);
const LOBBY_TOGGLE_VERBS = new Set(['ww.pace', 'ww.win', 'ww.reveal']);
const ROLE_SETUP_VERBS = new Set(['ww.roles', 'ww.cfg-wolves', 'ww.cfg-gods', 'ww.cfg-auto']);
const ACTION_VERBS = Object.freeze({
  'ww.kill': (values) => ({ type: 'night-kill', targetId: values[0] }),
  'ww.kill-none': () => ({ type: 'night-kill', targetId: null }),
  'ww.check': (values) => ({ type: 'night-check', targetId: values[0] }),
  'ww.guard': (values) => ({ type: 'night-guard', targetId: values[0] }),
  'ww.guard-none': () => ({ type: 'night-guard', targetId: null }),
  'ww.save': () => ({ type: 'witch', choice: 'save' }),
  'ww.poison': (values) => ({ type: 'witch', choice: 'poison', targetId: values[0] }),
  'ww.skip': () => ({ type: 'witch', choice: 'skip' }),
  'ww.vote': (values) => ({ type: 'vote', targetId: values[0] }),
  'ww.vote-none': () => ({ type: 'vote', targetId: null }),
  'ww.shoot': (values) => ({ type: 'hunter-shoot', targetId: values[0] }),
  'ww.shoot-none': () => ({ type: 'hunter-shoot', targetId: null }),
});

const BUTTON_STYLES = Object.freeze({
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
});

function isWerewolfVerb(verb) {
  const value = String(verb || '');
  return PANEL_VERBS.has(value) || value.startsWith('ww.');
}

function teamLabel(role) {
  return role === 'wolf' ? '狼人陣營' : '好人陣營';
}

function seatName(names, seatEntry) {
  return `${seatEntry.seat}號 ${names.get(seatEntry.id) || '玩家'}`;
}

function targetOptions(view, names, { exclude = [], mark = new Map(), selected = null } = {}) {
  return view.targets
    .filter((entry) => !exclude.includes(entry.id))
    .map((entry) => ({
      label: seatName(names, entry).slice(0, 100),
      value: entry.id,
      ...(mark.has(entry.id) ? { description: mark.get(entry.id) } : {}),
      ...(selected === entry.id ? { default: true } : {}),
    }));
}

function select(customId, placeholder, options, { minValues = 1, maxValues = 1 } = {}) {
  return { type: 'select', customId, placeholder, options, minValues, maxValues };
}

function buttonRow(...buttons) {
  return { type: 'buttons', buttons: buttons.filter(Boolean) };
}

function idFor(sessionId, revision, verb) {
  return buildBoardCustomId({ sessionId, revision, verb });
}

function seatLabelFor(stateView, names, id) {
  if (id == null) return '空';
  const entry = stateView.players.find((item) => item.id === id) || null;
  return entry ? `${entry.seat}號 ${names.get(id) || '玩家'}` : '已出局的玩家';
}

// The private action menu for the viewer's role in the current phase.
function buildActionMenu({ sessionId, view, names, seats, notice = '' }) {
  const rows = [];
  const lines = notice ? [notice, ''] : [];
  const serial = view?.phaseSerial ?? 0;
  const custom = (verb) => idFor(sessionId, serial, verb);
  const seatText = (id) => seatLabelFor({ players: seats }, names, id);
  if (!view) return { content: '你不是這局狼人殺的玩家。', rows };
  if (view.phase === 'ended') return { content: [...lines, '這局狼人殺已經結束。'].join('\n'), rows };
  if (!view.alive && !view.hunterTurn) {
    return { content: [...lines, '你已經出局，請保持安靜觀戰。可以按「查看身分」回顧自己的角色。'].join('\n'), rows };
  }

  if (view.phase === 'night') {
    if (view.role === 'wolf') {
      const teammates = new Map(view.teammates.map((entry) => [entry.id, '狼隊友']));
      const pack = [view.selfId, ...view.teammates.filter((entry) => entry.alive).map((entry) => entry.id)];
      lines.push('🐺 選擇今晚要殺害的玩家。夜晚結束前都可以更改；狼隊取最高票，平票由小吉隨機決定，都沒選就空刀。');
      const choices = pack.map((id) => {
        const chosen = view.wolfVotes && Object.hasOwn(view.wolfVotes, id);
        return `${seatText(id)}：${chosen ? (view.wolfVotes[id] ? seatText(view.wolfVotes[id]) : '空刀') : '尚未選擇'}`;
      });
      lines.push(`狼隊目前選擇：\n${choices.join('\n')}`);
      rows.push(select(custom('ww.kill'), '選擇要殺害的玩家', targetOptions(view, names, {
        mark: teammates,
        selected: view.wolfVotes?.[view.selfId] ?? null,
      })));
      rows.push(buttonRow({ customId: custom('ww.kill-none'), label: '空刀', style: 'secondary' }));
    } else if (view.role === 'seer') {
      if (view.checkedTonight) {
        const check = view.seerChecks[view.seerChecks.length - 1];
        lines.push(`🔮 今晚已查驗：${seatText(check.targetId)} 是 **${check.wolf ? '狼人' : '好人'}**。請等待天亮。`);
      } else {
        lines.push('🔮 選擇今晚要查驗的玩家，結果只有你看得到。');
        rows.push(select(custom('ww.check'), '選擇要查驗的玩家', targetOptions(view, names, { exclude: [view.selfId] })));
      }
    } else if (view.role === 'guard') {
      const last = view.guard?.lastTarget;
      lines.push(`🛡️ 選擇今晚要守護的玩家（可以守自己${last ? `，不能連續守 ${seatText(last)}` : ''}）。夜晚結束前都可以更改。`);
      if (view.guard?.current !== undefined) lines.push(`目前選擇：${view.guard.current ? seatText(view.guard.current) : '空守'}`);
      rows.push(select(custom('ww.guard'), '選擇要守護的玩家', targetOptions(view, names, {
        exclude: last ? [last] : [],
        selected: view.guard?.current ?? null,
      })));
      rows.push(buttonRow({ customId: custom('ww.guard-none'), label: '空守', style: 'secondary' }));
    } else if (view.role === 'witch') {
      lines.push('🧪 狼人行動結束後才輪到女巫，請等討論串出現「女巫請睜眼」再按「行動」。');
    } else {
      lines.push('🌙 夜晚沒有你需要做的事，請等待天亮。');
    }
  } else if (view.phase === 'witch') {
    if (view.role !== 'witch' || !view.witch) {
      lines.push('🧪 女巫行動中，請等待天亮。');
    } else if (view.witch.chosen) {
      lines.push('🧪 你今晚已經做出決定，請等待天亮。');
    } else {
      if (!view.witch.knowsTarget) lines.push('🧪 解藥已經用完，你看不到今晚的刀口。');
      else lines.push(view.witch.wolfTarget ? `🧪 今晚被狼人選中的是 ${seatText(view.witch.wolfTarget)}。` : '🧪 今晚狼人沒有殺人。');
      lines.push(`解藥：${view.potions.antidote ? '可用' : '已用完'}｜毒藥：${view.potions.poison ? '可用' : '已用完'}｜同一晚只能用一瓶${view.day === 1 ? '' : '，第一晚以後不能救自己'}。`);
      if (view.witch.canPoison) {
        rows.push(select(custom('ww.poison'), '使用毒藥：選擇要毒的玩家', targetOptions(view, names, { exclude: [view.selfId] })));
      }
      rows.push(buttonRow(
        view.witch.canSave ? { customId: custom('ww.save'), label: '使用解藥', style: 'success' } : null,
        { customId: custom('ww.skip'), label: '今晚都不使用', style: 'secondary' }
      ));
    }
  } else if (view.phase === 'day') {
    lines.push('💬 白天討論中，請到面板下方的討論串發言。想直接投票請按面板的「準備投票」。');
  } else if (view.phase === 'vote') {
    lines.push('🗳️ 選擇要投票出局的玩家，投票結束前都可以更改。');
    if (view.myVote !== undefined) lines.push(`你目前投給：${view.myVote ? seatText(view.myVote) : '棄票'}`);
    rows.push(select(custom('ww.vote'), '選擇要投票的玩家', targetOptions(view, names, {
      exclude: [view.selfId],
      selected: view.myVote ?? null,
    })));
    rows.push(buttonRow({ customId: custom('ww.vote-none'), label: '棄票', style: 'secondary' }));
  } else if (view.phase === 'hunter') {
    if (view.hunterTurn) {
      lines.push('🔫 你可以開槍帶走一名存活的玩家，也可以選擇不開槍。');
      rows.push(select(custom('ww.shoot'), '選擇要帶走的玩家', targetOptions(view, names, { exclude: [view.selfId] })));
      rows.push(buttonRow({ customId: custom('ww.shoot-none'), label: '不開槍', style: 'secondary' }));
    } else {
      lines.push('🔫 等待獵人決定是否開槍。');
    }
  }
  if (view.deadline) lines.push(`這個階段 <t:${Math.floor(Date.parse(view.deadline) / 1000)}:R>結束。`);
  return { content: lines.join('\n'), rows };
}

function buildRoleCard({ view, names, seats }) {
  if (!view) return '你不是這局狼人殺的玩家。';
  const seatText = (id) => seatLabelFor({ players: seats }, names, id);
  const lines = [
    `你是 **${view.seat}號**，身分：**${ROLE_LABELS[view.role]}**（${teamLabel(view.role)}）｜${view.alive ? '存活' : '已出局'}`,
    ROLE_TIPS[view.role],
  ];
  if (view.role === 'wolf') {
    lines.push(`狼隊友：${view.teammates.length
      ? view.teammates.map((entry) => `${seatText(entry.id)}${entry.alive ? '' : '（出局）'}`).join('、')
      : '沒有，你是唯一的狼人'}`);
  }
  if (view.role === 'seer' && view.seerChecks.length) {
    lines.push(`查驗紀錄：\n${view.seerChecks.map((check) => `第 ${check.day} 夜：${seatText(check.targetId)} → ${check.wolf ? '狼人' : '好人'}`).join('\n')}`);
  }
  if (view.role === 'witch' && view.potions) {
    lines.push(`解藥：${view.potions.antidote ? '可用' : '已用完'}｜毒藥：${view.potions.poison ? '可用' : '已用完'}`);
  }
  if (view.role === 'guard' && view.guard?.lastTarget) lines.push(`上一晚守護：${seatText(view.guard.lastTarget)}`);
  return lines.join('\n');
}

function currentRoleSetup(session) {
  const settings = lobbySettings(session.rules);
  const count = session.players.length;
  if (settings.roles) return { wolves: settings.roles.wolves, gods: [...settings.roles.gods], auto: false };
  const auto = AUTO_SETUPS[count];
  return { wolves: auto?.wolves ?? 2, gods: auto ? [...auto.gods] : defaultGodsFor(count), auto: true };
}

function buildRoleSetupMenu(session, notice = '') {
  const settings = lobbySettings(session.rules);
  const count = session.players.length;
  const current = currentRoleSetup(session);
  const resolved = resolveRoleSetup(count, settings.roles);
  const custom = (verb) => idFor(session.id, 0, verb);
  const lines = notice ? [notice, ''] : [];
  lines.push(
    `**角色設定**（目前 ${count} 人，${settings.roles ? '房主自訂' : '依人數自動配置'}）`,
    `目前配置：${resolved.ok ? describeSetup(resolved) : resolved.reason}`,
    '選擇狼人數量與要加入的神職，其餘座位由平民補滿。開始遊戲時狼人必須少於好人，角色也不能比玩家多。'
  );
  const rows = [
    select(custom('ww.cfg-wolves'), '狼人數量', Array.from({ length: MAX_WOLVES }, (_, index) => ({
      label: `${index + 1} 隻狼人`,
      value: String(index + 1),
      ...(current.wolves === index + 1 ? { default: true } : {}),
    }))),
    select(custom('ww.cfg-gods'), '神職（可複選，也可以都不選）', GOD_ROLES.map((role) => ({
      label: ROLE_LABELS[role],
      value: role,
      ...(current.gods.includes(role) ? { default: true } : {}),
    })), { minValues: 0, maxValues: GOD_ROLES.length }),
    buttonRow({ customId: custom('ww.cfg-auto'), label: '恢復依人數自動配置', style: 'secondary' }),
  ];
  return { content: lines.join('\n'), rows };
}

function toDiscordRows(rows = []) {
  return rows.map((row) => {
    if (row.type === 'select') {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(row.customId)
        .setPlaceholder(row.placeholder.slice(0, 150))
        .setMinValues(row.minValues)
        .setMaxValues(Math.min(row.maxValues, row.options.length || 1))
        .addOptions(row.options.slice(0, 25));
      return new ActionRowBuilder().addComponents(menu);
    }
    return new ActionRowBuilder().addComponents(row.buttons.map((button) => new ButtonBuilder()
      .setCustomId(button.customId)
      .setLabel(button.label)
      .setStyle(BUTTON_STYLES[button.style] || ButtonStyle.Secondary)));
  });
}

async function resolveNames(interaction, ids) {
  const names = new Map();
  const guild = interaction?.guild;
  const missing = [];
  for (const id of ids) {
    const member = guild?.members?.cache?.get?.(id);
    if (member?.displayName) names.set(id, member.displayName);
    else missing.push(id);
  }
  if (missing.length && typeof guild?.members?.fetch === 'function') {
    try {
      const fetched = await guild.members.fetch({ user: missing });
      fetched?.forEach?.((member) => { if (member?.displayName) names.set(member.id, member.displayName); });
    } catch (_error) {
      // Names are cosmetic; seat numbers still identify every player.
    }
  }
  for (const id of ids) if (!names.has(id)) names.set(id, interaction?.client?.users?.cache?.get?.(id)?.username || '玩家');
  return names;
}

function actionNotice(action, view, names, seats) {
  const seatText = (id) => seatLabelFor({ players: seats }, names, id);
  switch (action.type) {
    case 'night-kill': return action.targetId ? `✅ 你選擇殺害 ${seatText(action.targetId)}。` : '✅ 你選擇空刀。';
    case 'night-check': {
      const check = view?.seerChecks?.[view.seerChecks.length - 1];
      return check ? `🔮 查驗結果：${seatText(check.targetId)} 是 **${check.wolf ? '狼人' : '好人'}**。` : '✅ 已查驗。';
    }
    case 'night-guard': return action.targetId ? `✅ 你今晚守護 ${seatText(action.targetId)}。` : '✅ 你選擇空守。';
    case 'witch':
      if (action.choice === 'save') return '✅ 你使用了解藥。';
      if (action.choice === 'poison') return `✅ 你對 ${seatText(action.targetId)} 使用了毒藥。`;
      return '✅ 你今晚不使用藥水。';
    case 'vote': return action.targetId ? `✅ 你投給 ${seatText(action.targetId)}。` : '✅ 你選擇棄票。';
    case 'hunter-shoot': return action.targetId ? `✅ 你開槍帶走了 ${seatText(action.targetId)}。` : '✅ 你選擇不開槍。';
    default: return '✅ 已記錄。';
  }
}

function createWerewolfInteractionAdapter({ service, store }) {
  if (!service || typeof service.submitAction !== 'function' || typeof service.configure !== 'function' ||
      !store || typeof store.getSessionById !== 'function') {
    throw new BoardCoreError('INVALID_INTERACTION_ADAPTER', 'Werewolf interaction dependencies are unavailable.');
  }

  async function loadSession(interaction, sessionId) {
    const session = await store.getSessionById(sessionId);
    if (!session || session.gameKey !== 'werewolf') throw new BoardCoreError('SESSION_NOT_FOUND', 'The werewolf session does not exist.');
    if (session.guildId !== interaction.guildId || session.channelId !== interaction.channelId) {
      throw new BoardCoreError('SESSION_SCOPE_MISMATCH', 'The interaction belongs to another channel.');
    }
    const participant = session.players.find((entry) => entry.userId === interaction.user?.id && entry.status === 'active');
    if (!participant) throw new BoardCoreError('NOT_A_PLAYER', 'Only werewolf players can use these controls.');
    return session;
  }

  // Player actions arrive from many people at once; a conflicting revision is re-read and retried.
  async function withLatest(session, work) {
    let current = session;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work(current);
      } catch (error) {
        if (error?.code !== 'STALE_REVISION' || attempt >= 4) throw error;
        current = await store.getSessionById(session.id);
        if (!current) throw new BoardCoreError('SESSION_NOT_FOUND', 'The werewolf session does not exist.');
      }
    }
  }

  function submit(interaction, session, action) {
    return withLatest(session, (current) => {
      if (current.status !== 'active') throw new BoardCoreError('SESSION_NOT_ACTIVE', 'The werewolf game is not running.');
      return service.submitAction({
        guildId: current.guildId,
        channelId: current.channelId,
        actorId: interaction.user.id,
        messageId: current.messageId,
        expectedRevision: current.revision,
        interactionId: interaction.id,
        action,
      });
    });
  }

  function configure(interaction, session, rules) {
    return withLatest(session, (current) => service.configure({
      guildId: current.guildId,
      channelId: current.channelId,
      actorId: interaction.user.id,
      expectedRevision: current.revision,
      interactionId: interaction.id,
      rules,
    }));
  }

  async function reply(interaction, { content, rows = [] }) {
    await interaction.editReply({ content: String(content || '').slice(0, 2000), components: toDiscordRows(rows), allowedMentions: { parse: [] } });
  }

  // Both kinds of acknowledgement leave a private message to edit; the runtime's error reply edits it too.
  async function openPrivate(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
    interaction.__boardReplyDeferred = true;
  }

  async function updatePrivate(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    interaction.__boardReplyDeferred = true;
  }

  async function privateContext(interaction, session) {
    const ids = session.players.map((entry) => entry.userId);
    const names = await resolveNames(interaction, ids);
    const view = session.state ? engine.getPrivateView(session.state, interaction.user.id) : null;
    if (view) view.selfId = interaction.user.id;
    const seats = session.players.map((entry, index) => ({ id: entry.userId, seat: index + 1 }));
    return { names, view, seats };
  }

  async function showActionMenu(interaction, session, notice = '') {
    const context = await privateContext(interaction, session);
    await reply(interaction, buildActionMenu({ sessionId: session.id, ...context, notice }));
  }

  async function handlePanel(interaction, session, verb) {
    await openPrivate(interaction);
    if (session.status !== 'active') throw new BoardCoreError('SESSION_NOT_ACTIVE', 'The werewolf game is not running.');
    if (verb === 'act.role') {
      const context = await privateContext(interaction, session);
      await reply(interaction, { content: buildRoleCard(context) });
      return { session };
    }
    if (verb === 'act.action') {
      await showActionMenu(interaction, session);
      return { session };
    }
    const action = verb === 'act.ready' ? { type: 'ready' } : { type: 'start-vote' };
    try {
      const result = await submit(interaction, session, action);
      const info = result.game?.werewolf;
      let content = '✅ 已提前開始投票，請按面板的「行動」投票。';
      if (verb === 'act.ready') {
        content = info?.phase === 'vote'
          ? '✅ 所有存活玩家都準備好了，開始投票！請按面板的「行動」投票。'
          : `✅ 你已準備投票${info?.progress ? `（${info.progress.done}／${info.progress.total}）` : ''}。所有存活玩家都準備好就會開始投票。`;
      }
      await reply(interaction, { content });
      return result;
    } catch (error) {
      if (!(error instanceof BoardRuleError)) throw error;
      await reply(interaction, {
        content: verb === 'act.ready'
          ? '現在不能準備投票：只有存活玩家能在白天討論時使用。'
          : '現在不能提前開票：只有房主能在白天討論時使用。',
      });
      return { session };
    }
  }

  async function handleLobby(interaction, session, verb) {
    if (session.status !== 'lobby') throw new BoardCoreError('LOBBY_CLOSED', 'The lobby is closed.');
    if (session.hostId !== interaction.user.id) throw new BoardCoreError('HOST_ONLY', 'Only the host can change the settings.');
    const settings = lobbySettings(session.rules);
    if (LOBBY_TOGGLE_VERBS.has(verb)) {
      await openPrivate(interaction);
      let patch;
      let text;
      if (verb === 'ww.pace') {
        patch = { pace: nextInOrder(PACE_ORDER, settings.pace) };
        text = `節奏改為 ${PACES[patch.pace].label}。`;
      } else if (verb === 'ww.win') {
        patch = { win: nextInOrder(WIN_ORDER, settings.win) };
        text = `勝利條件改為 ${WIN_MODES[patch.win].label}（${WIN_MODES[patch.win].description}）。`;
      } else {
        patch = { reveal: !settings.reveal };
        text = patch.reveal ? '出局時會公開身分。' : '出局時不公開身分（遊戲結束才揭曉）。';
      }
      const result = await configure(interaction, session, patch);
      await reply(interaction, { content: `✅ ${text}` });
      return result;
    }
    if (verb === 'ww.roles') {
      await openPrivate(interaction);
      await reply(interaction, buildRoleSetupMenu(session));
      return { session };
    }
    await updatePrivate(interaction);
    const current = currentRoleSetup(session);
    let roles = null;
    if (verb === 'ww.cfg-wolves') roles = { wolves: Number(interaction.values?.[0]), gods: current.gods };
    else if (verb === 'ww.cfg-gods') roles = { wolves: current.wolves, gods: [...(interaction.values || [])] };
    try {
      const result = await configure(interaction, session, { roles });
      const latest = await store.getSessionById(session.id);
      await reply(interaction, buildRoleSetupMenu(latest || session, '✅ 已更新角色設定。'));
      return result;
    } catch (error) {
      if (!(error instanceof BoardRuleError)) throw error;
      await reply(interaction, buildRoleSetupMenu(session, '⚠️ 這個角色設定無法使用。'));
      return { session };
    }
  }

  async function handleAction(interaction, session, decoded) {
    await updatePrivate(interaction);
    if (session.status !== 'active') {
      await reply(interaction, { content: '這局狼人殺已經結束。' });
      return { session };
    }
    const view = engine.getPrivateView(session.state, interaction.user.id);
    if (!view || decoded.revision !== view.phaseSerial) {
      await showActionMenu(interaction, session, '⌛ 這個選單已經過期，以下是目前的行動選單。');
      return { session };
    }
    const action = ACTION_VERBS[decoded.verb](Array.isArray(interaction.values) ? interaction.values : []);
    let result;
    try {
      result = await submit(interaction, session, action);
    } catch (error) {
      if (!(error instanceof BoardRuleError)) throw error;
      const latest = await store.getSessionById(session.id);
      await showActionMenu(interaction, latest || session, '⚠️ 這個選擇現在不能使用，可能階段已經改變。');
      return { session: latest || session };
    }
    const latest = await store.getSessionById(session.id);
    const context = await privateContext(interaction, latest || session);
    const notice = actionNotice(action, context.view, context.names, context.seats);
    await reply(interaction, buildActionMenu({ sessionId: session.id, ...context, notice }));
    return result;
  }

  return Object.freeze({
    handles: isWerewolfVerb,
    async handle(interaction, decoded) {
      const session = await loadSession(interaction, decoded.sessionId);
      if (PANEL_VERBS.has(decoded.verb)) return handlePanel(interaction, session, decoded.verb);
      if (LOBBY_TOGGLE_VERBS.has(decoded.verb) || ROLE_SETUP_VERBS.has(decoded.verb)) {
        return handleLobby(interaction, session, decoded.verb);
      }
      if (Object.hasOwn(ACTION_VERBS, decoded.verb)) return handleAction(interaction, session, decoded);
      throw new BoardCoreError('ACTION_NOT_AVAILABLE', 'This werewolf control is not available.');
    },
  });
}

module.exports = {
  ACTION_VERBS,
  PANEL_VERBS,
  buildActionMenu,
  buildRoleCard,
  buildRoleSetupMenu,
  createWerewolfInteractionAdapter,
  isWerewolfVerb,
  resolveNames,
  toDiscordRows,
};
