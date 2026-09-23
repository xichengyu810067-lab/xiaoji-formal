(function bootstrapXiaojiGame() {
  'use strict';

  const labels = Object.freeze({ tetris: '俄羅斯方塊', 'number-match': '數字配對', sudoku: '數獨' });
  const difficultyLabels = Object.freeze({ easy: '簡單', normal: '一般', complex: '複雜', hard: '困難' });
  const errorLabels = Object.freeze({
    missing_launch_token: '請回到 Discord 使用 /games play，由小吉建立一次性遊戲連結。',
    token_invalid: '這個遊戲連結已使用或無效，請回 Discord 重新建立。',
    session_expired: '遊戲連結已逾時，請回 Discord 重新建立。',
    replay_mismatch: '動作順序不一致，為保護獎勵，這局已停止同步。',
    rate_limited: '操作太快囉，稍等一下再繼續。',
  });
  const TETROMINOES = Object.freeze([
    [[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [2, 0], [1, 1]], [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [0, 1], [1, 1]], [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[2, 0], [0, 1], [1, 1], [2, 1]],
  ]);

  const root = document.querySelector('[data-game-root]');
  const gameType = root?.dataset.game;
  const apiMeta = document.querySelector('meta[name="xiaoji-game-api-base"]')?.content;
  let currentSession = null;
  let selectedPair = null;
  let selectedSudokuCell = null;
  let tetrisColumn = 3;
  let tetrisRotation = 0;
  let busy = false;

  function setMessage(message, tone = 'neutral') {
    const element = document.querySelector('[data-game-message]');
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function setBusy(value) {
    busy = value;
    document.querySelectorAll('[data-game-action]').forEach((button) => { button.disabled = value; });
    root?.setAttribute('aria-busy', String(value));
  }

  function renderMeta(session) {
    document.querySelector('[data-game-title]').textContent = labels[session.game];
    document.querySelector('[data-game-difficulty]').textContent = difficultyLabels[session.difficulty];
    document.querySelector('[data-game-turn]').textContent = String(session.actionCount);
    const reward = session.status === 'completed' && Number.isSafeInteger(session.reward) && session.reward >= 0
      ? session.reward
      : null;
    document.querySelector('[data-game-reward]').textContent = reward === null ? '完成後結算' : `${reward} 吉幣`;
    if (session.status === 'completed') {
      setMessage(reward > 0
        ? `遊戲完成！小吉已依伺服器驗證結果結算 ${reward} 吉幣。`
        : '遊戲結束。這一局未達獎勵條件，再挑戰一次吧！', reward > 0 ? 'success' : 'neutral');
    }
  }

  function rotateShape(shape, rotations) {
    let result = shape.map(([x, y]) => [x, y]);
    for (let turn = 0; turn < rotations; turn += 1) result = result.map(([x, y]) => [-y, x]);
    const minX = Math.min(...result.map(([x]) => x));
    const minY = Math.min(...result.map(([, y]) => y));
    return result.map(([x, y]) => [x - minX, y - minY]);
  }

  async function getTetrisShape(state) {
    const bytes = new TextEncoder().encode(`${state.seed}:${state.pieceIndex}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const value = (((digest[0] * 256 + digest[1]) * 256 + digest[2]) * 256 + digest[3]) / 0x100000000;
    return rotateShape(TETROMINOES[Math.floor(value * TETROMINOES.length)], tetrisRotation);
  }

  function drawGrid(canvas, cells, rows, columns, activeColor = '#ff78a9') {
    const context = canvas.getContext('2d');
    const width = canvas.width / columns;
    const height = canvas.height / rows;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#2e2948';
    context.fillRect(0, 0, canvas.width, canvas.height);
    cells.forEach((cell, index) => {
      const x = index % columns;
      const y = Math.floor(index / columns);
      context.fillStyle = cell ? activeColor : 'rgba(255,255,255,.055)';
      context.fillRect(x * width + 1, y * height + 1, width - 2, height - 2);
    });
  }

  async function renderTetris(session) {
    const state = session.state;
    if (!Array.isArray(state.board) || state.board.length !== 20) throw new Error('invalid_tetris_state');
    drawGrid(document.querySelector('[data-tetris-board]'), state.board.flat(), 20, 10);
    document.querySelector('[data-tetris-score]').textContent = String(Number(state.score) || 0);
    document.querySelector('[data-tetris-combo]').textContent = String(Number(state.streak) || 0);
    const shape = await getTetrisShape(state);
    const width = Math.max(...shape.map(([x]) => x)) + 1;
    tetrisColumn = Math.min(tetrisColumn, 10 - width);
    const slider = document.querySelector('[data-tetris-column]');
    slider.max = String(10 - width);
    slider.value = String(tetrisColumn);
    document.querySelector('[data-tetris-column-label]').textContent = String(tetrisColumn + 1);
    const preview = Array(16).fill(0);
    shape.forEach(([x, y]) => { preview[y * 4 + x] = 1; });
    drawGrid(document.querySelector('[data-tetris-preview]'), preview, 4, 4, '#bda1ff');
    if (session.status !== 'active') document.querySelector('[data-tetris-controls]').hidden = true;
  }

  function createNumberButton(value, index, session) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'number-tile';
    button.dataset.gameAction = '';
    button.textContent = value == null ? '' : String(value);
    button.disabled = busy || value == null || session.status !== 'active';
    if (selectedPair === index) button.classList.add('is-selected');
    button.addEventListener('click', async () => {
      if (selectedPair == null) {
        selectedPair = index;
        renderNumberMatch(currentSession);
        setMessage('再選一個上下左右相鄰的數字。');
        return;
      }
      const first = selectedPair;
      selectedPair = null;
      if (first === index) { renderNumberMatch(currentSession); return; }
      await submitAction({ type: 'pair', first, second: index });
    });
    return button;
  }

  function renderNumberMatch(session) {
    const state = session.state;
    if (!Array.isArray(state.board) || !Number.isInteger(state.columns)) throw new Error('invalid_number_match_state');
    const board = document.querySelector('[data-number-board]');
    board.style.setProperty('--columns', String(state.columns));
    board.classList.toggle('is-complete', Boolean(state.completed));
    if (state.completed) {
      const completion = document.createElement('div');
      completion.className = 'completion-badge';
      completion.textContent = '全數消除 ✦';
      board.replaceChildren(completion);
    } else {
      board.replaceChildren(...state.board.map((value, index) => createNumberButton(value, index, session)));
    }
    document.querySelector('[data-number-left]').textContent = String(state.board.filter((value) => value != null).length);
  }

  function createSudokuCell(value, row, column, puzzle, session) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sudoku-cell';
    button.textContent = value ? String(value) : '';
    const given = puzzle[row][column] !== 0;
    if (given) button.classList.add('is-given');
    if (selectedSudokuCell?.row === row && selectedSudokuCell?.column === column) button.classList.add('is-selected');
    button.disabled = given || session.status !== 'active' || busy;
    button.dataset.gameAction = '';
    button.setAttribute('aria-label', `第 ${row + 1} 列第 ${column + 1} 格${value ? `，${value}` : '，空白'}`);
    button.addEventListener('click', () => {
      selectedSudokuCell = { row, column };
      renderSudoku(currentSession);
      setMessage('選擇要填入的數字；也可以按清除。');
    });
    return button;
  }

  function renderSudoku(session) {
    const { entries, puzzle } = session.state;
    if (!Array.isArray(entries) || entries.length !== 9 || !Array.isArray(puzzle) || puzzle.length !== 9) throw new Error('invalid_sudoku_state');
    const board = document.querySelector('[data-sudoku-board]');
    const cells = [];
    for (let row = 0; row < 9; row += 1) for (let column = 0; column < 9; column += 1) cells.push(createSudokuCell(entries[row][column], row, column, puzzle, session));
    board.replaceChildren(...cells);
    document.querySelectorAll('[data-sudoku-value]').forEach((button) => { button.disabled = busy || !selectedSudokuCell || session.status !== 'active'; });
  }

  async function renderSession(session) {
    if (session.game !== gameType) throw new Error('wrong_game_page');
    currentSession = session;
    renderMeta(session);
    if (session.game === 'tetris') await renderTetris(session);
    else if (session.game === 'number-match') renderNumberMatch(session);
    else renderSudoku(session);
  }

  let gameApi;
  async function submitAction(action) {
    if (busy || currentSession?.status !== 'active') return;
    setBusy(true);
    setMessage('小吉正在驗證這一步…');
    try {
      await renderSession(await gameApi.submit(action));
      if (currentSession.status === 'active') setMessage('驗證完成，可以繼續！', 'success');
    } catch (error) {
      setMessage(errorLabels[error.code] || '這一步無法完成；沒有通過驗證，也不會發放獎勵。', 'error');
    } finally {
      setBusy(false);
      if (currentSession) await renderSession(currentSession);
    }
  }

  function bindTetrisControls() {
    const slider = document.querySelector('[data-tetris-column]');
    slider.addEventListener('input', () => {
      tetrisColumn = Number(slider.value);
      document.querySelector('[data-tetris-column-label]').textContent = String(tetrisColumn + 1);
    });
    document.querySelector('[data-tetris-left]').addEventListener('click', () => { tetrisColumn = Math.max(0, tetrisColumn - 1); slider.value = String(tetrisColumn); slider.dispatchEvent(new Event('input')); });
    document.querySelector('[data-tetris-right]').addEventListener('click', () => { tetrisColumn = Math.min(Number(slider.max), tetrisColumn + 1); slider.value = String(tetrisColumn); slider.dispatchEvent(new Event('input')); });
    document.querySelector('[data-tetris-rotate]').addEventListener('click', async () => { tetrisRotation = (tetrisRotation + 1) % 4; if (currentSession) await renderTetris(currentSession); });
    document.querySelector('[data-tetris-drop]').addEventListener('click', () => submitAction({ type: 'lock', column: tetrisColumn, rotation: tetrisRotation }));
    document.addEventListener('keydown', (event) => {
      if (busy || currentSession?.status !== 'active') return;
      if (event.key === 'ArrowLeft') document.querySelector('[data-tetris-left]').click();
      else if (event.key === 'ArrowRight') document.querySelector('[data-tetris-right]').click();
      else if (event.key === 'ArrowUp') document.querySelector('[data-tetris-rotate]').click();
      else if (event.code === 'Space') { event.preventDefault(); document.querySelector('[data-tetris-drop]').click(); }
    });
  }

  function bindSudokuControls() {
    document.querySelectorAll('[data-sudoku-value]').forEach((button) => {
      button.addEventListener('click', () => {
        if (selectedSudokuCell) submitAction({ type: 'set', ...selectedSudokuCell, value: Number(button.dataset.sudokuValue) });
      });
    });
  }

  async function boot() {
    try {
      const apiBase = XiaojiGameClientCore.normalizeApiBase(apiMeta, window.location.origin);
      const launchToken = XiaojiGameClientCore.consumeLaunchToken(window.location, window.history);
      gameApi = XiaojiGameClientCore.createGameApi({ fetchImpl: window.fetch.bind(window), apiBase });
      if (gameType === 'tetris') bindTetrisControls();
      if (gameType === 'sudoku') bindSudokuControls();
      setBusy(true);
      setMessage('小吉正在驗證一次性遊戲連結…');
      await renderSession(await gameApi.exchange(launchToken));
      setMessage('連結驗證完成，開始遊戲吧！', 'success');
    } catch (error) {
      root?.classList.add('is-unavailable');
      setMessage(errorLabels[error.message] || errorLabels[error.code] || '遊戲服務目前無法使用，請稍後再試。', 'error');
    } finally {
      setBusy(false);
      if (currentSession) await renderSession(currentSession);
    }
  }

  boot();
})();
