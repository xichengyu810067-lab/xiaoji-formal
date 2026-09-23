const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MENTION_OUTCOME,
  finalizeGeneratedConversationalReply,
  finalizeConversationalInformationReply,
  getConversationDisplayName,
  getExplicitCallText,
  getMentionFallbackReply,
  isPublicPersistenceSuppressed,
  replyInChunks,
} = require('../src/services/mentionService');
const { developerInstructions } = require('../src/services/aiService');
const { AI_PROVIDER_RATE_LIMIT_REPLY } = require('../src/services/aiService');
const { CHAT_STYLE_NAMES } = require('../src/services/chatStyleService');
const { parseWeatherQuery, normalizeWeatherCommandLocation } = require('../src/utils/weatherNLP');
const pingCommand = require('../src/commands/ping');

test('AI instructions know Xiaoji has weather command', () => {
  assert.match(developerInstructions, /\/weather/);
  assert.match(developerInstructions, /Never say 小吉 has no weather feature/);
});

test('provider rate-limit reply is never altered by a chat style or romance preference', () => {
  for (const style of CHAT_STYLE_NAMES) {
    assert.equal(AI_PROVIDER_RATE_LIMIT_REPLY, '小吉有點累了，請稍後再跟我聊天', style);
  }
});

test('provider rate-limit outcome suppresses event-layer public persistence only', () => {
  assert.equal(isPublicPersistenceSuppressed(undefined), false);
  assert.equal(isPublicPersistenceSuppressed({ outcome: 'other' }), false);
  assert.equal(
    isPublicPersistenceSuppressed({ outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE }),
    true
  );
});

test('mention fallback gives weather prompt when weather is queried', () => {
  const reply = getMentionFallbackReply('你有查詢天氣功能嗎');
  assert.match(reply, /你想查哪裡的天氣呢/);
});

test('mention fallback gives help prompt when asked for help', () => {
  const reply = getMentionFallbackReply('幫助');
  assert.match(reply, /\/weather/);
});

test('mention fallback covers first-stage keyword replies', () => {
  assert.match(getMentionFallbackReply('晚安'), /晚安/);
  assert.match(getMentionFallbackReply('你是誰'), /我是小吉/);
  assert.match(getMentionFallbackReply('幫我寫公告'), /公告草稿/);
});

test('Discord conversation display name uses member, global name, then username', () => {
  assert.equal(
    getConversationDisplayName({
      member: { displayName: '伺服器暱稱' },
      author: { globalName: '全域名稱', username: 'account-name' },
    }),
    '伺服器暱稱'
  );
  assert.equal(
    getConversationDisplayName({ author: { globalName: '全域名稱', username: 'account-name' } }),
    '全域名稱'
  );
  assert.equal(getConversationDisplayName({ author: { username: 'account-name' } }), 'account-name');
  assert.equal(
    getConversationDisplayName({
      member: { displayName: '123456789012345678' },
      author: { id: '123456789012345678', globalName: '安全名稱', username: 'account-name' },
    }),
    '安全名稱'
  );
});

test('mention fallback addresses the Discord display name and keeps the canonical bot name', () => {
  const greeting = getMentionFallbackReply('你好', '市長大人');
  const generic = getMentionFallbackReply('今天想聊遊戲', '市長大人');

  assert.match(greeting, /市長大人/);
  assert.match(greeting, /我是小吉/);
  assert.match(generic, /市長大人/);
  assert.match(generic, /小吉收到/);
  assert.doesNotMatch(`${greeting}\n${generic}`, /小幾|小雞|小機/);
  assert.doesNotMatch(
    getMentionFallbackReply('我的編號是 123456789012345678', '市長大人', '123456789012345678'),
    /123456789012345678/
  );
});

test('mention fallback deterministically applies every chat style before the shared finalizer', () => {
  const userId = '123456789012345678';
  const replies = CHAT_STYLE_NAMES.map((style) =>
    getMentionFallbackReply(`今天想聊遊戲 ${userId}`, '新的顯示名稱', userId, style)
  );
  assert.equal(new Set(replies).size, CHAT_STYLE_NAMES.length);
  for (const reply of replies) {
    assert.match(reply, /新的顯示名稱/);
    assert.match(reply, /小吉/);
    assert.doesNotMatch(reply, new RegExp(userId));
  }
  assert.match(replies[0], /✨/);
  assert.match(replies[3], /已收到/);
  assert.match(replies[4], /才沒有忽略你/);
  assert.match(replies[5], /尊重你想怎麼繼續/);
});

test('romance fallback layers affectionate safety over every style and off preserves normal output', () => {
  const userId = '123456789012345678';
  for (const style of CHAT_STYLE_NAMES) {
    const normal = getMentionFallbackReply('今天想聊遊戲', '新的顯示名稱', userId, style, false);
    const romantic = getMentionFallbackReply(
      `今天想聊遊戲 ${userId}`,
      '新的顯示名稱',
      userId,
      style,
      true
    );
    assert.equal(normal, getMentionFallbackReply('今天想聊遊戲', '新的顯示名稱', userId, style));
    assert.notEqual(romantic, normal);
    assert.match(romantic, /新的顯示名稱/);
    assert.match(romantic, /小吉/);
    assert.doesNotMatch(romantic, new RegExp(userId));
  }
  assert.match(getMentionFallbackReply('你好', '市長大人', userId, 'cute', true), /甜甜地聊聊/);
  assert.match(getMentionFallbackReply('你好', '市長大人', userId, 'yandere', true), /尊重你的選擇與界線/);
});

test('memory and weather facts keep their content while every chat style and romance layer is applied', () => {
  const userId = '123456789012345678';
  const fact = `臺北今天氣溫 18 ~ 24 度；內部編號 ${userId}`;
  const replies = CHAT_STYLE_NAMES.map((style) =>
    finalizeConversationalInformationReply(fact, '跨服旅人', userId, style, true)
  );

  assert.equal(new Set(replies).size, CHAT_STYLE_NAMES.length);
  for (const reply of replies) {
    assert.match(reply, /臺北今天氣溫 18 ~ 24 度/);
    assert.match(reply, /跨服旅人/);
    assert.match(reply, /小吉/);
    assert.doesNotMatch(reply, new RegExp(userId));
  }
  assert.match(replies[0], /幫你整理好啦/);
  assert.match(replies[3], /資料如下/);
  assert.match(replies[4], /才不是特地整理/);
  assert.match(replies[5], /尊重你的選擇與界線/);
});

test('generated provider replies receive a deterministic romance layer after opt-in', () => {
  const userId = '123456789012345678';
  const providerReply = `我在這裡。內部編號 ${userId}`;

  const normal = finalizeGeneratedConversationalReply(
    providerReply,
    '跨服旅人',
    userId,
    'cold',
    false
  );
  const romantic = finalizeGeneratedConversationalReply(
    providerReply,
    '跨服旅人',
    userId,
    'cold',
    true
  );

  assert.equal(normal, '我在這裡。內部編號 [內部識別碼已隱藏]');
  assert.match(romantic, /跨服旅人。小吉對你的在意，比語氣明顯。/);
  assert.match(romantic, /我在這裡/);
  assert.doesNotMatch(romantic, new RegExp(userId));
});

test('chat style and romance mode do not transform non-conversational system command replies', async () => {
  const messages = [];
  await pingCommand.execute({
    createdTimestamp: 1_000,
    client: { ws: { ping: 12.4 } },
    async reply(payload) {
      messages.push(payload);
      return { createdTimestamp: 1_025 };
    },
    async editReply(content) { messages.push(content); },
  });
  assert.deepEqual(messages, [
    { content: '小吉正在量測延遲...', fetchReply: true },
    'Pong! 往返延遲 25ms，WebSocket 12ms。',
  ]);
});

test('explicit Xiaoji call is parsed without a Discord mention', () => {
  assert.equal(getExplicitCallText('小吉 晚安'), '晚安');
  assert.equal(getExplicitCallText('小吉：你在嗎'), '你在嗎');
  assert.equal(getExplicitCallText('今天小吉好忙'), null);
});

test('replyInChunks replies to an available source message', async () => {
  const replies = [];
  const channelMessages = [];
  const message = {
    async reply(payload) {
      replies.push(payload);
    },
    channel: {
      async send(payload) {
        channelMessages.push(payload);
      },
    },
  };

  await replyInChunks(message, '正常回覆');

  assert.deepEqual(replies, [
    { content: '正常回覆', allowedMentions: { repliedUser: false } },
  ]);
  assert.deepEqual(channelMessages, []);
});

test('replyInChunks falls back once when Discord rejects a missing message reference', async () => {
  const channelMessages = [];
  const referenceError = new Error('message_reference[MESSAGE_REFERENCE_UNKNOWN_MESSAGE]: Unknown message');
  referenceError.code = 50035;
  referenceError.rawError = {
    errors: {
      message_reference: {
        _errors: [{ code: 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE' }],
      },
    },
  };
  const message = {
    async reply() {
      throw referenceError;
    },
    channel: {
      async send(payload) {
        channelMessages.push(payload);
      },
    },
  };

  await replyInChunks(message, '降級回覆');

  assert.deepEqual(channelMessages, [
    { content: '降級回覆', allowedMentions: { parse: [] } },
  ]);
});

test('replyInChunks preserves unrelated Discord errors', async () => {
  const unrelatedError = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  const message = {
    async reply() {
      throw unrelatedError;
    },
    channel: {
      async send() {
        assert.fail('channel fallback must not run for unrelated errors');
      },
    },
  };

  await assert.rejects(replyInChunks(message, '不可吞掉'), (error) => error === unrelatedError);
});

test('parseWeatherQuery resolves city before district for natural language weather', () => {
  const cases = [
    ['臺北市大同區天氣', '臺北市', '大同區', '臺北市大同區'],
    ['台北市大同區天氣', '臺北市', '大同區', '臺北市大同區'],
    ['台北 大同區 天氣', '臺北市', '大同區', '臺北市大同區'],
    ['臺北大同天氣', '臺北市', '大同區', '臺北市大同區'],
    ['台北大同天氣', '臺北市', '大同區', '臺北市大同區'],
    ['新北市新莊區天氣', '新北市', '新莊區', '新北市新莊區'],
    ['新北新莊天氣', '新北市', '新莊區', '新北市新莊區'],
    ['台南市東區天氣', '臺南市', '東區', '臺南市東區'],
    ['臺南市東區天氣', '臺南市', '東區', '臺南市東區'],
    ['台南東區天氣', '臺南市', '東區', '臺南市東區'],
    ['台中市西屯區天氣', '臺中市', '西屯區', '臺中市西屯區'],
    ['臺中西屯天氣', '臺中市', '西屯區', '臺中市西屯區'],
    ['新竹東區天氣', '新竹市', '東區', '新竹市東區'],
    ['新竹竹北天氣', '新竹縣', '竹北市', '新竹縣竹北市'],
    ['新竹縣竹北市天氣', '新竹縣', '竹北市', '新竹縣竹北市'],
    ['竹北天氣', '新竹縣', '竹北市', '新竹縣竹北市'],
    ['桃園中壢天氣', '桃園市', '中壢區', '桃園市中壢區'],
  ];

  for (const [input, city, district, location] of cases) {
    const query = parseWeatherQuery(input);
    assert.equal(query.city, city, input);
    assert.equal(query.district, district, input);
    assert.equal(query.location, location, input);
    assert.equal(query.ambiguous, null, input);
    assert.equal(query.debug.cleaned.includes('天氣'), false, input);
  }
});

test('parseWeatherQuery keeps district-only repeated names ambiguous', () => {
  for (const input of ['東區天氣', '北區天氣', '中正區天氣', '大同區天氣']) {
    const query = parseWeatherQuery(input);
    assert.ok(query.ambiguous, input);
    assert.ok(query.candidates.length > 1, input);
  }
});

test('slash weather uses the same location normalization as mention weather', () => {
  const natural = parseWeatherQuery('台北 大同區 天氣');
  const slash = normalizeWeatherCommandLocation('台北 大同區');

  assert.equal(natural.location, slash.location);
  assert.equal(natural.city, slash.city);
  assert.equal(natural.district, slash.district);
  assert.equal(natural.apiLocation, slash.apiLocation);
});

test('weather normalization keeps Hsinchu city and county districts distinct', () => {
  const cityDistrict = normalizeWeatherCommandLocation('新竹東區');
  const countyDistrict = normalizeWeatherCommandLocation('新竹竹北');

  assert.equal(cityDistrict.location, '新竹市東區');
  assert.equal(cityDistrict.apiLocation, 'Hsinchu, TW');
  assert.equal(countyDistrict.location, '新竹縣竹北市');
  assert.equal(countyDistrict.apiLocation, 'Zhubei, TW');
});
