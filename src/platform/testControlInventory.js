'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TestControlError } = require('./testControlPolicy');

const INVENTORY_VERSION = 1;
const INVENTORY_DIRECTORY = 'inventory';
const LIVE_TEST_DIRECTORY = 'live-test';
const MESSAGE_KINDS = new Set(['message', 'ephemeral', 'thread']);
const SNOWFLAKE_PATTERN = /^\d{16,22}$/u;
const TEST_CONTROL_RUNTIME_SYMBOL = Symbol.for('xiaoji.testControlRuntimeController');

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);
}

function asSnowflake(value) {
  const normalized = String(value || '');
  return isSnowflake(normalized) ? normalized : null;
}

function inventoryFilename(now, run) {
  const timestamp = new Date(now).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  return `${timestamp}-${run.slice(0, 8)}.jsonl`;
}

function safeFailureCode(error) {
  const code = String(error?.code || '');
  return /^TEST_[A-Z0-9_]{1,60}$/u.test(code) ? code : 'TEST_INVENTORY_RESULT_UNAVAILABLE';
}

function safeSource(value, fallback = 'discord-rest') {
  const source = String(value || fallback).replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 160);
  return source || fallback;
}

function requirePolicy(policy) {
  if (!policy || typeof policy.dataRoot !== 'string' || !isSnowflake(String(policy.expectedApplicationId || '')) ||
      !(policy.allowedGuildIds instanceof Set) || !(policy.allowedActorIds instanceof Set) ||
      typeof policy.allowsGuild !== 'function' || typeof policy.allowsChannel !== 'function' ||
      typeof policy.allowsActor !== 'function') {
    throw new TypeError('Test-control inventory requires a verified policy.');
  }
  return policy;
}

function createTestControlInventory(policy, {
  fsImpl = fs,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  requirePolicy(policy);
  const run = randomBytes(16).toString('hex');
  const startedAtMs = now();
  const liveTestRoot = path.join(policy.dataRoot, LIVE_TEST_DIRECTORY);
  const directory = path.join(liveTestRoot, INVENTORY_DIRECTORY);
  const channels = new Map();
  const messages = new Map();
  const pending = new Map();
  let sequence = 0;
  let descriptor = null;
  let filePath = null;
  let sealed = false;
  let gatewayObserver = null;
  let exitHandler = null;

  function closeDescriptor() {
    const openDescriptor = descriptor;
    descriptor = null;
    if (openDescriptor === null) return true;
    try {
      fsImpl.closeSync(openDescriptor);
      return true;
    } catch {
      return false;
    }
  }

  function stopAfterWriteFailure() {
    try {
      const runtimeController = globalThis[TEST_CONTROL_RUNTIME_SYMBOL];
      if (runtimeController?.active === true) runtimeController.requestStop?.('START_FAILED');
    } catch {
      // A failed best-effort stop must not reveal an operating-system error or keep writing.
    }
  }

  function writeFailure() {
    closeDescriptor();
    policy.reporter?.deny?.('TEST_INVENTORY_WRITE_FAILED', 'inventory');
    stopAfterWriteFailure();
    throw new TestControlError('TEST_INVENTORY_WRITE_FAILED');
  }

  function append(record) {
    if (descriptor === null || sealed) writeFailure();
    try {
      fsImpl.writeSync(descriptor, `${JSON.stringify(record)}\n`, null, 'utf8');
      fsImpl.fsyncSync(descriptor);
    } catch {
      writeFailure();
    }
  }

  function initialize() {
    try {
      fsImpl.mkdirSync(liveTestRoot, { recursive: true, mode: 0o700 });
      fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const liveStat = fsImpl.lstatSync(liveTestRoot);
      const directoryStat = fsImpl.lstatSync(directory);
      if (!liveStat.isDirectory() || liveStat.isSymbolicLink() || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        writeFailure();
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const base = inventoryFilename(startedAtMs, run).slice(0, -'.jsonl'.length);
        const name = attempt === 0 ? `${base}.jsonl` : `${base}-${attempt}.jsonl`;
        try {
          filePath = path.join(directory, name);
          descriptor = fsImpl.openSync(filePath, 'wx', 0o600);
          break;
        } catch (error) {
          if (error?.code !== 'EEXIST') writeFailure();
        }
      }
      if (descriptor === null) writeFailure();
      append({
        t: 'header',
        v: INVENTORY_VERSION,
        run,
        kind: 'commands',
        app: policy.expectedApplicationId,
        guilds: [...policy.allowedGuildIds].sort(),
        actors: [...policy.allowedActorIds].sort(),
        startedAt: new Date(startedAtMs).toISOString(),
      });
    } catch (error) {
      if (error instanceof TestControlError) throw error;
      writeFailure();
    }
  }

  function messageKind(message) {
    if (Number(message?.flags || 0) & 64) return 'ephemeral';
    if (message?.thread || message?.channel?.isThread?.()) return 'thread';
    return 'message';
  }

  function rememberChannel(channelId, guildId) {
    const channel = asSnowflake(channelId);
    const guild = asSnowflake(guildId);
    if (!channel || !guild || !policy.allowsChannel(channel) || !policy.allowsGuild(guild)) return false;
    channels.set(channel, guild);
    return true;
  }

  function getGuildForChannel(channelId) {
    return channels.get(asSnowflake(channelId) || '') || null;
  }

  function beginMessage({ guildId, channelId, source = 'discord-rest' } = {}) {
    const guild = asSnowflake(guildId);
    const channel = asSnowflake(channelId);
    if (!guild || !channel || !policy.allowsGuild(guild) || !policy.allowsChannel(channel) || sealed) {
      writeFailure();
    }
    const seq = ++sequence;
    pending.set(seq, { guild, channel, source: safeSource(source) });
    append({ t: 'pending', seq, g: guild, c: channel, at: new Date(now()).toISOString(), src: pending.get(seq).source });
    return seq;
  }

  function recordMessage({ guildId, channelId, messageId, by, kind = 'message', source, seq = null, origin }) {
    const guild = asSnowflake(guildId);
    const channel = asSnowflake(channelId);
    const message = asSnowflake(messageId);
    if (!guild || !channel || !message || !['bot', 'user'].includes(by) || !MESSAGE_KINDS.has(kind) ||
        !policy.allowsGuild(guild) || !policy.allowsChannel(channel)) return false;
    const existing = messages.get(message);
    const shouldWrite = !existing || seq !== null;
    if (shouldWrite) {
      const record = { t: 'msg', g: guild, c: channel, m: message, at: new Date(now()).toISOString(), by, k: kind };
      if (seq !== null) record.seq = seq;
      if (source) record.src = safeSource(source);
      append(record);
    }
    const current = existing || { rest: false, gateway: false };
    if (origin === 'rest') current.rest = true;
    if (origin === 'gateway') current.gateway = true;
    messages.set(message, current);
    if (seq !== null) pending.delete(seq);
    return true;
  }

  function resolveMessage(seq, response) {
    const pendingRecord = pending.get(seq);
    if (!pendingRecord) return false;
    const messageId = asSnowflake(response?.id);
    if (!messageId || String(response?.author?.id || '') !== policy.expectedApplicationId) {
      return failMessage(seq, 'TEST_INVENTORY_RESULT_UNAVAILABLE');
    }
    return recordMessage({
      guildId: pendingRecord.guild,
      channelId: pendingRecord.channel,
      messageId,
      by: 'bot',
      kind: messageKind(response),
      source: pendingRecord.source,
      seq,
      origin: 'rest',
    });
  }

  function failMessage(seq, code) {
    const pendingRecord = pending.get(seq);
    if (!pendingRecord) return false;
    append({
      t: 'fail',
      seq,
      g: pendingRecord.guild,
      c: pendingRecord.channel,
      at: new Date(now()).toISOString(),
      src: pendingRecord.source,
      code: safeFailureCode({ code }),
    });
    pending.delete(seq);
    return true;
  }

  function observeGatewayMessage(message) {
    const guild = asSnowflake(message?.guildId);
    const channel = asSnowflake(message?.channelId);
    const author = asSnowflake(message?.author?.id);
    const id = asSnowflake(message?.id);
    if (!guild || !channel || !author || !id || !policy.allowsGuild(guild) || !policy.allowsChannel(channel)) return false;
    rememberChannel(channel, guild);
    const by = author === policy.expectedApplicationId ? 'bot' : policy.allowsActor(author) ? 'user' : null;
    if (!by) return false;
    return recordMessage({ guildId: guild, channelId: channel, messageId: id, by, kind: messageKind(message),
      source: by === 'bot' ? 'gateway:bot' : 'gateway:user', origin: 'gateway' });
  }

  function installGatewayObserver(client) {
    if (gatewayObserver || !client || typeof client.prependListener !== 'function') return false;
    gatewayObserver = (message) => { observeGatewayMessage(message); };
    client.prependListener('messageCreate', gatewayObserver);
    return true;
  }

  function installExitSeal(processRef = process) {
    if (exitHandler || !processRef || typeof processRef.once !== 'function') return false;
    exitHandler = () => {
      try { seal(); } catch { /* exit handlers must not disclose filesystem details */ }
    };
    processRef.once('exit', exitHandler);
    return true;
  }

  function seal() {
    if (sealed) return false;
    const entries = [...messages.values()];
    append({
      t: 'seal',
      count: messages.size,
      pendingOpen: pending.size,
      restOnly: entries.filter((item) => item.rest && !item.gateway).length,
      gatewayOnly: entries.filter((item) => item.gateway && !item.rest).length,
      endedAt: new Date(now()).toISOString(),
    });
    sealed = true;
    if (!closeDescriptor()) writeFailure();
    return true;
  }

  initialize();
  return Object.freeze({
    beginMessage,
    failMessage,
    filePath: () => filePath,
    getGuildForChannel,
    installExitSeal,
    installGatewayObserver,
    observeGatewayMessage,
    rememberChannel,
    resolveMessage,
    seal,
    snapshot: () => Object.freeze({ run, sealed, messages: messages.size, pending: pending.size }),
  });
}

module.exports = {
  INVENTORY_VERSION,
  createTestControlInventory,
};
