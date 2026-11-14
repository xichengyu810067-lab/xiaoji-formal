const { createHash } = require('node:crypto');
const { BoardRuleError } = require('../core/contracts');
const { isTrustedSystemAction } = require('../core/trustedSystemActions');
const {
  GOD_ROLES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PACES,
  ROLE_LABELS,
  WIN_MODES,
  WerewolfRulesError,
  describeSetup,
  normalizeWerewolfOptions,
  resolveRoleSetup,
} = require('../werewolf/rules');

// Werewolf with Xiaoji as the judge. The state holds every secret (roles, night choices, seer results); only
// getPublicView() reaches the shared panel and it never carries a secret, whoever the viewer is. getPrivateView() is
// for the one player who asked, and the Discord layer only ever answers it in a reply that player alone can see.

const key = 'werewolf';
const rulesVersion = '1';
const minPlayers = MIN_PLAYERS;
const maxPlayers = MAX_PLAYERS;
const allowedPlayerCounts = Object.freeze(Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i));
// The host may end a running table (it is reported as a draw), and the host role passes on when the host leaves.
const hostCanEnd = true;
const transferHostOnLeave = true;
// Settings the host may change from the lobby panel before the game starts.
const lobbyOptions = Object.freeze(['pace', 'win', 'reveal', 'roles']);

const PHASE_TIMEOUT_ACTION = 'system:phase-timeout';
const PHASES = Object.freeze(['night', 'witch', 'day', 'vote', 'hunter', 'ended']);
const MAX_LOG_ENTRIES = 60;
const MAX_DAYS = 30;
const INACTIVE_LIMIT = 2;

function fail(code, message) {
  throw new BoardRuleError(code, message);
}

function invalid(message = 'This werewolf action is not valid.') {
  fail('INVALID_ACTION', message);
}

function normalizeOptions(options = {}) {
  try {
    return normalizeWerewolfOptions(options);
  } catch (error) {
    if (error instanceof WerewolfRulesError) invalid(error.message);
    throw error;
  }
}

function toIso(value, label) {
  const time = Date.parse(String(value || ''));
  if (!Number.isFinite(time)) invalid(`${label} is invalid.`);
  return new Date(time).toISOString();
}

function addSeconds(now, seconds) {
  return new Date(Date.parse(now) + seconds * 1000).toISOString();
}

function timestamp(iso) {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:R>`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Deterministic draws from the session seed, so a stored game always replays the same way.
function draw(state, label, modulo) {
  const digest = createHash('sha256').update(`${state.seed}|${state.rngCounter}|${label}`).digest();
  state.rngCounter += 1;
  return digest.readUInt32BE(0) % modulo;
}

function validateState(state) {
  if (!state || state.gameKey !== key || state.rulesVersion !== rulesVersion || !PHASES.includes(state.phase) ||
      !Array.isArray(state.players) || state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS ||
      !Array.isArray(state.log) || typeof state.seed !== 'string' || !Number.isSafeInteger(state.rngCounter)) {
    invalid('Werewolf state is invalid.');
  }
  return state;
}

function player(state, id) {
  return state.players.find((entry) => entry.id === id) || null;
}

function alivePlayers(state) {
  return state.players.filter((entry) => entry.alive);
}

function label(entry) {
  return `${entry.seat}號 <@${entry.id}>`;
}

function labelWithRole(state, entry) {
  return state.settings.reveal ? `${label(entry)}（${ROLE_LABELS[entry.role]}）` : label(entry);
}

function announce(state, now, text, ping = []) {
  state.logSeq += 1;
  const entry = { seq: state.logSeq, day: state.day, at: now, text };
  if (ping.length) entry.ping = [...ping];
  state.log.push(entry);
  if (state.log.length > MAX_LOG_ENTRIES) state.log.splice(0, state.log.length - MAX_LOG_ENTRIES);
}

function pace(state) {
  return PACES[state.settings.pace];
}

function enterPhase(state, phase, now, seconds) {
  state.phase = phase;
  state.phaseSerial += 1;
  state.responded = [];
  state.deadline = seconds == null ? null : addSeconds(now, seconds);
}

function aliveWithRole(state, role) {
  return alivePlayers(state).filter((entry) => entry.role === role);
}

function hasRole(state, role) {
  return state.players.some((entry) => entry.role === role);
}

function markResponded(state, id) {
  if (!state.responded.includes(id)) state.responded.push(id);
}

// Required players who did not answer get one strike; any answer clears their strikes. Only living players count.
function countMisses(state, requiredIds) {
  for (const id of requiredIds) {
    const entry = player(state, id);
    if (!entry?.alive) continue;
    state.missed[id] = state.responded.includes(id) ? 0 : (state.missed[id] || 0) + 1;
  }
}

function inactivePlayers(state) {
  return alivePlayers(state).filter((entry) => (state.missed[entry.id] || 0) >= INACTIVE_LIMIT);
}

function kill(state, entry, cause) {
  entry.alive = false;
  entry.death = { day: state.day, phase: state.phase, cause };
}

function teamOf(entry) {
  return entry.role === 'wolf' ? 'wolves' : 'village';
}

function findWinner(state) {
  const alive = alivePlayers(state);
  if (!alive.some((entry) => entry.role === 'wolf')) return 'village';
  if (state.settings.win === 'city') return alive.every((entry) => entry.role === 'wolf') ? 'wolves' : null;
  const godsLost = state.players.some((entry) => GOD_ROLES.includes(entry.role)) &&
    !alive.some((entry) => GOD_ROLES.includes(entry.role));
  const villagersLost = state.players.some((entry) => entry.role === 'villager') &&
    !alive.some((entry) => entry.role === 'villager');
  return godsLost || villagersLost ? 'wolves' : null;
}

function roleList(state) {
  return state.players.map((entry) => `${label(entry)}：${ROLE_LABELS[entry.role]}${entry.alive ? '' : '（出局）'}`).join('\n');
}

function finish(state, now, result, reason) {
  enterPhase(state, 'ended', now, null);
  if (result === 'draw') {
    state.outcome = { terminal: true, type: 'draw', winnerIds: [], loserIds: [], reason };
  } else {
    state.outcome = {
      terminal: true,
      type: 'win',
      winnerIds: state.players.filter((entry) => teamOf(entry) === result).map((entry) => entry.id),
      loserIds: state.players.filter((entry) => teamOf(entry) !== result).map((entry) => entry.id),
      reason,
    };
  }
  const headline = {
    'werewolf-village-win': '🏁 遊戲結束：狼人全數出局，好人陣營獲勝！',
    'werewolf-wolves-win': `🏁 遊戲結束：${state.settings.win === 'city' ? '好人全滅' : '神職或平民全滅'}，狼人陣營獲勝！`,
    'werewolf-day-limit': `🏁 遊戲結束：已進行 ${MAX_DAYS} 天仍未分出勝負，本局平手。`,
    'host-ended': '🏁 房主結束了這局狼人殺，本局平手。',
  }[reason];
  announce(state, now, `${headline}\n**身分揭曉**\n${roleList(state)}`);
}

// Ends the game when a side has won. Returns true when it did.
function settle(state, now) {
  const winner = findWinner(state);
  if (!winner) return false;
  finish(state, now, winner, winner === 'village' ? 'werewolf-village-win' : 'werewolf-wolves-win');
  return true;
}

function nightRequiredIds(state) {
  return alivePlayers(state).filter((entry) => ['wolf', 'seer', 'guard'].includes(entry.role)).map((entry) => entry.id);
}

function witchRequiredIds(state) {
  return aliveWithRole(state, 'witch')
    .filter(() => state.potions.antidote || state.potions.poison)
    .map((entry) => entry.id);
}

function startNight(state, now) {
  if (state.day > MAX_DAYS) {
    finish(state, now, 'draw', 'werewolf-day-limit');
    return;
  }
  enterPhase(state, 'night', now, pace(state).night);
  state.night = {
    wolfVotes: {},
    wolfTarget: null,
    seerTarget: null,
    guardTarget: null,
    guardChosen: false,
    witchChoice: null,
    witchTarget: null,
  };
  announce(state, now, `🌙 第 ${state.day} 夜：天黑請閉眼。有夜晚技能的玩家請按面板的「行動」，${timestamp(state.deadline)}截止。`);
}

function nightComplete(state) {
  const wolvesDone = aliveWithRole(state, 'wolf').every((entry) => Object.hasOwn(state.night.wolfVotes, entry.id));
  const seerDone = aliveWithRole(state, 'seer').every(() => state.night.seerTarget != null);
  const guardDone = aliveWithRole(state, 'guard').every(() => state.night.guardChosen);
  return wolvesDone && seerDone && guardDone;
}

function tallyWolfTarget(state) {
  const counts = new Map();
  for (const wolf of aliveWithRole(state, 'wolf')) {
    const target = state.night.wolfVotes[wolf.id];
    if (target && player(state, target)?.alive) counts.set(target, (counts.get(target) || 0) + 1);
  }
  if (!counts.size) return null;
  const top = Math.max(...counts.values());
  const tied = state.players.filter((entry) => counts.get(entry.id) === top).map((entry) => entry.id);
  return tied.length === 1 ? tied[0] : tied[draw(state, 'wolf-tie', tied.length)];
}

function endNightActions(state, now) {
  countMisses(state, nightRequiredIds(state));
  state.night.wolfTarget = tallyWolfTarget(state);
  if (hasRole(state, 'witch')) {
    enterPhase(state, 'witch', now, pace(state).witch);
    announce(state, now, `🧪 狼人已經行動，女巫請睜眼（${timestamp(state.deadline)}截止）。`);
    return;
  }
  resolveNight(state, now);
}

function resolveNight(state, now) {
  const night = state.night;
  const deaths = new Map();
  if (night.wolfTarget) {
    const guarded = night.guardTarget === night.wolfTarget;
    const saved = night.witchChoice === 'save';
    // Guarded and saved on the same night cancel out, so the target still dies.
    if (guarded === saved) deaths.set(night.wolfTarget, 'wolf');
  }
  if (night.witchChoice === 'poison' && night.witchTarget) deaths.set(night.witchTarget, 'poison');
  for (const entry of inactivePlayers(state)) if (!deaths.has(entry.id)) deaths.set(entry.id, 'inactive');
  state.lastGuardTarget = night.guardTarget;
  const dead = state.players.filter((entry) => deaths.has(entry.id) && entry.alive);
  for (const entry of dead) {
    kill(state, entry, deaths.get(entry.id));
    delete state.missed[entry.id];
  }
  // Causes stay secret: a player removed for not answering is announced with the night's other deaths.
  announce(state, now, dead.length
    ? `☀️ 第 ${state.day} 天：天亮了。昨晚死亡的是：${dead.map((entry) => labelWithRole(state, entry)).join('、')}。`
    : `☀️ 第 ${state.day} 天：天亮了，昨晚是平安夜。`);
  if (settle(state, now)) return;
  const hunter = dead.find((entry) => entry.role === 'hunter' && entry.death.cause === 'wolf');
  if (hunter) startHunter(state, now, hunter, 'day');
  else startDay(state, now);
}

function startDay(state, now) {
  enterPhase(state, 'day', now, pace(state).day);
  state.ready = [];
  announce(state, now, `💬 請在這個討論串討論，${timestamp(state.deadline)}開始投票。所有存活玩家都按「準備投票」，或房主按「提前開票」，就會提早投票。`);
}

function startVote(state, now) {
  enterPhase(state, 'vote', now, pace(state).vote);
  state.votes = {};
  const alive = alivePlayers(state);
  announce(
    state,
    now,
    `🗳️ 開始投票！存活玩家請按面板的「行動」投票，${timestamp(state.deadline)}截止。最高票出局，平票沒有人出局。`,
    alive.map((entry) => entry.id)
  );
}

function voteComplete(state) {
  return alivePlayers(state).every((entry) => Object.hasOwn(state.votes, entry.id));
}

function endVote(state, now) {
  const alive = alivePlayers(state);
  countMisses(state, alive.map((entry) => entry.id));
  const counts = new Map();
  const lines = [];
  const abstained = [];
  const missing = [];
  for (const voter of alive) {
    if (!Object.hasOwn(state.votes, voter.id)) missing.push(voter);
    else if (state.votes[voter.id] && player(state, state.votes[voter.id])?.alive) {
      const target = state.votes[voter.id];
      counts.set(target, [...(counts.get(target) || []), voter]);
    } else abstained.push(voter);
  }
  for (const target of state.players.filter((entry) => counts.has(entry.id))) {
    const voters = counts.get(target.id);
    lines.push(`${label(target)} ← ${voters.map((entry) => `${entry.seat}號`).join('、')}（${voters.length} 票）`);
  }
  if (abstained.length) lines.push(`棄票：${abstained.map((entry) => `${entry.seat}號`).join('、')}`);
  if (missing.length) lines.push(`未投票：${missing.map((entry) => `${entry.seat}號`).join('、')}`);
  const top = Math.max(0, ...[...counts.values()].map((voters) => voters.length));
  const leaders = state.players.filter((entry) => counts.get(entry.id)?.length === top && top > 0);
  let eliminated = null;
  if (leaders.length === 1) {
    eliminated = leaders[0];
    kill(state, eliminated, 'vote');
    delete state.missed[eliminated.id];
  }
  const result = eliminated
    ? `${labelWithRole(state, eliminated)} 被投票出局。`
    : `${top > 0 ? '最高票平手' : '沒有人得票'}，這一輪沒有人出局。`;
  announce(state, now, `📊 投票結果：\n${lines.length ? lines.join('\n') : '（沒有投票紀錄）'}\n${result}`);
  const kicked = inactivePlayers(state);
  for (const entry of kicked) {
    kill(state, entry, 'inactive');
    delete state.missed[entry.id];
  }
  if (kicked.length) {
    announce(state, now, `⌛ ${kicked.map((entry) => labelWithRole(state, entry)).join('、')} 連續兩次沒有回應，判定離席出局。`);
  }
  if (settle(state, now)) return;
  if (eliminated?.role === 'hunter') startHunter(state, now, eliminated, 'night');
  else {
    state.day += 1;
    startNight(state, now);
  }
}

function startHunter(state, now, hunter, returnPhase) {
  enterPhase(state, 'hunter', now, pace(state).hunter);
  state.hunter = { id: hunter.id, returnPhase };
  announce(state, now, `🔫 ${label(hunter)} 是獵人，可以決定是否開槍帶走一名玩家（${timestamp(state.deadline)}截止）。`, [hunter.id]);
}

function resolveHunter(state, now, targetId, { timedOut = false } = {}) {
  const hunter = player(state, state.hunter.id);
  const target = targetId ? player(state, targetId) : null;
  if (target?.alive) {
    kill(state, target, 'hunter');
    delete state.missed[target.id];
    announce(state, now, `🔫 獵人 ${label(hunter)} 開槍帶走了 ${labelWithRole(state, target)}。`);
  } else {
    announce(state, now, timedOut ? `獵人 ${label(hunter)} 沒有在時限內開槍。` : `獵人 ${label(hunter)} 選擇不開槍。`);
  }
  const { returnPhase } = state.hunter;
  state.hunter = null;
  if (settle(state, now)) return;
  if (returnPhase === 'day') startDay(state, now);
  else {
    state.day += 1;
    startNight(state, now);
  }
}

function endPhase(state, now) {
  if (state.phase === 'night') endNightActions(state, now);
  else if (state.phase === 'witch') {
    countMisses(state, witchRequiredIds(state));
    resolveNight(state, now);
  } else if (state.phase === 'day') startVote(state, now);
  else if (state.phase === 'vote') endVote(state, now);
  else if (state.phase === 'hunter') resolveHunter(state, now, null, { timedOut: true });
}

// Moves on as soon as everyone the current phase waits for has answered.
function advanceIfComplete(state, now) {
  if (state.phase === 'night' && nightComplete(state)) endNightActions(state, now);
  else if (state.phase === 'witch' && state.night.witchChoice != null) resolveNight(state, now);
  else if (state.phase === 'day' && alivePlayers(state).every((entry) => state.ready.includes(entry.id))) startVote(state, now);
  else if (state.phase === 'vote' && voteComplete(state)) endVote(state, now);
}

function createInitialState({ players, rules, seed, now }) {
  if (!Array.isArray(players) || players.some((id) => typeof id !== 'string' || !id) || new Set(players).size !== players.length) {
    invalid('Werewolf players are invalid.');
  }
  if (typeof seed !== 'string' || !seed) invalid('Werewolf seed is invalid.');
  const settings = normalizeOptions(rules || {});
  const setup = resolveRoleSetup(players.length, settings.roles);
  if (!setup.ok) fail('INVALID_SETUP', setup.reason);
  const startedAt = toIso(now, 'Start time');
  const state = {
    gameKey: key,
    rulesVersion,
    seed,
    rngCounter: 0,
    settings: { pace: settings.pace, win: settings.win, reveal: settings.reveal },
    setup: { wolves: setup.wolves, gods: setup.gods, villagers: setup.villagers },
    players: players.map((id, index) => ({ id, seat: index + 1, role: null, alive: true, death: null })),
    phase: 'night',
    phaseSerial: 0,
    day: 1,
    deadline: null,
    responded: [],
    ready: [],
    votes: {},
    night: null,
    potions: { antidote: true, poison: true },
    lastGuardTarget: null,
    seerChecks: [],
    hunter: null,
    missed: {},
    log: [],
    logSeq: 0,
    outcome: null,
  };
  const deck = [
    ...Array(setup.wolves).fill('wolf'),
    ...setup.gods,
    ...Array(setup.villagers).fill('villager'),
  ];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = draw(state, 'deal', index + 1);
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  state.players.forEach((entry, index) => { entry.role = deck[index]; });
  announce(
    state,
    startedAt,
    `🐺 狼人殺開始！本局 ${players.length} 人：${describeSetup(setup)}。勝利條件：${WIN_MODES[settings.win].label}（${WIN_MODES[settings.win].description}）；出局${settings.reveal ? '會' : '不會'}公開身分。\n請先按面板的「查看身分」確認自己的角色，只有你看得到。`,
    players
  );
  startNight(state, startedAt);
  return state;
}

function requireAlive(state, actorId) {
  const actor = player(state, actorId);
  if (!actor) fail('ACTION_NOT_LEGAL', 'Only werewolf players can act.');
  if (!actor.alive) fail('ACTION_NOT_LEGAL', 'Players who are out cannot act.');
  return actor;
}

function requireRole(state, actorId, role, phase) {
  const actor = requireAlive(state, actorId);
  if (actor.role !== role || state.phase !== phase) fail('ACTION_NOT_LEGAL', 'This action is not available now.');
  return actor;
}

function requireTarget(state, targetId, { allowNull = false, exclude = [] } = {}) {
  if (targetId == null) {
    if (!allowNull) invalid('A target is required.');
    return null;
  }
  const target = typeof targetId === 'string' ? player(state, targetId) : null;
  if (!target || !target.alive || exclude.includes(target.id)) fail('ACTION_NOT_LEGAL', 'This target cannot be chosen.');
  return target.id;
}

function assertKeys(action, keys) {
  if (Object.keys(action).some((name) => !keys.includes(name))) invalid('Werewolf action has unknown fields.');
}

function applyUserAction(state, action, context) {
  const actorId = context.actorId;
  switch (action.type) {
    case 'night-kill': {
      assertKeys(action, ['type', 'targetId']);
      requireRole(state, actorId, 'wolf', 'night');
      state.night.wolfVotes[actorId] = requireTarget(state, action.targetId, { allowNull: true });
      markResponded(state, actorId);
      break;
    }
    case 'night-check': {
      assertKeys(action, ['type', 'targetId']);
      requireRole(state, actorId, 'seer', 'night');
      if (state.night.seerTarget != null) fail('ACTION_NOT_LEGAL', 'The seer already checked someone tonight.');
      const targetId = requireTarget(state, action.targetId, { exclude: [actorId] });
      state.night.seerTarget = targetId;
      state.seerChecks.push({ day: state.day, targetId, wolf: player(state, targetId).role === 'wolf' });
      markResponded(state, actorId);
      break;
    }
    case 'night-guard': {
      assertKeys(action, ['type', 'targetId']);
      requireRole(state, actorId, 'guard', 'night');
      const exclude = state.lastGuardTarget ? [state.lastGuardTarget] : [];
      state.night.guardTarget = requireTarget(state, action.targetId, { allowNull: true, exclude });
      state.night.guardChosen = true;
      markResponded(state, actorId);
      break;
    }
    case 'witch': {
      assertKeys(action, ['type', 'choice', 'targetId']);
      requireRole(state, actorId, 'witch', 'witch');
      if (state.night.witchChoice != null) fail('ACTION_NOT_LEGAL', 'The witch already decided tonight.');
      if (action.choice === 'save') {
        const target = state.night.wolfTarget;
        if (!state.potions.antidote || !target || (target === actorId && state.day !== 1)) {
          fail('ACTION_NOT_LEGAL', 'The antidote cannot be used now.');
        }
        state.potions.antidote = false;
        state.night.witchChoice = 'save';
      } else if (action.choice === 'poison') {
        if (!state.potions.poison) fail('ACTION_NOT_LEGAL', 'The poison is already used.');
        state.night.witchTarget = requireTarget(state, action.targetId, { exclude: [actorId] });
        state.potions.poison = false;
        state.night.witchChoice = 'poison';
      } else if (action.choice === 'skip') {
        state.night.witchChoice = 'skip';
      } else invalid('Witch choice is invalid.');
      markResponded(state, actorId);
      break;
    }
    case 'ready': {
      assertKeys(action, ['type']);
      requireAlive(state, actorId);
      if (state.phase !== 'day') fail('ACTION_NOT_LEGAL', 'Voting readiness is only for the day discussion.');
      if (!state.ready.includes(actorId)) state.ready.push(actorId);
      break;
    }
    case 'start-vote': {
      assertKeys(action, ['type']);
      if (state.phase !== 'day') fail('ACTION_NOT_LEGAL', 'Voting can only start from the day discussion.');
      if (context.hostId !== actorId) fail('ACTION_NOT_LEGAL', 'Only the host can start the vote early.');
      startVote(state, context.now);
      return;
    }
    case 'vote': {
      assertKeys(action, ['type', 'targetId']);
      requireAlive(state, actorId);
      if (state.phase !== 'vote') fail('ACTION_NOT_LEGAL', 'Voting is not open.');
      state.votes[actorId] = requireTarget(state, action.targetId, { allowNull: true, exclude: [actorId] });
      markResponded(state, actorId);
      break;
    }
    case 'hunter-shoot': {
      assertKeys(action, ['type', 'targetId']);
      if (state.phase !== 'hunter' || state.hunter?.id !== actorId) fail('ACTION_NOT_LEGAL', 'Only the hunter can shoot now.');
      resolveHunter(state, context.now, requireTarget(state, action.targetId, { allowNull: true, exclude: [actorId] }));
      return;
    }
    default:
      invalid('Unknown werewolf action.');
  }
  advanceIfComplete(state, context.now);
}

function removePlayer(state, actorId, now) {
  const actor = player(state, actorId);
  if (!actor || state.phase === 'ended' || !actor.alive) return;
  kill(state, actor, 'left');
  delete state.missed[actorId];
  announce(state, now, `🚪 ${labelWithRole(state, actor)} 離開了遊戲，視為出局。`);
  // Choices aimed at the player who left are cleared so those players can choose again.
  if (state.night) {
    for (const [wolfId, target] of Object.entries(state.night.wolfVotes)) {
      if (target === actorId) {
        delete state.night.wolfVotes[wolfId];
        state.responded = state.responded.filter((id) => id !== wolfId);
      }
    }
    if (state.phase === 'night' && state.night.guardTarget === actorId) {
      state.night.guardTarget = null;
      state.night.guardChosen = false;
    }
  }
  for (const [voterId, target] of Object.entries(state.votes || {})) {
    if (target === actorId) {
      delete state.votes[voterId];
      state.responded = state.responded.filter((id) => id !== voterId);
    }
  }
  if (state.phase === 'hunter' && state.hunter?.id === actorId) {
    resolveHunter(state, now, null);
    return;
  }
  if (settle(state, now)) return;
  advanceIfComplete(state, now);
}

function applyAction(stateValue, action, context) {
  const state = clone(validateState(stateValue));
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') invalid('Werewolf action is invalid.');
  if (!context || typeof context.actorId !== 'string') invalid('Werewolf action context is invalid.');
  const now = toIso(context.now, 'Action time');
  const phaseBefore = state.phase;
  const serialBefore = state.phaseSerial;

  if (action.type === 'player-retired') {
    if (!isTrustedSystemAction(action, 'player-retired') || action.playerId !== context.actorId) {
      invalid('Player retirement must come from the server.');
    }
    removePlayer(state, context.actorId, now);
  } else if (action.type === 'host-stop') {
    if (!isTrustedSystemAction(action, 'host-stop')) invalid('Host stop must come from the server.');
    if (state.phase !== 'ended') finish(state, now, 'draw', 'host-ended');
  } else if (action.type === PHASE_TIMEOUT_ACTION) {
    if (!isTrustedSystemAction(action, PHASE_TIMEOUT_ACTION)) invalid('Phase timeouts must come from the server.');
    if (!state.deadline || Date.parse(state.deadline) > Date.parse(now)) fail('ACTION_NOT_LEGAL', 'The phase is not over yet.');
    endPhase(state, now);
  } else {
    if (state.phase === 'ended') fail('CLAIM_NOT_AVAILABLE', 'This werewolf game has already ended.');
    applyUserAction(state, action, { ...context, now });
  }

  const events = [{ type: 'werewolf-updated' }];
  if (state.phaseSerial !== serialBefore) events.push({ type: 'werewolf-phase', from: phaseBefore, to: state.phase });
  return { state, outcome: state.outcome, events, progressed: true };
}

function isRevealed(state, entry) {
  return state.phase === 'ended' || (state.settings.reveal && !entry.alive);
}

const PHASE_LABELS = Object.freeze({
  night: '夜晚行動中',
  witch: '女巫行動中',
  day: '白天討論',
  vote: '投票中',
  hunter: '獵人決定是否開槍',
  ended: '遊戲結束',
});

function phaseTitle(state) {
  if (state.phase === 'ended') return '遊戲結束';
  const unit = ['night', 'witch'].includes(state.phase) ? '夜' : '天';
  return `第 ${state.day} ${unit}｜${PHASE_LABELS[state.phase]}`;
}

function outcomeText(outcome) {
  if (!outcome) return null;
  if (outcome.type === 'draw') return '本局平手';
  return outcome.reason === 'werewolf-village-win' ? '好人陣營獲勝' : '狼人陣營獲勝';
}

function progressOf(state) {
  const alive = alivePlayers(state).length;
  if (state.phase === 'vote') return { label: '已投票', done: Object.keys(state.votes).length, total: alive };
  if (state.phase === 'day') return { label: '準備投票', done: state.ready.length, total: alive };
  return null;
}

function getPublicView(stateValue) {
  const state = validateState(stateValue);
  const alive = alivePlayers(state).length;
  const progress = progressOf(state);
  const setupText = describeSetup({ ok: true, ...state.setup });
  const prompts = [
    { type: 'status', text: phaseTitle(state) },
    { type: 'status', text: `存活 ${alive}／${state.players.length} 人` },
    { type: 'status', text: `配置：${setupText}` },
    { type: 'status', text: `${WIN_MODES[state.settings.win].label}｜出局${state.settings.reveal ? '公開' : '不公開'}身分｜${PACES[state.settings.pace].label}節奏` },
  ];
  if (state.outcome) prompts.push({ type: 'status', text: outcomeText(state.outcome) });
  else if (progress) prompts.push({ type: 'status', text: `${progress.label} ${progress.done}／${progress.total}` });
  return {
    gameKey: key,
    rulesVersion,
    title: '狼人殺',
    board: { kind: 'narrative', width: null, height: null, points: [], pieces: [] },
    turn: null,
    prompts,
    outcome: state.outcome,
    werewolf: {
      phase: state.phase,
      phaseTitle: phaseTitle(state),
      day: state.day,
      phaseSerial: state.phaseSerial,
      deadline: state.deadline,
      settings: clone(state.settings),
      setupText,
      progress,
      outcomeText: outcomeText(state.outcome),
      players: state.players.map((entry) => ({
        id: entry.id,
        seat: entry.seat,
        alive: entry.alive,
        role: isRevealed(state, entry) ? entry.role : null,
      })),
      log: state.log.slice(-10).map((entry) => clone(entry)),
    },
  };
}

function getDeadline(stateValue) {
  const state = validateState(stateValue);
  return state.phase === 'ended' ? null : state.deadline;
}

// Everything one player may know: their own role and, by role, teammates, checks, potions or the wolves' target.
function getPrivateView(stateValue, viewerId) {
  const state = validateState(stateValue);
  const viewer = player(state, viewerId);
  if (!viewer) return null;
  const view = {
    seat: viewer.seat,
    role: viewer.role,
    alive: viewer.alive,
    phase: state.phase,
    phaseSerial: state.phaseSerial,
    day: state.day,
    deadline: state.deadline,
    targets: alivePlayers(state).map(({ id, seat }) => ({ id, seat })),
    teammates: [],
    wolfVotes: null,
    seerChecks: [],
    checkedTonight: false,
    potions: null,
    witch: null,
    guard: null,
    myVote: Object.hasOwn(state.votes || {}, viewerId) ? state.votes[viewerId] : undefined,
    ready: state.ready.includes(viewerId),
    hunterTurn: state.phase === 'hunter' && state.hunter?.id === viewerId,
    responded: state.responded.includes(viewerId),
  };
  if (viewer.role === 'wolf') {
    view.teammates = state.players.filter((entry) => entry.role === 'wolf' && entry.id !== viewerId)
      .map(({ id, seat, alive }) => ({ id, seat, alive }));
    if (state.phase === 'night') view.wolfVotes = clone(state.night.wolfVotes);
  }
  if (viewer.role === 'seer') {
    view.seerChecks = clone(state.seerChecks);
    view.checkedTonight = state.phase === 'night' && state.night?.seerTarget != null;
  }
  if (viewer.role === 'witch') {
    view.potions = clone(state.potions);
    if (state.phase === 'witch') {
      const target = state.night.wolfTarget;
      view.witch = {
        // Once the antidote is gone the witch no longer learns who the wolves chose.
        knowsTarget: state.potions.antidote,
        wolfTarget: state.potions.antidote ? target : null,
        canSave: state.potions.antidote && Boolean(target) && (target !== viewerId || state.day === 1),
        canPoison: state.potions.poison,
        chosen: state.night.witchChoice != null,
      };
    }
  }
  if (viewer.role === 'guard') {
    view.guard = {
      lastTarget: state.lastGuardTarget,
      current: state.phase === 'night' && state.night.guardChosen ? state.night.guardTarget : undefined,
    };
  }
  return view;
}

module.exports = {
  MAX_DAYS,
  PHASE_TIMEOUT_ACTION,
  allowedPlayerCounts,
  applyAction,
  createInitialState,
  getDeadline,
  getPrivateView,
  getPublicView,
  hostCanEnd,
  key,
  lobbyOptions,
  maxPlayers,
  minPlayers,
  normalizeOptions,
  rulesVersion,
  transferHostOnLeave,
};
