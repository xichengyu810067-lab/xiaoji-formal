// Werewolf table rules that both the engine and the Discord layer read: role names, the default role setup for each
// player count, the three paces and the lobby settings a host may change. Everything here is plain data; the engine
// owns every decision that depends on the game state.

const MIN_PLAYERS = 6;
const MAX_PLAYERS = 12;
const MAX_WOLVES = 5;

const ROLES = Object.freeze(['wolf', 'seer', 'witch', 'hunter', 'guard', 'villager']);
const GOD_ROLES = Object.freeze(['seer', 'witch', 'hunter', 'guard']);

const ROLE_LABELS = Object.freeze({
  wolf: '狼人',
  seer: '預言家',
  witch: '女巫',
  hunter: '獵人',
  guard: '守衛',
  villager: '平民',
});

const ROLE_TIPS = Object.freeze({
  wolf: '每晚和狼隊友一起選擇一名玩家殺害；狼隊取最多票的目標，平票由小吉隨機決定，都沒選就空刀。',
  seer: '每晚可以查驗一名玩家是好人還是狼人，結果只有你看得到。',
  witch: '有一瓶解藥和一瓶毒藥，各能用一次；同一晚只能用一瓶，只有第一晚可以救自己。解藥用完後就看不到刀口。',
  hunter: '被狼人殺害或被投票出局時，可以開槍帶走一名玩家；被毒死或離席出局時不能開槍。',
  guard: '每晚可以守護一名玩家（可以守自己），不能連續兩晚守同一人；同一晚被守又被救的人仍會死亡。',
  villager: '沒有夜晚技能，靠白天的討論與投票找出狼人。',
});

// Default role setups agreed for the table (seer, witch, hunter and guard join as the table grows).
const AUTO_SETUPS = Object.freeze({
  6: Object.freeze({ wolves: 2, gods: Object.freeze(['seer', 'witch']) }),
  7: Object.freeze({ wolves: 2, gods: Object.freeze(['seer', 'witch', 'hunter']) }),
  8: Object.freeze({ wolves: 3, gods: Object.freeze(['seer', 'witch', 'hunter']) }),
  9: Object.freeze({ wolves: 3, gods: Object.freeze(['seer', 'witch', 'hunter']) }),
  10: Object.freeze({ wolves: 3, gods: Object.freeze(['seer', 'witch', 'hunter', 'guard']) }),
  11: Object.freeze({ wolves: 4, gods: Object.freeze(['seer', 'witch', 'hunter', 'guard']) }),
  12: Object.freeze({ wolves: 4, gods: Object.freeze(['seer', 'witch', 'hunter', 'guard']) }),
});

// Seconds for each timed phase. "witch" is the second half of the night, after the wolves chose.
const PACES = Object.freeze({
  fast: Object.freeze({ label: '快速', night: 60, witch: 30, day: 5 * 60, vote: 60, hunter: 30 }),
  standard: Object.freeze({ label: '標準', night: 90, witch: 45, day: 10 * 60, vote: 90, hunter: 45 }),
  slow: Object.freeze({ label: '慢速', night: 120, witch: 60, day: 20 * 60, vote: 120, hunter: 60 }),
});
const PACE_ORDER = Object.freeze(['slow', 'standard', 'fast']);

const WIN_MODES = Object.freeze({
  edge: Object.freeze({ label: '屠邊', description: '神職全滅或平民全滅時狼人獲勝' }),
  city: Object.freeze({ label: '屠城', description: '好人全滅時狼人獲勝' }),
});
const WIN_ORDER = Object.freeze(['edge', 'city']);

const DEFAULT_OPTIONS = Object.freeze({ pace: 'slow', win: 'edge', reveal: false, roles: null });

class WerewolfRulesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WerewolfRulesError';
  }
}

function normalizeRoleSetup(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WerewolfRulesError('Role setup is invalid.');
  const wolves = value.wolves;
  if (!Number.isInteger(wolves) || wolves < 1 || wolves > MAX_WOLVES) throw new WerewolfRulesError('Wolf count is invalid.');
  if (!Array.isArray(value.gods) || value.gods.some((role) => !GOD_ROLES.includes(role)) ||
      new Set(value.gods).size !== value.gods.length) {
    throw new WerewolfRulesError('God roles are invalid.');
  }
  return { wolves, gods: GOD_ROLES.filter((role) => value.gods.includes(role)) };
}

function normalizeWerewolfOptions(options = {}) {
  const input = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const allowed = new Set(['pace', 'win', 'reveal', 'roles']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new WerewolfRulesError('Unknown werewolf option.');
  const pace = input.pace ?? DEFAULT_OPTIONS.pace;
  const win = input.win ?? DEFAULT_OPTIONS.win;
  const reveal = input.reveal ?? DEFAULT_OPTIONS.reveal;
  if (!Object.hasOwn(PACES, pace)) throw new WerewolfRulesError('Pace is invalid.');
  if (!Object.hasOwn(WIN_MODES, win)) throw new WerewolfRulesError('Win mode is invalid.');
  if (typeof reveal !== 'boolean') throw new WerewolfRulesError('Reveal option is invalid.');
  return { pace, win, reveal, roles: normalizeRoleSetup(input.roles ?? null) };
}

// The setup for a given number of players, or a reason it cannot be played. Villagers fill every seat left.
function resolveRoleSetup(playerCount, roles = null) {
  const auto = roles == null;
  const base = auto ? AUTO_SETUPS[playerCount] : roles;
  if (!base) {
    return { ok: false, reason: `狼人殺需要 ${MIN_PLAYERS}–${MAX_PLAYERS} 人。` };
  }
  const villagers = playerCount - base.wolves - base.gods.length;
  if (villagers < 0) return { ok: false, reason: '角色比玩家還多，請減少狼人或神職。' };
  if (base.wolves >= playerCount - base.wolves) return { ok: false, reason: '狼人必須少於好人。' };
  return { ok: true, auto, wolves: base.wolves, gods: [...base.gods], villagers };
}

function describeSetup(setup) {
  if (!setup?.ok) return setup?.reason || '角色設定無法使用。';
  const parts = [`${setup.wolves} 狼`];
  for (const role of setup.gods) parts.push(ROLE_LABELS[role]);
  if (setup.villagers) parts.push(`${setup.villagers} 平民`);
  return parts.join('、');
}

function describePace(pace) {
  const value = PACES[pace] || PACES[DEFAULT_OPTIONS.pace];
  return `${value.label}（夜晚 ${value.night} 秒＋女巫 ${value.witch} 秒／討論 ${value.day / 60} 分／投票 ${value.vote} 秒）`;
}

function nextInOrder(order, value) {
  const index = order.indexOf(value);
  return order[(index + 1) % order.length];
}

module.exports = {
  AUTO_SETUPS,
  DEFAULT_OPTIONS,
  GOD_ROLES,
  MAX_PLAYERS,
  MAX_WOLVES,
  MIN_PLAYERS,
  PACES,
  PACE_ORDER,
  ROLES,
  ROLE_LABELS,
  ROLE_TIPS,
  WIN_MODES,
  WIN_ORDER,
  WerewolfRulesError,
  describePace,
  describeSetup,
  nextInOrder,
  normalizeRoleSetup,
  normalizeWerewolfOptions,
  resolveRoleSetup,
};
