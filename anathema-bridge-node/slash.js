'use strict';

// Native Discord slash commands: typing "/" shows the options with descriptions, which
// the message-based `!bridger` syntax cannot do. Valour has no equivalent UI.
//
// Registration is per-guild so the commands appear immediately instead of waiting for
// global propagation.

const { SlashCommandBuilder } = require('discord.js');

const NAMES = ['restart', 'power', 'status', 'pause', 'resume', 'cmd', 'help'];

function definitions() {
  return [
    new SlashCommandBuilder()
      .setName('bridger')
      .setDescription('Anathema bridge controls')
      .addSubcommand(sub => sub.setName('restart').setDescription('Restart the hosted server (15s countdown)'))
      .addSubcommand(sub => sub.setName('power').setDescription('Stop the server if running, start it if stopped'))
      .addSubcommand(sub => sub.setName('status').setDescription('Report server status, TPS and player count'))
      .addSubcommand(sub =>
        sub
          .setName('pause')
          .setDescription('Silence alerts for a while (chat keeps flowing)')
          .addIntegerOption(option =>
            option
              .setName('minutes')
              .setDescription('How long to stay quiet; defaults to 120')
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(1440),
          ),
      )
      .addSubcommand(sub => sub.setName('resume').setDescription('Bring alerts back'))
      .addSubcommand(sub => sub.setName('help').setDescription('List the bridge controls'))
      .addSubcommand(sub =>
        sub
          .setName('cmd')
          .setDescription('Run a command in the server console')
          .addStringOption(option =>
            option
              .setName('command')
              .setDescription('Console command, e.g. say hello')
              .setRequired(true),
          ),
      )
      .toJSON(),
  ];
}

async function register(guild) {
  if (!guild) return;
  await guild.commands.set(definitions());
  console.log(`[Slash] Registered /bridger (${NAMES.join(', ')}) in ${guild.name}.`);
}

function createHandler({ control, channelId, allowedUserIds, logger = console }) {
  return async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'bridger') return;

    if (interaction.channelId !== channelId) {
      await interaction.reply({ content: 'Bridge controls only work in the alerts channel.', ephemeral: true }).catch(() => {});
      return;
    }

    if (!allowedUserIds.includes(interaction.user.id)) {
      logger.warn(`[Slash] rejected /bridger from ${interaction.user.tag} (${interaction.user.id}).`);
      await interaction.reply({ content: 'Not authorised for bridge controls.', ephemeral: true }).catch(() => {});
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    let text = `!bridger ${subcommand}`;

    if (subcommand === 'cmd') {
      text = `!bridger cmd [${interaction.options.getString('command')}]`;
    } else if (subcommand === 'pause') {
      const minutes = interaction.options.getInteger('minutes');
      text = minutes ? `!bridger pause ${minutes}` : '!bridger pause';
    }

    let replied = false;
    const reply = async content => {
      if (!replied) {
        replied = true;
        await interaction.reply({ content }).catch(() => {});
        return;
      }
      await interaction.followUp({ content }).catch(() => {});
    };

    try {
      await control.executeText(text, { requestedBy: `<@${interaction.user.id}>`, reply });
    } catch (error) {
      logger.error(`[Slash] /bridger ${subcommand} failed: ${error.message}`);
      await reply(`Command failed — ${error.message}`);
    }
  };
}

module.exports = { register, createHandler, definitions };
