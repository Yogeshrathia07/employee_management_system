require('dotenv').config();
const sequelize = require('../config/database');
const { cleanupDuplicateIndexes } = require('../config/mysqlIndexCleanup');

async function run() {
  await sequelize.authenticate();
  console.log('Connected to MySQL');

  await cleanupDuplicateIndexes(sequelize, { logger: console.log });

  await sequelize.close();
  console.log('\nIndex cleanup finished. You can now start the server with: npm run dev');
}

run().catch(err => { console.error(err.message); process.exit(1); });
