'use strict';

// Synthetic command of command group "beta" for test/extensionScopePins.test.js.
// It is only ever serialized or registered into in-memory fakes.
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('synthetic-beta')
    .setDescription('Synthetic beta command'),
  async execute() {},
};
