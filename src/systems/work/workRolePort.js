'use strict';

// The work system asks extensions about job roles at two moments: after a primary cycle is settled and after a legacy
// payroll. Who asks is not the work system's business. The work system is a set of module functions with no place where
// it is built, so the assembly root (src/index.js) hands it the process's work role coordinator here, once, and the work
// system only knows this port; it never loads a coordinator itself.
//
// Before any coordinator is configured the port does what the work system did before the port existed: it asks the
// extension host that the client carries. With no host on the client, or no extension that has the hook, nothing
// happens, and nothing is thrown. That is also what a caller gets who runs the work system without the assembly root
// (a test, or a script) and hands it a client with a host of its own. The process itself configures the coordinator
// before it runs anything.
let workRoleCoordinator = null;

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

// Takes the process's work role coordinator. Handing over the same one again is fine; a different one is refused, so
// that two coordinators in one process cannot go unnoticed.
function configureWorkRoleCoordinator(coordinator) {
  if (typeof coordinator?.runHook !== 'function') {
    throw refusal('WORK_ROLE_COORDINATOR_INVALID', 'The work role coordinator needs a runHook function.');
  }
  if (workRoleCoordinator !== null && workRoleCoordinator !== coordinator) {
    throw refusal('WORK_ROLE_COORDINATOR_CONFLICT',
      'The work system already has a work role coordinator; the process has exactly one.');
  }
  workRoleCoordinator = coordinator;
  return coordinator;
}

// What the work system asks with while no coordinator is configured. The extension host is loaded when it is asked,
// not when this module is: the assembly root requires this module early and it should stay light.
const clientHostRoles = Object.freeze({
  runHook(client, hookName, payload) {
    const { getClientExtensionHost } = require('../../extensions/extensionHost');
    return getClientExtensionHost(client).runHook(hookName, payload);
  },
});

// The coordinator the work system asks: the configured one, or the client's own host while none is configured.
function getWorkRoleCoordinator() {
  return workRoleCoordinator ?? clientHostRoles;
}

// For tests only: a running process configures the coordinator once and keeps it.
function resetWorkRoleCoordinatorForTests() {
  workRoleCoordinator = null;
}

module.exports = { configureWorkRoleCoordinator, getWorkRoleCoordinator, resetWorkRoleCoordinatorForTests };
