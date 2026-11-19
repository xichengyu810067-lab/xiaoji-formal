// Statement helpers for a node:sqlite database (DatabaseSync), and the checks of table shape, foreign
// keys and integrity that the open sequence and the migrations share. Nothing here holds state.
//
// The helpers keep the behaviour the callers were written against (sql.js until v1.3.x):
//   - Rows are plain objects. node:sqlite returns rows with a null prototype; each is copied.
//   - Parameters are an array (positional) or an object (named). A JS number that fits in 32 bits
//     is bound as an INTEGER and every other number as a REAL, a BigInt as its decimal text and a
//     boolean as 1 or 0, exactly as sql.js bound them (node:sqlite on its own binds every number
//     as a REAL, which would store 5 as '5.0' in a TEXT column).
//   - runSql without parameters executes every statement of the text (exec); with parameters it
//     runs the first statement only.
//   - A SQLite error is thrown as a plain Error with SQLite's message, as sql.js threw it: node:sqlite
//     adds code 'ERR_SQLITE_ERROR', which callers that report error.code would otherwise show. SQLite's
//     result code stays on it as errcode (and errstr).
function bindValue(value) {
  if (typeof value === 'number') return value === (value | 0) ? BigInt(value) : value;
  if (typeof value === 'bigint') return String(value);
  return value;
}

function bindParameters(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params.map(bindValue);
  if (typeof params === 'object' && !ArrayBuffer.isView(params)) {
    return [Object.fromEntries(Object.entries(params).map(([key, value]) => [key, bindValue(value)]))];
  }
  return [];
}

function plainSqliteError(error) {
  if (error?.code !== 'ERR_SQLITE_ERROR') return error;
  const plain = new Error(error.message);
  plain.errcode = error.errcode;
  plain.errstr = error.errstr;
  return plain;
}

function getRows(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...bindParameters(params)).map((row) => ({ ...row }));
  } catch (error) {
    throw plainSqliteError(error);
  }
}

function getRow(db, sql, params = []) {
  return getRows(db, sql, params)[0] || null;
}

function runSql(db, sql, params = []) {
  try {
    if (params == null || (Array.isArray(params) && params.length === 0)) {
      db.exec(sql);
      return;
    }
    db.prepare(sql).run(...bindParameters(params));
  } catch (error) {
    throw plainSqliteError(error);
  }
}

function getTableNames(db) {
  return new Set(
    getRows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).map((row) => row.name)
  );
}

function getColumnNames(db, tableName) {
  return getRows(db, `PRAGMA table_info(${tableName})`).map((column) => column.name);
}

function getTableColumns(db, tableName) {
  return getRows(db, `PRAGMA table_info(${tableName})`).map((column) => ({
    name: column.name,
    type: String(column.type || '').trim().toUpperCase(),
    notNull: Number(column.notnull) === 1,
    defaultValue: column.dflt_value == null ? null : String(column.dflt_value).trim(),
    primaryKeyPosition: Number(column.pk),
  }));
}

function addColumnIfMissing(db, tableName, columnName, columnDefinition) {
  const columns = getColumnNames(db, tableName);

  if (!columns.includes(columnName)) {
    runSql(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

function hasUniqueIndex(db, tableName, expectedColumns) {
  const indexes = getRows(db, `PRAGMA index_list(${tableName})`).filter((index) => Number(index.unique) === 1);

  return indexes.some((index) => {
    const quotedIndexName = `"${String(index.name).replaceAll('"', '""')}"`;
    const columns = getRows(db, `PRAGMA index_info(${quotedIndexName})`).map((column) => column.name);
    return columns.length === expectedColumns.length && columns.every((column, index) => column === expectedColumns[index]);
  });
}

function getTableDefinition(db, tableName) {
  const row = getRow(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);

  if (!row?.sql) {
    throw new Error(`${tableName} is missing its table definition`);
  }

  return String(row.sql)
    .toLowerCase()
    .replace(/[\s\"`\[\]]+/g, '');
}

function verifyTableContract(db, tableName, requiredColumns, requiredChecks) {
  const actualColumns = new Map(getTableColumns(db, tableName).map((column) => [column.name, column]));

  for (const [columnName, expected] of Object.entries(requiredColumns)) {
    const actual = actualColumns.get(columnName);

    if (!actual) {
      throw new Error(`${tableName} is missing required column: ${columnName}`);
    }

    if (
      actual.type !== expected.type ||
      actual.notNull !== expected.notNull ||
      actual.defaultValue !== expected.defaultValue ||
      actual.primaryKeyPosition !== expected.primaryKeyPosition
    ) {
      throw new Error(`${tableName}.${columnName} does not match its required schema contract`);
    }
  }

  const definition = getTableDefinition(db, tableName);
  for (const check of requiredChecks) {
    if (!definition.includes(check)) {
      throw new Error(`${tableName} is missing required CHECK constraint: ${check}`);
    }
  }
}

function assertForeignKeysEnabled(db) {
  if (Number(getRow(db, 'PRAGMA foreign_keys')?.foreign_keys) !== 1) {
    throw new Error('SQLite foreign key enforcement is disabled');
  }
}

function enableForeignKeys(db) {
  runSql(db, 'PRAGMA foreign_keys = ON');
  assertForeignKeysEnabled(db);
}

function verifyForeignKeyIntegrity(db) {
  const violation = getRow(db, 'PRAGMA foreign_key_check');
  if (violation) throw new Error(`SQLite foreign key violation in ${violation.table}`);
}

// The bytes of the whole main database (sqlite3_serialize); nothing is written.
function exportDatabase(db) {
  return Buffer.from(db.serialize());
}

function verifyIntegrity(db) {
  const result = getRow(db, 'PRAGMA integrity_check');
  const value = result?.integrity_check;

  if (value !== 'ok') {
    throw new Error(`SQLite integrity check failed: ${value || 'unknown result'}`);
  }
}

function getColumnNameSet(db, tableName) {
  return new Set(getRows(db, `PRAGMA table_info(${tableName})`).map((row) => row.name));
}

function requireColumns(db, tableName, requiredColumns) {
  const columns = getColumnNameSet(db, tableName);
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`${tableName} is missing required columns: ${missing.join(', ')}`);
  }
}

module.exports = {
  getRows,
  getRow,
  runSql,
  getTableNames,
  getColumnNames,
  getTableColumns,
  addColumnIfMissing,
  hasUniqueIndex,
  getTableDefinition,
  verifyTableContract,
  assertForeignKeysEnabled,
  enableForeignKeys,
  verifyForeignKeyIntegrity,
  exportDatabase,
  verifyIntegrity,
  getColumnNameSet,
  requireColumns,
};
