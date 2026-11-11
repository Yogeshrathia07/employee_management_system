'use strict';
// End-to-end checks for document upload / view / download through the real routes,
// multer and auth middleware, using a temporary uploads folder and mocked models.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-uploads-'));
process.env.UPLOADS_DIR = path.join(uploadsRoot, 'store');   // not created yet: boot must create it
process.env.JWT_SECRET = 'document-files-test-secret';

const express = require('express');
const jwt = require('jsonwebtoken');
const models = require('../models');
const uploads = require('../config/uploads');

const PDF = Buffer.from('%PDF-1.4\n% document-files test\n%%EOF\n');
const records = new Map();
let nextId = 1;
let server;
let baseUrl;
const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
const authHeader = { Authorization: 'Bearer ' + token };

function addRecord(fields) {
  const row = { id: nextId++, userId: 7, type: 'other', mimeType: 'application/pdf', fileName: 'scan.pdf', issuedByCompany: false, ...fields };
  records.set(row.id, row);
  return row;
}

before(async () => {
  mock.method(models.User, 'findByPk', async id => ({ id: Number(id), role: Number(id) === 1 ? 'superadmin' : 'employee',
    status: 'active', companyId: 2, managerId: null }));
  mock.method(models.Document, 'count', async () => 0);
  mock.method(models.Document, 'create', async data => addRecord(data));
  mock.method(models.Document, 'findByPk', async id => records.get(Number(id)) || null);
  const app = express();
  app.use('/api', require('../routes'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = 'http://127.0.0.1:' + server.address().port + '/api';
});

after(() => {
  mock.restoreAll();
  server && server.close();
  fs.rmSync(uploadsRoot, { recursive: true, force: true });
});

async function fetchFile(id, action) {
  const res = await fetch(`${baseUrl}/documents/${id}/${action}`, { headers: authHeader });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

test('boot creates the configured uploads folders and reports them writable', () => {
  assert.equal(uploads.UPLOADS_ROOT, path.resolve(process.env.UPLOADS_DIR));
  assert.equal(fs.existsSync(uploads.DOCUMENTS_DIR), false);
  assert.deepEqual(uploads.ensureUploadDirs(), []);
  assert.ok(fs.statSync(uploads.DOCUMENTS_DIR).isDirectory());
  assert.ok(fs.statSync(uploads.PHOTOS_DIR).isDirectory());
});

test('a new upload stores only the file name and can be viewed and downloaded', async () => {
  uploads.ensureUploadDirs();
  const form = new FormData();
  form.append('title', 'Scan');
  form.append('type', 'other');
  form.append('file', new Blob([PDF], { type: 'application/pdf' }), 'Résumé आधार (v2).pdf');
  const res = await fetch(`${baseUrl}/documents`, { method: 'POST', headers: authHeader, body: form });
  assert.equal(res.status, 201, await res.clone().text());
  const doc = await res.json();
  assert.match(doc.filePath, /^\d+-\d+\.pdf$/, 'only the generated file name is stored');
  assert.equal(doc.fileName, 'Résumé आधार (v2).pdf', 'UTF-8 file name kept intact');
  assert.ok(fs.existsSync(path.join(uploads.DOCUMENTS_DIR, doc.filePath)), 'file written to the configured folder');

  const view = await fetchFile(doc.id, 'view');
  assert.equal(view.res.status, 200);
  assert.deepEqual(view.body, PDF);
  assert.equal(view.res.headers.get('content-disposition'),
    `inline; filename="R_sum_ ____ (v2).pdf"; filename*=UTF-8''${encodeURIComponent('Résumé आधार ')}%28v2%29.pdf`);
  assert.equal(uploads.contentDisposition('inline', 'a "quoted" name.pdf'),
    `inline; filename="a _quoted_ name.pdf"; filename*=UTF-8''a%20%22quoted%22%20name.pdf`);

  const download = await fetchFile(doc.id, 'download');
  assert.equal(download.res.status, 200);
  assert.deepEqual(download.body, PDF);
  assert.match(download.res.headers.get('content-disposition'), /^attachment; /);
});

test('legacy rows holding relative, absolute or differently-cased paths still resolve', async () => {
  uploads.ensureUploadDirs();
  const name = '1699000000000-123456789.pdf';
  fs.writeFileSync(path.join(uploads.DOCUMENTS_DIR, name), PDF);
  for (const stored of [
    `C:\\Users\\dev\\ems-updated\\uploads\\documents\\${name}`,
    `/Users/dev/ems-updated/uploads/documents/${name}`,
    `uploads/documents/${name}`,
    `uploads\\documents\\${name}`,
    name.toUpperCase(),
  ]) {
    const row = addRecord({ filePath: stored });
    for (const action of ['view', 'download']) {
      const { res, body } = await fetchFile(row.id, action);
      assert.equal(res.status, 200, `${action} ${stored}`);
      assert.deepEqual(body, PDF);
    }
  }
});

test('a missing file is a clean 404 that logs the absolute path looked up', async t => {
  uploads.ensureUploadDirs();
  const warn = t.mock.method(console, 'warn', () => {});
  const row = addRecord({ filePath: 'C:\\Users\\dev\\uploads\\documents\\gone.pdf' });
  for (const action of ['view', 'download']) {
    const { res, body } = await fetchFile(row.id, action);
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(body), { message: 'File not found on server' });
  }
  const logged = warn.mock.calls.map(call => call.arguments.join(' '));
  assert.ok(logged.some(line => line.includes(path.join(uploads.DOCUMENTS_DIR, 'gone.pdf'))), logged.join('\n'));
});

test('stored values cannot reach files outside the uploads folder', async t => {
  uploads.ensureUploadDirs();
  t.mock.method(console, 'warn', () => {});
  const appFile = path.join(__dirname, '..', 'server.js');
  for (const stored of ['../../server.js', '..\\..\\server.js', appFile, '..', 'scan.pdf\0.txt', '']) {
    const row = addRecord({ filePath: stored });
    const { res } = await fetchFile(row.id, 'view');
    assert.equal(res.status, 404, JSON.stringify(stored));
  }
  const dir = uploads.DOCUMENTS_DIR;
  assert.equal(uploads.resolveStoredFile(dir, '..'), null);
  assert.equal(uploads.resolveStoredFile(dir, 'a\0b.pdf'), null);
  assert.equal(uploads.resolveStoredFile(dir, '../../etc/passwd'), path.join(dir, 'passwd'));
  assert.equal(uploads.resolveStoredFile(dir, 'D:\\old\\uploads\\documents\\x.pdf'), path.join(dir, 'x.pdf'));
});
