async function validateDelivery(client, reminder) {
  const guild = await client.guilds.fetch(reminder.deliveryGuildId);
  const member = await guild.members.fetch(reminder.userId);
  const channel = await client.channels.fetch(reminder.deliveryChannelId);
  if (!channel?.isTextBased?.() || channel.guildId !== reminder.deliveryGuildId ||
      typeof channel.send !== 'function') throw new Error('原提醒頻道已無法使用。');
  const userPermissions = channel.permissionsFor(member);
  const botPermissions = channel.permissionsFor(guild.members.me || client.user);
  if (!userPermissions?.has('ViewChannel') || !botPermissions?.has('ViewChannel') ||
      !botPermissions?.has('SendMessages')) throw new Error('原提醒頻道或成員權限不足。');
  return channel;
}

module.exports = { validateDelivery };
