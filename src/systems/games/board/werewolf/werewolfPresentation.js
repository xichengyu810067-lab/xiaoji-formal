const {
  AUTO_SETUPS,
  DEFAULT_OPTIONS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PACES,
  ROLE_LABELS,
  WIN_MODES,
  describePace,
  describeSetup,
  resolveRoleSetup,
} = require('./rules');

// The shared werewolf panel: what the lobby and the running game show to everyone in the channel. Nothing here reads
// a role that the public view did not already reveal.

function lobbySettings(rules) {
  return { ...DEFAULT_OPTIONS, ...(rules || {}) };
}

function lobbyPrompts(session, rules) {
  const settings = lobbySettings(rules);
  const count = session.players.length;
  const setup = resolveRoleSetup(count, settings.roles);
  const setupText = setup.ok ? describeSetup(setup) : setup.reason;
  return [
    { type: 'status', text: `等待玩家加入：目前 ${count} 人（需要 ${MIN_PLAYERS}–${MAX_PLAYERS} 人）` },
    { type: 'status', text: `角色（${settings.roles ? '房主自訂' : '依人數自動'}）：${setupText}` },
    { type: 'status', text: `勝利條件：${WIN_MODES[settings.win].label}（${WIN_MODES[settings.win].description}）` },
    { type: 'status', text: `出局${settings.reveal ? '會' : '不會'}公開身分` },
    { type: 'status', text: `節奏：${describePace(settings.pace)}` },
  ];
}

function buildLobbyView(session, rules) {
  const settings = lobbySettings(rules);
  const prompts = lobbyPrompts(session, settings);
  return {
    game: {
      gameKey: 'werewolf',
      rulesVersion: session.rulesVersion,
      title: '狼人殺',
      board: { kind: 'narrative', width: null, height: null, points: [], pieces: [] },
      turn: null,
      prompts,
      outcome: null,
      controls: [],
      embedText: [
        '房主可以按下方按鈕調整設定；人數到齊後按「開始遊戲」。',
        ...prompts.map((prompt) => `• ${prompt.text}`),
        '',
        `玩家：${session.players.map((entry, index) => `${index + 1}號 <@${entry.userId}>`).join('、')}`,
      ].join('\n'),
    },
    lobbyControls: [
      { verb: 'ww.pace', label: `節奏：${PACES[settings.pace].label}`, style: 'secondary' },
      { verb: 'ww.win', label: `勝利：${WIN_MODES[settings.win].label}`, style: 'secondary' },
      { verb: 'ww.reveal', label: `出局${settings.reveal ? '公開' : '不公開'}身分`, style: 'secondary' },
      { verb: 'ww.roles', label: '角色設定', style: 'primary' },
    ],
  };
}

function buildActiveControls(view) {
  const phase = view?.werewolf?.phase;
  const day = phase === 'day';
  return [
    { id: 'role', label: '查看身分', kind: 'button', style: 'secondary' },
    { id: 'action', label: '行動', kind: 'button', style: 'primary', disabled: phase === 'ended' },
    { id: 'ready', label: '準備投票', kind: 'button', style: 'success', disabled: !day },
    { id: 'start-vote', label: '提前開票（房主）', kind: 'button', style: 'secondary', disabled: !day },
  ];
}

function playerLine(entry) {
  const role = entry.role ? `（${ROLE_LABELS[entry.role]}）` : '';
  return `${entry.seat}號 <@${entry.id}>${role}`;
}

function buildActiveEmbedText(view) {
  const info = view?.werewolf;
  if (!info) return '';
  const alive = info.players.filter((entry) => entry.alive);
  const dead = info.players.filter((entry) => !entry.alive);
  const lines = [`**${info.phaseTitle}**${info.deadline && info.phase !== 'ended' ? `｜${`<t:${Math.floor(Date.parse(info.deadline) / 1000)}:R>`}結束` : ''}`];
  if (info.outcomeText) lines.push(`結果：**${info.outcomeText}**`);
  if (info.progress) lines.push(`${info.progress.label}：${info.progress.done}／${info.progress.total}`);
  lines.push(`存活（${alive.length}）：${alive.map(playerLine).join('、') || '無'}`);
  if (dead.length) lines.push(`出局（${dead.length}）：${dead.map(playerLine).join('、')}`);
  lines.push(`配置：${info.setupText}`);
  if (info.phase !== 'ended') {
    lines.push('', '討論請到這則訊息下方的討論串。夜晚技能、投票與開槍都按「行動」，只有你自己看得到。');
  }
  return lines.join('\n').slice(0, 3800);
}

function defaultGodsFor(count) {
  return [...(AUTO_SETUPS[count]?.gods || AUTO_SETUPS[MIN_PLAYERS].gods)];
}

module.exports = {
  buildActiveControls,
  buildActiveEmbedText,
  buildLobbyView,
  defaultGodsFor,
  lobbySettings,
};
