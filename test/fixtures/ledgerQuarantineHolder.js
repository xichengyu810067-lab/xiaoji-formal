'use strict';

// Child process for test/ledgerStore.test.js. It opens a synthetic word-chain reaction
// ledger, opens a fence, makes the fence close fail to persist (which quarantines the
// ledger), reports the quarantine state on stdout, and then waits to be killed before any
// stop() or close(), which simulates the console window being closed.

const { openPublicPurposeLedger } = require('../../src/systems/safety/sideEffectLedger');

const [filePath, expectedReceiptSha256, botId, guildId, channelId] = process.argv.slice(2);

try {
  let failFenceClose = false;
  const ledger = openPublicPurposeLedger({
    filePath,
    expectedReceiptSha256,
    expectedPurposeIdentity: { purposeId: 'word-chain.reaction', botId, sourceNamespace: 'discord.messageCreate' },
    faultInjector: ({ label, phase }) => {
      if (failFenceClose && label === 'close-reaction-fence' && phase === 'before-ledger-write') {
        throw new Error('synthetic fence persistence fault');
      }
    },
  });
  const opened = ledger.openReactionFence({ guildId, channelId, sessionKey: 'word-chain.reaction|crash' });
  failFenceClose = true;
  try {
    ledger.closeReactionFence(guildId, { generation: opened.fence.generation });
    process.stdout.write('FENCE_CLOSED_UNEXPECTEDLY\n');
  } catch {
    process.stdout.write(`QUARANTINED ${ledger.quarantined}\n`);
  }
  setInterval(() => {}, 60_000);
} catch (error) {
  process.stdout.write(`ERROR ${error?.code || 'UNKNOWN'}\n`);
  process.exitCode = 1;
}
