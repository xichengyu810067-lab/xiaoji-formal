'use strict';

// /work status, status-user and status-all show a member's primary job. The public core changes no job role itself:
// only an extension that exports workRole.syncPrimaryJobRoleForMember does. With such an extension the block says the
// role is checked by the management features; without one it says nothing about role sync. Neither reply names the
// private extension. The work service and the permission check are stand-ins; nothing is read or written.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createExtensionHost } = require('../src/extensions/extensionHost');
const { workRoleCoordinator } = require('../src/coordinators/workRoleCoordinator');

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);
const GUILD_ID = 'work-status-guild';
const MEMBER = { id: 'work-status-member', username: 'member', globalName: '成員甲' };
const PRIMARY = Object.freeze({
  scope: 'primary', userId: MEMBER.id, jobName: '服務生', globalCycleId: 'cycle-1', sourceGuildId: GUILD_ID,
  workDays: 7, status: 'active', startAt: '2026-10-01T00:00:00.000Z', payAt: '2026-10-08T00:00:00.000Z',
  settledAmount: null,
});
const STATUS = Object.freeze({
  primaryStatusView: PRIMARY, activeJobs: [], latestPayroll: null, latestPrimaryPayroll: null, recentTasks: [],
});

function loadWork(t) {
  const patches = [
    [require(src('utils', 'moderation.js')), 'ensureModerationAccess', async () => ({ ok: true })],
    [require(src('services', 'workService.js')), 'getWorkStatus', async () => STATUS],
    [require(src('services', 'workService.js')), 'getAllWorkStatuses', async () => [PRIMARY]],
  ];
  const originals = patches.map(([target, key]) => target[key]);
  for (const [target, key, value] of patches) target[key] = value;
  const commandPath = require.resolve(src('commands', 'work.js'));
  delete require.cache[commandPath];
  const command = require(commandPath);
  t.after(() => {
    delete require.cache[commandPath];
    patches.forEach(([target, key], index) => { target[key] = originals[index]; });
  });
  return command;
}

function roleExtension() {
  return {
    apiVersion: 1,
    id: 'synthetic-roles',
    hooks: { workRole: { syncPrimaryJobRoleForMember: async () => ({ ok: true, warnings: [] }) } },
  };
}

async function runStatus(command, subcommand, client) {
  const replies = [];
  const members = new Map([[MEMBER.id, { id: MEMBER.id }]]);
  await command.execute({
    commandName: 'work',
    guildId: GUILD_ID,
    user: MEMBER,
    client,
    guild: {
      id: GUILD_ID,
      memberCount: 1,
      members: { fetch: async (id) => (id ? members.get(id) ?? null : members) },
    },
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getUser: () => MEMBER,
      getInteger: () => null,
      getString: () => null,
    },
    async reply(payload) { replies.push(payload); },
    async followUp(payload) { replies.push(payload); },
  });
  assert.equal(replies.length, 1, subcommand);
  return replies[0].content;
}

const SUBCOMMANDS = ['status', 'status-user', 'status-all'];

test('with an extension that syncs primary-job roles, the status says the management features check it', async (t) => {
  const command = loadWork(t);
  const client = { extensionHost: createExtensionHost([roleExtension()]) };
  assert.equal(workRoleCoordinator.hasWorkRoleHook(client, 'syncPrimaryJobRoleForMember'), true);
  for (const subcommand of SUBCOMMANDS) {
    const content = await runStatus(command, subcommand, client);
    assert.ok(content.includes('全域主職：服務生'), content);
    assert.ok(content.includes('角色同步：由管理功能核對'), content);
    assert.doesNotMatch(content, /私有擴充/u, subcommand);
  }
});

test('without such an extension, the status says nothing about role sync', async (t) => {
  const command = loadWork(t);
  const otherHook = { apiVersion: 1, id: 'synthetic-other', hooks: { ready: async () => {} } };
  for (const client of [{}, { extensionHost: createExtensionHost([]) }, { extensionHost: createExtensionHost([otherHook]) }]) {
    assert.equal(workRoleCoordinator.hasWorkRoleHook(client, 'syncPrimaryJobRoleForMember'), false);
    for (const subcommand of SUBCOMMANDS) {
      const content = await runStatus(command, subcommand, client);
      assert.ok(content.includes('全域主職：服務生'), content);
      assert.doesNotMatch(content, /角色同步|私有擴充/u, subcommand);
    }
  }
});

test('no /work reply text names the private extension', () => {
  const source = require('node:fs').readFileSync(src('commands', 'work.js'), 'utf8');
  const texts = source.match(/'[^'\n]*'|`[^`\n]*`/gu) || [];
  assert.deepEqual(texts.filter((text) => text.includes('私有擴充')), []);
});
