'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const { createTestControlEgress } = require('../src/platform/testControlEgress');
const { createTestControlInventory } = require('../src/platform/testControlInventory');
const { loadTestControlPolicy } = require('../src/platform/testControlPolicy');
const { IDS, createFixture } = require('./testControlSupport');

const STARTED_AT = Date.UTC(2026, 9, 5, 0, 0, 0);
const MESSAGE_ID = '999999999999999999';
const USER_MESSAGE_ID = '999999999999999998';

function inventoryOptions() {
  let current = STARTED_AT;
  return {
    now: () => current++,
    randomBytes: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
  };
}

function records(writer) {
  return fs.readFileSync(writer.filePath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('inventory records only allowed gateway authors and seals a complete JSONL session', () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const writer = createTestControlInventory(policy, inventoryOptions());
    const client = new EventEmitter();
    assert.equal(writer.rememberChannel(IDS.channel, IDS.guild), true);
    assert.equal(writer.installGatewayObserver(client), true);

    const sequence = writer.beginMessage({ guildId: IDS.guild, channelId: IDS.channel, source: 'interaction:/ping' });
    assert.equal(writer.resolveMessage(sequence, { id: MESSAGE_ID, author: { id: IDS.app } }), true);
    client.emit('messageCreate', {
      id: USER_MESSAGE_ID, guildId: IDS.guild, channelId: IDS.channel, author: { id: IDS.actor }, content: 'must not persist',
    });
    client.emit('messageCreate', {
      id: '999999999999999997', guildId: IDS.guild, channelId: IDS.channel, author: { id: IDS.formal }, content: 'must not persist',
    });
    assert.equal(writer.seal(), true);

    const logged = records(writer);
    assert.deepEqual(logged.map((record) => record.t), ['header', 'pending', 'msg', 'msg', 'seal']);
    assert.deepEqual(logged[0], {
      t: 'header', v: 1, run: '00112233445566778899aabbccddeeff', kind: 'commands', app: IDS.app,
      guilds: [IDS.guild], actors: [IDS.actor], startedAt: new Date(STARTED_AT).toISOString(),
    });
    assert.deepEqual(logged[1], {
      t: 'pending', seq: 1, g: IDS.guild, c: IDS.channel, at: new Date(STARTED_AT + 1).toISOString(),
      src: 'interaction:/ping',
    });
    assert.deepEqual(logged[2], {
      t: 'msg', seq: 1, g: IDS.guild, c: IDS.channel, m: MESSAGE_ID,
      at: new Date(STARTED_AT + 2).toISOString(), src: 'interaction:/ping', by: 'bot', k: 'message',
    });
    assert.deepEqual(logged[3], {
      t: 'msg', g: IDS.guild, c: IDS.channel, m: USER_MESSAGE_ID,
      at: new Date(STARTED_AT + 3).toISOString(), src: 'gateway:user', by: 'user', k: 'message',
    });
    assert.deepEqual(logged[4], {
      t: 'seal', count: 2, pendingOpen: 0, restOnly: 1, gatewayOnly: 1,
      endedAt: new Date(STARTED_AT + 4).toISOString(),
    });
    assert.equal(JSON.stringify(logged).includes('must not persist'), false);
  } finally { fixture.cleanup(); }
});

test('inventory writes pending before the REST transport and resolves both outcomes', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const pendingSeenByTransport = [];
    let requestCount = 0;
    const rest = {
      async request(options) {
        requestCount += 1;
        if (options.fullRoute === `/channels/${IDS.channel}`) return { id: IDS.channel, guild_id: IDS.guild };
        pendingSeenByTransport.push(records(writer).some((record) => record.t === 'pending' && record.seq === requestCount - 1));
        if (requestCount === 3) throw Object.assign(new Error('synthetic transport failure'), { code: 'ETIMEDOUT' });
        return { id: MESSAGE_ID, author: { id: IDS.app } };
      },
    };
    const egress = createTestControlEgress(policy);
    egress.install(rest);
    await rest.request({ method: 'GET', fullRoute: `/channels/${IDS.channel}` });
    const writer = egress.enableInventory(inventoryOptions());
    await rest.request({ method: 'POST', fullRoute: `/channels/${IDS.channel}/messages` });
    await assert.rejects(() => rest.request({ method: 'POST', fullRoute: `/channels/${IDS.channel}/messages` }),
      /synthetic transport failure/u);
    assert.deepEqual(pendingSeenByTransport, [true, true]);
    assert.equal(writer.seal(), true);

    const logged = records(writer);
    assert.deepEqual(logged.map((record) => record.t), ['header', 'pending', 'msg', 'pending', 'fail', 'seal']);
    assert.equal(logged[2].seq, logged[1].seq);
    assert.equal(logged[4].seq, logged[3].seq);
    assert.equal(logged[4].code, 'TEST_INVENTORY_RESULT_UNAVAILABLE');
  } finally { fixture.cleanup(); }
});

test('inventory covers followup and deferred-original webhook message routes', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const pendingSeenByTransport = [];
    let webhookRequest = 0;
    const rest = {
      async request(options) {
        if (options.fullRoute === `/channels/${IDS.channel}`) return { id: IDS.channel, guild_id: IDS.guild };
        webhookRequest += 1;
        pendingSeenByTransport.push(records(writer).at(-1));
        if (webhookRequest === 2) throw Object.assign(new Error('synthetic deferred reply failure'), {
          code: 'TEST_SYNTHETIC_REPLY_FAILURE',
        });
        return { id: MESSAGE_ID, author: { id: IDS.app } };
      },
    };
    const egress = createTestControlEgress(policy);
    egress.bindInteraction({
      id: IDS.interaction, token: 'synthetic-interaction-token', guildId: IDS.guild, channelId: IDS.channel,
      commandName: 'ping', user: { id: IDS.actor },
    });
    egress.install(rest);
    await rest.request({ method: 'GET', fullRoute: `/channels/${IDS.channel}` });
    const writer = egress.enableInventory(inventoryOptions());
    await rest.request({ method: 'POST', fullRoute: `/webhooks/${IDS.app}/synthetic-interaction-token` });
    await assert.rejects(() => rest.request({ method: 'PATCH',
      fullRoute: `/webhooks/${IDS.app}/synthetic-interaction-token/messages/@original` }),
    /synthetic deferred reply failure/u);
    assert.deepEqual(pendingSeenByTransport.map((record) => [record.t, record.seq, record.src]), [
      ['pending', 1, 'interaction:/ping'],
      ['pending', 2, 'interaction:/ping'],
    ]);
    assert.equal(writer.seal(), true);

    const logged = records(writer);
    assert.deepEqual(logged.map((record) => record.t), ['header', 'pending', 'msg', 'pending', 'fail', 'seal']);
    assert.equal(logged[2].seq, 1);
    assert.equal(logged[2].src, 'interaction:/ping');
    assert.equal(logged[4].seq, 2);
    assert.equal(logged[4].code, 'TEST_SYNTHETIC_REPLY_FAILURE');
  } finally { fixture.cleanup(); }
});

test('inventory write failure reports a fixed code and stops the active test session', () => {
  const fixture = createFixture();
  const runtimeSymbol = Symbol.for('xiaoji.testControlRuntimeController');
  const originalRuntime = globalThis[runtimeSymbol];
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const stopped = [];
    globalThis[runtimeSymbol] = { active: true, requestStop: (reason) => stopped.push(reason) };
    let writes = 0;
    const fsImpl = { ...fs, writeSync(...args) {
      if (writes++ > 0) throw new Error('synthetic write failure');
      return fs.writeSync(...args);
    } };
    const writer = createTestControlInventory(policy, { ...inventoryOptions(), fsImpl });
    assert.throws(() => writer.beginMessage({ guildId: IDS.guild, channelId: IDS.channel }),
      (error) => error.code === 'TEST_INVENTORY_WRITE_FAILED');
    assert.deepEqual(stopped, ['START_FAILED']);
    assert.equal(policy.reporter.count('TEST_INVENTORY_WRITE_FAILED', 'inventory'), 1);
  } finally {
    if (originalRuntime === undefined) delete globalThis[runtimeSymbol];
    else globalThis[runtimeSymbol] = originalRuntime;
    fixture.cleanup();
  }
});

test('inventory seals during process exit without requiring a direct runtime-controller hook', () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const writer = createTestControlInventory(policy, inventoryOptions());
    const processRef = new EventEmitter();
    assert.equal(writer.installExitSeal(processRef), true);
    processRef.emit('exit');
    assert.equal(writer.snapshot().sealed, true);
    assert.deepEqual(records(writer).map((record) => record.t), ['header', 'seal']);
  } finally { fixture.cleanup(); }
});
