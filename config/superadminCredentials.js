'use strict';

function nonEmptyString(value, fallback, options) {
  const raw = value == null ? '' : String(value);
  const normalized = options && options.trim === false ? raw : raw.trim();
  return normalized ? normalized : fallback;
}

function getSuperadminCredentials() {
  return {
    name: nonEmptyString(process.env.SUPERADMIN_NAME, 'Super Admin'),
    email: nonEmptyString(process.env.SUPERADMIN_EMAIL, 'superadmin@ems.com').toLowerCase(),
    password: nonEmptyString(process.env.SUPERADMIN_PASSWORD, 'EmsDemo@2026', { trim: false }),
  };
}

module.exports = {
  getSuperadminCredentials,
};
