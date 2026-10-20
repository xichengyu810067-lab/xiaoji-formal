const { CoinServiceError } = require('../services/coinService');

function membershipError() {
  return new CoinServiceError('VENUE_MEMBERSHIP_UNVERIFIED', '目前無法核實場館工作人員是否在此伺服器，請稍後再試。');
}

// A bot is refused for what it is, so the answer does not read like a lookup that may work later.
function botStaffError() {
  return new CoinServiceError('VENUE_STAFF_IS_BOT', '機器人不能擔任服務生、廚師或調酒師，請改選真人成員。');
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
    const botUserIds = new Set();
    for (const member of roster.values()) {
      if (!member?.id || member.guild?.id !== guild.id) throw membershipError();
      if (member.user?.bot) botUserIds.add(member.id);
      else verifiedUserIds.push(member.id);
    }
    if (requestedIds.some((id) => botUserIds.has(id))) throw botStaffError();
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
    if (member?.id === userId && member.guild?.id === guild.id && member.user?.bot) throw botStaffError();
    if (!validMember(member, guild.id, userId)) throw membershipError();
    verifiedUserIds.push(userId);
  }
  return { guildId: guild.id, verifiedUserIds, rosterComplete: false };
}

module.exports = { verifyVenueMembers };
