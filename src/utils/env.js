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

function getDiscordGuildId() {
  return getFirstEnv(['DISCORD_GUILD_ID', 'GUILD_ID']);
}

function getBotOwnerId() {
  return getFirstEnv(['BOT_OWNER_ID', 'OWNER_ID']);
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
  getDiscordGuildId,
  getDiscordToken,
  getEnv,
  getFirstEnv,
  requireEnvValue,
};
