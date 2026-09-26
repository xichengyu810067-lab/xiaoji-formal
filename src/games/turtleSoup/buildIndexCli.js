const implementation = require('../../systems/games/board/turtleSoup/buildIndexCli');
if (require.main === module) process.exitCode = implementation.main();
module.exports = implementation;
