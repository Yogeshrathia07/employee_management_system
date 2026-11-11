'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PayrollCalc = require('../public/js/payroll-calc');
const { Salary } = require('../models');
const { runPreSyncMigrations } = require('../config/schemaMigrations');
const root = path.resolve(__dirname, '..');

// A full month of a ₹20,000 structure with no conveyance, so wages = CTC unless days are lost.
const month = (extra = {}) => PayrollCalc.compute(Object.assign({
  month: 11, year: 2026, totalDays: 30, allowedLeave: 2, leaveTaken: 0,
  basicSalary: 12000, hra: 5000, specialAllowance: 3000,
}, extra));

test('ESIC is not deducted unless the employee is marked applicable', () => {
  const c = month();
  assert.equal(c.esic, 0);
  assert.equal(c.employerEsic, 0);
  assert.equal(c.totalDeductions, 0);
  assert.equal(c.netSalary, 20000);
});

test('ESIC takes 0.75% from the employee and shows the 3.25% employer share separately', () => {
  const c = month({ esicApplicable: true, pfContribution: 1800 });
  assert.equal(c.esic, 150);
  assert.equal(c.employerEsic, 650);
  assert.equal(c.totalDeductions, 1950);          // PF + ESIC; the employer share is not deducted
  assert.equal(c.netSalary, 20000 - 1950);
});

test('ESIC is calculated on wages earned, after absent / LOP days', () => {
  // 5 days of leave with 2 allowed → 3 unpaid days → ₹2,000 absent deduction.
  const c = month({ esicApplicable: true, leaveTaken: 5 });
  assert.equal(c.absentDeduction, 2000);
  assert.equal(c.esicWages, 18000);
  assert.equal(c.esic, 135);
  assert.equal(c.employerEsic, 585);
});

test('ESIC contributions round up to the next rupee', () => {
  const c = PayrollCalc.compute({ totalDays: 30, basicSalary: 18333, esicApplicable: true });
  assert.equal(c.esic, 138);          // 137.4975
  assert.equal(c.employerEsic, 596);  // 595.8225
  const exact = PayrollCalc.compute({ totalDays: 30, basicSalary: 20000, esicApplicable: true });
  assert.equal(exact.esic, 150);      // an exact amount is not pushed up
});

test('ESIC stops above the ₹21,000 wage limit', () => {
  const atLimit = PayrollCalc.compute({ totalDays: 30, basicSalary: 21000, esicApplicable: true });
  assert.equal(atLimit.esic, 158);
  assert.equal(atLimit.esicAboveLimit, false);
  const above = PayrollCalc.compute({ totalDays: 30, basicSalary: 21001, esicApplicable: true });
  assert.equal(above.esic, 0);
  assert.equal(above.employerEsic, 0);
  assert.equal(above.esicAboveLimit, true);
});

test('the payroll sheet\'s Yes/No values and the server\'s booleans mean the same', () => {
  assert.equal(month({ esicApplicable: 'Yes' }).esic, 150);
  assert.equal(month({ esicApplicable: 'No' }).esic, 0);
  assert.equal(month({ esicApplicable: 'true' }).esic, 150);
  assert.equal(month({ esicApplicable: 1 }).esic, 150);
  assert.equal(month({ esicApplicable: false }).esic, 0);
});

test('salary records keep the ESIC they were created with', () => {
  const base = { month: 11, year: 2026, totalDays: 30, basicSalary: 12000, hra: 5000, specialAllowance: 3000 };
  const old = Salary.withPayroll(base);                       // saved before ESIC existed
  assert.equal(old.esic, 0);
  assert.equal(old.netSalary, 20000);
  const covered = Salary.withPayroll(Object.assign({ esicApplicable: true }, base));
  assert.equal(covered.esic, 150);
  assert.equal(covered.employerEsic, 650);
  assert.equal(covered.deductions, 150);
  assert.equal(covered.netSalary, 19850);
});

test('the ESIC columns are added when missing, even with DB_SYNC_ALTER=false', async () => {
  const run = async existing => {
    const statements = [];
    const sequelize = { query: async sql => {
      statements.push(sql);
      if (sql.startsWith('SHOW COLUMNS')) {
        const [, table, column] = sql.match(/FROM `(\w+)` LIKE '(\w+)'/);
        return [existing(table, column) ? [{ Field: column, Null: 'YES' }] : []];
      }
      return [[]];
    } };
    await runPreSyncMigrations(sequelize, { logger: () => {} });
    return statements.filter(sql => sql.startsWith('ALTER TABLE') && sql.includes('ADD COLUMN'));
  };
  const added = await run(() => false);
  assert.deepEqual(added.map(sql => sql.match(/`(\w+)` ADD COLUMN `(\w+)`/).slice(1).join('.')).sort(),
    ['Salaries.employerEsic', 'Salaries.esic', 'Salaries.esicApplicable', 'Users.esicApplicable']);
  assert.deepEqual(await run(() => true), []);
});

test('company lists show the GST number so companies with the same name can be told apart', () => {
  const source = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  const start = source.indexOf('// ─── Company dropdowns ───');
  const end = source.indexOf('\nfunction setAuthCookie', start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.companyOptionLabel({ id: 1, name: 'DHPE', gstNo: '27AAACD1234E1Z5' }), 'DHPE | GST: 27AAACD1234E1Z5');
  assert.equal(context.companyOptionLabel({ id: 2, name: 'DHPE', gstNo: '' }), 'DHPE');
  assert.equal(context.companyOptionHtml({ id: 3, name: 'A & B <Builders>', gstNo: '29X' }),
    '<option value="3">A &amp; B &lt;Builders&gt; | GST: 29X</option>');
});

test('the service worker file only removes leftover workers and never serves pages from a cache', () => {
  const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  assert.ok(!/addEventListener\(\s*['"]fetch/.test(sw));
  assert.ok(sw.includes('registration.unregister()'));
  assert.ok(sw.includes('caches.delete'));
});
