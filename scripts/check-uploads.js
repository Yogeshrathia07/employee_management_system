'use strict';
// Read-only check for "File not found on server": lists database rows whose uploaded
// file is not in the uploads folder. It changes nothing. Run it on the server:
//   node scripts/check-uploads.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sequelize, Document, CompanyPolicy, Notification, WorkOrder, User, Company } = require('../models');
const { APP_UPLOADS_ROOT, UPLOADS_ROOT, DOCUMENTS_DIR, PHOTOS_DIR, findStoredFile } = require('../config/uploads');

const SOURCES = [
  ['Employee documents', Document, 'filePath', DOCUMENTS_DIR],
  ['Company policies', CompanyPolicy, 'fileUrl', DOCUMENTS_DIR],
  ['Notification attachments', Notification, 'filePath', DOCUMENTS_DIR],
  ['Work order annexures', WorkOrder, 'annexurePdfPath', DOCUMENTS_DIR],
  ['Profile photos', User, 'profilePhoto', PHOTOS_DIR],
  ['Company logos', Company, 'logoUrl', PHOTOS_DIR],
];

function storedForm(value) {
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) return 'Windows absolute path';
  if (value.startsWith('/')) return 'absolute path';
  if (/[\\/]/.test(value)) return 'relative path';
  return 'file name';
}

function listFiles(dir) {
  try { return fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir, name)).isFile()); } catch (_) { return []; }
}

async function main() {
  console.log(`Uploads folder: ${UPLOADS_ROOT}${process.env.UPLOADS_DIR ? ' (from UPLOADS_DIR)' : ' (inside the app folder)'}`);
  for (const dir of [DOCUMENTS_DIR, PHOTOS_DIR]) {
    const exists = fs.existsSync(dir);
    let writable = false;
    try { fs.accessSync(dir, fs.constants.W_OK); writable = true; } catch (_) {}
    console.log(`  ${dir}: ${exists ? listFiles(dir).length + ' files' : 'MISSING'}${exists && !writable ? ', NOT WRITABLE' : ''}`);
  }
  if (path.resolve(APP_UPLOADS_ROOT) !== UPLOADS_ROOT) {
    const left = listFiles(path.join(APP_UPLOADS_ROOT, 'documents')).length + listFiles(path.join(APP_UPLOADS_ROOT, 'photos')).length;
    if (left) console.log(`  ${left} file(s) are still in ${APP_UPLOADS_ROOT}; move them into ${UPLOADS_ROOT}`);
  }

  let missingTotal = 0;
  const referenced = new Set();
  for (const [label, Model, column, dir] of SOURCES) {
    const rows = (await Model.findAll({ attributes: ['id', column], raw: true }))
      .filter(row => String(row[column] || '').trim());
    const missing = [];
    const legacy = {};
    let caseOnly = 0;
    for (const row of rows) {
      const stored = String(row[column]).trim();
      const found = findStoredFile(dir, stored);
      const form = storedForm(stored);
      if (form !== 'file name') legacy[form] = (legacy[form] || 0) + 1;
      if (!found.path) { missing.push({ id: row.id, stored, lookedUp: found.lookedUp || '(rejected: not a file name inside the folder)' }); continue; }
      referenced.add(found.path);
      if (path.basename(found.path) !== path.basename(found.lookedUp)) caseOnly += 1;
    }
    missingTotal += missing.length;
    const notes = Object.entries(legacy).map(([form, n]) => `${n} stored as ${form}`);
    if (caseOnly) notes.push(`${caseOnly} matched only by ignoring letter case`);
    console.log(`\n${label}: ${rows.length} with a file, ${missing.length} missing${notes.length ? ' (' + notes.join(', ') + ')' : ''}`);
    missing.slice(0, 50).forEach(m => console.log(`  id ${m.id}: stored ${JSON.stringify(m.stored)} -> looked for ${m.lookedUp}`));
    if (missing.length > 50) console.log(`  ... and ${missing.length - 50} more`);
  }

  const unreferenced = listFiles(DOCUMENTS_DIR).filter(name => !referenced.has(path.join(DOCUMENTS_DIR, name))).length;
  console.log(`\n${unreferenced} file(s) in ${DOCUMENTS_DIR} are not referenced by any row.`);
  if (missingTotal) {
    console.log(`\n${missingTotal} row(s) point at files that are not on this server. Copy those files into the folder above`
      + ' (for example from the machine the database was exported from), or re-upload them.');
  }
  return missingTotal;
}

main()
  .then(missing => sequelize.close().then(() => process.exit(missing ? 1 : 0)))
  .catch(err => { console.error(err.message); sequelize.close().finally(() => process.exit(2)); });
