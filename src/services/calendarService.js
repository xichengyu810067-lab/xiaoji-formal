const path = require('node:path');
const { createCalendarSystem } = require('../systems/community/calendarSystem');
const { resolvePersonalDataPath } = require('../platform/personalDataPaths');

const calendarPath = path.join(__dirname, '..', 'data', 'calendarEvents.json');
let activeSystem = null;
function getActiveSystem() {
  if (!activeSystem) activeSystem = createCalendarSystem({ filePath: resolvePersonalDataPath('calendar').filePath });
  return activeSystem;
}
const shape = createCalendarSystem({ filePath: calendarPath });
const pureMethods = new Set(['createCalendarEvent', 'createPersonalCalendarEvent',
  'formatCalendarEventList', 'parseCalendarDate', 'parseTaipeiCalendarDate']);
module.exports = {
  ...Object.fromEntries(Object.entries(shape).map(([name, value]) => [name,
    typeof value === 'function' && !pureMethods.has(name)
      ? (...args) => getActiveSystem()[name](...args) : value])),
  createCalendarSystem,
};
