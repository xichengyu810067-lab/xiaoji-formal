const { sanitizeUntrustedText } = require('./disclosurePolicy');

// Invisible format characters (bidirectional overrides, zero-width and tag characters) are dropped from names.
function safeName(value) {
  return sanitizeUntrustedText(value).replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ').replace(/[<>`]/g, '')
    .replace(/@/g, '＠')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
}

// Read beside a member mention, where it is already clear who is meant.
function asksMemberIdentity(text) {
  return /(?:誰|認識|介紹|身分|身份|這位|這個人|who\s+is|tell\s+me\s+about)/i.test(String(text || ''));
}

// Without a mention only a "who is <name>" sentence looks a member up; "誰發明電燈" or "介紹一下台北101" go to the model.
function asksNamedMemberIdentity(text) {
  return /(?:是誰|誰是|是什麼人|是哪位|認不認識|認識.{1,40}?嗎|who\s+is)/i.test(String(text || ''));
}

// The question names the server's members, so a name that matches no one gets a hint instead of a model guess.
const MEMBER_CONTEXT = /(?:成員|伺服器|群組|群裡|這裡|這邊|本群)/;
// "我是誰", "他是誰": a pronoun is never looked up as a name.
const PRONOUN = /^(?:我|你|妳|您|他|她|它|牠|我們|你們|他們|她們|這|那|這個|那個|自己|大家|現在|目前)$/;
const NAME_FILLER = /小吉|這個伺服器|伺服器裡|伺服器|群組裡|群組|群裡|本群|這裡|這邊|請問|你知道|知道|你認識|認不認識|認識|誰是|是誰|是什麼人|是哪位|這位成員|成員|請|幫我|介紹一下|介紹|這位|這個人|身分|身份|資料|資訊|嗎|呢|啊|喔|的|[？?。！!,，：:~～]/g;

function memberFact(member) {
  if (!member?.user) return null;
  const displayName = safeName(member.displayName || member.user.globalName || member.user.username);
  const username = safeName(member.user.username);
  if (!displayName || !username) return null;
  return { displayName, username, bot: Boolean(member.user.bot) };
}

function formatMemberFact(fact) {
  return `這位成員在本伺服器的顯示名稱是「${fact.displayName}」，使用者名稱是「${fact.username}」，${fact.bot ? '是機器人' : '不是機器人'}。`;
}

async function resolveMentionMember(message, userId) {
  if (!message.guild || !/^\d{17,20}$/.test(userId)) return null;
  const cached = message.mentions?.members?.get?.(userId) || message.guild.members?.cache?.get?.(userId);
  if (cached) return cached;
  try {
    return await message.guild.members?.fetch?.(userId) || null;
  } catch {
    return null;
  }
}

async function resolveMemberFacts(message, text) {
  if (!message?.guildId || !message.guild) return { facts: [], reply: null };
  const ids = [...String(text || '').matchAll(/<@!?(\d{17,20})>/g)]
    .map((match) => match[1]).filter((id) => id !== message.client?.user?.id);
  const uniqueIds = [...new Set(ids)].slice(0, 3);
  const facts = (await Promise.all(uniqueIds.map(async (id) => memberFact(await resolveMentionMember(message, id)))))
    .filter(Boolean);
  if (uniqueIds.length && asksMemberIdentity(text)) {
    if (uniqueIds.length !== 1 || facts.length !== 1) {
      return { facts: [], reply: '請只提及一位目前在這個伺服器的成員，我才能確認你問的是誰。' };
    }
    return { facts, reply: formatMemberFact(facts[0]) };
  }
  if (uniqueIds.length) return { facts, reply: null };
  if (!asksNamedMemberIdentity(text)) return { facts: [], reply: null };

  // No match is a hint only when the question is about the server's members; otherwise the model answers.
  const aboutMembers = MEMBER_CONTEXT.test(String(text));
  const notFound = aboutMembers
    ? { facts: [], reply: '請直接提及那位成員，我才能確認你問的是誰。' }
    : { facts: [], reply: null };
  const target = safeName(String(text).replace(NAME_FILLER, ''));
  if (!target || target.length > 80 || PRONOUN.test(target)) return notFound;
  let candidates;
  try {
    candidates = await message.guild.members?.fetch?.({ query: target, limit: 100 });
  } catch {
    candidates = null;
  }
  if (!candidates || candidates.size >= 100) return notFound;
  const known = [...candidates.values()].filter((member) => memberFact(member));
  const exact = known.filter((member) => {
    const fact = memberFact(member);
    return fact.displayName === target || fact.username === target;
  });
  // Discord matches the query as a name prefix. A single prefix match is taken only when the question is about the
  // server's members, so "愛迪生是誰" does not answer with a member called 愛迪生粉絲.
  const matches = exact.length || !aboutMembers ? exact : known;
  if (matches.length !== 1) return notFound;
  const fact = memberFact(matches[0]);
  return { facts: [fact], reply: formatMemberFact(fact) };
}

module.exports = { asksMemberIdentity, asksNamedMemberIdentity, formatMemberFact, resolveMemberFacts };
