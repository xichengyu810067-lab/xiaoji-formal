'use strict';

// How interactionCreate answers an AutocompleteInteraction, a chat input command and a button. Guilds are no longer
// reviewed: whatever status an earlier version recorded for a guild (pending, unknown, denied, or none at all), its
// members are served as in any other guild, and the record is left as it was. Every respond() failure (an expired
// interaction, code 10062, or anything else) must be swallowed with only its code logged, never become an unhandled
// rejection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-interaction-audit-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = 'owner-user';

const { initializeNewCoinDatabase, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const interactionCreate = require('../src/events/interactionCreate');
const logger = require('../src/utils/logger');

const APPROVED_GUILD = 'approved-guild';
const PENDING_GUILD = 'pending-guild';
const UNKNOWN_GUILD = 'unknown-guild';
const DENIED_GUILD = 'denied-guild';
const UNRECORDED_GUILD = 'never-seen-guild';
const EVERY_GUILD = [APPROVED_GUILD, PENDING_GUILD, UNKNOWN_GUILD, DENIED_GUILD, UNRECORDED_GUILD];

const AUDIT_FILE_TEXT = `${JSON.stringify({
  [APPROVED_GUILD]: { status: 'approved' },
  [PENDING_GUILD]: { status: 'pending' },
  [UNKNOWN_GUILD]: { status: 'unknown', manualAudit: true },
  [DENIED_GUILD]: { status: 'denied', reason: 'Audit timeout (24h)' },
}, null, 2)}\n`;
fs.writeFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, AUDIT_FILE_TEXT);
fs.writeFileSync(process.env.XIAOJI_INVITER_WHITELIST_PATH, '[]\n');

test.before(async () => {
  resetCoinDatabaseForTests();
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// A real AutocompleteInteraction can only respond() with suggestions: it has no reply(), followUp() or deferReply().
function createAutocomplete({ guildId, userId = 'stranger', respond, onAutocomplete = async () => {}, commands = null }) {
  return {
    client: { commands: commands || new Map([['board', { autocomplete: async (interaction) => onAutocomplete(interaction) }]]) },
    guildId,
    channelId: 'room',
    user: { id: userId },
    commandName: 'board',
    responded: false,
    isAutocomplete: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => false,
    respond,
  };
}

function expiredInteraction() {
  return Object.assign(new Error('Unknown interaction with token detail'), { code: 10062 });
}

async function captureLogs(run) {
  const logs = { warnings: [], errors: [] };
  const originalWarn = logger.warn;
  const originalError = logger.error;
  logger.warn = (message) => { logs.warnings.push(String(message)); };
  logger.error = (message, cause) => { logs.errors.push({ message: String(message), cause }); };
  try {
    await run();
  } finally {
    logger.warn = originalWarn;
    logger.error = originalError;
  }
  return logs;
}

test('任何狀態的伺服器（核准、待審、未知、已拒絕、沒有紀錄）的 autocomplete 都照常交給指令', async () => {
  for (const guildId of EVERY_GUILD) {
    for (const userId of ['stranger', 'owner-user']) {
      const responses = [];
      let commandCalls = 0;
      const interaction = createAutocomplete({
        guildId,
        userId,
        respond: async (choices) => { responses.push(choices); },
        onAutocomplete: async () => { commandCalls += 1; },
      });

      await assert.doesNotReject(() => interactionCreate.execute(interaction));

      assert.equal(commandCalls, 1, `${guildId}/${userId}`);
      assert.deepEqual(responses, [], `${guildId}/${userId}`);
    }
  }
});

test('任何狀態的伺服器的指令都照常執行，沒有任何審核提示，審核紀錄檔也不被改動', async () => {
  for (const guildId of EVERY_GUILD) {
    const replies = [];
    let executed = 0;
    const interaction = {
      client: { commands: new Map([['board', { execute: async () => { executed += 1; } }]]) },
      guildId,
      channelId: 'room',
      user: { id: 'stranger' },
      commandName: 'board',
      replied: false,
      deferred: false,
      isAutocomplete: () => false,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isChatInputCommand: () => true,
      reply: async (payload) => { replies.push(payload); },
    };

    await interactionCreate.execute(interaction);

    assert.equal(executed, 1, guildId);
    assert.deepEqual(replies, [], guildId);
  }
  assert.equal(fs.readFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, 'utf8'), AUDIT_FILE_TEXT);
});

test('任何狀態的伺服器的按鈕互動都交給對應的處理器，不再收到審核提示', async () => {
  for (const guildId of EVERY_GUILD) {
    const handled = [];
    const replies = [];
    const interaction = {
      client: {
        commands: new Map([['coin-admin', { handleComponent: async (value) => { handled.push(value.customId); } }]]),
      },
      guildId,
      channelId: 'room',
      user: { id: 'stranger' },
      customId: 'coin-admin|1|add|synthetic',
      replied: false,
      deferred: false,
      isAutocomplete: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isChatInputCommand: () => false,
      reply: async (payload) => { replies.push(payload); },
    };

    await interactionCreate.execute(interaction);

    assert.deepEqual(handled, ['coin-admin|1|add|synthetic'], guildId);
    assert.deepEqual(replies, [], guildId);
  }
});

test('指令沒有 autocomplete 處理器時回空清單；互動已過期（10062）時吞掉錯誤並只記錄代碼', async () => {
  for (const commands of [new Map(), new Map([['board', {}]])]) {
    const responses = [];
    const answered = createAutocomplete({
      guildId: APPROVED_GUILD, commands, respond: async (choices) => { responses.push(choices); },
    });
    await interactionCreate.execute(answered);
    assert.deepEqual(responses, [[]]);

    const expired = createAutocomplete({
      guildId: APPROVED_GUILD, commands, respond: async () => { throw expiredInteraction(); },
    });
    const logs = await captureLogs(async () => {
      await assert.doesNotReject(() => interactionCreate.execute(expired));
    });
    assert.equal(logs.warnings.length, 1);
    assert.match(logs.warnings[0], /code=10062/u);
    assert.doesNotMatch(logs.warnings[0], /token detail|Unknown interaction/u);
    assert.deepEqual(logs.errors, []);
  }
});

test('指令的 autocomplete 失敗時記錄指令錯誤並補回空清單；補回時互動已過期（10062）也被吞掉', async () => {
  const responses = [];
  const failing = createAutocomplete({
    guildId: APPROVED_GUILD,
    onAutocomplete: async () => { throw new Error('synthetic autocomplete failure'); },
    respond: async (choices) => { responses.push(choices); },
  });
  const recovered = await captureLogs(() => interactionCreate.execute(failing));
  assert.deepEqual(responses, [[]]);
  assert.equal(recovered.errors.length, 1);
  assert.match(recovered.errors[0].message, /\/board autocomplete failed/u);
  assert.deepEqual(recovered.warnings, []);

  const expired = createAutocomplete({
    guildId: APPROVED_GUILD,
    onAutocomplete: async () => { throw new Error('synthetic autocomplete failure'); },
    respond: async () => { throw expiredInteraction(); },
  });
  const swallowed = await captureLogs(async () => {
    await assert.doesNotReject(() => interactionCreate.execute(expired));
  });
  assert.equal(swallowed.errors.length, 1);
  assert.equal(swallowed.warnings.length, 1);
  assert.match(swallowed.warnings[0], /code=10062/u);
  assert.doesNotMatch(swallowed.warnings[0], /token detail|Unknown interaction/u);
});

test('指令自己的 respond 因互動過期（10062）失敗時，整個事件處理不拋出，也沒有未處理的 rejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const interaction = createAutocomplete({
      guildId: APPROVED_GUILD,
      onAutocomplete: async (value) => value.respond([{ name: 'a', value: 'a' }]),
      respond: async () => { throw expiredInteraction(); },
    });

    const logs = await captureLogs(async () => {
      await assert.doesNotReject(() => interactionCreate.execute(interaction));
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.equal(logs.errors.length, 1);
    assert.equal(logs.warnings.length, 1);
    assert.match(logs.warnings[0], /code=10062/u);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('指令的 autocomplete 已經回應過才失敗時，不再補空清單', async () => {
  let respondCalls = 0;
  const interaction = createAutocomplete({
    guildId: APPROVED_GUILD,
    onAutocomplete: async (value) => { value.responded = true; throw new Error('late failure'); },
    respond: async () => { respondCalls += 1; },
  });

  const logs = await captureLogs(() => interactionCreate.execute(interaction));

  assert.equal(respondCalls, 0);
  assert.equal(logs.errors.length, 1);
});
