'use strict';

// Small, idempotent schema steps that sequelize.sync({ alter: true }) cannot do
// in the right order on its own. Each step checks the current schema first, so
// running it on every start is safe.

async function makeColumnNullable(sequelize, table, column, type, logger) {
  let rows;
  try {
    [rows] = await sequelize.query(`SHOW COLUMNS FROM \`${table}\` LIKE '${column}'`);
  } catch (err) {
    return; // table not created yet — sync will create it with the new definition
  }
  if (!rows || !rows.length || String(rows[0].Null).toUpperCase() === 'YES') return;
  try {
    await sequelize.query(`ALTER TABLE \`${table}\` MODIFY \`${column}\` ${type} NULL`);
    logger(`[migrate] ${table}.${column} is now optional`);
  } catch (err) {
    logger(`[migrate] could not make ${table}.${column} optional: ${err.message}`);
  }
}

async function runPreSyncMigrations(sequelize, options) {
  const logger = (options && options.logger) || console.log;
  // Projects are master data now; a project manager is optional. The column
  // must be nullable before sync adds the "ON DELETE SET NULL" foreign key.
  await makeColumnNullable(sequelize, 'Projects', 'managerId', 'INT(11)', logger);
}

module.exports = { runPreSyncMigrations };
