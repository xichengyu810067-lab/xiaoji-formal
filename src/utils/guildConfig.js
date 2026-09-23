const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, '..', 'data', 'guildConfig.json');

const defaultGuildConfig = {
  welcomeChannelId: null,
  weatherDefaultCity: null,
  memory: {
    sharePublicAcrossChannels: false,
  },
  music: {
    stayInVoice: null,
  },
  extensions: {},
};

function ensureConfigFile() {
  const directory = path.dirname(configPath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, '{}\n', 'utf8');
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(defaults, stored) {
  if (!isPlainObject(stored)) {
    return structuredClone(defaults);
  }

  const output = { ...structuredClone(defaults), ...stored };

  for (const [key, value] of Object.entries(defaults)) {
    if (isPlainObject(value)) {
      output[key] = mergeConfig(value, stored[key]);
    }
  }

  return output;
}

function normalizeGuildConfig(config) {
  const normalized = mergeConfig(defaultGuildConfig, config);

  normalized.welcomeChannelId = normalized.welcomeChannelId || null;
  normalized.weatherDefaultCity = normalized.weatherDefaultCity
    ? String(normalized.weatherDefaultCity).trim().slice(0, 100)
    : null;
  normalized.memory.sharePublicAcrossChannels = Boolean(normalized.memory.sharePublicAcrossChannels);
  normalized.music.stayInVoice = typeof normalized.music.stayInVoice === 'boolean' ? normalized.music.stayInVoice : null;
  normalized.extensions = isPlainObject(normalized.extensions) ? normalized.extensions : {};

  return normalized;
}

function readAllGuildConfig() {
  ensureConfigFile();

  try {
    const raw = fs.readFileSync(configPath, 'utf8').trim();

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);

    if (!isPlainObject(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function writeAllGuildConfig(config) {
  ensureConfigFile();
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, configPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function getGuildConfig(guildId) {
  const allConfig = readAllGuildConfig();
  return normalizeGuildConfig(allConfig[guildId]);
}

function setGuildConfig(guildId, guildConfig) {
  const allConfig = readAllGuildConfig();
  allConfig[guildId] = normalizeGuildConfig(guildConfig);
  writeAllGuildConfig(allConfig);
  return allConfig[guildId];
}

function updateGuildConfig(guildId, updater) {
  const allConfig = readAllGuildConfig();
  const current = normalizeGuildConfig(allConfig[guildId]);
  const next = updater(structuredClone(current)) || current;
  allConfig[guildId] = normalizeGuildConfig(next);
  writeAllGuildConfig(allConfig);
  return allConfig[guildId];
}

function setGuildWelcomeChannel(guildId, welcomeChannelId) {
  return updateGuildConfig(guildId, (config) => {
    config.welcomeChannelId = welcomeChannelId;
    return config;
  });
}

function setMusicStayInVoice(guildId, enabled) {
  return updateGuildConfig(guildId, (config) => {
    config.music.stayInVoice = Boolean(enabled);
    return config;
  });
}

function setWeatherDefaultCity(guildId, city) {
  return updateGuildConfig(guildId, (config) => {
    const normalizedCity = String(city || '').trim();
    config.weatherDefaultCity = normalizedCity || null;
    return config;
  });
}

module.exports = {
  defaultGuildConfig,
  getGuildConfig,
  normalizeGuildConfig,
  readAllGuildConfig,
  setGuildConfig,
  setGuildWelcomeChannel,
  setMusicStayInVoice,
  setWeatherDefaultCity,
  updateGuildConfig,
  writeAllGuildConfig,
};
