const packageJson = require('../../package.json');

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 MB';
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getBotStatus(client, now = Date.now()) {
  const uptimeMs = Math.floor(process.uptime() * 1000);
  const memory = process.memoryUsage();
  const startedAt = new Date(now - uptimeMs);

  return {
    uptime: formatDuration(uptimeMs),
    memoryUsage: {
      rss: formatBytes(memory.rss),
      heapUsed: formatBytes(memory.heapUsed),
      heapTotal: formatBytes(memory.heapTotal),
    },
    guildCount: client.guilds.cache.size,
    commandCount: client.commands?.size || 0,
    version: packageJson.version,
    startedAt,
  };
}

module.exports = {
  formatBytes,
  formatDuration,
  getBotStatus,
};
