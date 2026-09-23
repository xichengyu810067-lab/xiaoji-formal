const test = require('node:test');
const assert = require('node:assert/strict');
const { getPollCounts, validatePollInput } = require('../src/services/pollService');

test('validatePollInput accepts a normal poll', () => {
  const result = validatePollInput('Lunch?', ['Rice', 'Noodles'], 10);
  assert.equal(result.ok, true);
  assert.deepEqual(result.options, ['Rice', 'Noodles']);
});

test('validatePollInput rejects duplicate options', () => {
  const result = validatePollInput('Lunch?', ['Rice', 'rice'], 10);
  assert.equal(result.ok, false);
});

test('getPollCounts counts one vote per user', () => {
  const counts = getPollCounts({
    options: ['A', 'B', 'C'],
    votes: {
      user1: 0,
      user2: 1,
      user3: 1,
    },
  });

  assert.deepEqual(counts, [1, 2, 0]);
});
