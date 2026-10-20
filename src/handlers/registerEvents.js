const fs = require('node:fs');
const path = require('node:path');
const {
  captureDiscordEventContext,
  runWithHostOperationContext,
} = require('../platform/hostOperationContext');

function getEventFiles(eventsPath = path.join(__dirname, '..', 'events')) {
  if (!fs.existsSync(eventsPath)) {
    return [];
  }

  return fs
    .readdirSync(eventsPath)
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join(eventsPath, file));
}

function registerEvents(client, eventsPath, { publicEffectAuthority = null } = {}) {
  for (const filePath of getEventFiles(eventsPath)) {
    const event = require(filePath);

    if (!event.name || typeof event.execute !== 'function') {
      throw new Error(`Invalid event module: ${filePath}`);
    }

    const listener = (...args) => runWithHostOperationContext(
      captureDiscordEventContext(event.name, args, { publicEffectAuthority }),
      () => event.execute(...args)
    );

    if (event.once) client.once(event.name, listener);
    else client.on(event.name, listener);
  }
}

module.exports = {
  registerEvents,
};
