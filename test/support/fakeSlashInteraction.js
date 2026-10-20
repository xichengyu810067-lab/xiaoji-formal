'use strict';

// A fake slash command interaction for tests that run a real command against a real, temporary coin database.
// Only Discord is faked: the guild's member list and the options the user filled in. Everything the command
// reads from the economy comes from the real services.

const MEMBER_NOT_FOUND = 'Unknown Member';

// A guild whose members are `memberIds`. Like discord.js, fetching one member by ID answers with that member or
// rejects when the user is not in the guild, and fetching without an ID answers with the whole list.
function createGuild(guildId, memberIds = [], { name = 'Fixture Guild' } = {}) {
  const members = new Map(memberIds.map((id) => [String(id), { id: String(id), guild: { id: guildId } }]));

  return {
    id: guildId,
    name,
    memberCount: members.size,
    members: {
      cache: new Map(),
      fetch: async (id) => {
        if (id === undefined) return members;
        const member = members.get(String(id));
        if (!member) throw new Error(MEMBER_NOT_FOUND);
        return member;
      },
    },
  };
}

// `users`, `strings` and `integers` hold the options by name. Every answer the command gives is kept, in order,
// in `replies`.
function createSlashInteraction({
  commandName, subcommand = null, guild, user, users = {}, strings = {}, integers = {}, client = {},
}) {
  const replies = [];
  const interaction = {
    commandName,
    id: 'fixture-interaction',
    guildId: guild.id,
    guild,
    user,
    client,
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getUser: (name) => users[name] ?? null,
      getString: (name) => strings[name] ?? null,
      getInteger: (name) => integers[name] ?? null,
    },
    async reply(payload) {
      replies.push(payload);
      interaction.replied = true;
    },
    async followUp(payload) {
      replies.push(payload);
    },
  };

  return { interaction, replies };
}

module.exports = { createGuild, createSlashInteraction };
