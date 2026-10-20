'use strict';

// The payloads the public game panels really build, resolved the way discord.js resolves a
// message (MessagePayload: body plus RawFile[] files) and sent through the egress guard and
// the egress limiter to a synthetic transport. A panel image must reach Discord together
// with the embed that shows it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessagePayload, Options, Routes } = require('discord.js');

const { installEgressGuard } = require('../src/platform/egressGuard');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const { buildSoloMessagePayload } = require('../src/systems/games/soloPresenter');
const { buildBoardMessagePayload } = require('../src/systems/games/board/discord/boardPresenter');
const { buildDiscordPayload } = require('../src/systems/games/board/discord/discordBoardBridge');
const { createSyntheticRest } = require('./fixtures/syntheticRest');

const CHANNEL_ID = '12345678901234567';
const MESSAGE_ID = '34567890123456789';
const APPLICATION_ID = '45678901234567890';
const INTERACTION_ID = '56789012345678901';
const GUILD_ID = '23456789012345678';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SYNTHETIC_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('synthetic panel image')]);
// discord.js only reads client options while it resolves a payload.
const TARGET = Object.freeze({ client: Object.freeze({ options: Options.createDefault() }) });

function guardedTransport() {
  const calls = [];
  const record = (method) => (route, request) => {
    calls.push(Object.freeze({ method, route, ...request }));
    return { id: MESSAGE_ID };
  };
  const rest = createSyntheticRest({ post: record('POST'), patch: record('PATCH') });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', resolveChannelGuild: () => GUILD_ID });
  const limiter = createEgressLimiter();
  guard.setAdmission((details) => limiter.admit(details));
  return { calls, rest };
}

async function resolvePayload(options) {
  const { body, files } = await MessagePayload.create(TARGET, options).resolveBody().resolveFiles();
  return { body, files };
}

function soloSession() {
  return {
    id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', revision: 3, status: 'active', gameType: 'sudoku', difficulty: 'normal',
    rewardStatus: null, state: { entries: Array.from({ length: 9 }, () => Array(9).fill(0)), completed: false },
  };
}

function boardResult() {
  return {
    session: {
      id: '0f9e8d7c-6b5a-4938-8271-605f4e3d2c1b', revision: 2, status: 'lobby', gameKey: 'gomoku', rulesVersion: 1,
      players: [{ userId: '67890123456789012' }], turn: null, outcome: null,
    },
  };
}

function assertDeliveredImage(call, name) {
  assert.equal(call.files.length, 1);
  assert.equal(call.files[0].name, name);
  assert.deepEqual(call.files[0].data, SYNTHETIC_PNG);
  const embeds = call.body.embeds || call.body.data?.embeds;
  assert.equal(embeds[0].image.url, `attachment://${name}`);
}

test('a solo game panel edit reaches the transport with its image and the embed that shows it', async () => {
  const { calls, rest } = guardedTransport();
  const payload = buildSoloMessagePayload(soloSession(), { renderPng: () => SYNTHETIC_PNG });
  await rest.patch(Routes.channelMessage(CHANNEL_ID, MESSAGE_ID), await resolvePayload(payload));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, `/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`);
  assertDeliveredImage(calls[0], 'solo-a1b2c3d4e5f60718293a4b5c6d7e8f90-r3.png');
});

test('a solo game panel sent as the deferred interaction reply reaches the transport with its image', async () => {
  const { calls, rest } = guardedTransport();
  const payload = buildSoloMessagePayload(soloSession(), { renderPng: () => SYNTHETIC_PNG });
  await rest.patch(Routes.webhookMessage(APPLICATION_ID, 'synthetic-token', '@original'),
    { ...(await resolvePayload(payload)), auth: false });
  assert.equal(calls.length, 1);
  assertDeliveredImage(calls[0], 'solo-a1b2c3d4e5f60718293a4b5c6d7e8f90-r3.png');
});

test('a solo game panel sent as an initial interaction response reaches the transport with its image', async () => {
  const { calls, rest } = guardedTransport();
  const payload = buildSoloMessagePayload(soloSession(), { renderPng: () => SYNTHETIC_PNG });
  const { body, files } = await resolvePayload(payload);
  await rest.post(Routes.interactionCallback(INTERACTION_ID, 'synthetic-token'),
    { body: { type: 4, data: body }, files, auth: false });
  assert.equal(calls.length, 1);
  assertDeliveredImage(calls[0], 'solo-a1b2c3d4e5f60718293a4b5c6d7e8f90-r3.png');
});

test('a board game panel edit reaches the transport with its image and the embed that shows it', async () => {
  const { calls, rest } = guardedTransport();
  const payload = buildDiscordPayload(await buildBoardMessagePayload(boardResult(), { renderPng: async () => SYNTHETIC_PNG }));
  await rest.patch(Routes.channelMessage(CHANNEL_ID, MESSAGE_ID), await resolvePayload(payload));
  assert.equal(calls.length, 1);
  assertDeliveredImage(calls[0], 'board-0f9e8d7c-6b5a-4938-8271-605f4e3d2c1b-r2.png');
});
