'use strict';

const { reportSecurityAlert } = require('../platform/safetyEventCatalog');

// Reports a security alert (see safetyEventCatalog.js) for a slash command or button interaction: where it
// happened (the guild, or a direct message) and who and what started it are taken from the interaction; nothing
// the user wrote is passed on. The notifier turns it into at most one fixed DM per guild and kind an hour, and
// only when this runs inside the host's operation for that interaction. A kind outside the catalogue throws.
function reportInteractionSecurityAlert(kind, interaction) {
  return reportSecurityAlert(kind, {
    guildId: interaction?.guildId ?? null,
    guildName: interaction?.guild?.name ?? '',
    actorId: interaction?.user?.id ?? null,
    channelId: interaction?.channelId ?? null,
    messageId: interaction?.id ?? null,
  });
}

module.exports = { reportInteractionSecurityAlert };
