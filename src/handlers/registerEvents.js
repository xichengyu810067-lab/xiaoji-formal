const fs = require('node:fs');
const path = require('node:path');

function getEventFiles(eventsPath = path.join(__dirname, '..', 'events')) {
  if (!fs.existsSync(eventsPath)) {
    return [];
  }

  return fs
    .readdirSync(eventsPath)
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join(eventsPath, file));
}

function registerEvents(client, eventsPath) {
  for (const filePath of getEventFiles(eventsPath)) {
    const event = require(filePath);

    if (!event.name || typeof event.execute !== 'function') {
      throw new Error(`Invalid event module: ${filePath}`);
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
  }
}

module.exports = {
  registerEvents,
};
