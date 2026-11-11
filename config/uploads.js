'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// One absolute uploads folder, anchored to the app rather than process.cwd(), which
// changes with how the server is started (pm2, systemd, cPanel). Set UPLOADS_DIR to
// an absolute folder outside the deployed code so a redeploy cannot wipe the files.
const APP_UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const UPLOADS_ROOT = path.resolve(process.env.UPLOADS_DIR || APP_UPLOADS_ROOT);
const DOCUMENTS_DIR = path.join(UPLOADS_ROOT, 'documents');
const PHOTOS_DIR = path.join(UPLOADS_ROOT, 'photos');

// Creates the upload folders and reports any the app user cannot write to.
function ensureUploadDirs(logger = console) {
  const problems = [];
  for (const dir of [DOCUMENTS_DIR, PHOTOS_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      problems.push(dir);
      logger.error(`[uploads] ${dir} is not writable by the app user (${err.code || err.message}); uploads will fail`);
    }
  }
  return problems;
}

// Maps a stored file reference to an absolute path inside `dir`, or null when the
// value cannot be a file there. New rows store just the file name; legacy rows may
// hold a relative path or another machine's absolute path (C:\Users\...\uploads\x.pdf,
// /Users/...), so only the final name is used. Both separators are split because
// path.basename() on Linux does not treat "\" as a separator.
function resolveStoredFile(dir, storedValue) {
  const raw = String(storedValue ?? '').trim();
  if (!raw || raw.includes('\0')) return null;
  const name = raw.split(/[\\/]+/).pop();
  if (!name || name === '.' || name === '..') return null;
  const base = path.resolve(dir);
  const resolved = path.resolve(base, name);
  return resolved.startsWith(base + path.sep) ? resolved : null;
}

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
}

// Finds the file for a stored reference. Linux file names are case-sensitive while
// Windows ones are not, so a file copied from a dev machine with different casing is
// matched case-insensitively. `lookedUp` is the path to log when nothing is found.
function findStoredFile(dir, storedValue) {
  const lookedUp = resolveStoredFile(dir, storedValue);
  if (!lookedUp) return { path: null, lookedUp: null };
  if (isFile(lookedUp)) return { path: lookedUp, lookedUp };
  const wanted = path.basename(lookedUp).toLowerCase();
  try {
    const match = fs.readdirSync(dir).find(name => name.toLowerCase() === wanted);
    if (match && isFile(path.join(dir, match))) return { path: path.join(dir, match), lookedUp };
  } catch (_) {
    // folder missing or unreadable: fall through to "not found"
  }
  return { path: null, lookedUp };
}

// Content-Disposition that survives quotes and non-Latin names (RFC 6266 / 5987).
function contentDisposition(type, fileName) {
  const name = String(fileName || 'document').replace(/[\r\n]+/g, ' ');
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  APP_UPLOADS_ROOT, UPLOADS_ROOT, DOCUMENTS_DIR, PHOTOS_DIR,
  ensureUploadDirs, resolveStoredFile, findStoredFile, contentDisposition,
};
