'use strict';

const { getClientExtensionHost } = require('../extensions/extensionHost');

// The one place that asks an extension about job roles. The core never changes a Discord role for a job itself: it runs
// a workRole.* hook and an extension (the private one, when it is loaded) does the work. Two callers ask:
//   - the /work command (src/commands/work.js), which loads this module directly;
//   - the work system (src/systems/work/workService.js), which does not load coordinators and reaches this one through
//     src/systems/work/workRolePort.js, where the assembly root (src/index.js) hands it over once.
// The hook names, payloads and default answers stay with each caller and are pinned by test/extensionScopePins.test.js
// and test/workRoleHostCalls.test.js. What is here is how the extension host is asked and how its answer is read.
function createWorkRoleCoordinator() {
  // Runs the hook `hookName`, written in full (`workRole.<name>`), on the extension host that `client` carries, and
  // returns what the host returns: one { extensionId, result } entry for each extension that has the hook. A client
  // with no host asks an empty one, so nothing answers.
  function runHook(client, hookName, payload) {
    return getClientExtensionHost(client).runHook(hookName, payload);
  }

  // Runs `workRole.<hookName>`, the name written without its prefix, and returns the first answer that is not
  // undefined. When no extension answers, or the first answer is falsy, `fallback` is returned instead, and a later
  // extension is never read. The default is a fresh object on each call.
  async function runWorkRoleHook(client, hookName, payload, fallback = { ok: true, skipped: true, role: null, warnings: [] }) {
    const results = await runHook(client, `workRole.${hookName}`, payload);
    return results.find((item) => item.result !== undefined)?.result || fallback;
  }

  // Whether an extension on the host that `client` carries exports `workRole.<hookName>`, the name written without its
  // prefix. The core changes no job role itself, so without such an extension a reply has no role sync to speak of.
  function hasWorkRoleHook(client, hookName) {
    const extensions = getClientExtensionHost(client).extensions;
    return Array.isArray(extensions) &&
      extensions.some((extension) => typeof extension?.hooks?.workRole?.[hookName] === 'function');
  }

  return Object.freeze({ hasWorkRoleHook, runHook, runWorkRoleHook });
}

// The coordinator of this process. It holds no state, so the /work command and the work system's port are given the
// very same object.
const workRoleCoordinator = createWorkRoleCoordinator();

module.exports = { createWorkRoleCoordinator, workRoleCoordinator };
