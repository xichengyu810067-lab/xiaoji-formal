const { BoardCoreError, cloneJson } = require('../core/contracts');
const { buildBoardCustomId } = require('./boardCustomId');
const { CAMP_DIRECTIONS } = require('../engines/checkers/board');
const { GAME_LABELS, seatSide } = require('../renderer/svgBoardRenderer');

const BUTTON_LABELS = Object.freeze({
  join: '加入',
  leave: '離開／認輸',
  begin: '開始遊戲',
  stop: '取消／結束',
  status: '重新整理',
  reveal: '查看湯底',
});

function button(session, verb, style = 'secondary', disabled = false) {
  return {
    type: 'button',
    customId: buildBoardCustomId({ sessionId: session.id, revision: session.revision, verb }),
    label: BUTTON_LABELS[verb] || verb,
    style,
    disabled,
  };
}

function buildBoardComponents(result) {
  const session = result.session;
  const controls = [];
  if (session.status === 'lobby') {
    controls.push(button(session, 'join', 'primary'));
    controls.push(button(session, 'leave'));
    controls.push(button(session, 'begin', 'success'));
    controls.push(button(session, 'stop', 'danger'));
    for (const control of result.lobbyControls || []) {
      const verb = String(control?.verb || '');
      if (!/^ww\.[a-z][a-z0-9-]{0,20}$/u.test(verb)) throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Lobby control is invalid.');
      controls.push({
        type: 'button',
        customId: buildBoardCustomId({ sessionId: session.id, revision: session.revision, verb }),
        label: String(control.label || verb).slice(0, 80),
        style: control.style || 'secondary',
        disabled: false,
      });
    }
  } else if (session.status === 'active') {
    controls.push(button(session, 'leave', 'danger'));
    controls.push(button(session, 'status'));
    for (const control of result.game?.controls || []) {
      const id = String(control?.id || '');
      if (!/^[a-z][a-z0-9-]{0,23}$/u.test(id)) throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Board control ID is invalid.');
      controls.push({
        type: control.kind === 'modal' ? 'modal-button' : 'button',
        customId: buildBoardCustomId({ sessionId: session.id, revision: session.revision, verb: `act.${id}` }),
        label: String(control.label || id).slice(0, 80),
        style: control.style || 'primary',
        disabled: control.disabled === true,
      });
    }
  } else if (session.gameKey === 'turtle-soup' && ['completed', 'cancelled', 'expired'].includes(session.status)) {
    controls.push(button(session, 'reveal', 'primary'));
  }
  const rows = [];
  for (let index = 0; index < controls.length; index += 5) {
    rows.push({ type: 'action-row', components: controls.slice(index, index + 5) });
  }
  return rows.slice(0, 5);
}

const STATUS_LABELS = Object.freeze({
  lobby: '等待玩家', active: '進行中', completed: '已結束', cancelled: '已取消', expired: '已逾時',
});
const DISCORD_ID_PATTERN = /^\d{17,20}$/u;

// A player as the panel names them: a mention (which shows the name and, with allowedMentions empty, pings no one),
// or the seat number when the ID is not a Discord ID.
function playerLabel(userId, seat) {
  return DISCORD_ID_PATTERN.test(String(userId)) ? `<@${userId}>` : `玩家 ${seat + 1}`;
}

// Who plays which side, for the games whose pieces have a colour (chess, go, gomoku, xiangqi, Chinese checkers): the
// board image only shows the colours and the seat numbers, so without this a player cannot tell which side is theirs.
// In the lobby the order of joining decides the sides, and the panel says so and lists who has joined; once the game
// runs it names each side's player and whose turn it is. Chinese checkers also says where each player starts and
// where they are heading, read from the game's public view, and how to write a move.
const CHECKERS_MOVE_HELP = '座標：英文字母是第幾列（由上而下 A～Q），數字是該列由左數第幾個點，棋盤圖上每個點都標有名稱。' +
  '移動輸入「起點 終點」，例如 E5 F5；連跳請依序寫出每個落點，例如 E5 G5 I5。';

function sidesFor(gameKey) {
  const sides = [];
  for (let seat = 0; seatSide(gameKey, seat); seat += 1) sides.push(seatSide(gameKey, seat));
  return sides;
}

function campText(game, userId) {
  const player = Array.isArray(game?.players) ? game.players.find((entry) => entry?.id === userId) : null;
  const from = CAMP_DIRECTIONS[player?.campId];
  const to = CAMP_DIRECTIONS[player?.targetCampId];
  return from && to ? `｜從${from}出發，目標${to}` : '';
}

function buildSideLines(session, game = null) {
  const sides = sidesFor(session.gameKey);
  if (sides.length < 2) return [];
  const [first, second] = sides;
  const players = Array.isArray(session.players) ? session.players : [];
  const checkers = session.gameKey === 'checkers';
  if (session.status === 'lobby') {
    const joined = players.slice(0, sides.length).map((player, seat) => {
      const side = sides[seat];
      return `${side.mark} ${side.name}：${playerLabel(player.userId, seat)}`;
    });
    const intro = sides.length === 2
      ? `先加入的是${first.mark} ${first.name}，第二位加入的是${second.mark} ${second.name}。`
      : `依加入順序分配棋色：${sides.map((side) => `${side.mark} ${side.name}`).join('、')}。`;
    const count = checkers ? [`已加入 ${players.length} 人；2、3、4 或 6 人時房主可以開始。`] : [];
    return [intro, ...count, ...joined];
  }
  const lines = players.slice(0, sides.length).map((player, seat) => {
    const side = sides[seat];
    const left = player.status && player.status !== 'active' ? '（已離開）' : '';
    const camp = checkers ? campText(game, player.userId) : '';
    return `${side.mark} ${side.name}（座位 ${seat + 1}）：${playerLabel(player.userId, seat)}${left}${camp}`;
  });
  if (session.status === 'active' && session.turn?.playerId) {
    const seat = players.findIndex((player) => player.userId === session.turn.playerId);
    const side = sides[seat];
    if (side) lines.push(`輪到：${side.mark} ${side.name} ${playerLabel(session.turn.playerId, seat)}`);
  }
  if (checkers && session.status === 'active') lines.push(CHECKERS_MOVE_HELP);
  return lines;
}

async function buildBoardMessagePayload(result, { renderPng }) {
  if (typeof renderPng !== 'function') throw new BoardCoreError('INVALID_PRESENTER', 'renderPng is required.');
  const publicResult = cloneJson(result, 'board presentation result');
  const playerOrder = publicResult.session.players.map((player) => player.userId);
  const gameLabel = GAME_LABELS[publicResult.session.gameKey] || '桌遊';
  const png = await renderPng(publicResult.game || {
    gameKey: publicResult.session.gameKey,
    rulesVersion: publicResult.session.rulesVersion,
    board: { kind: 'narrative', width: null, height: null, points: [], pieces: [] },
    turn: publicResult.session.turn,
    prompts: [{ type: 'status', text: '等待玩家進入。' }],
    outcome: publicResult.session.outcome,
  }, {
    playerOrder,
    title: gameLabel,
  });
  if (!Buffer.isBuffer(png) || png.length < 8) throw new BoardCoreError('RENDER_FAILED', 'Board renderer returned no PNG.');
  const fileName = `board-${publicResult.session.id}-r${publicResult.session.revision}.png`;
  return {
    embeds: [{
      title: gameLabel,
      description: [
        `狀態：${STATUS_LABELS[publicResult.session.status] || publicResult.session.status}｜版本：${publicResult.session.revision}`,
        ...buildSideLines(publicResult.session, publicResult.game),
        typeof publicResult.game?.embedText === 'string' ? publicResult.game.embedText : '',
      ].filter(Boolean).join('\n').slice(0, 4000),
      image: { url: `attachment://${fileName}` },
    }],
    files: [{ attachment: png, name: fileName }],
    components: buildBoardComponents(publicResult),
    allowedMentions: { parse: [] },
  };
}

function createDiscordBoardPresenter({ renderPng, transport }) {
  if (!transport || typeof transport.update !== 'function') {
    throw new BoardCoreError('INVALID_PRESENTER', 'Discord transport must expose update().');
  }
  return Object.freeze({
    async refresh(result) {
      const payload = await buildBoardMessagePayload(result, { renderPng });
      await transport.update({
        guildId: result.session.guildId,
        channelId: result.session.channelId,
        messageId: result.session.messageId,
        payload,
      });
      return payload;
    },
  });
}

module.exports = {
  buildBoardComponents,
  buildSideLines,
  buildBoardMessagePayload,
  createDiscordBoardPresenter,
};
