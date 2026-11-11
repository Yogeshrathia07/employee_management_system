'use strict';
// Run with Playwright available through NODE_PATH or the local dev installation.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const companies = [{ id: 1, name: 'Example Engineering', status: 'active' }, { id: 2, name: 'Other Construction', status: 'inactive' }];
function records(key) {
  return ['2026-06-15', '2025-06-15', '2026-06-30'].map((date, i) => ({
    id: i + 1, companyId: i === 2 ? 2 : 1, name: ['Zeta Client', 'Alpha Client', 'Beta Client'][i],
    customerName: ['Zeta Client', 'Alpha Client', 'Beta Client'][i], clientName: ['Zeta Client', 'Alpha Client', 'Beta Client'][i],
    vendorName: ['Zeta Client', 'Alpha Client', 'Beta Client'][i], partyName: ['Zeta Client', 'Alpha Client', 'Beta Client'][i],
    invoiceNumber: 'INV-' + (i + 1), proformaNumber: 'PRO-' + (i + 1), quotationNumber: 'QUO-' + (i + 1),
    poNumber: 'PO-' + (i + 1), woNumber: 'WO-' + (i + 1), projectCode: 'PRJ-' + (i + 1),
    clientCode: 'CLT-' + (i + 1), vendorCode: 'VEN-' + (i + 1), paymentNumber: 'PAY-' + (i + 1),
    date, invoiceDate: date, paymentDate: date, startDate: date, createdAt: date + 'T00:00:00Z',
    financialYear: i === 1 ? '25-26' : '26-27', status: key === 'clt' || key === 'ven' ? 'Active' : 'Draft',
    documentType: 'Tax Invoice', invoiceType: 'B2B', paymentType: i === 1 ? 'advance' : 'bill',
    totalAmount: [300, 100, 200][i], budget: [300, 100, 200][i], spent: 0,
    grossAmount: [300, 100, 200][i], gstAmount: 0, netAmount: [300, 100, 200][i],
    invoices: [], purchaseOrders: [], workOrders: [], items: [], email: 'contact@example.test'
  }));
}
function tdsRecords() {
  return [
    { id: 101, companyId: 1, code: 'TDS-CON', nature: 'Contractor', section: '194C', payeeType: 'Individual', rate: 1, active: true, applicableFrom: '2024-04-01', applicableTo: null },
    { id: 102, companyId: 1, code: 'TDS-INACTIVE', nature: 'Inactive professional', section: '194J', payeeType: 'Company', rate: 10, active: false, applicableFrom: '2026-04-01', applicableTo: null },
    { id: 103, companyId: 2, code: 'TDS-OTHER', nature: 'Other company rule', section: '194J', payeeType: 'Company', rate: 2, active: true, applicableFrom: '2026-04-01', applicableTo: null },
    { id: 104, companyId: 1, code: 'TDS-FUTURE', nature: 'Future rule', section: '194J', payeeType: 'Company', rate: 3, active: true, applicableFrom: '2028-04-01', applicableTo: null },
    { id: 105, companyId: 1, code: 'TDS-ANY-DATE', nature: 'Any date rule', section: '194Q', payeeType: 'Any', rate: 0.1, active: true, applicableFrom: null, applicableTo: null },
    { id: 106, companyId: 1, code: 'TDS-BOUNDED', nature: 'Quarterly rule', section: '194H', payeeType: 'Company', rate: 5, active: true, applicableFrom: '2026-04-01', applicableTo: '2026-06-30' }
  ].map(rule => ({ ...rule, company: companies.find(company => company.id === rule.companyId) }));
}
let role = 'superadmin';
const invoiceQueries = [];
const tdsWrites = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/superadmin/accounts' || url.pathname === '/admin/accounts') {
    res.setHeader('Content-Type', 'text/html');
    res.end(ejs.render(fs.readFileSync(path.join(root, 'views/superadmin/accounts.ejs'), 'utf8'),
      { pageRole: role, title: 'Accounts' }, { filename: path.join(root, 'views/superadmin/accounts.ejs'), root: path.join(root, 'views') }));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.startsWith('/api/tds-rules') && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { tdsWrites.push({ path: url.pathname, body: JSON.parse(body || '{}') }); res.end(JSON.stringify({ message: 'Test request recorded', created: 0 })); });
      return;
    }
    if (url.pathname === '/api/tds-rules') {
      const companyId = role === 'admin' ? '1' : url.searchParams.get('companyId');
      return res.end(JSON.stringify(tdsRecords().filter(rule => !companyId || String(rule.companyId) === companyId)));
    }
    if (url.pathname === '/api/users/me') return res.end(JSON.stringify({ id: 1, name: 'QA User', role, companyId: role === 'admin' ? 1 : null }));
    if (url.pathname === '/api/companies') return res.end(JSON.stringify(role === 'admin' ? companies.slice(0, 1) : companies));
    const endpoints = { invoices: 'inv', payments: 'pay', 'proformas-db': 'pro', quotations: 'quo', 'purchase-orders': 'po', clients: 'clt', vendors: 'ven', 'project-accounts': 'prj', 'work-orders': 'cwo' };
    const endpoint = url.pathname.slice(5);
    if (endpoints[endpoint]) {
      if (endpoint === 'invoices') invoiceQueries.push(url.searchParams.toString());
      let rows = records(endpoints[endpoint]);
      if (role === 'admin') rows = rows.filter(row => row.companyId === 1);
      return res.end(JSON.stringify(rows));
    }
    return res.end(JSON.stringify(url.pathname.includes('settings') ? {} : []));
  }
  const file = path.resolve(root, 'public', '.' + decodeURIComponent(url.pathname));
  if (file.startsWith(path.join(root, 'public') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.statusCode = 404;
  res.end();
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(() => {
      localStorage.setItem('ems_token', 'qa-token');
      localStorage.setItem('ems_user', JSON.stringify({ id: 1, name: 'QA User', role: 'superadmin' }));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin + '/superadmin/accounts');
    await page.waitForFunction(() => document.querySelectorAll('#inv-company-filter option').length === 3);
    const checkTabs = async () => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.locator('.acc-module-nav').evaluate(nav => {
        const box = nav.getBoundingClientRect();
        const tabs = [...nav.querySelectorAll('.acc-tab')].map(tab => ({ ...Object.fromEntries(['left', 'right', 'top', 'width'].map(key => [key, tab.getBoundingClientRect()[key]])), clipped: tab.scrollWidth > tab.clientWidth }));
        const bottom = Math.max(...tabs.map(tab => tab.top));
        const last = tabs.filter(tab => Math.abs(tab.top - bottom) < 1);
        return { widths: tabs.map(tab => tab.width), columns: getComputedStyle(nav).getPropertyValue('--account-tab-columns'), container: getComputedStyle(nav.parentElement).containerName, centered: Math.abs((last[0].left + last.at(-1).right) / 2 - (box.left + box.right) / 2), clipped: tabs.some(tab => tab.clipped) };
      });
      assert.ok(Math.max(...layout.widths) - Math.min(...layout.widths) < 1, JSON.stringify(layout));
      assert.ok(layout.centered < 1 && !layout.clipped, JSON.stringify(layout));
    };
    await checkTabs();
    await page.setViewportSize({ width: 1100, height: 1100 });
    await checkTabs();
    await page.setViewportSize({ width: 1440, height: 1100 });
    const countRows = async (key, expected) => {
      await page.waitForFunction(({ key, expected }) => {
        const rows = [...document.querySelectorAll('#' + key + '-body > tr')].filter(row => !row.querySelector('td[colspan]'));
        return rows.length === expected;
      }, { key, expected }, { timeout: 10000 });
    };
    await page.evaluate(() => showModule('inv'));
    await countRows('inv', 3);
    await page.selectOption('#inv-company-filter', '1');
    await countRows('inv', 2);
    await page.fill('#inv-fy-year', '2026');
    await page.locator('#inv-fy-year').dispatchEvent('change');
    await countRows('inv', 1);
    assert.equal(await page.getAttribute('#inv-fy-all', 'aria-pressed'), 'false');
    assert.ok(invoiceQueries.some(query => query.includes('from=2026-04-01') && query.includes('to=2027-03-31')));

    for (const key of ['pay', 'pro', 'quo', 'po', 'clt', 'ven', 'cwo', 'vwo', 'prj']) {
      await page.evaluate(key => showModule(key), key);
      await countRows(key, 1);
      assert.equal(await page.inputValue('#' + key + '-company-filter'), '1');
      assert.equal(await page.inputValue('#' + key + '-fy-year'), '2026');
      await page.fill('#' + key + '-search', 'no such record');
      await countRows(key, 0);
      await page.fill('#' + key + '-search', '');
      await countRows(key, 1);
      if (key === 'pay') {
        await page.selectOption('#pay-type', 'advance');
        await countRows(key, 0);
        await page.selectOption('#pay-type', '');
      } else {
        await page.selectOption('#' + key + '-status', key === 'clt' || key === 'ven' ? 'Inactive' : ['prj', 'cwo', 'vwo'].includes(key) ? 'Completed' : 'Sent');
        await countRows(key, 0);
        await page.selectOption('#' + key + '-status', '');
      }
      await countRows(key, 1);
      console.log('PASS browser filters: ' + key);
    }
    await page.evaluate(() => showModule('tds'));
    await countRows('tds', 3);
    assert.equal(await page.inputValue('#tds-company-filter'), '1');
    assert.equal(await page.inputValue('#tds-fy-year'), '2026');
    await page.selectOption('#tds-status', 'Inactive');
    await countRows('tds', 1);
    await page.selectOption('#tds-status', '');
    await countRows('tds', 4);
    await page.selectOption('#tds-status', 'Active');
    await countRows('tds', 3);
    await page.fill('#tds-search', '194C');
    await countRows('tds', 1);
    await page.fill('#tds-search', '');
    await countRows('tds', 3);
    await page.selectOption('#tds-payee-filter', 'Company');
    await countRows('tds', 1);
    await page.selectOption('#tds-section-filter', '194C');
    await countRows('tds', 0);
    await page.selectOption('#tds-payee-filter', 'Individual');
    await countRows('tds', 1);
    await page.selectOption('#tds-section-filter', '');
    await page.selectOption('#tds-payee-filter', '');
    await countRows('tds', 3);
    await page.selectOption('#tds-sort', 'rate_asc');
    await page.waitForFunction(() => document.querySelector('#tds-body tr').textContent.includes('TDS-ANY-DATE'));
    await page.evaluate(() => openTdsModal(101));
    await page.waitForSelector('#tds-modal.show');
    assert.equal(await page.inputValue('#tds-rule-company'), '1');
    assert.ok(await page.isDisabled('#tds-rule-company'));
    await page.evaluate(() => closeModal('tds-modal'));
    await page.selectOption('#tds-company-filter', '');
    await countRows('tds', 4);
    const writesBefore = tdsWrites.length;
    await page.evaluate(() => restoreTdsDefaults());
    assert.equal(tdsWrites.length, writesBefore);
    await page.evaluate(() => openTdsModal());
    await page.waitForSelector('#tds-modal.show');
    assert.equal(await page.inputValue('#tds-rule-company'), '');
    assert.ok(await page.isEnabled('#tds-rule-company'));
    await page.selectOption('#tds-rule-company', '2');
    await page.fill('#tds-code', 'TDS-NEW');
    await page.fill('#tds-nature', 'Test rule');
    await page.fill('#tds-rate', '2');
    await page.evaluate(() => saveTdsRule());
    await page.waitForFunction(() => !document.getElementById('tds-modal').classList.contains('show'));
    assert.equal(tdsWrites.at(-1).body.companyId, '2');
    await page.selectOption('#tds-company-filter', '1');
    await countRows('tds', 3);
    if (process.env.ACCOUNT_FILTER_SCREENSHOTS) {
      fs.mkdirSync(process.env.ACCOUNT_FILTER_SCREENSHOTS, { recursive: true });
      await page.evaluate(() => document.querySelectorAll('.toast').forEach(toast => toast.remove()));
      await page.screenshot({ path: path.join(process.env.ACCOUNT_FILTER_SCREENSHOTS, 'tds-desktop.png') });
      await page.locator('.acc-module-nav').screenshot({ path: path.join(process.env.ACCOUNT_FILTER_SCREENSHOTS, 'tabs-desktop.png') });
    }
    console.log('PASS TDS status/search/section/payee/rate/applicability and explicit create/edit company targets.');
    await page.evaluate(() => showModule('rep'));
    await countRows('rep', 1);
    for (const section of ['pro', 'quo', 'po', 'clt', 'ven', 'cwo', 'vwo', 'prj', 'inv']) {
      await page.selectOption('#rep-section', section);
      await countRows('rep', 1);
      if (section === 'cwo' || section === 'vwo') {
        assert.ok((await page.textContent('#rep-body')).includes('Zeta Client'));
        assert.ok((await page.textContent('#rep-body')).includes('2026-06-15'));
      }
    }
    await page.selectOption('#rep-section', 'pay');
    await countRows('rep', 1);
    const exportCount = await page.evaluate(() => {
      var exported;
      window.XLSX = { utils: { aoa_to_sheet: rows => { exported = rows; return {}; }, book_new: () => ({}), book_append_sheet: () => {} }, writeFile: () => {} };
      exportReportExcel();
      return exported.length - 1;
    });
    assert.equal(exportCount, 1);
    await page.selectOption('#rep-section', 'tds');
    await countRows('rep', 4);
    await page.selectOption('#rep-status', 'Active');
    await countRows('rep', 3);
    await page.selectOption('#rep-sort', 'rate_asc');
    await page.waitForFunction(() => document.querySelector('#rep-body tr').textContent.includes('TDS-ANY-DATE'));
    await page.evaluate(() => showModule('pro'));
    await page.fill('#pro-fy-year', '22222');
    await page.locator('#pro-fy-year').dispatchEvent('change');
    await countRows('pro', 0);
    assert.equal(await page.getAttribute('#pro-fy-year', 'aria-invalid'), 'true');
    await page.click('#pro-fy-all');
    await countRows('pro', 2);
    assert.equal(await page.getAttribute('#pro-fy-all', 'aria-pressed'), 'true');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('pro-fy-all')).backgroundColor === 'rgb(17, 17, 17)');
    await page.selectOption('#pro-sort', 'customer_asc');
    await page.waitForFunction(() => document.querySelector('#pro-body tr').textContent.includes('Alpha Client'));
    await page.selectOption('#pro-company-filter', '2');
    await countRows('pro', 1);
    assert.ok((await page.textContent('#pro-body')).includes('Beta Client'));
    await page.selectOption('#pro-company-filter', '1');
    await countRows('pro', 2);

    const screenshotDir = process.env.ACCOUNT_FILTER_SCREENSHOTS;
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.evaluate(() => document.querySelectorAll('.toast').forEach(toast => toast.remove()));
      await page.screenshot({ path: path.join(screenshotDir, 'desktop.png') });
    }
    await page.setViewportSize({ width: 390, height: 1000 });
    const bounds = await page.locator('#mod-pro .account-filter-bar').evaluate(el => {
      const bar = el.getBoundingClientRect();
      return { x: bar.x, right: bar.right, viewport: innerWidth,
        bad: [...el.querySelectorAll('input,select,button')].some(input => { const rect = input.getBoundingClientRect(); return rect.left < bar.left || rect.right > bar.right; }) };
    });
    assert.ok(bounds.x >= 0 && bounds.right <= bounds.viewport + 1 && !bounds.bad, JSON.stringify(bounds));
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'mobile.png') });
    await page.evaluate(() => showModule('tds'));
    await countRows('tds', 4);
    const tdsBounds = await page.locator('#mod-tds .account-filter-bar').evaluate(el => {
      const box = el.getBoundingClientRect();
      return { right: box.right, viewport: innerWidth, bad: [...el.querySelectorAll('input,select,button')].some(input => { const r = input.getBoundingClientRect(); return r.left < box.left || r.right > box.right; }) };
    });
    assert.ok(tdsBounds.right <= tdsBounds.viewport + 1 && !tdsBounds.bad, JSON.stringify(tdsBounds));
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'tds-mobile.png') });
    assert.deepEqual(errors, []);

    role = 'admin';
    await page.evaluate(() => localStorage.setItem('ems_user', JSON.stringify({ id: 1, name: 'QA User', role: 'admin', companyId: 1 })));
    await page.goto(origin + '/admin/accounts');
    assert.equal(await page.locator('[id$="-company-filter"]').count(), 0);
    await page.evaluate(() => showModule('ven'));
    await countRows('ven', 2);
    await page.evaluate(() => showModule('tds'));
    await countRows('tds', 4);
    await page.evaluate(() => openTdsModal());
    await page.waitForSelector('#tds-modal.show');
    assert.equal(await page.locator('#tds-rule-company').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS report export, invalid years, historical company options, mobile bounds and admin view.');
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
