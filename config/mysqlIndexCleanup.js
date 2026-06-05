'use strict';

const TABLE_NAMES = [
  'Users', 'Leaves', 'Timesheets', 'Salaries', 'Documents',
  'Notifications', 'NotificationReads', 'RecycleBins', 'Tasks', 'Projects', 'CompanyPolicies', 'Companies',
  'Invoices', 'SpreadsheetWorkbooks',
  'Vendors', 'Clients', 'Quotations', 'Proformas', 'PurchaseOrders', 'WorkOrders', 'ProjectAccounts',
];

function uniqueList(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function sortIndexParts(parts) {
  return parts.slice().sort((a, b) => Number(a.Seq_in_index || 0) - Number(b.Seq_in_index || 0));
}

function buildIndexMeta(keyName, rows) {
  const parts = sortIndexParts(rows);
  const first = parts[0] || {};
  return {
    keyName,
    isPrimary: keyName === 'PRIMARY',
    isUnique: Number(first.Non_unique || 0) === 0,
    indexType: String(first.Index_type || '').toUpperCase(),
    columns: parts.map(part => String(part.Column_name || '')).join(','),
    columnsWithLength: parts.map(part => {
      const column = String(part.Column_name || '');
      return part.Sub_part ? `${column}(${part.Sub_part})` : column;
    }).join(','),
  };
}

function indexKeepSort(a, b) {
  const aGenerated = /_\d+$/.test(a.keyName) || /_key\d*$/i.test(a.keyName);
  const bGenerated = /_\d+$/.test(b.keyName) || /_key\d*$/i.test(b.keyName);
  if (aGenerated !== bGenerated) return aGenerated ? 1 : -1;
  if (a.keyName.length !== b.keyName.length) return a.keyName.length - b.keyName.length;
  return a.keyName.localeCompare(b.keyName);
}

function planDuplicateIndexDrops(rows) {
  const byName = new Map();
  rows.forEach(row => {
    const keyName = String(row.Key_name || '');
    if (!keyName) return;
    if (!byName.has(keyName)) byName.set(keyName, []);
    byName.get(keyName).push(row);
  });

  const indexes = Array.from(byName.entries())
    .map(([keyName, parts]) => buildIndexMeta(keyName, parts))
    .filter(index => !index.isPrimary);

  const duplicateGroups = new Map();
  indexes.forEach(index => {
    const groupKey = `${index.isUnique ? 'U' : 'N'}|${index.indexType}|${index.columnsWithLength}`;
    if (!duplicateGroups.has(groupKey)) duplicateGroups.set(groupKey, []);
    duplicateGroups.get(groupKey).push(index);
  });

  const dropNames = [];
  duplicateGroups.forEach(group => {
    if (group.length < 2) return;
    const sorted = group.slice().sort(indexKeepSort);
    sorted.slice(1).forEach(index => dropNames.push(index.keyName));
  });

  const uniqueGroups = new Set(
    indexes
      .filter(index => index.isUnique)
      .map(index => `${index.indexType}|${index.columnsWithLength}`)
  );

  indexes
    .filter(index => !index.isUnique)
    .forEach(index => {
      if (uniqueGroups.has(`${index.indexType}|${index.columnsWithLength}`)) {
        dropNames.push(index.keyName);
      }
    });

  return uniqueList(dropNames);
}

async function cleanupDuplicateIndexes(sequelize, options) {
  const opts = Object.assign({
    tables: TABLE_NAMES,
    logger: console.log,
    dryRun: false,
  }, options || {});

  const summary = [];

  for (const tableName of opts.tables) {
    try {
      const [rows] = await sequelize.query(`SHOW INDEX FROM \`${tableName}\``);
      const dropNames = planDuplicateIndexDrops(rows);
      const beforeCount = uniqueList(rows.map(row => row.Key_name)).length;
      const tableSummary = { tableName, beforeCount, dropped: [] };

      for (const keyName of dropNames) {
        if (opts.dryRun) {
          tableSummary.dropped.push(keyName);
          continue;
        }
        try {
          await sequelize.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${keyName}\``);
          tableSummary.dropped.push(keyName);
        } catch (err) {
          opts.logger(`[index-cleanup] Could not drop ${keyName} on ${tableName}: ${err.message}`);
        }
      }

      summary.push(tableSummary);

      if (tableSummary.dropped.length) {
        opts.logger(`[index-cleanup] ${tableName}: dropped ${tableSummary.dropped.length} duplicate/redundant index(es)`);
      }
    } catch (err) {
      opts.logger(`[index-cleanup] ${tableName}: skipped (${err.message})`);
    }
  }

  return summary;
}

module.exports = {
  TABLE_NAMES,
  cleanupDuplicateIndexes,
  planDuplicateIndexDrops,
};
