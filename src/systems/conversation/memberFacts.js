function safeName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>`]/g, '')
    .replace(/@/g, '＠')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
}

function asksMemberIdentity(text) {
  return /(?:誰|認識|介紹|身分|身份|這位|這個人|who\s+is|tell\s+me\s+about)/i.test(String(text || ''));
}

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
  if (!asksMemberIdentity(text)) return { facts: [], reply: null };

  const target = safeName(String(text).replace(/小吉|誰是|是誰|請|幫我|介紹|認識|這位|這個人|的|身分|身份|資料|資訊|[？?。！!,，：:]/g, ''));
  if (!target || target.length > 80) return { facts: [], reply: null };
  let candidates;
  try {
    candidates = await message.guild.members?.fetch?.({ query: target, limit: 100 });
  } catch {
    candidates = null;
  }
  if (!candidates || candidates.size >= 100) {
    return { facts: [], reply: '請直接提及那位成員，我才能確認你問的是誰。' };
  }
  const matches = [...candidates.values()].filter((member) => {
    const fact = memberFact(member);
    return fact && (fact.displayName === target || fact.username === target);
  });
  if (matches.length !== 1) {
    return { facts: [], reply: '請直接提及那位成員，我才能確認你問的是誰。' };
  }
  const fact = memberFact(matches[0]);
  return { facts: [fact], reply: formatMemberFact(fact) };
}

module.exports = { asksMemberIdentity, formatMemberFact, resolveMemberFacts };
