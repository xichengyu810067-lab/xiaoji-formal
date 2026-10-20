'use strict';

// What an administrator reads of today's daily riddle and daily discussion in the status commands: the state of the
// event in Chinese, and a state the commands do not know as it is stored. Only fake Discord objects and a synthetic
// database in a temporary directory are used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-daily-status-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = 'owner-user';

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
} = require('../src/services/coinDatabase');
const riddleService = require('../src/services/dailyRiddleService');
const discussionService = require('../src/services/dailyDiscussionService');
const { dailyEventStatusLabels, formatDailyEventStatus } = require('../src/utils/dailyEventStatus');
const { getTaipeiDateKey } = require('../src/utils/taipeiClock');
const riddleCommand = require('../src/commands/daily-riddle');
const discussionCommand = require('../src/commands/daily-discussion');
const logger = require('../src/utils/logger');

const STORED_STATUSES = ['claimed', 'published', 'published_late', 'settling', 'rewarding', 'settled', 'blocked', 'missed', 'failed'];

test.before(async () => {
  resetCoinDatabaseForTests();
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test('every stored daily event state has a Chinese label, and an unknown one is shown as stored', () => {
  assert.deepEqual(Object.keys(dailyEventStatusLabels).sort(), [...STORED_STATUSES].sort());
  for (const status of STORED_STATUSES) {
    const label = formatDailyEventStatus(status);
    assert.match(label, /[一-鿿]/u, status);
    assert.doesNotMatch(label, /[A-Za-z_]/u, status);
  }
  assert.equal(formatDailyEventStatus('published_late'), '已發布（比預定時間晚），進行中');
  assert.equal(formatDailyEventStatus('some_future_state'), 'some_future_state');
  assert.equal(formatDailyEventStatus('constructor'), 'constructor');
  assert.equal(formatDailyEventStatus(undefined), '尚未建立');
  assert.equal(formatDailyEventStatus(null), '尚未建立');
});

function createStatusInteraction(guildId) {
  const replies = [];
  return {
    replies,
    interaction: {
      commandName: 'daily',
      guildId,
      channelId: 'room',
      user: { id: 'owner-user' },
      memberPermissions: { has: () => true },
      guild: { id: guildId, members: { me: { permissions: { has: () => true } }, fetch: async () => null } },
      deferred: false,
      replied: false,
      inGuild: () => true,
      options: { getSubcommand: () => 'status' },
      reply: async (payload) => { replies.push(payload); },
      followUp: async (payload) => { replies.push(payload); },
    },
  };
}

test('/daily-riddle status and /daily-discussion status show today\'s event state in Chinese', async () => {
  const today = getTaipeiDateKey();
  const todayNoon = new Date(`${today}T11:00:00+08:00`);
  const cases = [
    ['riddle', riddleCommand, async (guildId) => riddleService.claimDailyRiddleEvent({
      guildId, parentChannelId: 'parent', localDate: today, now: todayNoon }), '每日猜謎'],
    ['discussion', discussionCommand, async (guildId) => discussionService.claimDailyDiscussionEvent({
      guildId, parentChannelId: 'parent', localDate: today, now: todayNoon }), '每日議題'],
  ];
  const original = { warn: logger.warn, error: logger.error };
  logger.warn = () => {};
  logger.error = () => {};
  try {
    for (const [name, command, claim, title] of cases) {
      const guildId = `status-${name}-guild`;
      // No event yet.
      const none = createStatusInteraction(guildId);
      await command.execute(none.interaction);
      assert.match(none.replies[0].content, new RegExp(`^${title}：已停用\\n父頻道：尚未設定\\n今日活動：尚未建立$`, 'u'), name);

      await claim(guildId);
      for (const status of STORED_STATUSES) {
        await withCoinDatabase((api) => api.run('UPDATE daily_events SET status = ? WHERE guild_id = ?', [status, guildId]));
        const run = createStatusInteraction(guildId);
        await command.execute(run.interaction);
        assert.equal(run.replies.length, 1, `${name} ${status}`);
        assert.ok(run.replies[0].content.endsWith(`今日活動：${dailyEventStatusLabels[status]}`), `${name} ${status}: ${run.replies[0].content}`);
        assert.ok(!run.replies[0].content.includes(status), `${name} ${status} must not show the stored word`);
      }
    }
  } finally {
    Object.assign(logger, original);
  }
});
