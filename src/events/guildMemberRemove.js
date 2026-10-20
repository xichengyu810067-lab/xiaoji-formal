const { Events } = require('discord.js');
const { authorizeEvent } = require('../platform/testControlIngress');
const { reportMemberLeft } = require('../systems/community/memberLeaveNotices');
const logger = require('../utils/logger');

// A member left (or was removed from) a server. Only the owner's server (XIAOJI_OWNER_GUILD_ID) is
// reported, to the Owner, as a fixed notice (src/systems/community/memberLeaveNotices.js). The member
// may be partial: the client keeps the GuildMember partial so that this event also arrives for a member
// that was not cached, and such a member can lack its join time and server nickname.
module.exports = {
  name: Events.GuildMemberRemove,

  async execute(member) {
    if (!authorizeEvent(member?.client, 'guildMemberRemove', { guildId: member?.guild?.id })) return;

    try {
      reportMemberLeft(member);
    } catch (error) {
      logger.error('member leave notice failed', error);
    }
  },
};
