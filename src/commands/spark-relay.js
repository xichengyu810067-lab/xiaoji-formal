const { SlashCommandBuilder } = require('discord.js');
const { DEFAULT_SIGNUP_HOURS, MAX_SIGNUP_HOURS, MAX_TASKS } = require('../systems/community/sparkRelay/rules');
const { MAX_SUBMISSION_LENGTH } = require('../systems/community/sparkRelay/service');
const { executeSparkRelayCommand } = require('../systems/community/sparkRelay/discord');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spark-relay')
    .setDescription('星火接續：隨機分組，每天輪一人完成小任務')
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('在這個頻道開一輪星火接續的報名')
        .addIntegerOption((option) =>
          option
            .setName('signup-hours')
            .setDescription(`報名幾小時後自動分組（預設 ${DEFAULT_SIGNUP_HOURS}）`)
            .setMinValue(1)
            .setMaxValue(MAX_SIGNUP_HOURS)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('tasks').setDescription('查看或領取輪到你的星火任務'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('submit')
        .setDescription('交出一件星火任務給小吉驗收')
        .addIntegerOption((option) =>
          option.setName('task').setDescription('任務編號').setRequired(true).setMinValue(1).setMaxValue(MAX_TASKS)
        )
        .addStringOption((option) =>
          option.setName('proof').setDescription('完成的內容或說明').setMaxLength(MAX_SUBMISSION_LENGTH)
        )
        .addAttachmentOption((option) => option.setName('image').setDescription('完成的證明圖片（png、jpg、gif、webp）'))
    )
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看你這一組的接力進度')),

  async execute(interaction) {
    await executeSparkRelayCommand(interaction);
  },
};
