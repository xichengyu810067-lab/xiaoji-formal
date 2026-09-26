const path = require('node:path');
const logger = require('../utils/logger');
const { createReminderSystem } = require('../systems/reminders/reminderSystem');
const { resolvePersonalDataPath } = require('../platform/personalDataPaths');

const remindersPath = path.join(__dirname, '..', 'data', 'reminders.json');
let activeSystem = null;
function getActiveSystem() {
  if (!activeSystem) {
    activeSystem = createReminderSystem({ filePath: resolvePersonalDataPath('reminders').filePath, logger });
  }
  return activeSystem;
}
const shape = createReminderSystem({ filePath: remindersPath, logger });
const pureMethods = new Set(['createReminder', 'parseReminderDuration']);
module.exports = {
  ...Object.fromEntries(Object.entries(shape).map(([name, value]) => [name,
    typeof value === 'function' && !pureMethods.has(name)
      ? (...args) => getActiveSystem()[name](...args) : value])),
  createReminderSystem,
};
