const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

const DISCORD_ID_PATTERN = /^\d{16,22}$/;
const UNAVAILABLE_MESSAGE = '小吉目前無法讀取這個伺服器的完整資訊，請在目前伺服器中重新使用 /server。';
const NOT_IN_GUILD_MESSAGE = '這個指令只能在伺服器內使用。';

function readCurrentGuild(interaction) {
  const guild = interaction?.guild;
  const guildId = String(interaction?.guildId || '');
  const ownerId = String(guild?.ownerId || '');
  const createdTimestamp = Number(guild?.createdTimestamp);
  if (interaction?.inGuild?.() === false || !guild || !DISCORD_ID_PATTERN.test(guildId) ||
      String(guild.id || '') !== guildId || typeof guild.name !== 'string' || !guild.name.trim() ||
      !Number.isSafeInteger(guild.memberCount) || guild.memberCount < 0 ||
      !Number.isFinite(createdTimestamp) || createdTimestamp <= 0 ||
      !DISCORD_ID_PATTERN.test(ownerId)) return null;
  return { guildId, guildName: guild.name, memberCount: guild.memberCount, createdTimestamp, ownerId };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('顯示目前伺服器資訊')
    .setDMPermission(false),

  async execute(interaction) {
    // A direct message has no server to describe; say so plainly instead of the "cannot read" answer.
    if (interaction?.inGuild?.() === false || (!interaction?.guild && !interaction?.guildId)) {
      await interaction.reply({
        content: NOT_IN_GUILD_MESSAGE,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const current = readCurrentGuild(interaction);
    if (!current) {
      await interaction.reply({
        content: UNAVAILABLE_MESSAGE,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const createdUnixSeconds = Math.floor(current.createdTimestamp / 1000);
    const embed = new EmbedBuilder()
      .setColor(0x57a6ff)
      .setTitle('目前伺服器資訊')
      .addFields(
        { name: '伺服器名稱', value: current.guildName },
        { name: '成員數', value: String(current.memberCount), inline: true },
        { name: '建立時間', value: `<t:${createdUnixSeconds}:F>`, inline: true },
        { name: '伺服器擁有者', value: `<@${current.ownerId}>\nID：\`${current.ownerId}\`` },
        { name: '伺服器 ID', value: `\`${current.guildId}\`` },
      );

    await interaction.reply({
      embeds: [embed],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  },
};
