'use strict';

// A poll asked for in a chat (src/systems/conversation/chatPoll.js): the model's proposal is checked like /poll's
// input and by the output check, shown with 確認 and 取消, and opened only when the member who asked presses 確認
// in time, in the same channel, through the same createPoll as /poll.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const retainedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-chat-poll-')));
require('../src/platform/retainedDataSource').configureRetainedDataSourceRoot(retainedRoot);
test.after(() => fs.rmSync(retainedRoot, { recursive: true, force: true }));

const {
  PROPOSAL_TTL_MS,
  clearChatPollsForTests,
  handleChatPollButton,
  offerChatPoll,
  preparePollProposal,
} = require('../src/systems/conversation/chatPoll');
const { readPolls } = require('../src/services/pollService');

const ASKER = '500000000000000001';
const OTHER = '500000000000000002';

test('a proposal becomes a poll only with 2 to 5 distinct options, and text the output check refuses drops it', () => {
  assert.deepEqual(preparePollProposal({ question: '午餐吃什麼', options: ['飯', '麵'], duration_minutes: 30 }),
    { question: '午餐吃什麼', options: ['飯', '麵'], durationMinutes: 30 });
  assert.equal(preparePollProposal({ question: '午餐', options: ['飯'], duration_minutes: 10 }), null);
  assert.equal(preparePollProposal({ question: '午餐', options: ['飯', '飯'], duration_minutes: 10 }), null);
  assert.equal(preparePollProposal(null), null);
  // Out-of-range durations are clamped; a sixth option is dropped.
  assert.equal(preparePollProposal({ question: 'q', options: ['a', 'b'], duration_minutes: 99999 }).durationMinutes, 1440);
  assert.deepEqual(preparePollProposal({ question: 'q', options: ['1', '2', '3', '4', '5', '6'], duration_minutes: 5 }).options,
    ['1', '2', '3', '4', '5']);
  assert.equal(preparePollProposal({ question: 'q', options: ['a', 'b'], duration_minutes: 5 }, {
    checkText: (text) => (text === 'b' ? null : text),
  }), null);
});

function chatMessage() {
  const sent = [];
  return {
    sent,
    message: {
      author: { id: ASKER }, guildId: 'guild-1', channelId: 'channel-1',
      reply: async (payload) => { sent.push(payload); return { id: 'preview-1' }; },
    },
  };
}

function press(customId, { userId = ASKER, channelId = 'channel-1' } = {}) {
  const answers = [];
  const edits = [];
  return {
    answers,
    edits,
    interaction: {
      customId, user: { id: userId }, guildId: 'guild-1', channelId, client: { channels: { fetch: async () => null } },
      message: { edit: async (payload) => edits.push(payload) },
      reply: async (payload) => answers.push(['reply', payload]),
      update: async (payload) => answers.push(['update', payload]),
      deferReply: async () => answers.push(['defer']),
      editReply: async (payload) => { answers.push(['edit', payload]); return { id: `poll-message-${answers.length}` }; },
    },
  };
}

test('only the member who asked can confirm; confirming opens the poll once and closes the preview', async () => {
  clearChatPollsForTests();
  const { message, sent } = chatMessage();
  await offerChatPoll(message, { question: '週末去哪', options: ['海邊', '山上'], durationMinutes: 10 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /週末去哪/u);
  const [confirmId, cancelId] = sent[0].components[0].components.map((button) => button.data.custom_id);
  assert.match(cancelId, /\|cancel\|/u);

  const stranger = press(confirmId, { userId: OTHER });
  await handleChatPollButton(stranger.interaction);
  assert.match(stranger.answers[0][1].content, /只有提出投票的人/u);
  assert.equal(Object.keys(readPolls()).length, 0);

  const asker = press(confirmId);
  await handleChatPollButton(asker.interaction);
  const polls = Object.values(readPolls());
  assert.equal(polls.length, 1);
  assert.equal(polls[0].question, '週末去哪');
  assert.equal(polls[0].createdBy, ASKER);
  assert.match(asker.edits[0].content, /已開出投票/u);
  assert.deepEqual(asker.edits[0].components, []);

  // A second press finds nothing: the proposal was used.
  const again = press(confirmId);
  await handleChatPollButton(again.interaction);
  assert.match(again.answers[0][1].content, /失效/u);
  assert.equal(Object.keys(readPolls()).length, 1);
});

test('cancel closes the preview without a poll; an expired proposal or another channel opens nothing', async () => {
  clearChatPollsForTests();
  const before = Object.keys(readPolls()).length;
  const first = chatMessage();
  await offerChatPoll(first.message, { question: '要不要開會', options: ['要', '不要'], durationMinutes: 10 });
  const cancelId = first.sent[0].components[0].components[1].data.custom_id;
  const cancel = press(cancelId);
  await handleChatPollButton(cancel.interaction);
  assert.equal(cancel.answers[0][0], 'update');
  assert.match(cancel.answers[0][1].content, /已取消/u);

  const second = chatMessage();
  const now = Date.now();
  await offerChatPoll(second.message, { question: '晚餐', options: ['飯', '麵'], durationMinutes: 10 }, { now });
  const confirmId = second.sent[0].components[0].components[0].data.custom_id;
  const elsewhere = press(confirmId, { channelId: 'channel-2' });
  await handleChatPollButton(elsewhere.interaction);
  assert.match(elsewhere.answers[0][1].content, /失效/u);
  const late = press(confirmId);
  await handleChatPollButton(late.interaction, { now: now + PROPOSAL_TTL_MS + 1 });
  assert.match(late.answers[0][1].content, /失效/u);
  assert.equal(Object.keys(readPolls()).length, before);
});
