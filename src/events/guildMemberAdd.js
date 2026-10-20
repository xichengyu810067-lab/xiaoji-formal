const { Events } = require('discord.js');
const { handleGuildMemberWelcome } = require('../services/welcomeService');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');
const { authorizeEvent } = require('../platform/testControlIngress');
const { getWelcomedMembers } = require('../systems/community/welcomedMembers');

// A member is welcomed once per server (src/systems/community/welcomedMembers.js). The reservation is
// taken here, synchronously, after the private hook and before the welcome is handled: it is kept
// (committed) only when the welcome was accepted for sending, and given back (released) otherwise, so
// a join that could not be welcomed is welcomed the next time. A bot is not welcomed, so it is not
// remembered either.
async function welcomeOnce(member) {
  let reservation = null;
  if (member.user?.bot !== true) {
    try {
      reservation = getWelcomedMembers().reserve(member.guild.id, member.id);
    } catch (error) {
      logger.error('welcome record failed', error);
    }
  }
  if (reservation && !reservation.proceed) {
    logger.info(`[Welcome] guild=${member.guild.id} skipped=${reservation.status === 'welcomed' ? 'already-welcomed' : 'in-progress'}`);
    return;
  }

  let queued = false;
  try {
    queued = (await handleGuildMemberWelcome(member)) === true;
  } catch (error) {
    logger.error('welcome handling failed', error);
  } finally {
    if (reservation) {
      try {
        if (queued) reservation.commit();
        else reservation.release();
      } catch (error) {
        logger.error('welcome record failed', error);
      }
    }
  }
}

module.exports = {
  name: Events.GuildMemberAdd,

  async execute(member) {
    if (!authorizeEvent(member?.client, 'guildMemberAdd', { guildId: member?.guild?.id })) return;
    if (!member?.guild?.id) return;

    try {
      await getClientExtensionHost(member.client).runHook('guildMemberAdd', { member });
    } catch (error) {
      logger.error('private member-add hook failed', error);
    }

    await welcomeOnce(member);
  },
};
