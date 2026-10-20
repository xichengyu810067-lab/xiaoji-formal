'use strict';

// Synthetic command of command group "alpha" for test/extensionScopePins.test.js.
// It is only ever serialized or registered into in-memory fakes.
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('synthetic-alpha')
    .setDescription('Synthetic alpha command'),
  async execute() {},
};
