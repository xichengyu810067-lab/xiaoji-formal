const test = require('node:test');
const assert = require('node:assert/strict');

const { createActionParsers, getModalDefinition } = require('../src/systems/games/board/discord/boardControls');
const { parseBoardCustomId } = require('../src/systems/games/board/discord/boardCustomId');
const { createDiscordBoardInteractionAdapter } = require('../src/systems/games/board/discord/boardInteractionAdapter');
const { MAX_INPUT_LENGTH, normalizeJudgeInput } = require('../src/systems/games/board/turtleSoup/retriever');

test('the control lookups answer only for controls that are defined', () => {
  assert.equal(typeof getModalDefinition('chess', 'move'), 'object');
  assert.equal(getModalDefinition('chess', 'move').title, '西洋棋走棋');

  for (const [gameKey, controlId] of [
    ['chess', 'constructor'], ['chess', 'toString'], ['chess', 'hasOwnProperty'], ['chess', '__proto__'],
    ['constructor', 'name'], ['__proto__', 'constructor'], ['toString', 'call'], ['unknown-game', 'move'],
    [undefined, 'move'], ['chess', undefined],
  ]) {
    assert.equal(getModalDefinition(gameKey, controlId), null, `${String(gameKey)} / ${String(controlId)}`);
  }
});

test('a board button whose action name is an object property is refused before any action is sent', async () => {
  // The custom id passes the shape check; only the lookup of the action decides.
  assert.deepEqual(parseBoardCustomId('board|1|abc|3|act.constructor'), {
    sessionId: 'abc', revision: 3, verb: 'act.constructor',
  });

  const session = {
    id: 'abc', gameKey: 'chess', guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1',
    players: [{ userId: 'player-1', status: 'active' }], revision: 3,
  };
  const calls = [];
  const adapter = createDiscordBoardInteractionAdapter({
    store: { getSessionById: async () => session },
    service: {
      readSession: async () => { calls.push('readSession'); return { game: { board: {} }, session }; },
      submitAction: async () => { calls.push('submitAction'); return {}; },
    },
    actionParsers: createActionParsers(),
  });

  await assert.rejects(() => adapter.handle({
    id: 'interaction-1', customId: 'board|1|abc|3|act.constructor', guildId: 'guild-1', channelId: 'channel-1',
    message: { id: 'message-1' }, user: { id: 'player-1' }, fields: { getTextInputValue: () => '' },
  }), { code: 'ACTION_NOT_AVAILABLE' });
  assert.deepEqual(calls, []);
});

test('the turtle soup guess box allows exactly what the judge accepts', () => {
  const [ask] = getModalDefinition('turtle-soup', 'ask').fields;
  const [guess] = getModalDefinition('turtle-soup', 'guess').fields;

  assert.equal(guess.maxLength, MAX_INPUT_LENGTH);
  assert.ok(ask.maxLength <= MAX_INPUT_LENGTH);
  // The longest text the box lets through is not turned away by the judge.
  assert.doesNotThrow(() => normalizeJudgeInput('答'.repeat(guess.maxLength)));
  assert.doesNotThrow(() => normalizeJudgeInput('問'.repeat(ask.maxLength)));
});
