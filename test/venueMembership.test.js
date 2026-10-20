const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyVenueMembers } = require('../src/platform/venueMembership');

function member(id, guildId = '100', bot = false) {
  return { id, guild: { id: guildId }, user: { bot } };
}

function guild(roster, { memberCount = roster.length, fail = false } = {}) {
  const members = new Map(roster.map((item) => [item.id, item]));
  return {
    id: '100',
    memberCount,
    members: {
      async fetch(id) {
        if (fail) throw new Error('Discord unavailable');
        if (id) return members.get(id);
        return members;
      },
    },
  };
}

test('venue membership verifies named humans in the current guild', async () => {
  const result = await verifyVenueMembers(guild([member('1'), member('2')]), { userIds: ['1', '2', '1'] });
  assert.deepEqual(result, { guildId: '100', verifiedUserIds: ['1', '2'], rosterComplete: false });
  await assert.rejects(() => verifyVenueMembers(guild([member('1', '200')]), { userIds: ['1'] }), { code: 'VENUE_MEMBERSHIP_UNVERIFIED' });
  // A bot is refused for being a bot, in words that do not suggest trying again later.
  await assert.rejects(() => verifyVenueMembers(guild([member('1', '100', true)]), { userIds: ['1'] }), {
    code: 'VENUE_STAFF_IS_BOT', message: '機器人不能擔任服務生、廚師或調酒師，請改選真人成員。',
  });
  // A bot of another server is not found here, so it stays an unverified member rather than a named bot.
  await assert.rejects(() => verifyVenueMembers(guild([member('1', '200', true)]), { userIds: ['1'] }), { code: 'VENUE_MEMBERSHIP_UNVERIFIED' });
});

test('venue auto assignment requires the complete verified roster', async () => {
  const roster = guild([member('1'), member('2'), member('3', '100', true)]);
  assert.deepEqual(await verifyVenueMembers(roster, { userIds: ['1'], completeRoster: true }), {
    guildId: '100', verifiedUserIds: ['1', '2'], rosterComplete: true,
  });
  await assert.rejects(() => verifyVenueMembers(guild([member('1')], { memberCount: 2 }), { completeRoster: true }), { code: 'VENUE_MEMBERSHIP_UNVERIFIED' });
  await assert.rejects(() => verifyVenueMembers(guild([member('1')], { fail: true }), { completeRoster: true }), { code: 'VENUE_MEMBERSHIP_UNVERIFIED' });
  await assert.rejects(() => verifyVenueMembers(roster, { userIds: ['3'], completeRoster: true }), { code: 'VENUE_STAFF_IS_BOT' });
  await assert.rejects(() => verifyVenueMembers(roster, { userIds: ['1', '3'], completeRoster: true }), { code: 'VENUE_STAFF_IS_BOT' });
  await assert.rejects(() => verifyVenueMembers(roster, { userIds: ['9'], completeRoster: true }), { code: 'VENUE_MEMBERSHIP_UNVERIFIED' });
});
