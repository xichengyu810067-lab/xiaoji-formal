const { getRow, getTableNames, runSql } = require('../sqlHelpers');

// A contract step that runs on every open, without a schema version of its own: the retired web game
// server wrote a maintenance row (detail game_server_disabled) for each solo game whenever it was
// switched off, and nothing has updated those rows since the server was removed. Exactly those rows
// are deleted; a row with any other status or detail for these features (a real broken mark, say) is
// left as it is. Once they are gone it writes nothing. No version bump, so an older release can still
// open the file after a normal stop.
const STALE_GAME_HEALTH_FEATURES = Object.freeze(['tetris', 'number_match', 'sudoku']);
const STALE_GAME_HEALTH_WHERE = `feature_key IN (?, ?, ?) AND status = 'maintenance' AND detail = 'game_server_disabled'`;

function removeStaleWebGameHealthRows(db) {
  if (!getTableNames(db).has('feature_health')) return 0;
  const found = Number(getRow(db, `SELECT COUNT(*) AS count FROM feature_health WHERE ${STALE_GAME_HEALTH_WHERE}`,
    [...STALE_GAME_HEALTH_FEATURES]).count);
  if (found === 0) return 0;
  runSql(db, `DELETE FROM feature_health WHERE ${STALE_GAME_HEALTH_WHERE}`, [...STALE_GAME_HEALTH_FEATURES]);
  return Number(getRow(db, 'SELECT changes() AS count').count);
}

module.exports = {
  STALE_GAME_HEALTH_FEATURES,
  removeStaleWebGameHealthRows,
};
