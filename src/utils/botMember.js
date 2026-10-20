'use strict';

// The bot's own member of a guild, as a whole member.
//
// The client keeps GuildMember partials (src/index.js), so that discord.js emits the leave of a member
// it never cached. A side effect of that setting: when the bot's own member is not in the cache,
// `guild.members.me` is no longer null. discord.js makes a partial member out of nothing but the bot's
// user, puts it in the cache and returns it. It has no roles, so the permissions it gives are those of
// @everyone, and `guild.members.me || guild.members.fetchMe()` would never fetch. Every place that
// needs the bot's permissions in a guild takes its member from here, and a partial member counts as
// none.

function isWholeMember(member) {
  return Boolean(member) && typeof member === 'object' && member.partial !== true;
}

// Synchronous: the bot's member from the cache when it is whole, otherwise null.
function cachedBotMember(guild) {
  let member = null;
  try {
    member = guild?.members?.me ?? null;
  } catch {
    member = null;
  }
  return isWholeMember(member) ? member : null;
}

// The bot's whole member: from the cache, or else fetched (which also completes a partial member in
// the cache). Null when it cannot be had; it never throws.
async function resolveBotMember(guild) {
  try {
    const cached = cachedBotMember(guild);
    if (cached) return cached;
    if (typeof guild?.members?.fetchMe !== 'function') return null;
    const fetched = await guild.members.fetchMe();
    return isWholeMember(fetched) ? fetched : null;
  } catch {
    return null;
  }
}

module.exports = { cachedBotMember, resolveBotMember };
