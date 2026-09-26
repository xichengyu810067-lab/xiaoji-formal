const test = require('node:test');
const assert = require('node:assert/strict');

test('old schedule paths keep the same factories as the new domain modules', () => {
  const oldReminder = require('../src/systems/reminders/reminderSystem');
  const newReminder = require('../src/systems/schedule/reminders/reminderSystem');
  const oldCalendar = require('../src/systems/community/calendarSystem');
  const newCalendar = require('../src/systems/schedule/calendar/calendarSystem');
  assert.equal(oldReminder, newReminder);
  assert.equal(oldCalendar, newCalendar);
  assert.equal(require('../src/services/reminderService').createReminderSystem,
    newReminder.createReminderSystem);
  assert.equal(require('../src/services/calendarService').createCalendarSystem,
    newCalendar.createCalendarSystem);
});

test('old work paths keep one coordinator and all cycle and payroll exports', () => {
  const oldService = require('../src/services/workService');
  const coordinator = require('../src/systems/work/workService');
  const oldSystem = require('../src/systems/economy/workSystem');
  const jobCycle = require('../src/systems/work/jobCycle');
  const payroll = require('../src/systems/work/payroll');
  assert.equal(oldService, coordinator);
  assert.deepEqual(Object.keys(oldSystem).sort(),
    [...Object.keys(jobCycle), ...Object.keys(payroll)].sort());
  for (const [name, value] of Object.entries({ ...jobCycle, ...payroll })) {
    assert.equal(oldSystem[name], value);
  }
});
