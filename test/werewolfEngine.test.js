const assert = require('node:assert/strict');
const test = require('node:test');
const { BoardRuleError } = require('../src/systems/games/board/core/contracts');
const { BoardEngineRegistry } = require('../src/systems/games/board/core/engineRegistry');
const { createTrustedSystemAction } = require('../src/systems/games/board/core/trustedSystemActions');
const engine = require('../src/systems/games/board/engines/werewolf');
const { AUTO_SETUPS, resolveRoleSetup } = require('../src/systems/games/board/werewolf/rules');

const START = '2026-11-13T00:00:00.000Z';

function players(count) {
  return Array.from({ length: count }, (_, index) => `p${index + 1}`);
}

function newGame(count = 9, rules = {}, seed = 'seed-a') {
  return engine.createInitialState({ players: players(count), rules: engine.normalizeOptions(rules), seed, now: START });
}

// Replaces the dealt roles so each test knows exactly who holds what.
function withRoles(state, roles) {
  const next = JSON.parse(JSON.stringify(state));
  next.players.forEach((entry, index) => { entry.role = roles[index]; });
  const count = (role) => roles.filter((value) => value === role).length;
  next.setup = {
    wolves: count('wolf'),
    gods: ['seer', 'witch', 'hunter', 'guard'].filter((role) => roles.includes(role)),
    villagers: count('villager'),
  };
  return next;
}

const NINE = ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'];
const TEN = ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager'];

function play(initial) {
  let state = initial;
  let now = Date.parse(START);
  const iso = () => new Date(now).toISOString();
  const api = {
    get state() { return state; },
    act(actorId, action) {
      state = engine.applyAction(state, action, { actorId, hostId: 'p1', now: iso() }).state;
      return state;
    },
    timeout() {
      now = Date.parse(state.deadline);
      state = engine.applyAction(state, createTrustedSystemAction('system:phase-timeout'), { actorId: 'p1', hostId: 'p1', now: iso() }).state;
      return state;
    },
    retire(actorId) {
      state = engine.applyAction(state, createTrustedSystemAction('player-retired', { playerId: actorId }), { actorId, hostId: 'p1', now: iso() }).state;
      return state;
    },
    stop() {
      state = engine.applyAction(state, createTrustedSystemAction('host-stop'), { actorId: 'p1', hostId: 'p1', now: iso() }).state;
      return state;
    },
    alive: () => state.players.filter((entry) => entry.alive).map((entry) => entry.id),
    dead: (id) => !state.players.find((entry) => entry.id === id).alive,
    lastLog: () => state.log[state.log.length - 1].text,
    logText: () => state.log.map((entry) => entry.text).join('\n'),
  };
  return api;
}

function expectRule(work, code) {
  assert.throws(work, (error) => error instanceof BoardRuleError && error.code === code);
}

test('the engine meets the board registry contract and is limited to 6–12 players', () => {
  const registry = new BoardEngineRegistry([engine]);
  assert.equal(registry.get('werewolf'), engine);
  assert.deepEqual(engine.allowedPlayerCounts, [6, 7, 8, 9, 10, 11, 12]);
  assert.equal(engine.hostCanEnd, true);
  assert.deepEqual([...engine.lobbyOptions], ['pace', 'win', 'reveal', 'roles']);
});

test('each table size deals the agreed default roles, the same way for the same seed', () => {
  const expected = {
    6: [2, ['seer', 'witch'], 2],
    7: [2, ['seer', 'witch', 'hunter'], 2],
    8: [3, ['seer', 'witch', 'hunter'], 2],
    9: [3, ['seer', 'witch', 'hunter'], 3],
    10: [3, ['seer', 'witch', 'hunter', 'guard'], 3],
    11: [4, ['seer', 'witch', 'hunter', 'guard'], 3],
    12: [4, ['seer', 'witch', 'hunter', 'guard'], 4],
  };
  for (const [count, [wolves, gods, villagers]] of Object.entries(expected)) {
    assert.deepEqual([AUTO_SETUPS[count].wolves, [...AUTO_SETUPS[count].gods]], [wolves, gods]);
    const state = newGame(Number(count));
    const roles = state.players.map((entry) => entry.role);
    assert.equal(roles.filter((role) => role === 'wolf').length, wolves);
    assert.equal(roles.filter((role) => role === 'villager').length, villagers);
    for (const god of gods) assert.equal(roles.filter((role) => role === god).length, 1);
    assert.deepEqual(newGame(Number(count)).players, state.players);
  }
  assert.notDeepEqual(newGame(12, {}, 'seed-a').players.map((entry) => entry.role),
    newGame(12, {}, 'seed-b').players.map((entry) => entry.role));
});

test('a host role setup fills the rest with villagers and must leave the wolves outnumbered', () => {
  const state = newGame(8, { roles: { wolves: 2, gods: ['seer', 'guard'] } });
  assert.deepEqual(state.setup, { wolves: 2, gods: ['seer', 'guard'], villagers: 4 });
  expectRule(() => newGame(6, { roles: { wolves: 3, gods: [] } }), 'INVALID_SETUP');
  expectRule(() => newGame(6, { roles: { wolves: 2, gods: ['seer', 'witch', 'hunter', 'guard', 'seer'] } }), 'INVALID_ACTION');
  expectRule(() => newGame(6, { roles: { wolves: 3, gods: ['seer', 'witch', 'hunter', 'guard'] } }), 'INVALID_SETUP');
  assert.equal(resolveRoleSetup(5, null).ok, false);
  expectRule(() => engine.normalizeOptions({ pace: 'turbo' }), 'INVALID_ACTION');
  expectRule(() => engine.normalizeOptions({ reveal: 'yes' }), 'INVALID_ACTION');
  expectRule(() => engine.normalizeOptions({ scenarioId: 'x' }), 'INVALID_ACTION');
  assert.deepEqual(engine.normalizeOptions({}), { pace: 'slow', win: 'edge', reveal: false, roles: null });
});

test('the public view never names a living player\'s role, for any viewer', () => {
  const game = play(withRoles(newGame(9), NINE));
  for (const viewerId of players(9)) {
    const view = engine.getPublicView(game.state, { viewerId, isParticipant: true, isActivePlayer: true });
    assert.ok(view.werewolf.players.every((entry) => entry.role === null));
    const text = JSON.stringify(view);
    for (const role of ['"wolf"', '"seer"', '"witch"', 'wolfVotes', 'seerChecks', 'potions']) assert.equal(text.includes(role), false, role);
  }
  assert.equal(engine.getPublicView(game.state).prompts.length <= 5, true);
});

test('wolves take the most chosen target, break ties by the seed and kill nobody when all pass', () => {
  const game = play(withRoles(newGame(9), NINE));
  game.act('p1', { type: 'night-kill', targetId: 'p7' });
  game.act('p2', { type: 'night-kill', targetId: 'p7' });
  game.act('p3', { type: 'night-kill', targetId: 'p8' });
  game.act('p4', { type: 'night-check', targetId: 'p1' });
  assert.equal(game.state.phase, 'witch');
  assert.equal(game.state.night.wolfTarget, 'p7');
  game.act('p5', { type: 'witch', choice: 'skip' });
  assert.equal(game.state.phase, 'day');
  assert.ok(game.dead('p7'));

  const tie = play(withRoles(newGame(9), NINE));
  tie.act('p1', { type: 'night-kill', targetId: 'p7' });
  tie.act('p2', { type: 'night-kill', targetId: 'p8' });
  tie.act('p3', { type: 'night-kill', targetId: null });
  tie.act('p4', { type: 'night-check', targetId: 'p1' });
  assert.ok(['p7', 'p8'].includes(tie.state.night.wolfTarget));

  const quiet = play(withRoles(newGame(9), NINE));
  for (const wolf of ['p1', 'p2', 'p3']) quiet.act(wolf, { type: 'night-kill', targetId: null });
  quiet.act('p4', { type: 'night-check', targetId: 'p1' });
  quiet.act('p5', { type: 'witch', choice: 'skip' });
  assert.match(quiet.logText(), /平安夜/u);
  assert.equal(quiet.alive().length, 9);
});

test('guard and antidote each save the target, but both on the same night still kill', () => {
  const outcomes = [];
  for (const [guard, save] of [[true, false], [false, true], [true, true], [false, false]]) {
    const game = play(withRoles(newGame(10), TEN));
    for (const wolf of ['p1', 'p2', 'p3']) game.act(wolf, { type: 'night-kill', targetId: 'p8' });
    game.act('p4', { type: 'night-check', targetId: 'p2' });
    game.act('p7', { type: 'night-guard', targetId: guard ? 'p8' : null });
    game.act('p5', save ? { type: 'witch', choice: 'save' } : { type: 'witch', choice: 'skip' });
    outcomes.push(game.dead('p8'));
  }
  assert.deepEqual(outcomes, [false, false, true, true]);
});

test('the guard cannot protect the same player two nights running', () => {
  const game = play(withRoles(newGame(10), TEN));
  for (const wolf of ['p1', 'p2', 'p3']) game.act(wolf, { type: 'night-kill', targetId: null });
  game.act('p4', { type: 'night-check', targetId: 'p2' });
  game.act('p7', { type: 'night-guard', targetId: 'p9' });
  game.act('p5', { type: 'witch', choice: 'skip' });
  game.act('p1', { type: 'start-vote' });
  for (const voter of game.alive()) game.act(voter, { type: 'vote', targetId: null });
  assert.equal(game.state.phase, 'night');
  expectRule(() => game.act('p7', { type: 'night-guard', targetId: 'p9' }), 'ACTION_NOT_LEGAL');
  game.act('p7', { type: 'night-guard', targetId: 'p7' });
});

test('the witch saves herself only on the first night, uses one potion a night and loses sight of the target', () => {
  const game = play(withRoles(newGame(9), NINE));
  for (const wolf of ['p1', 'p2', 'p3']) game.act(wolf, { type: 'night-kill', targetId: 'p5' });
  game.act('p4', { type: 'night-check', targetId: 'p1' });
  const view = engine.getPrivateView(game.state, 'p5');
  assert.equal(view.witch.wolfTarget, 'p5');
  assert.equal(view.witch.canSave, true);
  game.act('p5', { type: 'witch', choice: 'save' });
  assert.equal(game.dead('p5'), false);
  expectRule(() => game.act('p5', { type: 'witch', choice: 'skip' }), 'ACTION_NOT_LEGAL');
  game.act('p1', { type: 'start-vote' });
  for (const voter of game.alive()) game.act(voter, { type: 'vote', targetId: null });
  for (const wolf of ['p1', 'p2', 'p3']) game.act(wolf, { type: 'night-kill', targetId: 'p5' });
  game.act('p4', { type: 'night-check', targetId: 'p2' });
  const second = engine.getPrivateView(game.state, 'p5');
  assert.equal(second.witch.knowsTarget, false);
  assert.equal(second.witch.wolfTarget, null);
  expectRule(() => game.act('p5', { type: 'witch', choice: 'save' }), 'ACTION_NOT_LEGAL');
  expectRule(() => game.act('p5', { type: 'witch', choice: 'poison', targetId: 'p5' }), 'ACTION_NOT_LEGAL');
  game.act('p5', { type: 'witch', choice: 'poison', targetId: 'p1' });
  assert.ok(game.dead('p1'));
  assert.ok(game.dead('p5'));
});

test('a poisoned hunter cannot shoot; a hunter killed by wolves or votes can', () => {
  const poisoned = play(withRoles(newGame(9), NINE));
  for (const wolf of ['p1', 'p2', 'p3']) poisoned.act(wolf, { type: 'night-kill', targetId: null });
  poisoned.act('p4', { type: 'night-check', targetId: 'p1' });
  poisoned.act('p5', { type: 'witch', choice: 'poison', targetId: 'p6' });
  assert.ok(poisoned.dead('p6'));
  assert.equal(poisoned.state.phase, 'day');

  const bitten = play(withRoles(newGame(9), NINE));
  for (const wolf of ['p1', 'p2', 'p3']) bitten.act(wolf, { type: 'night-kill', targetId: 'p6' });
  bitten.act('p4', { type: 'night-check', targetId: 'p1' });
  bitten.act('p5', { type: 'witch', choice: 'skip' });
  assert.equal(bitten.state.phase, 'hunter');
  expectRule(() => bitten.act('p7', { type: 'hunter-shoot', targetId: 'p1' }), 'ACTION_NOT_LEGAL');
  bitten.act('p6', { type: 'hunter-shoot', targetId: 'p1' });
  assert.ok(bitten.dead('p1'));
  assert.equal(bitten.state.phase, 'day');

  const voted = play(withRoles(newGame(9), NINE));
  for (const wolf of ['p1', 'p2', 'p3']) voted.act(wolf, { type: 'night-kill', targetId: null });
  voted.act('p4', { type: 'night-check', targetId: 'p1' });
  voted.act('p5', { type: 'witch', choice: 'skip' });
  voted.act('p1', { type: 'start-vote' });
  for (const voter of voted.alive()) voted.act(voter, { type: 'vote', targetId: voter === 'p6' ? 'p1' : 'p6' });
  assert.equal(voted.state.phase, 'hunter');
  voted.timeout();
  assert.match(voted.lastLog(), /天黑請閉眼/u);
  assert.match(voted.logText(), /沒有在時限內開槍/u);
  assert.equal(voted.state.day, 2);
});

test('the most voted player is out, a tie sends nobody out and the votes are announced', () => {
  const game = play(withRoles(newGame(9), NINE));
  for (const wolf of ['p1', 'p2', 'p3']) game.act(wolf, { type: 'night-kill', targetId: null });
  game.act('p4', { type: 'night-check', targetId: 'p1' });
  game.act('p5', { type: 'witch', choice: 'skip' });
  for (const voter of game.alive()) game.act(voter, { type: 'ready' });
  assert.equal(game.state.phase, 'vote');
  expectRule(() => game.act('p4', { type: 'vote', targetId: 'p4' }), 'ACTION_NOT_LEGAL');
  const split = { p1: 'p8', p2: 'p8', p3: 'p9', p4: 'p9' };
  for (const voter of game.alive()) game.act(voter, { type: 'vote', targetId: split[voter] || null });
  assert.match(game.logText(), /最高票平手，這一輪沒有人出局/u);
  assert.equal(game.alive().length, 9);
  for (const wolf of ['p1', 'p2', 'p3']) game.act(wolf, { type: 'night-kill', targetId: null });
  game.act('p4', { type: 'night-check', targetId: 'p2' });
  game.act('p5', { type: 'witch', choice: 'skip' });
  game.act('p1', { type: 'start-vote' });
  for (const voter of game.alive()) game.act(voter, { type: 'vote', targetId: voter === 'p2' ? 'p3' : 'p2' });
  assert.ok(game.dead('p2'));
  assert.match(game.logText(), /2號 <@p2> 被投票出局/u);
});

test('two missed answers in a row remove a living player; at night the cause stays hidden', () => {
  const game = play(withRoles(newGame(9), NINE));
  for (const wolf of ['p1', 'p2', 'p3']) game.act(wolf, { type: 'night-kill', targetId: null });
  game.act('p4', { type: 'night-check', targetId: 'p7' });
  game.act('p5', { type: 'witch', choice: 'skip' });
  game.act('p1', { type: 'start-vote' });
  for (const voter of game.alive().filter((id) => id !== 'p1')) game.act(voter, { type: 'vote', targetId: null });
  game.timeout();
  assert.equal(game.state.missed.p1, 1);
  game.act('p2', { type: 'night-kill', targetId: null });
  game.act('p3', { type: 'night-kill', targetId: null });
  game.act('p4', { type: 'night-check', targetId: 'p8' });
  game.timeout();
  game.act('p5', { type: 'witch', choice: 'skip' });
  assert.ok(game.dead('p1'));
  const morning = game.state.log.find((entry) => /第 2 天：天亮了/u.test(entry.text)).text;
  assert.match(morning, /昨晚死亡的是：1號 <@p1>。$/u);
  assert.equal(/離席|狼人/u.test(morning), false);
  // Answering again clears the count: the seer answered every phase and is still in.
  assert.equal(game.state.missed.p4 || 0, 0);
});

test('a player missing two votes is announced as removed for not answering', () => {
  const game = play(withRoles(newGame(9), NINE));
  const night = () => {
    for (const wolf of ['p1', 'p2', 'p3']) game.act(wolf, { type: 'night-kill', targetId: null });
    game.act('p4', { type: 'night-check', targetId: 'p1' });
    game.act('p5', { type: 'witch', choice: 'skip' });
    game.act('p1', { type: 'start-vote' });
  };
  night();
  for (const voter of game.alive().filter((id) => id !== 'p9')) game.act(voter, { type: 'vote', targetId: null });
  game.timeout();
  night();
  for (const voter of game.alive().filter((id) => id !== 'p9')) game.act(voter, { type: 'vote', targetId: null });
  game.timeout();
  assert.ok(game.dead('p9'));
  assert.match(game.logText(), /9號 <@p9> 連續兩次沒有回應，判定離席出局/u);
});

test('the wolves win by the host\'s rule: one side of the village (edge) or all of it (city)', () => {
  const roles = ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'];
  const edge = play(withRoles(newGame(6), roles));
  edge.act('p1', { type: 'night-kill', targetId: 'p3' });
  edge.act('p2', { type: 'night-kill', targetId: 'p3' });
  edge.act('p3', { type: 'night-check', targetId: 'p5' });
  edge.act('p4', { type: 'witch', choice: 'poison', targetId: 'p5' });
  // p3 bitten, p5 poisoned: the gods remain (witch), the villagers remain (p6); the game goes on.
  assert.equal(edge.state.phase, 'day');
  edge.act('p1', { type: 'start-vote' });
  for (const voter of edge.alive()) edge.act(voter, { type: 'vote', targetId: voter === 'p6' ? 'p1' : 'p6' });
  assert.equal(edge.state.phase, 'ended');
  assert.equal(edge.state.outcome.reason, 'werewolf-wolves-win');
  assert.deepEqual(edge.state.outcome.winnerIds, ['p1', 'p2']);

  const city = play(withRoles(newGame(6, { win: 'city' }), roles));
  city.act('p1', { type: 'night-kill', targetId: 'p3' });
  city.act('p2', { type: 'night-kill', targetId: 'p3' });
  city.act('p3', { type: 'night-check', targetId: 'p5' });
  city.act('p4', { type: 'witch', choice: 'poison', targetId: 'p5' });
  city.act('p1', { type: 'start-vote' });
  for (const voter of city.alive()) city.act(voter, { type: 'vote', targetId: voter === 'p6' ? 'p1' : 'p6' });
  assert.equal(city.state.phase, 'night');
  assert.match(city.logText(), /6號 <@p6> 被投票出局/u);
});

test('revealing roles on death follows the host setting, and the end reveals everyone', () => {
  const hidden = play(withRoles(newGame(9), NINE));
  hidden.retire('p4');
  assert.equal(hidden.lastLog().includes('預言家'), false);
  assert.equal(engine.getPublicView(hidden.state).werewolf.players[3].role, null);

  const shown = play(withRoles(newGame(9, { reveal: true }), NINE));
  shown.retire('p4');
  assert.match(shown.lastLog(), /4號 <@p4>（預言家）/u);
  assert.equal(engine.getPublicView(shown.state).werewolf.players[3].role, 'seer');
  assert.equal(engine.getPublicView(shown.state).werewolf.players[0].role, null);

  hidden.stop();
  assert.equal(hidden.state.phase, 'ended');
  assert.deepEqual(hidden.state.outcome, { terminal: true, type: 'draw', winnerIds: [], loserIds: [], reason: 'host-ended' });
  assert.ok(engine.getPublicView(hidden.state).werewolf.players.every((entry) => entry.role));
  assert.match(hidden.lastLog(), /身分揭曉/u);
});

test('a player who leaves is out at once and choices aimed at them can be made again', () => {
  const game = play(withRoles(newGame(9), NINE));
  game.act('p1', { type: 'night-kill', targetId: 'p8' });
  game.act('p2', { type: 'night-kill', targetId: 'p7' });
  game.retire('p8');
  assert.ok(game.dead('p8'));
  assert.equal(Object.hasOwn(game.state.night.wolfVotes, 'p1'), false);
  assert.equal(game.state.phase, 'night');
  game.retire('p1');
  game.retire('p2');
  game.retire('p3');
  assert.equal(game.state.phase, 'ended');
  assert.equal(game.state.outcome.reason, 'werewolf-village-win');
  game.retire('p4');
  assert.equal(game.state.phase, 'ended');
});

test('only the server may retire players, end phases or stop the game', () => {
  const game = play(withRoles(newGame(9), NINE));
  const context = { actorId: 'p1', hostId: 'p1', now: START };
  for (const type of ['player-retired', 'system:phase-timeout', 'host-stop']) {
    expectRule(() => engine.applyAction(game.state, { type, playerId: 'p1' }, context), 'INVALID_ACTION');
  }
  expectRule(() => engine.applyAction(game.state, createTrustedSystemAction('system:phase-timeout'), context), 'ACTION_NOT_LEGAL');
  expectRule(() => game.act('p7', { type: 'night-kill', targetId: 'p8' }), 'ACTION_NOT_LEGAL');
  expectRule(() => game.act('p2', { type: 'start-vote' }), 'ACTION_NOT_LEGAL');
  expectRule(() => game.act('p1', { type: 'night-kill', targetId: 'p8', extra: 1 }), 'INVALID_ACTION');
});

test('private views tell each player only their own secrets', () => {
  const game = play(withRoles(newGame(9), NINE));
  game.act('p4', { type: 'night-check', targetId: 'p2' });
  const seer = engine.getPrivateView(game.state, 'p4');
  assert.deepEqual(seer.seerChecks, [{ day: 1, targetId: 'p2', wolf: true }]);
  assert.equal(seer.teammates.length, 0);
  const wolf = engine.getPrivateView(game.state, 'p1');
  assert.deepEqual(wolf.teammates.map((entry) => entry.id), ['p2', 'p3']);
  const villager = engine.getPrivateView(game.state, 'p7');
  assert.deepEqual([villager.teammates, villager.seerChecks, villager.potions, villager.wolfVotes], [[], [], null, null]);
  assert.equal(engine.getPrivateView(game.state, 'stranger'), null);
  expectRule(() => game.act('p4', { type: 'night-check', targetId: 'p3' }), 'ACTION_NOT_LEGAL');
});

test('the game stops as a draw after the day limit', () => {
  const game = play(withRoles(newGame(9), NINE));
  for (let guard = 0; guard < 400 && game.state.phase !== 'ended'; guard += 1) {
    if (game.state.phase === 'night') {
      for (const wolf of ['p1', 'p2', 'p3']) game.act(wolf, { type: 'night-kill', targetId: null });
      game.act('p4', { type: 'night-check', targetId: 'p7' });
    } else if (game.state.phase === 'witch') game.act('p5', { type: 'witch', choice: 'skip' });
    else if (game.state.phase === 'day') game.act('p1', { type: 'start-vote' });
    else if (game.state.phase === 'vote') for (const voter of game.alive()) game.act(voter, { type: 'vote', targetId: null });
  }
  assert.equal(game.state.outcome.reason, 'werewolf-day-limit');
  assert.equal(game.state.outcome.type, 'draw');
  assert.ok(game.state.log.length <= 60);
});
