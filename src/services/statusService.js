const packageJson = require('../../package.json');

function getBotStatus(client) {
  let online = false;
  try {
    online = typeof client?.isReady === 'function' ? client.isReady() : Boolean(client?.readyAt);
  } catch (_error) {
    online = false;
  }
  return {
    online,
    version: packageJson.version,
  };
}

module.exports = {
  getBotStatus,
};
