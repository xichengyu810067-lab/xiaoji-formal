const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const previewDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-game-preview-'));
process.env.COIN_DB_PATH = path.join(previewDirectory, 'preview.sqlite');

const { initializeCoinDatabase, withCoinTransaction } = require('../src/services/coinDatabase');
const { createGameSession } = require('../src/services/gameService');
const { startGameServer, stopGameServer } = require('../src/services/gameServer');

const secret = 'local-preview-only-game-secret-32-bytes-minimum';
const websiteBase = 'http://127.0.0.1:4173';

async function shutdown() {
  await stopGameServer().catch(() => {});
  fs.rmSync(previewDirectory, { recursive: true, force: true });
}

async function main() {
  await initializeCoinDatabase();
  await withCoinTransaction((api) => api.run(
    "INSERT INTO coin_guild_settings (guild_id, enabled, created_at, updated_at) VALUES ('preview-guild', 1, ?, ?)",
    [new Date().toISOString(), new Date().toISOString()]
  ));
  await startGameServer({
    enabled: true,
    host: '127.0.0.1',
    port: 8790,
    allowedOrigins: new Set([websiteBase]),
    secret,
    healthReporter: async () => {},
  });

  for (const gameType of ['tetris', 'number-match', 'sudoku']) {
    const session = await createGameSession({
      userId: 'preview-user', guildId: 'preview-guild', channelId: 'preview-channel',
      gameType, difficulty: 'easy', secret,
    });
    console.log(`${gameType}: ${websiteBase}/games/${gameType}?difficulty=easy#token=${encodeURIComponent(session.launchToken)}`);
  }
  console.log('Preview sessions expire in 30 minutes. Press Ctrl+C to stop.');
}

process.once('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
main().catch(async (error) => {
  console.error(`Game preview failed: ${error.message}`);
  await shutdown();
  process.exitCode = 1;
});
