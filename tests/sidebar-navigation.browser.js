'use strict';
// Runs actual page routes and authentication with fixture users; API data is mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const ejs = require('ejs');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
const { User } = require('../models');
const { pageAuth } = require('../middleware/auth');

const root = path.resolve(__dirname, '..');
const secret = 'local-sidebar-navigation-regression-secret';
const previousSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = secret;
const company = { id: 1, name: 'Example Engineering', status: 'active' };
const roles = ['superadmin', 'admin', 'manager', 'employee'];
const users = roles.map((role, index) => ({ id: index + 1, name: 'QA ' + role,
  role, status: 'active', companyId: role === 'superadmin' ? null : 1,
  company: role === 'superadmin' ? null : company, verificationStatus: 'verified', email: role + '@example.test' }));
const originalFindByPk = User.findByPk;
User.findByPk = async id => users.find(user => user.id === Number(id));

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));
app.engine('ejs', (file, options, done) => ejs.renderFile(file, options, { root: path.join(root, 'views'), views: [path.join(root, 'views')] }, done));
app.use(express.static(path.join(root, 'public')));
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const routes = [...source.matchAll(/app\.get\('([^']+)', \(req, res\) => res\.render\('([^']+)', (\{[^\n]+\})\)\);/g)];
for (const [, url, view, data] of routes) {
  const role = url.split('/')[1];
  if (!roles.includes(role)) continue;
  const options = vm.runInNewContext('(' + data + ')');
  app.get(url, pageAuth(...(role === 'admin' ? ['admin', 'superadmin'] : [role])), (req, res) => res.render(view, options));
}
app.get('/login', (req, res) => res.status(401).send('Login required'));
app.use((req, res) => res.status(404).send('Missing route: ' + req.path));

function expectedLinks(role) {
  const file = path.join(root, 'views/partials/sidebar-' + role + '.ejs');
  return [...ejs.render(fs.readFileSync(file, 'utf8'), { sidebarRole: role }, { filename: file }).matchAll(/href="([^"]+)"/g)].map(match => match[1]);
}

(async () => {
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  let browser;
  let clicks = 0;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    const origin = 'http://127.0.0.1:' + server.address().port;
    for (const user of users) {
      const expected = expectedLinks(user.role);
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const token = jwt.sign({ id: user.id }, secret, { expiresIn: '1h' });
      await context.addCookies([{ name: 'token', value: token, url: origin, sameSite: 'Lax' }]);
      await context.addInitScript(({ token, user }) => {
        localStorage.setItem('ems_token', token);
        localStorage.setItem('ems_user', JSON.stringify(user));
      }, { token, user });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push({ path: new URL(page.url()).pathname, message: error.message }));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        // Calendar pages require their pinned application dependency, not a mock.
        if (url.href === 'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.10/index.global.min.js') return route.continue();
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        let data = [];
        if (url.pathname === '/api/users/me') data = user;
        else if (url.pathname === '/api/companies') data = [company];
        else if (url.pathname.includes('/settings/')) data = {};
        else if (url.pathname.includes('/spreadsheet')) data = { id: 1, sheets: [], cells: {}, metadata: {} };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      });
      const assertMenu = async destination => {
        assert.equal(new URL(page.url()).pathname, destination, user.role + ': destination');
        assert.equal(await page.locator('#sidebar').count(), 1);
        assert.equal(await page.getAttribute('#sidebar', 'data-sidebar-role'), user.role);
        assert.deepEqual(await page.locator('#sidebar .nav-link').evaluateAll(links => links.map(link => link.getAttribute('href'))), expected);
        assert.deepEqual(await page.locator('#sidebar .nav-link.active').evaluateAll(links => links.map(link => link.getAttribute('href'))), [destination]);
        assert.equal(await page.getAttribute('#sidebar .nav-link.active', 'aria-current'), 'page');
      };
      await page.goto(origin + '/' + user.role + '/dashboard');
      for (const destination of expected) {
        const [response] = await Promise.all([
          page.waitForNavigation({ waitUntil: 'load' }),
          page.locator('#sidebar .nav-link[href="' + destination + '"]').click()
        ]);
        assert.equal(response.status(), 200, destination);
        await assertMenu(destination);
        clicks++;
      }
      if (user.role === 'superadmin') {
        await page.evaluate(() => localStorage.setItem('ems_user', JSON.stringify({ id: 1, role: 'admin', name: 'Stale cached role' })));
        await page.goto(origin + '/admin/leaves');
        await assertMenu('/admin/leaves');
      }
      if (user.role === 'manager') {
        await page.goto(origin + '/manager/profile');
        await assertMenu('/manager/profile');
      }
      await page.setViewportSize({ width: 390, height: 850 });
      await page.goto(origin + '/' + user.role + '/dashboard');
      await page.locator('.mobile-menu-btn').click();
      await page.waitForFunction(() => document.getElementById('sidebar').classList.contains('open'));
      assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
      assert.equal(await page.getAttribute('.mobile-menu-btn', 'aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.getElementById('sidebar').classList.contains('open')), false);
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
      await page.locator('.mobile-menu-btn').click();
      await page.locator('#sidebarOverlay').click({ position: { x: 25, y: 120 } });
      assert.equal(await page.getAttribute('.mobile-menu-btn', 'aria-expanded'), 'false');
      await page.evaluate(() => {
        const nav = document.querySelector('#sidebar nav');
        nav.innerHTML = nav.innerHTML;
        initSidebarNavigation();
      });
      await page.locator('.mobile-menu-btn').click();
      const destination = expected[1];
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        page.locator('#sidebar .nav-link[href="' + destination + '"] .nav-icon').click()
      ]);
      await assertMenu(destination);
      clicks++;
      assert.equal(await page.evaluate(() => document.getElementById('sidebarOverlay').classList.contains('show')), false);
      await page.locator('.mobile-menu-btn').click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForFunction(() => !document.getElementById('sidebarOverlay').classList.contains('show'));
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
      assert.equal(await page.evaluate(() => document.getElementById('sidebar').inert), false);
      assert.deepEqual(pageErrors, [], JSON.stringify(pageErrors));
      console.log('PASS ' + user.role + ': ' + expected.length + ' sidebar links, active states, server role, and mobile interactions.');
      await context.close();
    }
    console.log('PASS: ' + clicks + ' real sidebar clicks across all four roles using authenticated page routes and fixture API data.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    User.findByPk = originalFindByPk;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
