const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-riddle-alias-'));
process.env.COIN_DB_PATH = path.join(tempRoot, 'synthetic.sqlite');
const { riddles } = require('../src/services/dailyRiddleCorpus');
const { isCorrectDailyRiddleAnswer } = require('../src/services/dailyRiddleService');

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('r021 accepts only its four stated answer forms, including normalized input', () => {
  const riddle = riddles.find((entry) => entry.id === 'r021');
  assert.ok(riddle);
  for (const answer of ['4', '四', '四個', '4個', '４個', '答案是：４個！']) {
    assert.equal(isCorrectDailyRiddleAnswer(answer, riddle), true, answer);
  }
  for (const answer of ['5個', '4種', '四條', '四個方位']) {
    assert.equal(isCorrectDailyRiddleAnswer(answer, riddle), false, answer);
  }
});
