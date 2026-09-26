const { BoardCoreError, cloneJson } = require('../../../../games/contracts');
const { buildBoardCustomId } = require('./boardCustomId');
const { GAME_LABELS } = require('../renderer/svgBoardRenderer');

const BUTTON_LABELS = Object.freeze({
  join: '加入',
  leave: '離開／認輸',
  begin: '開始遊戲',
  stop: '取消／結束',
  status: '重新整理',
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
      description: `狀態：${publicResult.session.status}｜版本：${publicResult.session.revision}`,
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
  buildBoardMessagePayload,
  createDiscordBoardPresenter,
};
