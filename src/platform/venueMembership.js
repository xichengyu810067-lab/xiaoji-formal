const { CoinServiceError } = require('../services/coinService');

function membershipError() {
  return new CoinServiceError('VENUE_MEMBERSHIP_UNVERIFIED', '目前無法核實場館工作人員是否在此伺服器，請稍後再試。');
}

function validMember(member, guildId, userId) {
  return member?.id === userId && member.guild?.id === guildId && !member.user?.bot;
}

async function verifyVenueMembers(guild, { userIds = [], completeRoster = false } = {}) {
  if (!guild?.id || typeof guild.members?.fetch !== 'function') throw membershipError();
  const requestedIds = [...new Set(userIds.filter(Boolean).map(String))];

  if (completeRoster) {
    const memberCount = guild.memberCount;
    if (!Number.isSafeInteger(memberCount) || memberCount < 1) throw membershipError();
    let roster;
    try {
      roster = await guild.members.fetch();
    } catch {
      throw membershipError();
    }
    if (roster?.size !== memberCount || typeof roster.values !== 'function') throw membershipError();
    const verifiedUserIds = [];
    for (const member of roster.values()) {
      if (!member?.id || member.guild?.id !== guild.id) throw membershipError();
      if (!member.user?.bot) verifiedUserIds.push(member.id);
    }
    if (new Set(verifiedUserIds).size !== verifiedUserIds.length ||
        requestedIds.some((id) => !verifiedUserIds.includes(id))) throw membershipError();
    return { guildId: guild.id, verifiedUserIds, rosterComplete: true };
  }

  const verifiedUserIds = [];
  for (const userId of requestedIds) {
    let member;
    try {
      member = await guild.members.fetch(userId);
    } catch {
      throw membershipError();
    }
    if (!validMember(member, guild.id, userId)) throw membershipError();
    verifiedUserIds.push(userId);
  }
  return { guildId: guild.id, verifiedUserIds, rosterComplete: false };
}

module.exports = { verifyVenueMembers };
