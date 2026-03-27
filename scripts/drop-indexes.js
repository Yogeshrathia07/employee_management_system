// One-time cleanup: drops ALL non-PRIMARY indexes from EMS tables
// Run once with: node scripts/drop-indexes.js
require('dotenv').config();
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  { host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 3306, dialect: 'mysql', logging: false }
);

const TABLES = [
  'Users', 'Leaves', 'Timesheets', 'Salaries', 'Documents',
  'Notifications', 'NotificationReads', 'RecycleBins', 'Tasks', 'CompanyPolicies', 'Companies',
];

async function run() {
  await sequelize.authenticate();
  console.log('Connected to MySQL');

  for (const table of TABLES) {
    try {
      const [rows] = await sequelize.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name != 'PRIMARY'`);
      const unique = [...new Set(rows.map(r => r.Key_name))];
      for (const key of unique) {
        try {
          await sequelize.query(`ALTER TABLE \`${table}\` DROP INDEX \`${key}\``);
          console.log(`  Dropped index ${key} on ${table}`);
        } catch (e) {
          console.log(`  Could not drop ${key} on ${table}: ${e.message}`);
        }
      }
      if (unique.length === 0) console.log(`  ${table}: no extra indexes`);
    } catch (e) {
      console.log(`  ${table}: skipped (${e.message})`);
    }
  }

  await sequelize.close();
  console.log('\nDone! You can now start the server with: npm run dev');
}

run().catch(err => { console.error(err.message); process.exit(1); });
