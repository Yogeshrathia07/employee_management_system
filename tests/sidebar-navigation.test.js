'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { pageAuth } = require('../middleware/auth');
const root = path.resolve(__dirname, '..');

function renderSidebar(partial, sidebarRole, extra = {}) {
  const file = path.join(root, 'views/partials/sidebar-' + partial + '.ejs');
  return ejs.render(fs.readFileSync(file, 'utf8'), { sidebarRole, ...extra }, { filename: file });
}
const hrefs = html => [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);

for (const role of ['superadmin', 'admin', 'manager', 'employee']) {
  test(`${role}: canonical sidebar links all have server routes`, () => {
    const html = renderSidebar(role, role);
    const routes = new Set([...fs.readFileSync(path.join(root, 'server.js'), 'utf8').matchAll(/app\.get\('([^']+)'/g)].map(match => match[1]));
    assert.equal((html.match(/id="sidebar"/g) || []).length, 1);
    assert.ok(html.includes('data-sidebar-role="' + role + '"'));
    for (const href of hrefs(html)) assert.ok(routes.has(href), role + ': missing route ' + href);
    assert.equal(new Set(hrefs(html)).size, hrefs(html).length);
  });
  test(`${role}: automatic sidebar contains one visible role menu`, () => {
    const html = renderSidebar('auto', role);
    assert.equal((html.match(/id="sidebar"/g) || []).length, 1);
    assert.ok(!html.includes('display:none'));
    assert.deepEqual(hrefs(html), hrefs(renderSidebar(role, role)));
  });
  test(`${role}: page authentication publishes the verified role for sidebar rendering`, async t => {
    t.mock.method(jwt, 'verify', () => ({ id: 1 }));
    t.mock.method(User, 'findByPk', async () => ({ id: 1, role, status: 'active' }));
    const req = { headers: { authorization: 'Bearer test-token' }, baseUrl: '/' + role, path: '/dashboard' };
    const res = { locals: {}, redirect: value => assert.fail('Unexpected redirect: ' + value), clearCookie() {} };
    let next = false;
    await pageAuth(role)(req, res, () => { next = true; });
    assert.ok(next);
    assert.equal(res.locals.sidebarRole, role);
  });
}
test('shared admin pages preserve the entire superadmin menu', () => {
  assert.deepEqual(hrefs(renderSidebar('admin', 'superadmin')), hrefs(renderSidebar('superadmin', 'superadmin')));
  assert.deepEqual(hrefs(renderSidebar('admin', 'admin', { pageRole: 'superadmin' })), hrefs(renderSidebar('admin', 'admin')));
});
test('manager profile uses manager routes instead of employee-only links', () => {
  const html = renderSidebar('employee', 'manager');
  assert.deepEqual(hrefs(html), hrefs(renderSidebar('manager', 'manager')));
  assert.ok(!html.includes('href="/employee/'));
});
test('denied page access never exposes a privileged sidebar role', async t => {
  t.mock.method(jwt, 'verify', () => ({ id: 1 }));
  t.mock.method(User, 'findByPk', async () => ({ id: 1, role: 'admin', status: 'active' }));
  const res = { locals: {}, redirect(value) { this.destination = value; }, clearCookie() {} };
  await pageAuth('superadmin')({ headers: { authorization: 'Bearer test-token' }, path: '/superadmin/users' }, res, () => assert.fail('Unauthorized page access'));
  assert.equal(res.destination, '/admin/dashboard');
  assert.equal(res.locals.sidebarRole, undefined);
});

function fakeElement(href) {
  const classes = new Set();
  return { href, inert: false, isConnected: true, attrs: {},
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle(value, enabled) { enabled ? classes.add(value) : classes.delete(value); } },
    getAttribute(name) { return name === 'href' ? href : this.attrs[name]; },
    setAttribute(name, value) { this.attrs[name] = value; },
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); },
    removeAttribute(name) { delete this.attrs[name]; },
    contains() { return false; }
  };
}
function navigationFixture(pathname = '/admin/leaves', mobile = false, beforeApi = null) {
  const links = ['/admin/leaves', '/admin/leave-calendar', '/admin/leaves/archive', '/admin/accounts'].map(fakeElement);
  const sidebar = fakeElement(); sidebar.querySelectorAll = () => links;
  const overlay = fakeElement(), button = fakeElement();
  const listeners = { document: {}, window: {} };
  const state = { mobile };
  const document = { body: { style: { overflow: 'auto' } }, activeElement: button,
    getElementById: id => id === 'sidebar' ? sidebar : overlay,
    querySelectorAll: () => [button],
    addEventListener(name, fn) { (listeners.document[name] ||= []).push(fn); }
  };
  const window = { location: { origin: 'http://example.test', pathname }, matchMedia: () => ({ matches: state.mobile }),
    addEventListener(name, fn) { (listeners.window[name] ||= []).push(fn); }
  };
  const context = vm.createContext({ document, window, URL });
  if (beforeApi) beforeApi(context, { sidebar, overlay });
  const source = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  const start = source.indexOf('var sidebarNavigationBound');
  vm.runInContext(source.slice(start, source.indexOf('async function apiFetch', start)), context);
  return { context, window, document, sidebar, overlay, button, links, listeners, state };
}
test('only the longest exact or slash-delimited sidebar match is highlighted', () => {
  const f = navigationFixture('/admin/leaves/archive/12');
  f.context.initSidebarNavigation();
  assert.equal(f.links.filter(link => link.classList.contains('active')).length, 1);
  assert.equal(f.links[2].attrs['aria-current'], 'page');
  f.window.location.pathname = '/admin/leaves-old';
  f.context.initSidebarNavigation();
  assert.equal(f.links.filter(link => link.classList.contains('active')).length, 0);
});
test('sidebar initialization is idempotent and delegated clicks preserve native navigation', () => {
  const f = navigationFixture('/admin/accounts', true);
  f.context.initSidebarNavigation(); f.context.initSidebarNavigation();
  assert.equal(f.listeners.document.click.length, 1);
  f.context.openSidebar();
  let prevented = false;
  f.listeners.document.click[0]({ target: { closest: () => f.links[0] }, button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(f.sidebar.classList.contains('open'), false);
});
test('mobile open, toggle, Escape and desktop resize restore scroll and ARIA state', () => {
  const f = navigationFixture('/admin/accounts', true);
  f.context.initSidebarNavigation();
  assert.equal(f.sidebar.inert, true);
  f.context.toggleSidebar();
  assert.equal(f.document.body.style.overflow, 'hidden');
  assert.equal(f.button.attrs['aria-expanded'], 'true');
  assert.equal(f.sidebar.inert, false);
  f.listeners.document.keydown[0]({ key: 'Escape' });
  assert.equal(f.document.body.style.overflow, 'auto');
  assert.equal(f.overlay.classList.contains('show'), false);
  f.context.openSidebar(); f.state.mobile = false;
  f.listeners.window.resize[0]();
  assert.equal(f.sidebar.inert, false);
  assert.equal(f.sidebar.classList.contains('open'), false);
  assert.equal(f.button.attrs['aria-expanded'], 'false');
  assert.equal(f.document.body.style.overflow, 'auto');
});
test('the menu button works before api.js has loaded, and api.js takes over the open menu', () => {
  const head = fs.readFileSync(path.join(root, 'views/partials/head.ejs'), 'utf8');
  const early = head.match(/<script id="sidebar-early-controls">([\s\S]*?)<\/script>/)[1];
  let openedEarly = false;
  const f = navigationFixture('/admin/accounts', true, (context, parts) => {
    vm.runInContext(early, context);
    context.openSidebar(); // ☰ tapped while the page is still loading
    openedEarly = parts.sidebar.classList.contains('open') && parts.overlay.classList.contains('show');
  });
  assert.equal(openedEarly, true);
  f.context.initSidebarNavigation(); // api.js
  f.context.initSidebarNavigation(); // sidebar-fix.js on older pages
  assert.equal(f.sidebar.classList.contains('open'), true);
  assert.equal(f.sidebar.inert, false);
  assert.equal(f.button.attrs['aria-expanded'], 'true');
  assert.equal(f.document.body.style.overflow, 'hidden');
  f.context.closeSidebar();
  assert.equal(f.sidebar.classList.contains('open'), false);
  assert.equal(f.overlay.classList.contains('show'), false);
  assert.equal(f.document.body.style.overflow, 'auto');
});
