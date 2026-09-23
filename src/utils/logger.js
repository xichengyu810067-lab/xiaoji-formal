const secretNamePattern = /(TOKEN|API[_-]?KEY|SECRET|PASSWORD|WEBHOOK)/i;
const discordTokenPattern = /[MN][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,}/g;
const openAiKeyPattern = /\b(sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,})\b/g;

function timestamp() {
  return new Date().toISOString();
}

function getKnownSecrets() {
  return Object.entries(process.env)
    .filter(([name, value]) => secretNamePattern.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value);
}

function redactText(value) {
  let output = String(value)
    .replace(discordTokenPattern, '[redacted-discord-token]')
    .replace(openAiKeyPattern, '[redacted-api-key]');

  for (const secret of getKnownSecrets()) {
    output = output.split(secret).join('[redacted-secret]');
  }

  return output;
}

function formatCause(cause) {
  if (!cause) {
    return '';
  }

  if (cause instanceof Error) {
    return redactText(cause.stack || cause.message);
  }

  try {
    return redactText(JSON.stringify(cause));
  } catch {
    return redactText(cause);
  }
}

function info(message) {
  console.log(`[${timestamp()}] [info] ${redactText(message)}`);
}

function warn(message) {
  console.warn(`[${timestamp()}] [warn] ${redactText(message)}`);
}

function error(message, cause) {
  console.error(`[${timestamp()}] [error] ${redactText(message)}`);

  if (cause) {
    console.error(formatCause(cause));
  }
}

module.exports = {
  redactText,
  info,
  warn,
  error,
};
