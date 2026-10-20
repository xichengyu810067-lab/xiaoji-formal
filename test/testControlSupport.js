'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  TEST_DATA_ROOT_MARKER,
  readDataRootIdentity,
  serializeTestDataRootMarker,
} = require('../src/platform/testControlPolicy');
const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');

const IDS = Object.freeze({
  app: '111111111111111111',
  formal: '222222222222222222',
  guild: '333333333333333333',
  channel: '444444444444444444',
  actor: '555555555555555555',
  interaction: '666666666666666666',
  otherGuild: '777777777777777777',
  otherChannel: '888888888888888888',
});

const DATA_FILES = Object.freeze({
  COIN_DB_PATH: 'xiaoji.sqlite',
  XIAOJI_AUDIT_DATA_PATH: 'guildAudit.json',
  XIAOJI_INVITER_WHITELIST_PATH: 'inviterWhitelist.json',
  XIAOJI_REMINDERS_PATH: 'reminders.json',
  XIAOJI_CALENDAR_PATH: 'calendarEvents.json',
  AI_CONVERSATION_PATH: 'aiConversationHistory.json',
  XIAOJI_MEMORY_PATH: 'xiaojiMemory.json',
});

function writeTestRootMarker(root, applicationId = IDS.app) {
  const markerPath = path.join(root, TEST_DATA_ROOT_MARKER);
  fs.writeFileSync(markerPath, serializeTestDataRootMarker(applicationId, readDataRootIdentity(root)));
  return markerPath;
}

function createFixture(overrides = {}) {
  const parent = makeRealTempDir('xiaoji-test-control-');
  const root = path.join(parent, 'isolated-data');
  fs.mkdirSync(root);
  for (const file of ['guildConfig.json', 'polls.json', 'guildQuotas.json']) {
    fs.writeFileSync(path.join(root, file), '{}');
  }
  const env = {
    XIAOJI_RUNTIME_MODE: 'test-control',
    XIAOJI_TEST_MODE: 'true',
    XIAOJI_TEST_LAUNCHER: 'true',
    XIAOJI_TEST_EXPECTED_APPLICATION_ID: IDS.app,
    XIAOJI_TEST_FORBIDDEN_APPLICATION_IDS: IDS.formal,
    XIAOJI_TEST_ALLOWED_GUILD_IDS: IDS.guild,
    XIAOJI_TEST_ALLOWED_CHANNEL_IDS: IDS.channel,
    XIAOJI_TEST_ALLOWED_ACTOR_IDS: IDS.actor,
    XIAOJI_TEST_ALLOWED_COMMANDS: 'ping',
    XIAOJI_TEST_ALLOWED_COMPONENT_PREFIXES: 'poll:',
    XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES: '',
    XIAOJI_TEST_ALLOWED_EVENTS: '',
    XIAOJI_TEST_ALLOWED_JOBS: '',
    XIAOJI_TEST_DATA_ROOT: root,
    XIAOJI_DATA_ROOT: root,
    DISCORD_TOKEN: 'synthetic-token',
    DISCORD_CLIENT_ID: IDS.app,
    BOT_OWNER_ID: IDS.actor,
    AUTO_DEPLOY_COMMANDS: 'false',
  };
  for (const [name, file] of Object.entries(DATA_FILES)) {
    const filePath = path.join(root, file);
    fs.writeFileSync(filePath, name === 'COIN_DB_PATH' ? 'synthetic' : '{}');
    env[name] = filePath;
  }
  Object.assign(env, overrides);
  const markerPath = writeTestRootMarker(root, env.XIAOJI_TEST_EXPECTED_APPLICATION_ID);
  return {
    env,
    markerPath,
    parent,
    root,
    cleanup() {
      removeRealTempDir(parent);
    },
  };
}

module.exports = { DATA_FILES, IDS, createFixture, writeTestRootMarker };
