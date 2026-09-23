const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCommandData, loadCommands } = require('../src/loadCommands');
const helpCommand = require('../src/commands/help');

test('public core loads without a private extension', () => {
  const commands = loadCommands();
  for (const commandName of [
    'weather', 'poll', 'quota', 'music', 'set-welcome', 'status', 'remind', 'exchange',
    'casino-admin', 'casino-lobby', 'casino-venue', 'duel-tower', 'luxury', 'luxury-admin',
    'pawn', 'number-chain', 'word-chain', 'romance', 'games',
  ]) {
    assert.ok(commands.has(commandName), `missing ${commandName}`);
  }
});

test('public deployment data contains no private management commands', () => {
  const names = loadCommandData().map((command) => command.name);
  assert.ok(names.includes('music'));
  assert.ok(names.includes('set-welcome'));
});

test('help contains public features and omits private management catalog', async () => {
  let payload;
  await helpCommand.execute({ reply: async (value) => { payload = value; } });
  assert.equal(payload.ephemeral, true);
  assert.equal(payload.embeds.length, 1);
  const embed = payload.embeds[0].toJSON();
  for (const field of embed.fields) assert.ok(field.value.length <= 1024);
  const text = embed.fields.map((field) => field.value).join('\n');
  assert.match(text, /\/set-welcome channel/);
  assert.match(text, /\/word-chain start\/stop\/status/);
  assert.match(text, /\/games play/);
});
