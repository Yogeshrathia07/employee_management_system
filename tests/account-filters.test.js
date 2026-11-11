'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const filters = require('../public/js/account-filters');

function fixture(key) {
  const config = filters.configs[key];
  return ['2026-04-01', '2027-03-31', '2027-04-01', '1800-05-01'].map((date, index) => ({
    id: index + 1, companyId: index === 2 ? 2 : 1, status: index === 1 ? 'Sent' : 'Draft',
    [config.date[0]]: date, [config.name[0]]: ['Zeta', 'Alpha', 'Beta', 'Historical'][index],
    [config.reference[0]]: 'REF-' + [10, 2, 1, 20][index],
    ...(config.amount ? { [config.amount]: [400, 100, 300, 200][index] } : {}),
    contactPerson: 'Contact ' + (index + 1), gstin: 'GSTIN-' + (index + 1),
    paymentType: index === 1 ? 'advance' : 'bill', documentType: 'Tax Invoice', invoiceType: 'B2B'
  }));
}
const ids = rows => rows.map(row => row.id);

test('financial-year picker uses April-March and retains full centuries', () => {
  assert.deepEqual([filters.period('2026', '04').from, filters.period('2026', '04').to], ['2026-04-01', '2027-03-31']);
  assert.equal(filters.period('2026', '01').from, '2025-04-01');
  assert.equal(filters.period('2026', '').from, '2026-04-01');
  assert.equal(filters.period('1800', '06').label, 'FY 1800-1801');
  assert.equal(filters.period('9999', '').to, '9999-12-31');
  assert.equal(filters.period('1000', '01').from, '1000-01-01');
  assert.equal(filters.period('', '').all, true);
});
test('partial, excessive, decimal, negative and missing years are invalid', () => {
  for (const value of ['444', '22222', '-2026', '20.26', '1e3', '0001']) assert.equal(filters.period(value, '04').valid, false, value);
  assert.equal(filters.period('', '04').valid, false);
  assert.equal(filters.period('2026', '13').valid, false);
});
for (const key of Object.keys(filters.configs).filter(key => key !== 'tds')) {
  test(`${key}: company, status, FY and search combine correctly`, () => {
    const rows = fixture(key);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { companyId: '1', year: '2026', status: 'draft' })), [1]);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { year: '2026' })), [2, 1]);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { companyId: '2', year: '2026' })), []);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { q: 'GSTIN-2' })), [2]);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { q: 'Contact 3' })), [3]);
  });
  test(`${key}: all years, historical years and date ranges work`, () => {
    const rows = fixture(key);
    assert.equal(filters.filterAndSort(rows, key, {}).length, 4);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { year: '1800' })), [4]);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { from: '2026-05-01', to: '2027-03-31' })), [2]);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { year: '22222' })), []);
  });
  test(`${key}: date, name, reference and applicable amount sorts are stable`, () => {
    const rows = fixture(key);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { sort: 'date_asc' })), [4, 1, 2, 3]);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { sort: 'customer_asc' })), [2, 3, 4, 1]);
    assert.deepEqual(ids(filters.filterAndSort(rows, key, { sort: 'reference_asc' })), [3, 2, 1, 4]);
    if (filters.configs[key].amount) assert.deepEqual(ids(filters.filterAndSort(rows, key, { sort: 'amount_desc' })), [1, 3, 4, 2]);
    assert.deepEqual(ids(rows), [1, 2, 3, 4]);
  });
}
test('work orders and projects fall back to registration date when start date is absent', () => {
  for (const key of ['cwo', 'vwo', 'prj']) assert.equal(filters.filterAndSort([{ id: 1, startDate: null, createdAt: '2026-10-15T23:59:00.000Z' }], key, { year: '2026' }).length, 1);
});
test('invoice document types and payment categories remain independent', () => {
  const invoices = fixture('inv');
  invoices[1].invoiceType = 'B2C';
  invoices[2].documentType = 'Credit Note';
  assert.deepEqual(ids(filters.filterAndSort(invoices, 'inv', { type: 'Tax Invoice:B2C' })), [2]);
  assert.deepEqual(ids(filters.filterAndSort(invoices, 'inv', { type: 'Credit Note' })), [3]);
  assert.deepEqual(ids(filters.filterAndSort(fixture('pay'), 'pay', { type: 'advance' })), [2]);
});
test('dated filters exclude undated records; all years retains them', () => {
  assert.equal(filters.filterAndSort([{ id: 1 }], 'pro', {}).length, 1);
  assert.equal(filters.filterAndSort([{ id: 1 }], 'pro', { year: '2026' }).length, 0);
});
test('admin and superadmin templates contain all filter bars and valid scripts without duplicate IDs', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'views/superadmin/accounts.ejs'), 'utf8');
  for (const pageRole of ['admin', 'superadmin']) {
    const html = ejs.render(source, { pageRole, title: 'Accounts' }, { filename: path.join(root, 'views/superadmin/accounts.ejs'), root: path.join(root, 'views') });
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const key of Object.keys(filters.configs).concat('rep')) {
      assert.ok(ids.includes(key + '-sort'));
      assert.ok(ids.includes(key + '-fy-year'));
      assert.equal(ids.includes(key + '-company-filter'), pageRole === 'superadmin');
    }
    assert.equal((html.match(/data-account-filter=/g) || []).length, 12);
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1]);
  }
});

function tdsFixture() {
  return [
    { id: 1, companyId: 1, code: 'C10', nature: 'Contractor', section: '194C', payeeType: 'Individual', rate: '1', active: true, applicableFrom: '2024-04-01', applicableTo: null, createdAt: '2030-01-01', conditionNote: 'Backdated applicability' },
    { id: 2, companyId: 1, code: 'C2', nature: 'Rent', section: '194I', payeeType: 'Company', rate: '10', active: false, applicableFrom: '2026-04-01', applicableTo: '2026-06-30' },
    { id: 3, companyId: 2, code: 'C1', nature: 'Goods', section: '194Q', payeeType: 'Buyer', rate: '0.1', active: true, applicableFrom: '2025-01-01', applicableTo: '2026-03-31' },
    { id: 4, companyId: 1, code: 'C20', nature: 'Professional', section: '194J', payeeType: 'Any', rate: '2', active: true, applicableFrom: '2027-04-01', applicableTo: null },
    { id: 5, companyId: 1, code: 'ANY', nature: 'General', section: '', payeeType: 'Any', rate: '3', active: true, applicableFrom: null, applicableTo: null },
    { id: 6, companyId: 1, code: 'BOUNDARY-MARCH', nature: 'March rule', rate: '4', active: true, applicableFrom: '2027-03-31', applicableTo: '2027-03-31' },
    { id: 7, companyId: 1, code: 'BOUNDARY-APRIL', nature: 'April rule', rate: '5', active: true, applicableFrom: '2026-01-01', applicableTo: '2026-04-01' }
  ];
}
test('TDS financial years match overlapping applicability, including open and undated rules', () => {
  assert.deepEqual(ids(filters.filterAndSort(tdsFixture(), 'tds', { companyId: 1, status: 'Active', year: '2026' })), [6, 7, 1, 5]);
  assert.deepEqual(ids(filters.filterAndSort(tdsFixture(), 'tds', { status: 'Inactive', year: '2026' })), [2]);
  assert.ok(!ids(filters.filterAndSort(tdsFixture(), 'tds', { year: '2026' })).includes(3));
});
test('TDS filters use applicability rather than rule creation date', () => {
  assert.equal(filters.filterAndSort(tdsFixture(), 'tds', { q: 'Backdated', year: '2026' })[0].id, 1);
  assert.equal(filters.filterAndSort(tdsFixture(), 'tds', { q: 'Professional', year: '2026' }).length, 0);
});
test('TDS company, section, payee and search filters combine', () => {
  assert.deepEqual(ids(filters.filterAndSort(tdsFixture(), 'tds', { companyId: '1', section: '194c', payeeType: 'individual', q: 'Contractor' })), [1]);
  assert.deepEqual(ids(filters.filterAndSort(tdsFixture(), 'tds', { q: '194Q' })), [3]);
  assert.equal(filters.filterAndSort(tdsFixture(), 'tds', { companyId: 1, section: '194Q' }).length, 0);
});
test('TDS rate and code ordering use numeric values and preserve source records', () => {
  const rows = tdsFixture();
  assert.deepEqual(ids(filters.filterAndSort(rows, 'tds', { sort: 'rate_asc' })), [3, 1, 4, 5, 6, 7, 2]);
  assert.ok(ids(filters.filterAndSort(rows, 'tds', { sort: 'reference_asc' })).indexOf(2) < ids(filters.filterAndSort(rows, 'tds', { sort: 'reference_asc' })).indexOf(1));
  assert.deepEqual(ids(rows), [1, 2, 3, 4, 5, 6, 7]);
});
test('TDS all years preserves all records and invalid or disjoint ranges produce no matches', () => {
  assert.equal(filters.filterAndSort(tdsFixture(), 'tds', {}).length, 7);
  assert.equal(filters.filterAndSort(tdsFixture(), 'tds', { year: '22222' }).length, 0);
  assert.equal(filters.filterAndSort(tdsFixture(), 'tds', { year: '2026', from: '2029-01-01', to: '2029-12-31' }).length, 0);
});
test('TDS treats boolean, numeric and serialized false values as inactive', () => {
  const rows = [false, 0, '0', 'false', true].map((active, index) => ({ id: index + 1, active }));
  assert.equal(filters.filterAndSort(rows, 'tds', { status: 'Inactive' }).length, 4);
  assert.deepEqual(ids(filters.filterAndSort(rows, 'tds', { status: 'Active' })), [5]);
});
