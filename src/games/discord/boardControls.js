const { BoardCoreError, cloneJson } = require('../contracts');
const { createGridMoveParser, getModalValue, parseGridCoordinate } = require('./boardInteractionAdapter');

const GAME_CHOICES = Object.freeze([
  Object.freeze({ name: '海龜湯（1–20 人）', value: 'turtle-soup' }),
  Object.freeze({ name: '西洋棋（2 人）', value: 'chess' }),
  Object.freeze({ name: '五子棋（2 人）', value: 'gomoku' }),
  Object.freeze({ name: '圍棋（2 人）', value: 'go' }),
  Object.freeze({ name: '六角星跳棋（2、3、4、6 人）', value: 'checkers' }),
  Object.freeze({ name: '象棋（2 人）', value: 'xiangqi' }),
]);

const CONTROL_DEFINITIONS = Object.freeze({
  'turtle-soup': Object.freeze([
    Object.freeze({ id: 'ask', label: '提問', kind: 'modal' }),
    Object.freeze({ id: 'guess', label: '猜答案', kind: 'modal', style: 'success' }),
  ]),
  chess: Object.freeze([
    Object.freeze({ id: 'move', label: '走棋', kind: 'modal' }),
    Object.freeze({ id: 'offer-draw', label: '提和', kind: 'button', style: 'secondary' }),
    Object.freeze({ id: 'accept-draw', label: '接受和棋', kind: 'button', style: 'success' }),
    Object.freeze({ id: 'claim-draw', label: '宣告和棋', kind: 'button', style: 'secondary' }),
    Object.freeze({ id: 'resign', label: '認輸', kind: 'button', style: 'danger' }),
  ]),
  gomoku: Object.freeze([
    Object.freeze({ id: 'place', label: '落子', kind: 'modal' }),
    Object.freeze({ id: 'offer-draw', label: '提和', kind: 'button', style: 'secondary' }),
    Object.freeze({ id: 'accept-draw', label: '接受和棋', kind: 'button', style: 'success' }),
    Object.freeze({ id: 'resign', label: '認輸', kind: 'button', style: 'danger' }),
  ]),
  go: Object.freeze([
    Object.freeze({ id: 'move', label: '落子', kind: 'modal' }),
    Object.freeze({ id: 'pass', label: '停一手', kind: 'button', style: 'secondary' }),
    Object.freeze({ id: 'propose-dead', label: '標記死子', kind: 'modal', style: 'secondary' }),
    Object.freeze({ id: 'confirm-dead', label: '確認死子', kind: 'button', style: 'success' }),
    Object.freeze({ id: 'resume-play', label: '恢復落子', kind: 'button', style: 'secondary' }),
    Object.freeze({ id: 'resign', label: '認輸', kind: 'button', style: 'danger' }),
  ]),
  checkers: Object.freeze([
    Object.freeze({ id: 'move', label: '移動／連跳', kind: 'modal' }),
    Object.freeze({ id: 'resign', label: '認輸', kind: 'button', style: 'danger' }),
  ]),
  xiangqi: Object.freeze([
    Object.freeze({ id: 'move', label: '走棋', kind: 'modal' }),
    Object.freeze({ id: 'offer-draw', label: '提和', kind: 'button', style: 'secondary' }),
    Object.freeze({ id: 'accept-draw', label: '接受和棋', kind: 'button', style: 'success' }),
    Object.freeze({ id: 'decline-draw', label: '拒絕和棋', kind: 'button', style: 'secondary' }),
    Object.freeze({ id: 'resign', label: '認輸', kind: 'button', style: 'danger' }),
  ]),
});

const MODAL_DEFINITIONS = Object.freeze({
  'turtle-soup': Object.freeze({
    ask: Object.freeze({ title: '向小吉提問', fields: [Object.freeze({ id: 'input', label: '只能用是、否或無關回答的問題', style: 'paragraph', maxLength: 1000 })] }),
    guess: Object.freeze({ title: '猜海龜湯答案', fields: [Object.freeze({ id: 'input', label: '完整說明你的推理', style: 'paragraph', maxLength: 2000 })] }),
  }),
  chess: Object.freeze({
    move: Object.freeze({ title: '西洋棋走棋', fields: [
      Object.freeze({ id: 'from', label: '起點（例如 E2）', placeholder: 'E2' }),
      Object.freeze({ id: 'to', label: '終點（例如 E4）', placeholder: 'E4' }),
      Object.freeze({ id: 'promotion', label: '升變（可留空：后／車／象／馬）', required: false, placeholder: '后' }),
    ] }),
  }),
  gomoku: Object.freeze({
    place: Object.freeze({ title: '五子棋落子', fields: [Object.freeze({ id: 'position', label: '座標（例如 H8）', placeholder: 'H8' })] }),
  }),
  go: Object.freeze({
    move: Object.freeze({ title: '圍棋落子', fields: [Object.freeze({ id: 'position', label: '座標（例如 E5）', placeholder: 'E5' })] }),
    'propose-dead': Object.freeze({ title: '標記完整死子集合', fields: [Object.freeze({ id: 'positions', label: '座標以空白或逗號分隔', placeholder: 'A1 B2 C3', style: 'paragraph', maxLength: 500 })] }),
  }),
  checkers: Object.freeze({
    move: Object.freeze({ title: '六角星跳棋移動', fields: [Object.freeze({ id: 'path', label: '點位路徑（依序以空白分隔）', placeholder: 'q0r0 q1r0 q3r0', style: 'paragraph', maxLength: 500 })] }),
  }),
  xiangqi: Object.freeze({
    move: Object.freeze({ title: '象棋走棋', fields: [
      Object.freeze({ id: 'from', label: '起點（例如 A1）', placeholder: 'A1' }),
      Object.freeze({ id: 'to', label: '終點（例如 A2）', placeholder: 'A2' }),
    ] }),
  }),
});

function simpleAction(type) {
  return () => ({ type });
}

function parseChessSquare(value) {
  const square = String(value || '').trim().toLowerCase();
  if (!/^[a-h][1-8]$/u.test(square)) {
    throw new BoardCoreError('INVALID_COORDINATE', '西洋棋座標請使用 A1 到 H8。');
  }
  return square;
}

function parsePromotion(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  const aliases = new Map([
    ['q', 'q'], ['后', 'q'], ['皇后', 'q'],
    ['r', 'r'], ['車', 'r'], ['车', 'r'],
    ['b', 'b'], ['象', 'b'],
    ['n', 'n'], ['馬', 'n'], ['马', 'n'],
  ]);
  const promotion = aliases.get(text);
  if (!promotion) throw new BoardCoreError('INVALID_ACTION', '升變請填后、車、象、馬，或 q、r、b、n。');
  return promotion;
}

function splitCoordinates(value) {
  return String(value || '').trim().split(/[\s,，;；]+/u).filter(Boolean);
}

function parseCheckersPath(value) {
  const points = splitCoordinates(value);
  if (points.length < 2 || points.some((point) => !/^q-?\d+r-?\d+$/u.test(point))) {
    throw new BoardCoreError('INVALID_COORDINATE', '跳棋路徑請輸入至少兩個 q…r… 點位，並依序以空白分隔。');
  }
  if (new Set(points).size !== points.length) {
    throw new BoardCoreError('INVALID_COORDINATE', '跳棋路徑不可重複經過同一點位。');
  }
  return points;
}

function createActionParsers() {
  return Object.freeze({
    chess: Object.freeze({
      move: ({ interaction }) => {
        const action = {
          type: 'move',
          from: parseChessSquare(getModalValue(interaction, 'from')),
          to: parseChessSquare(getModalValue(interaction, 'to')),
        };
        const promotion = parsePromotion(getModalValue(interaction, 'promotion'));
        if (promotion) action.promotion = promotion;
        return action;
      },
      'offer-draw': simpleAction('offer-draw'),
      'accept-draw': simpleAction('accept-draw'),
      'claim-draw': simpleAction('claim-draw'),
      resign: simpleAction('resign'),
    }),
    gomoku: Object.freeze({
      place: ({ interaction, publicView }) => ({ type: 'place', ...parseGridCoordinate(getModalValue(interaction, 'position'), publicView.board) }),
      'offer-draw': simpleAction('offer-draw'),
      'accept-draw': simpleAction('accept-draw'),
      resign: simpleAction('resign'),
    }),
    go: Object.freeze({
      move: ({ interaction, publicView }) => ({ type: 'move', ...parseGridCoordinate(getModalValue(interaction, 'position'), publicView.board) }),
      pass: simpleAction('pass'),
      'propose-dead': ({ interaction, publicView }) => {
        const coordinates = splitCoordinates(getModalValue(interaction, 'positions'))
          .map((value) => parseGridCoordinate(value, publicView.board));
        if (!coordinates.length) throw new BoardCoreError('INVALID_COORDINATE', '請至少輸入一個死子座標。');
        return { type: 'propose-dead', coordinates };
      },
      'confirm-dead': simpleAction('confirm-dead'),
      'resume-play': simpleAction('resume-play'),
      resign: simpleAction('resign'),
    }),
    checkers: Object.freeze({
      move: ({ interaction }) => ({ type: 'move', path: parseCheckersPath(getModalValue(interaction, 'path')) }),
      resign: simpleAction('resign'),
    }),
    xiangqi: Object.freeze({
      move: createGridMoveParser(),
      'offer-draw': simpleAction('offer-draw'),
      'accept-draw': simpleAction('accept-draw'),
      'decline-draw': simpleAction('decline-draw'),
      resign: simpleAction('resign'),
    }),
  });
}

function getModalDefinition(gameKey, controlId) {
  return MODAL_DEFINITIONS[gameKey]?.[controlId] || null;
}

function getControls(gameKey) {
  return (CONTROL_DEFINITIONS[gameKey] || []).map((control) => ({ ...control }));
}

async function decorateBoardResult(result, { store, scenarioProvider = null } = {}) {
  const decorated = cloneJson(result, 'board result');
  if (decorated.game) decorated.game.controls = getControls(decorated.session.gameKey);
  if (decorated.session.gameKey !== 'turtle-soup' || !decorated.game || !scenarioProvider) return decorated;

  try {
    const session = await store.getSessionById(decorated.session.id);
    if (!session?.state?.scenarioId || !Number.isSafeInteger(session.state.scenarioVersion)) return decorated;
    const scenario = scenarioProvider.loadScenario({
      scenarioId: session.state.scenarioId,
      scenarioVersion: session.state.scenarioVersion,
    });
    decorated.game.prompts = [
      { type: 'scenario', text: scenario.publicPrompt },
      ...(decorated.game.prompts || []).filter((prompt) => prompt?.type !== 'scenario'),
    ];
  } catch (_error) {
    // Corpus failures must never disclose private content or damage the stored session.
  }
  return decorated;
}

module.exports = {
  CONTROL_DEFINITIONS,
  GAME_CHOICES,
  MODAL_DEFINITIONS,
  createActionParsers,
  decorateBoardResult,
  getControls,
  getModalDefinition,
  parseCheckersPath,
  parseChessSquare,
  parsePromotion,
  splitCoordinates,
};
