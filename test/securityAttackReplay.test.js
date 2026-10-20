'use strict';

// Attack tests for the controls of a live message used where they were not made for: a button or a modal of a panel
// of one guild sent from a second guild the bot is also in, from another channel, from another message, from a
// direct message, with an old or hand-written revision, or with its custom ID rewritten.
//
// Everything runs through the real interaction handler, the real board, personal-game, blackjack, poll and coin-admin
// handlers and a real coin database (test/support/attackSession.js). The panels are made by the commands that make
// them; the replay is the same custom ID sent in a different place, by the person who owns the panel, by a stranger,
// and by the Administrator of the other guild. Every refusal is held to the same bar as in the other attack tests:
// one private answer, the interaction count the only table that moves, no file, no message, no REST request, and the
// message the control was on is as it was.
//
// A plain test that passes is a defence that held. A test marked todo is a gap that is reported and not fixed here.

const test = require('node:test');
const assert = require('node:assert/strict');

const attack = require('./support/attackSession');

const session = attack.createAttackSession({ prefix: 'xiaoji-attack-replay-' });

const coinService = require('../src/services/coinService');
const chipService = require('../src/services/chipService');
const { withCoinDatabase } = require('../src/services/coinDatabase');
const { parseBoardCustomId, buildBoardCustomId } = require('../src/systems/games/board/discord/boardCustomId');
const { parseSoloCustomId, buildSoloCustomId } = require('../src/systems/games/soloCustomId');
const { assertSessionBoundary } = require('../src/systems/games/board/discord/boardInteractionAdapter');
const { BoardCoreError } = require('../src/systems/games/board/core/contracts');
const { GameError } = require('../src/systems/games/soloGameError');
const { CoinCampaignError } = require('../src/services/coinCampaignService');
const coinAdminCommand = require('../src/commands/coin-admin');
const { previewPayloadHash } = require('../src/services/coinAdminAddService');

const { IDS } = session;
const HOME = IDS.approvedGuild;
const AWAY = IDS.pendingGuild;

// What the handlers answer, spelled out here and not read from the code under test.
const BOARD_OTHER_PLACE = '這個棋盤不屬於目前伺服器或頻道。';
const BOARD_OTHER_MESSAGE = '這個控制不是目前棋盤的最新版，請使用最新訊息。';
const BOARD_STALE = '棋盤已更新，請使用最新訊息上的按鈕。';
const BOARD_GENERIC = '小吉暫時無法處理這個棋盤操作，請稍後再試。';
const SOLO_OTHER_PLACE = '這不是原本的伺服器或頻道。';
const SOLO_OTHER_MESSAGE = '請使用目前的遊戲訊息。';
const SOLO_NOT_OWNER = '只有這局的建立者可以操作。';
const SOLO_GENERIC = '遊戲目前無法處理，請稍後再試。';
const BLACKJACK_MISSING = '找不到這局 21點，可能已經結束或被清除。';
const BLACKJACK_NOT_OWNER = '只有開局的玩家可以操作這局 21點。';
const POLL_MISSING = '找不到這個投票，可能已經被清除。';

test.before(async () => {
  await session.open();
  for (const guildId of [HOME, AWAY]) await coinService.setGuildEconomyEnabled(guildId, true, { operatorId: IDS.owner });
  for (const userId of [IDS.member, IDS.target, IDS.owner]) {
    await coinService.adjustPlayerBalance(HOME, userId, {
      action: 'add', amount: 1_000_000, operatorId: IDS.owner, reason: '重放攻擊測試初始資金', operationId: `attack-replay-seed-${userId}`,
    });
    await chipService.buyChips(HOME, userId, 100_000);
  }
});

test.after(() => session.close());

// The places a control can be replayed from. `kind` says which kind of mismatch it is: another guild or channel
// (the panel belongs to a place), or another message in the panel's own channel.
function contextsFor(panel) {
  const away = session.places.away;
  const dm = session.places.dm;
  const elsewhere = session.channel('replay-other-channel');
  return [
    { name: 'the other guild, carrying the panel\'s own message', kind: 'place', where: 'away', channel: away.channel, message: panel.message },
    { name: 'the other guild, on a message of its own', kind: 'place', where: 'away', channel: away.channel, message: session.makeMessage(away.channel) },
    { name: 'another channel of the same guild, on a message of its own', kind: 'place', where: 'home', channel: elsewhere,
      message: session.makeMessage(elsewhere) },
    { name: 'another channel of the same guild, carrying the panel\'s own message', kind: 'place', where: 'home', channel: elsewhere,
      message: panel.message },
    { name: 'the panel\'s channel, on another message', kind: 'message', where: 'home', channel: panel.channel,
      message: session.makeMessage(panel.channel) },
    { name: 'a direct message', kind: 'place', where: 'dm', channel: dm.channel, message: session.makeMessage(dm.channel) },
  ];
}

// Who sends it: the people the panel belongs to, a stranger of the same guild, and the Administrator of the other
// guild (who can only be in the other guild or in a direct message).
function senders(panelOwners, context) {
  const list = [...panelOwners, 'target'];
  if (context.where !== 'home') list.push('awayAdmin');
  return list;
}

function assertRefusal(label, outcome, expected) {
  attack.assertRanCleanly(outcome, label);
  attack.assertRefusedWith(outcome, expected, label);
  attack.assertChangedNothing(session, outcome, label);
  assert.deepEqual(outcome.changes.tables, { feature_usage_daily: 1 }, `${label}: only the interaction count moved`);
  assert.equal(outcome.sourceMessageChanged, false, `${label}: the message the control was on is as it was`);
  assert.deepEqual(outcome.effects, [], `${label}: nothing reached the channel`);
}

// ---------------------------------------------------------------------------------------------------------
// the panels
// ---------------------------------------------------------------------------------------------------------

const panels = {};

async function makeBoard(channelName, { begin }) {
  const channel = session.channel(channelName);
  const started = await session.run('board start', { as: 'owner', channel, options: { game: 'gomoku' } });
  attack.assertRanCleanly(started, 'board start');
  const panel = session.panelOf(started);
  assert.ok(panel, 'the board left a panel with controls');
  if (begin) {
    const join = session.controlsOf(panel.message).find((control) => control.custom_id.endsWith('|join'));
    attack.assertRanCleanly(await session.press(join.custom_id, { as: 'member', message: panel.message, channel }), 'join');
    const start = session.controlsOf(panel.message).find((control) => control.custom_id.endsWith('|begin'));
    attack.assertRanCleanly(await session.press(start.custom_id, { as: 'owner', message: panel.message, channel }), 'begin');
  }
  return panel;
}

const verbOf = (customId) => customId.split('|').slice(4).join('|');

test('a lobby control sent from another guild, channel, message or direct message is refused, by anyone', async () => {
  panels.lobby = await makeBoard('replay-lobby', { begin: false });
  const controls = session.controlsOf(panels.lobby.message);
  assert.deepEqual(controls.map((control) => verbOf(control.custom_id)).sort(), ['begin', 'join', 'leave', 'stop']);
  let replays = 0;
  for (const control of controls) {
    for (const context of contextsFor(panels.lobby)) {
      for (const as of senders(['owner', 'member'], context)) {
        const outcome = await session.press(control.custom_id, { as, where: context.where, channel: context.channel, message: context.message });
        assertRefusal(`${as} presses ${verbOf(control.custom_id)} from ${context.name}`, outcome,
          context.kind === 'message' ? BOARD_OTHER_MESSAGE : BOARD_OTHER_PLACE);
        replays += 1;
      }
    }
  }
  assert.ok(replays >= 70, `${replays} replays`);
  // Nobody got into the lobby, and it can still be begun by its host from where it is.
  const players = await withCoinDatabase((api) => api.all("SELECT players_json FROM board_sessions WHERE message_id = ?", [panels.lobby.message.id]));
  assert.equal(players.length, 1);
  assert.deepEqual(JSON.parse(players[0].players_json).map((player) => player.userId), [IDS.owner]);
});

test('an active board\'s controls, status and move buttons included, are refused from every other place', async () => {
  panels.active = await makeBoard('replay-active', { begin: true });
  const controls = session.controlsOf(panels.active.message);
  assert.ok(controls.some((control) => verbOf(control.custom_id) === 'act.place'));
  assert.ok(controls.some((control) => verbOf(control.custom_id) === 'status'));
  let replays = 0;
  for (const control of controls) {
    for (const context of contextsFor(panels.active)) {
      for (const as of senders(['owner', 'member'], context)) {
        const outcome = await session.press(control.custom_id, { as, where: context.where, channel: context.channel, message: context.message });
        assertRefusal(`${as} presses ${verbOf(control.custom_id)} from ${context.name}`, outcome,
          context.kind === 'message' ? BOARD_OTHER_MESSAGE : BOARD_OTHER_PLACE);
        replays += 1;
      }
    }
  }
  assert.ok(replays >= 100, `${replays} replays`);
});

test('a move submitted from a modal of the board in another place is refused, and no stone is placed', async () => {
  const place = session.controlsOf(panels.active.message).find((control) => verbOf(control.custom_id) === 'act.place');
  const opened = await session.press(place.custom_id, { as: 'owner', message: panels.active.message, channel: panels.active.channel });
  attack.assertRanCleanly(opened, 'the player opens the move modal');
  assert.equal(opened.modals.length, 1, 'the legitimate press shows the modal');
  const [modal] = opened.modals;
  const fields = Object.fromEntries(modal.inputs.map((input) => [input.custom_id, 'H8']));
  for (const context of contextsFor(panels.active)) {
    for (const as of senders(['owner', 'member'], context)) {
      const outcome = await session.submit(modal, {
        as, where: context.where, channel: context.channel, message: context.message, fields,
      });
      assertRefusal(`${as} submits the move from ${context.name}`, outcome,
        context.kind === 'message' ? BOARD_OTHER_MESSAGE : BOARD_OTHER_PLACE);
    }
  }
  // The same press and submission in the panel's own place does place the stone (a control that nothing could ever
  // use would make the refusals above empty).
  const placed = await session.submit(modal, { as: 'owner', message: panels.active.message, channel: panels.active.channel, fields });
  attack.assertRanCleanly(placed, 'the player submits the move where it belongs');
  assert.ok(Object.hasOwn(placed.changes.tables, 'board_actions'), 'the move is stored');
});

test('an old revision, revision 0, an empty revision and a revision nobody has are refused, and so are unreadable ones', async () => {
  const lobby = await makeBoard('replay-revisions', { begin: false });
  const [join] = session.controlsOf(lobby.message).filter((control) => verbOf(control.custom_id) === 'join');
  const { sessionId, revision } = parseBoardCustomId(join.custom_id);
  const id = (value) => `board|1|${sessionId}|${value}|join`;
  const stale = [id(revision - 1), id(revision + 1), id(0), id(''), id(9_007_199_254_740_991), id(revision + 1000)];
  for (const customId of stale) {
    for (const as of ['member', 'target']) {
      const outcome = await session.press(customId, { as, message: lobby.message, channel: lobby.channel });
      assertRefusal(`${as} presses ${customId.slice(-14)}`, outcome, BOARD_STALE);
    }
  }
  // A revision written so that it is not a revision: refused by the parser, with the same generic answer.
  const unreadable = [id(-1), id('1.5'), id('1e21'), id('NaN'), id('abc'), id('9007199254740993'), id('Infinity'),
    id('1|1'), `board|1|${sessionId}|${revision}|JOIN`, `board|1|${sessionId}|${revision}|join|extra`, `BOARD|1|${sessionId}|${revision}|join`,
    `board|2|${sessionId}|${revision}|join`, `board|1|${'a'.repeat(65)}|${revision}|join`, `board|1||${revision}|join`,
    `board|1|${sessionId}\u0000|${revision}|join`, `board|1|${sessionId}|${revision}|__proto__`, `board|1|${sessionId}|${revision}|act.__proto__`];
  for (const customId of unreadable) {
    const outcome = await session.press(customId, { as: 'member', message: lobby.message, channel: lobby.channel });
    attack.assertRanCleanly(outcome, `unreadable ${JSON.stringify(customId).slice(0, 40)}`);
    attack.assertChangedNothing(session, outcome, JSON.stringify(customId));
    if (customId.startsWith('board|')) {
      // The board handler read it and said no.
      assert.equal(outcome.texts.length, 1, JSON.stringify(customId));
      assert.equal(outcome.last, BOARD_GENERIC, JSON.stringify(customId));
      assert.deepEqual(outcome.changes.tables, { feature_usage_daily: 1 });
    } else {
      // Not a board ID at all (the prefix is lower case): no handler takes it, and nothing happens.
      assert.deepEqual(outcome.texts, [], JSON.stringify(customId));
      assert.deepEqual(outcome.changes.tables, {}, JSON.stringify(customId));
    }
  }
  // The same session with a verb nobody gave it, and with another session's ID.
  for (const customId of [`board|1|${sessionId}|${revision}|act.nothing`, `board|1|${sessionId}|${revision}|jump`,
    `board|1|5eed0000-0000-4000-8000-ffffffffffff|${revision}|join`]) {
    const outcome = await session.press(customId, { as: 'member', message: lobby.message, channel: lobby.channel });
    attack.assertRanCleanly(outcome, customId);
    assert.equal(outcome.texts.length, 1, customId);
    attack.assertChangedNothing(session, outcome, customId);
    assert.deepEqual(outcome.changes.tables, { feature_usage_daily: 1 }, customId);
  }
});

test('a personal game answers its maker only, from its own channel and message only', async () => {
  const channel = session.channel('replay-solo');
  const started = await session.run('board start', { as: 'member', channel, options: { game: 'sudoku', difficulty: 'easy' } });
  attack.assertRanCleanly(started, 'sudoku start');
  panels.solo = session.panelOf(started);
  const controls = session.controlsOf(panels.solo.message);
  assert.deepEqual(controls.map((control) => verbOf(control.custom_id)).sort(), ['move.s', 'move.sb', 'refresh']);
  let replays = 0;
  for (const control of controls) {
    for (const context of contextsFor(panels.solo)) {
      for (const as of senders(['member'], context)) {
        const outcome = await session.press(control.custom_id, { as, where: context.where, channel: context.channel, message: context.message });
        const label = `${as} presses ${verbOf(control.custom_id)} from ${context.name}`;
        let expected = SOLO_NOT_OWNER;
        if (context.where === 'dm') expected = SOLO_GENERIC;
        else if (as === 'member') expected = context.kind === 'message' ? SOLO_OTHER_MESSAGE : SOLO_OTHER_PLACE;
        attack.assertRanCleanly(outcome, label);
        attack.assertRefusedWith(outcome, expected, label);
        attack.assertChangedNothing(session, outcome, label);
        assert.deepEqual(outcome.changes.tables, { feature_usage_daily: 1 }, label);
        assert.equal(outcome.modals.length, 0, `${label}: no move modal is shown to a refused press`);
        assert.equal(outcome.sourceMessageChanged, false, label);
        replays += 1;
      }
    }
  }
  assert.ok(replays >= 40, `${replays} replays`);
});

test('a move of a personal game submitted from another place or by another user is refused, and no cell is filled', async () => {
  const cell = session.controlsOf(panels.solo.message).find((control) => verbOf(control.custom_id) === 'move.s');
  const opened = await session.press(cell.custom_id, { as: 'member', message: panels.solo.message, channel: panels.solo.channel });
  attack.assertRanCleanly(opened, 'the maker opens the move modal');
  assert.equal(opened.modals.length, 1);
  const [modal] = opened.modals;
  const fields = { cell: 'A1', value: '5' };
  for (const context of contextsFor(panels.solo)) {
    for (const as of senders(['member'], context)) {
      const outcome = await session.submit(modal, {
        as, where: context.where, channel: context.channel, message: context.message, fields,
      });
      const label = `${as} submits the move from ${context.name}`;
      attack.assertRanCleanly(outcome, label);
      assert.equal(outcome.texts.length, 1, label);
      assert.notEqual(outcome.last, '', label);
      attack.assertChangedNothing(session, outcome, label);
      assert.deepEqual(outcome.changes.tables, { feature_usage_daily: 1 }, label);
    }
  }
});

test('a blackjack hand answers its player only, and only in the guild it was dealt in', async () => {
  const channel = session.channel('replay-blackjack');
  const dealt = await session.run('board start', { as: 'member', channel, options: { game: 'casino-blackjack', amount: 100 } });
  attack.assertRanCleanly(dealt, 'blackjack start');
  panels.blackjack = session.panelOf(dealt);
  const controls = session.controlsOf(panels.blackjack.message);
  assert.equal(controls.length, 2);
  for (const control of controls) {
    for (const context of contextsFor(panels.blackjack)) {
      for (const as of senders(['member'], context)) {
        // From the player's own guild the hand is the player's to play from any message (the next test); everything
        // else is refused.
        if (context.where === 'home' && as === 'member') continue;
        const outcome = await session.press(control.custom_id, { as, where: context.where, channel: context.channel, message: context.message });
        const label = `${as} presses ${control.custom_id} from ${context.name}`;
        attack.assertRanCleanly(outcome, label);
        attack.assertRefusedWith(outcome, context.where === 'home' ? BLACKJACK_NOT_OWNER : BLACKJACK_MISSING, label);
        attack.assertChangedNothing(session, outcome, label);
        assert.deepEqual(outcome.changes.tables, { feature_usage_daily: 1 }, label);
        assert.equal(outcome.sourceMessageChanged, false, label);
      }
    }
  }
});

test('a blackjack control is refused from a message or channel other than its own, like a board or personal game control', {
  todo: 'a blackjack hand is bound to its guild and its player only (src/services/casinoService.js, getBlackjackSession): the player\'s own control ID plays the hand from any message or channel of the guild, and update() then rewrites that other message; the board and personal games also bind the channel and the message',
}, async () => {
  const channel = session.channel('replay-blackjack-2');
  const dealt = await session.run('board start', { as: 'owner', channel, options: { game: 'casino-blackjack', amount: 100 } });
  const panel = session.panelOf(dealt);
  const stand = session.controlsOf(panel.message).find((control) => control.custom_id.includes(':stand:'));
  const elsewhere = session.channel('replay-blackjack-3');
  const outcome = await session.press(stand.custom_id, {
    as: 'owner', where: 'home', channel: elsewhere, message: session.makeMessage(elsewhere),
  });
  attack.assertChangedNothing(session, outcome, 'the hand played from another message');
  assert.deepEqual(outcome.changes.tables, { feature_usage_daily: 1 });
  assert.equal(outcome.sourceMessageChanged, false);
});

test('a poll vote is refused from another guild, from a direct message, and from a message that is not the poll\'s', async () => {
  const channel = session.channel('replay-poll');
  const created = await session.run('poll', { as: 'owner', channel, options: {} });
  attack.assertRanCleanly(created, 'poll');
  panels.poll = session.panelOf(created);
  const controls = session.controlsOf(panels.poll.message);
  assert.equal(controls.length, 2);
  for (const control of controls) {
    for (const context of contextsFor(panels.poll)) {
      // The other channel's own copy of the poll message is the poll message: its ID is what binds a vote (a message
      // ID belongs to one channel), so that combination is a vote like any other and is left to the next test.
      if (context.where === 'home' && context.message === panels.poll.message) continue;
      for (const as of senders(['owner'], context)) {
        const outcome = await session.press(control.custom_id, { as, where: context.where, channel: context.channel, message: context.message });
        const label = `${as} presses ${control.custom_id} from ${context.name}`;
        attack.assertRanCleanly(outcome, label);
        attack.assertRefusedWith(outcome, POLL_MISSING, label);
        attack.assertChangedNothing(session, outcome, label);
        assert.deepEqual(outcome.changes.tables, { feature_usage_daily: 1 }, label);
        assert.equal(outcome.sourceMessageChanged, false, label);
      }
    }
  }
});

test('a poll vote from its own message counts once per voter, and a second press moves the vote instead of adding one', async () => {
  const [first, second] = session.controlsOf(panels.poll.message);
  const press = (as, control) => session.press(control.custom_id, { as, message: panels.poll.message, channel: panels.poll.channel });
  const a = await press('member', first);
  assert.match(a.last, /總票數：1/u);
  const b = await press('member', second);
  assert.match(b.last, /總票數：1/u, 'the same member voting again still counts once');
  assert.match(b.last, /2\. 選項乙 \/ 1 票/u);
  const c = await press('target', second);
  assert.match(c.last, /總票數：2/u);
});

// ---------------------------------------------------------------------------------------------------------
// the session boundary itself
// ---------------------------------------------------------------------------------------------------------

test('assertSessionBoundary refuses another session, another guild or channel, another message and a non-player, in that order', () => {
  const stored = {
    id: 'session-1', guildId: HOME, channelId: IDS.approvedChannel, messageId: 'message-1',
    players: [{ userId: IDS.owner, status: 'active' }, { userId: IDS.member, status: 'left' }],
  };
  const identity = { guildId: HOME, channelId: IDS.approvedChannel, messageId: 'message-1', actorId: IDS.owner };
  const decoded = { sessionId: 'session-1' };
  const code = (changes, verb = 'join', session_ = stored, decodedChanges = {}) => {
    try {
      assertSessionBoundary(session_, { ...identity, ...changes }, { ...decoded, ...decodedChanges }, verb);
      return null;
    } catch (error) {
      assert.ok(error instanceof BoardCoreError, `a ${error?.constructor?.name} escaped`);
      return error.code;
    }
  };
  assert.equal(code({}), null, 'the right place, message and player');
  assert.equal(code({}, 'join', null), 'SESSION_NOT_FOUND', 'no session');
  assert.equal(code({}, 'join', stored, { sessionId: 'session-2' }), 'SESSION_NOT_FOUND', 'another session');
  assert.equal(code({ guildId: AWAY }), 'SESSION_SCOPE_MISMATCH', 'another guild');
  assert.equal(code({ channelId: IDS.pendingChannel }), 'SESSION_SCOPE_MISMATCH', 'another channel');
  assert.equal(code({ guildId: AWAY, channelId: IDS.pendingChannel }), 'SESSION_SCOPE_MISMATCH', 'another guild and channel');
  assert.equal(code({ messageId: 'message-2' }), 'MESSAGE_MISMATCH', 'another message');
  assert.equal(code({ messageId: '' }), 'MESSAGE_MISMATCH', 'no message');
  assert.equal(code({}, 'join', { ...stored, messageId: null }), 'MESSAGE_MISMATCH', 'a session with no message bound yet');
  // The place is looked at before the message, and the message before the player.
  assert.equal(code({ guildId: AWAY, messageId: 'message-2' }), 'SESSION_SCOPE_MISMATCH');
  assert.equal(code({ messageId: 'message-2', actorId: IDS.target }), 'MESSAGE_MISMATCH');
  // The controls of a game need an active player; joining does not.
  for (const verb of ['leave', 'begin', 'stop', 'status', 'act.place', 'act.resign', 'act.anything']) {
    assert.equal(code({ actorId: IDS.target }, verb), 'NOT_A_PLAYER', `${verb} by a stranger`);
    assert.equal(code({ actorId: IDS.member }, verb), 'NOT_A_PLAYER', `${verb} by a player who left`);
    assert.equal(code({}, verb), null, `${verb} by an active player`);
  }
  assert.equal(code({ actorId: IDS.target }, 'join'), null, 'a stranger may join');
});

// ---------------------------------------------------------------------------------------------------------
// the coin-admin preview: the same buttons with another guild, expiry or digest
// ---------------------------------------------------------------------------------------------------------

async function walletOf(userId) {
  return withCoinDatabase((api) => api.get('SELECT balance, total_earned FROM coin_wallets WHERE user_id = ?', [userId]));
}

async function confirmationRow(operationId) {
  return withCoinDatabase((api) => api.get(
    'SELECT status, guild_id, expires_at, payload_hash, result_json FROM coin_admin_add_confirmations WHERE operation_id = ?', [operationId]
  ));
}

function addCustomId(customId, changes) {
  const parts = customId.split('|');
  // coin-admin|1|add|<action>|<mode>|<operationId>|<expiresAt>|<digest>
  const names = { action: 3, mode: 4, operationId: 5, expiresAt: 6, digest: 7 };
  for (const [name, value] of Object.entries(changes)) parts[names[name]] = String(value);
  return parts.join('|');
}

async function makeAddPreview(options) {
  const outcome = await session.run('coin-admin add', { as: 'owner', channel: session.channel('replay-add'), options });
  attack.assertRanCleanly(outcome, 'coin-admin add');
  const panel = session.panelOf(outcome);
  assert.ok(panel, 'the preview shows its buttons');
  const [confirm, cancel] = session.controlsOf(panel.message);
  const decoded = coinAdminCommand._test.parseAddCustomId(confirm.custom_id);
  return { panel, confirm: confirm.custom_id, cancel: cancel.custom_id, decoded, operationId: decoded.operationId };
}

const PREVIEW_MISMATCH = '這份加幣預覽不屬於目前的操作者或伺服器。';
const PREVIEW_EXPIRED = '這份加幣預覽已過期，請重新執行 /coin-admin add。';
const PREVIEW_INVALID = '活動預覽已變更，請重新預覽。';

test('a single-user add preview confirmed from another guild, with another expiry or another digest, pays nothing', async () => {
  const before = await walletOf(IDS.target);
  const preview = await makeAddPreview({ user: IDS.target, amount: 700, reason: '重放攻擊測試' });
  const pending = await confirmationRow(preview.operationId);
  assert.equal(pending.status, 'pending');
  const flipped = (digest) => `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
  const attempts = [
    ['another guild', preview.confirm, { where: 'away', channel: session.places.away.channel }],
    ['another guild, cancelled', preview.cancel, { where: 'away', channel: session.places.away.channel }],
    ['an expiry one second later', addCustomId(preview.confirm, { expiresAt: preview.decoded.expiresAt + 1 }), {}],
    ['an expiry a day later', addCustomId(preview.confirm, { expiresAt: preview.decoded.expiresAt + 86_400 }), {}],
    ['an expiry that never comes', addCustomId(preview.confirm, { expiresAt: 99_999_999_999 }), {}],
    ['another digest', addCustomId(preview.confirm, { digest: flipped(preview.decoded.digest) }), {}],
    ['an all-zero digest', addCustomId(preview.confirm, { digest: '0'.repeat(24) }), {}],
    ['the role mode', addCustomId(preview.confirm, { mode: 'r' }), {}],
    ['another operation ID', addCustomId(preview.confirm, { operationId: '1456074443980800999' }), {}],
  ];
  for (const [name, customId, place] of attempts) {
    const outcome = await session.press(customId, { as: 'owner', message: preview.panel.message, ...place });
    attack.assertRanCleanly(outcome, name);
    assert.equal(outcome.texts.length >= 1, true, name);
    assert.ok([PREVIEW_MISMATCH, PREVIEW_INVALID].includes(outcome.last), `${name}: refused, got ${outcome.last}`);
    assert.deepEqual(Object.keys(outcome.changes.tables).filter((table) => table !== 'feature_usage_daily'), [], `${name}: nothing was written`);
    assert.deepEqual(await walletOf(IDS.target), before, `${name}: the wallet did not move`);
    assert.deepEqual(await confirmationRow(preview.operationId), pending, `${name}: the preview is as it was`);
  }
  // The real button of the real guild pays once.
  const paid = await session.press(preview.confirm, { as: 'owner', message: preview.panel.message, channel: session.places.home.channel });
  attack.assertRanCleanly(paid, 'the genuine confirmation');
  assert.match(paid.last, /^單人加幣完成。/u);
  assert.equal((await walletOf(IDS.target)).balance, before.balance + 700);
  // Pressing it again, or from the other guild afterwards, pays nothing more.
  for (const place of [{}, { where: 'away', channel: session.places.away.channel }]) {
    const again = await session.press(preview.confirm, { as: 'owner', message: preview.panel.message, ...place });
    attack.assertRanCleanly(again, 'the genuine confirmation again');
    assert.equal((await walletOf(IDS.target)).balance, before.balance + 700, 'paid once');
  }
});

test('a member who is not the bot owner cannot confirm or cancel an add preview, from either guild', async () => {
  const before = await walletOf(IDS.target);
  const preview = await makeAddPreview({ user: IDS.target, amount: 55, reason: '非擁有者按鈕測試' });
  const pending = await confirmationRow(preview.operationId);
  for (const [as, place] of [['member', {}], ['admin', {}], ['target', {}], ['awayAdmin', { where: 'away', channel: session.places.away.channel }],
    ['member', { where: 'away', channel: session.places.away.channel }]]) {
    for (const customId of [preview.confirm, preview.cancel]) {
      const outcome = await session.press(customId, { as, message: preview.panel.message, ...place });
      attack.assertRanCleanly(outcome, `${as} presses ${customId.split('|')[3]}`);
      attack.assertRefusedWith(outcome, attack.OWNER_DENIED, `${as} presses ${customId.split('|')[3]}`);
      attack.assertChangedNothing(session, outcome, `${as} presses ${customId.split('|')[3]}`);
    }
  }
  assert.deepEqual(await walletOf(IDS.target), before);
  assert.deepEqual(await confirmationRow(preview.operationId), pending);
});

test('an add preview that has expired pays nothing, and an edited expiry does not bring it back', async () => {
  const before = await walletOf(IDS.target);
  const preview = await makeAddPreview({ user: IDS.target, amount: 66, reason: '逾期預覽測試' });
  const row = await confirmationRow(preview.operationId);
  assert.equal(row.expires_at, preview.decoded.expiresAt);
  // 15 minutes and a second after the preview was made.
  const saved = session.clockOffset;
  session.clockOffset += 15 * 60 * 1000 + 5_000;
  try {
    const late = await session.press(preview.confirm, { as: 'owner', message: preview.panel.message });
    assert.equal(late.last, PREVIEW_EXPIRED);
    const stretched = await session.press(addCustomId(preview.confirm, { expiresAt: preview.decoded.expiresAt + 3600 }),
      { as: 'owner', message: preview.panel.message });
    assert.equal(stretched.last, PREVIEW_MISMATCH, 'a custom ID with a later expiry is not the stored preview');
  } finally {
    session.clockOffset = saved;
  }
  assert.deepEqual(await walletOf(IDS.target), before);
  assert.equal((await confirmationRow(preview.operationId)).status, 'pending');
});

test('a role add preview confirmed from another guild, with another expiry or digest, pays no one', async () => {
  const preview = await makeAddPreview({ role: IDS.role, 'campaign-id': 'attack-replay-campaign', amount: 40, reason: '身分組重放攻擊測試' });
  assert.equal(preview.decoded.mode, 'role');
  const pending = await confirmationRow(preview.operationId);
  const before = [await walletOf(IDS.member), await walletOf(IDS.target)];
  const flipped = `${preview.decoded.digest.slice(0, -1)}${preview.decoded.digest.endsWith('0') ? '1' : '0'}`;
  const attempts = [
    ['another guild', preview.confirm, { where: 'away', channel: session.places.away.channel }],
    ['an expiry one second later', addCustomId(preview.confirm, { expiresAt: preview.decoded.expiresAt + 1 }), {}],
    ['another digest', addCustomId(preview.confirm, { digest: flipped }), {}],
    ['the user mode', addCustomId(preview.confirm, { mode: 'u' }), {}],
  ];
  for (const [name, customId, place] of attempts) {
    const outcome = await session.press(customId, { as: 'owner', message: preview.panel.message, ...place });
    attack.assertRanCleanly(outcome, name);
    assert.ok([PREVIEW_MISMATCH, PREVIEW_INVALID].includes(outcome.last), `${name}: refused, got ${outcome.last}`);
    assert.deepEqual(Object.keys(outcome.changes.tables).filter((table) => table !== 'feature_usage_daily'), [], name);
    assert.deepEqual([await walletOf(IDS.member), await walletOf(IDS.target)], before, `${name}: nobody was paid`);
    assert.deepEqual(await confirmationRow(preview.operationId), pending, `${name}: the preview is as it was`);
  }
});

test('the stored digest follows every field of the preview, so a rewritten preview cannot keep an old digest', () => {
  const base = {
    operationId: '1456074443980800011', mode: 'user', actorUserId: IDS.owner, guildId: HOME, targetUserId: IDS.target,
    amount: 100, reason: '摘要測試', expiresAt: 1_772_424_907,
  };
  const digest = previewPayloadHash(base);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  const changes = [
    { operationId: '1456074443980800012' }, { mode: 'role', roleId: IDS.role, campaignId: 'c', previewToken: 'a'.repeat(64) },
    { actorUserId: IDS.admin }, { guildId: AWAY }, { targetUserId: IDS.member }, { amount: 101 }, { reason: '摘要測試。' },
    { expiresAt: base.expiresAt + 1 },
  ];
  const seen = new Set([digest]);
  for (const change of changes) {
    const next = previewPayloadHash({ ...base, ...change });
    assert.ok(!seen.has(next), `changing ${Object.keys(change).join(', ')} changes the digest`);
    seen.add(next);
  }
});

// ---------------------------------------------------------------------------------------------------------
// custom IDs written by hand
// ---------------------------------------------------------------------------------------------------------

// Strings an attacker would try in place of a custom ID, and in each position of one.
const HOSTILE_TEXT = Object.freeze([
  '', ' ', '|', '||||', '|||||||||', 'board', 'solo', 'coin-admin', 'null', 'undefined', 'NaN', '0', '-1', '1e21',
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '__proto__|__proto__|__proto__',
  'a'.repeat(100), 'a'.repeat(101), 'a'.repeat(1000), 'a'.repeat(100_000),
  '會話', '𝒃𝒐𝒂𝒓𝒅', 'ｂｏａｒｄ|1|ａｂｃ|1|ｊｏｉｎ', '‮board‬', '​board|1|abc|1|join', 'board​|1|abc|1|join',
  'board|1|abc|1|jo​in', 'board|1|abc|١|join', 'board|1|abc|1|join\u0000', '\u0000', '\u001f', '\u007f', '\ud800', '\u{1f4a9}',
  '\n', '\r\n', '\t', 'board|1|abc|1|join\n', ' board|1|abc|1|join', 'board|1|abc|1|join ', 'BOARD|1|abc|1|JOIN',
  'Board|1|Abc|1|Join', 'board|1|abc|1|join|', '|board|1|abc|1|join', 'board||1|abc|1|join', 'board|1|abc|1|join|join',
  'board|1|abc|1', 'board|1|abc', 'board|1|abc|1|join|x|y|z', 'solo|1|abc|1|refresh|', 'solo|1|abc|1|move.s|x',
  'coin-admin|1|add|confirm|u|1|2|3', `coin-admin|1|add|confirm|u|1|2|${'a'.repeat(24)}|`,
  `coin-admin|1|add|confirm|u|1|${'9'.repeat(400)}|${'a'.repeat(24)}`, `coin-admin|1|add|confirm|u|${'x'.repeat(400)}|1|${'a'.repeat(24)}`,
  `coin-admin|1|add|confirm|u|id|${Number.MAX_SAFE_INTEGER}|${'a'.repeat(24)}`, `coin-admin|1|add|confirm|u|id|1e3|${'a'.repeat(24)}`,
  `coin-admin|1|add|confirm|u|id|0x10|${'a'.repeat(24)}`, `coin-admin|1|add|confirm|u|id|-5|${'a'.repeat(24)}`,
  `coin-admin|1|add|confirm|u|id|5|${'A'.repeat(24)}`, `coin-admin|1|add|confirm|u|id|5|${'g'.repeat(24)}`,
  'coin-admin|1|add|CONFIRM|u|id|5|' + 'a'.repeat(24), 'coin-admin|1|add|confirm|U|id|5|' + 'a'.repeat(24),
]);
const HOSTILE_VALUES = Object.freeze([null, undefined, 0, 1, -1, NaN, Infinity, true, false, {}, [], ['board|1|abc|1|join'],
  { toString() { return 'board|1|abc|1|join'; } }, Symbol('custom id'), 10n, () => 'board|1|abc|1|join']);

// A parser may accept a string or refuse it with its own error type and a code; nothing else may come out of it.
function attempt(parser, input) {
  try {
    return { ok: true, value: parser(input) };
  } catch (error) {
    return { ok: false, error };
  }
}

function assertParses(name, parser, ErrorType, validShape) {
  let accepted = 0;
  let refused = 0;
  for (const input of [...HOSTILE_TEXT, ...HOSTILE_VALUES]) {
    const result = attempt(parser, input);
    const shown = typeof input === 'symbol' ? 'a Symbol' : typeof input === 'bigint' ? '10n' : typeof input === 'function' ? 'a function' : JSON.stringify(input)?.slice(0, 60);
    if (result.ok) {
      accepted += 1;
      assert.ok(validShape(result.value), `${name} accepted ${shown} as ${JSON.stringify(result.value)?.slice(0, 120)}`);
    } else {
      refused += 1;
      assert.ok(result.error instanceof ErrorType, `${name} threw a ${result.error?.constructor?.name} for ${shown}: ${result.error?.message}`);
      assert.equal(typeof result.error.code, 'string', `${name} refuses ${shown} with a code`);
      assert.match(result.error.code, /^[A-Z_]+$/u);
    }
  }
  assert.ok(refused > 40, `${name} refused ${refused}`);
  return { accepted, refused };
}

test('parseBoardCustomId refuses hostile text with its own error and decodes only well-formed parts', () => {
  const shape = (value) => /^[A-Za-z0-9_-]{1,64}$/u.test(value.sessionId) && Number.isSafeInteger(value.revision) &&
    value.revision >= 0 && /^[a-z][a-z0-9.-]{0,31}$/u.test(value.verb) && Object.keys(value).length === 3;
  assertParses('parseBoardCustomId', parseBoardCustomId, BoardCoreError, shape);
  // Never longer than Discord's limit, whatever the prefix.
  assert.throws(() => parseBoardCustomId(`board|1|${'a'.repeat(64)}|1|${'a'.repeat(32)}`), { code: 'INVALID_CUSTOM_ID' });
  assert.throws(() => parseBoardCustomId('b'.repeat(100_000)), { code: 'INVALID_CUSTOM_ID' });
  // The ID the bot writes is read back exactly.
  const built = buildBoardCustomId({ sessionId: 'abc-DEF_123', revision: 7, verb: 'act.place' });
  assert.deepEqual(parseBoardCustomId(built), { sessionId: 'abc-DEF_123', revision: 7, verb: 'act.place' });
  for (const bad of [{ sessionId: 'a|b', revision: 1, verb: 'join' }, { sessionId: 'abc', revision: -1, verb: 'join' },
    { sessionId: 'abc', revision: 1.5, verb: 'join' }, { sessionId: 'abc', revision: 1, verb: 'Join' },
    { sessionId: 'a'.repeat(65), revision: 1, verb: 'join' }, { sessionId: '', revision: 1, verb: 'join' }]) {
    assert.throws(() => buildBoardCustomId(bad), BoardCoreError);
  }
});

test('parseBoardCustomId reads numerals the way Number() does, which gains an attacker nothing', () => {
  // Observation, pinned as it is: the revision is read with Number(), so "01", "1e0", "0x1", " 1" and "" (zero) are
  // read as numbers, and whitespace around the session and the verb is trimmed. The bot never writes these forms and
  // the decoded revision is then compared with the stored one (the refusals above), so a rewritten ID can only be as
  // old as the revision it names or as new as the current one; it cannot name a revision that does not exist.
  const decode = (revision) => parseBoardCustomId(`board|1|abc|${revision}|join`).revision;
  assert.deepEqual(['1', '01', '1e0', '0x1', ' 1', '1 '].map(decode), [1, 1, 1, 1, 1, 1]);
  assert.equal(decode(''), 0);
  assert.equal(decode('1e1'), 10);
  for (const refused of ['-1', '1.5', '1e21', 'NaN', 'Infinity', '9007199254740993', 'abc', '١']) {
    assert.throws(() => decode(refused), { code: 'INVALID_REVISION' }, refused);
  }
  assert.deepEqual(parseBoardCustomId('board|1| abc |1| join\n'), { sessionId: 'abc', revision: 1, verb: 'join' });
});

test('parseSoloCustomId refuses hostile text with its own error and decodes only well-formed parts', () => {
  const verbs = new Set(['move.t', 'move.n', 'move.s', 'move.sb', 'refresh']);
  const shape = (value) => /^[A-Za-z0-9_-]{1,64}$/u.test(value.sessionId) && Number.isSafeInteger(value.revision) &&
    value.revision >= 0 && verbs.has(value.verb) && Object.keys(value).length === 3;
  assertParses('parseSoloCustomId', parseSoloCustomId, GameError, shape);
  assert.throws(() => parseSoloCustomId(`solo|1|${'a'.repeat(100)}|1|refresh`), { code: 'INVALID_CUSTOM_ID' });
  const built = buildSoloCustomId({ sessionId: 'e447b857965ecdaace714fe2043a9b08', revision: 3, verb: 'move.sb' });
  assert.deepEqual(parseSoloCustomId(built), { sessionId: 'e447b857965ecdaace714fe2043a9b08', revision: 3, verb: 'move.sb' });
  for (const verb of ['move.x', 'MOVE.S', 'refresh ', 'constructor', '__proto__', 'toString', 'act.place', '']) {
    assert.throws(() => parseSoloCustomId(`solo|1|abc|1|${verb}`), { code: 'INVALID_CUSTOM_ID' }, JSON.stringify(verb));
  }
  assert.throws(() => buildSoloCustomId({ sessionId: 'abc', revision: 1, verb: 'move.x' }), GameError);
  assert.throws(() => buildSoloCustomId({ sessionId: 'a b', revision: 1, verb: 'refresh' }), GameError);
});

test('parseAddCustomId refuses hostile text with its own error and decodes only well-formed parts', () => {
  const { parseAddCustomId } = coinAdminCommand._test;
  const shape = (value) => ['confirm', 'cancel'].includes(value.action) && ['user', 'role'].includes(value.mode) &&
    typeof value.operationId === 'string' && value.operationId.length > 0 && typeof value.expiresAt === 'number' &&
    value.expiresAt >= 0 && /^[a-f0-9]{24}$/u.test(value.digest) && Object.keys(value).length === 5;
  assertParses('parseAddCustomId', parseAddCustomId, CoinCampaignError, shape);
  const good = `coin-admin|1|add|confirm|u|1456074443980800011|1772424907|${'ab12'.repeat(6)}`;
  assert.deepEqual(parseAddCustomId(good), {
    action: 'confirm', mode: 'user', operationId: '1456074443980800011', expiresAt: 1_772_424_907, digest: 'ab12'.repeat(6),
  });
  for (const bad of [good.replace('confirm', 'Confirm'), good.replace('|u|', '|U|'), good.replace('|1|add|', '|2|add|'),
    good.replace('|add|', '|sub|'), `${good}|`, `${good}|x`, good.replace('1772424907', ''), good.replace('1772424907', '-1'),
    good.replace('1772424907', '1.5'), good.replace('1772424907', ' 5'), good.replace('1456074443980800011', ''),
    good.replace('ab12'.repeat(6), 'AB12'.repeat(6)), good.replace('ab12'.repeat(6), 'ab12'.repeat(5)),
    good.replace('ab12'.repeat(6), 'ab12'.repeat(7)), good.replace('ab12'.repeat(6), 'zz12'.repeat(6))]) {
    assert.throws(() => parseAddCustomId(bad), { code: 'PREVIEW_CHANGED' }, bad);
  }
});

test('parseAddCustomId keeps to the 100 characters of a custom ID and reads the expiry as a safe integer', {
  todo: 'parseAddCustomId (src/commands/coin-admin.js) has no length limit and reads the expiry with Number(): a 400-digit expiry decodes as Infinity and a 400-character operation ID is accepted; the stored preview never matches such an ID (validateControl), so it is refused one step later',
}, () => {
  const { parseAddCustomId } = coinAdminCommand._test;
  const digest = 'a'.repeat(24);
  assert.throws(() => parseAddCustomId(`coin-admin|1|add|confirm|u|id|${'9'.repeat(400)}|${digest}`), { code: 'PREVIEW_CHANGED' });
  assert.throws(() => parseAddCustomId(`coin-admin|1|add|confirm|u|id|9007199254740993|${digest}`), { code: 'PREVIEW_CHANGED' });
  assert.throws(() => parseAddCustomId(`coin-admin|1|add|confirm|u|${'x'.repeat(400)}|1|${digest}`), { code: 'PREVIEW_CHANGED' });
});

test('a hand-written custom ID reaches no game, poll, hand or preview: every family answers with a refusal and writes nothing', async () => {
  const lobby = await makeBoard('replay-handwritten', { begin: false });
  const ids = [
    'board|1|', 'board|1|||', 'board|', 'board', 'solo|1|', 'solo|1|menu', 'solo|1|difficulty|nothing', 'solo|1|difficulty|',
    'poll:', 'poll:0:0', 'poll:__proto__:0', 'poll:constructor:1', `poll:${lobby.message.id}:__proto__`, `poll:${lobby.message.id}:-1`,
    `poll:${lobby.message.id}:1e0`, `poll:${lobby.message.id}:99`, 'casino:blackjack:', 'casino:blackjack:hit:', 'casino:blackjack:hit:0',
    'casino:blackjack:hit:-1', 'casino:blackjack:hit:1.5', 'casino:blackjack:hit:1e21', 'casino:blackjack:hit:NaN',
    'casino:blackjack:hit:9007199254740993', 'casino:blackjack:hit:__proto__', 'casino:blackjack:hit:987654',
    'casino:blackjack:stand:987654', 'casino:blackjack:fold:987654',
    'coin-admin|1|add|', 'coin-admin|1|add|confirm', 'coin-admin|1|add|confirm|u|x|1|' + 'a'.repeat(24),
  ];
  for (const customId of ids) {
    for (const as of ['member', 'owner']) {
      const outcome = await session.press(customId, { as, message: lobby.message, channel: lobby.channel });
      const label = `${as} presses ${JSON.stringify(customId)}`;
      attack.assertRanCleanly(outcome, label);
      assert.ok(outcome.texts.length <= 2, label);
      assert.deepEqual(Object.keys(outcome.changes.tables).filter((table) => table !== 'feature_usage_daily'), [], `${label}: nothing written`);
      assert.deepEqual(outcome.changes.files, [], label);
      // A refused preview press says so on the preview itself and takes its buttons away; the others leave it be.
      if (!customId.startsWith('coin-admin|')) assert.equal(outcome.sourceMessageChanged, false, label);
    }
  }
});
