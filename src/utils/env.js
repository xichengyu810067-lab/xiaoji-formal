function getEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getFirstEnv(names) {
  for (const name of names) {
    const value = getEnv(name);
    if (value) {
      return value;
    }
  }

  return null;
}

function getDiscordToken() {
  return getFirstEnv(['DISCORD_TOKEN']);
}

function getDiscordClientId() {
  return getFirstEnv(['DISCORD_CLIENT_ID', 'CLIENT_ID']);
}

function getBotOwnerId() {
  return getFirstEnv(['BOT_OWNER_ID', 'OWNER_ID']);
}

// The guild the owner-only commands go to (XIAOJI_OWNER_GUILD_ID, the same variable deploy-commands.js
// reads). Anything that is not exactly one Discord ID of 16 to 22 digits is "not set": null, and the
// value is never echoed, in case a secret was pasted into it.
const OWNER_GUILD_ID_PATTERN = /^\d{16,22}$/u;

function getOwnerGuildId() {
  const value = getEnv('XIAOJI_OWNER_GUILD_ID');
  return value !== null && OWNER_GUILD_ID_PATTERN.test(value) ? value : null;
}

function requireEnvValue(label, value, aliases = []) {
  if (value) {
    return value;
  }

  const names = [label, ...aliases].join(' or ');
  throw new Error(`Missing required environment variable: ${names}`);
}

module.exports = {
  getBotOwnerId,
  getDiscordClientId,
  getDiscordToken,
  getEnv,
  getFirstEnv,
  getOwnerGuildId,
  requireEnvValue,
};
