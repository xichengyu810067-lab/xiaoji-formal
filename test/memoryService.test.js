const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-query-memory-test-'));
process.env.XIAOJI_MEMORY_PATH = path.join(testRoot, 'xiaojiMemory.json');
const {
  answerMemoryQuery,
  clearMemoryForTests,
  getPrivateMemoryContext,
  recordPrivateInteraction,
  recordPublicMessage,
} = require('../src/services/memoryService');

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
  delete process.env.XIAOJI_MEMORY_PATH;
});

function createMessage({ guildId = 'guild-1', channelId = 'channel-1', userId, username, displayName, content }) {
  return {
    guildId,
    channelId,
    content,
    createdTimestamp: Date.now(),
    author: {
      id: userId,
      username,
      tag: `${username}#0000`,
      bot: false,
    },
    member: {
      displayName,
    },
  };
}

function createQueryMessage({ userId = 'user-2', username = 'sister', displayName = '妹妹', content = '' } = {}) {
  return createMessage({ userId, username, displayName, content });
}

test('self memory query can use the requester private memory', () => {
  clearMemoryForTests();
  recordPrivateInteraction({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    displayName: '哥哥',
    userText: '晚安',
    assistantText: '晚安呀',
  });

  const reply = answerMemoryQuery({
    text: '我剛剛有沒有說晚安？',
    message: createQueryMessage({ userId: 'user-1', username: 'brother', displayName: '哥哥' }),
  });

  assert.match(reply, /有喔/);
  assert.match(reply, /晚安/);
});

test('private AI context follows the same user across guilds and isolates every other user', () => {
  clearMemoryForTests();
  recordPrivateInteraction({
    guildId: 'guild-a',
    channelId: 'channel-a',
    userId: 'travelling-user',
    displayName: '跨服玩家',
    userText: '我最近最喜歡研究天文攝影',
    assistantText: '小吉記住了',
  });
  recordPrivateInteraction({
    guildId: 'guild-a',
    channelId: 'channel-a',
    userId: 'different-user',
    displayName: '另一個人',
    userText: '這是另一個人的私人偏好',
    assistantText: '收到',
  });

  const sameUserContextInGuildB = getPrivateMemoryContext('travelling-user');
  const differentUserContext = getPrivateMemoryContext('different-user');

  assert.match(sameUserContextInGuildB, /最喜歡研究天文攝影/);
  assert.doesNotMatch(sameUserContextInGuildB, /另一個人的私人偏好/);
  assert.match(differentUserContext, /另一個人的私人偏好/);
  assert.doesNotMatch(differentUserContext, /最喜歡研究天文攝影/);
  assert.doesNotMatch(sameUserContextInGuildB, /guild-a|channel-a|travelling-user/);
});

test('private AI context has explicit record and character bounds', () => {
  clearMemoryForTests();

  for (let index = 0; index < 8; index += 1) {
    recordPrivateInteraction({
      guildId: `guild-${index}`,
      channelId: `channel-${index}`,
      userId: 'bounded-user',
      displayName: '有界使用者',
      userText: `偏好紀錄-${index}-${'內容'.repeat(50)}`,
      assistantText: `回覆-${index}-${'摘要'.repeat(50)}`,
    });
  }

  const context = getPrivateMemoryContext('bounded-user', { maxRecords: 2, maxCharacters: 240 });
  assert.ok(context.length <= 240);
  assert.match(context, /偏好紀錄-7|回覆-7/);
  assert.doesNotMatch(context, /偏好紀錄-0/);
});

test('corrupt private memory is preserved and excluded from AI context', () => {
  clearMemoryForTests();
  fs.writeFileSync(process.env.XIAOJI_MEMORY_PATH, '{broken-memory', 'utf8');

  assert.equal(getPrivateMemoryContext('user-1'), '');
  assert.equal(
    recordPrivateInteraction({
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      displayName: '使用者',
      userText: '不可覆寫原檔',
      assistantText: '不可寫入',
    }),
    null
  );
  assert.equal(fs.readFileSync(process.env.XIAOJI_MEMORY_PATH, 'utf8'), '{broken-memory');

  clearMemoryForTests();
});

test('another user can find public same-channel memory by display name', () => {
  clearMemoryForTests();
  recordPublicMessage(
    createMessage({
      userId: 'user-1',
      username: 'brother',
      displayName: '哥哥',
      content: '<@123> 晚安',
    })
  );

  const reply = answerMemoryQuery({
    text: '哥哥剛剛有沒有說晚安？',
    message: createQueryMessage(),
  });

  assert.match(reply, /哥哥/);
  assert.match(reply, /說過晚安/);
});

test('private memory about another user is not disclosed', () => {
  clearMemoryForTests();
  recordPrivateInteraction({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    displayName: '哥哥',
    userText: '秘密',
    assistantText: '我知道了',
  });

  const reply = answerMemoryQuery({
    text: '哥哥私下跟你說了什麼？',
    message: createQueryMessage(),
  });

  assert.match(reply, /私人對話/);
  assert.doesNotMatch(reply, /秘密/);
});

test('another user gets privacy response when only private target memory matches', () => {
  clearMemoryForTests();
  recordPrivateInteraction({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    displayName: '哥哥',
    userText: '晚安',
    assistantText: '晚安呀',
  });

  const reply = answerMemoryQuery({
    text: '哥哥剛剛有沒有說晚安？',
    message: createQueryMessage(),
  });

  assert.match(reply, /私人對話/);
  assert.doesNotMatch(reply, /晚安呀/);
});

test('unknown public memory query avoids definitive denial', () => {
  clearMemoryForTests();

  const reply = answerMemoryQuery({
    text: '剛剛有人說晚安嗎？',
    message: createQueryMessage(),
  });

  assert.match(reply, /目前沒有在可查的公開紀錄中找到/);
  assert.doesNotMatch(reply, /沒有人說過/);
});
