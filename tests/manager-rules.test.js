'use strict';
// Rules found in the manager audit: what a manager may see and do.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Op } = require('sequelize');

process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-manager-'));
const models = require('../models');
const users = require('../controllers/userController');
const salary = require('../controllers/salaryController');
const documents = require('../controllers/documentController');
const tasks = require('../controllers/taskController');
const leaves = require('../controllers/leaveController');
const timesheets = require('../controllers/timesheetController');

const admin = { id: 2, role: 'admin', companyId: 1 };
const manager = { id: 3, role: 'manager', companyId: 1 };
const employee = { id: 4, role: 'employee', companyId: 1 };

function call(handler, user, { params = {}, body = {}, query = {} } = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {},
  };
  return Promise.resolve(handler({ user, params, body, query }, res)).then(() => res);
}
const saved = obj => Object.assign(obj, { save: async () => obj, destroy: async () => obj, toJSON: () => ({ ...obj }), changed: () => false });

test('a manager\'s team list leaves out pay; HR still sees it', async t => {
  let options;
  t.mock.method(models.User, 'findAll', async opts => { options = opts; return []; });
  await call(users.getUsers, manager);
  assert.deepEqual(options.where, { managerId: manager.id });
  for (const field of ['password', 'baseSalary', 'basicSalary', 'hra', 'bonus', 'esicApplicable']) {
    assert.ok(options.attributes.exclude.includes(field), field + ' is hidden from managers');
  }
  await call(users.getUsers, admin);
  assert.deepEqual(options.attributes.exclude, ['password']);
});

test('staff see their own salary only once HR has frozen it', async t => {
  let where;
  t.mock.method(models.Salary, 'findAll', async opts => { where = opts.where; return []; });
  for (const who of [manager, employee]) {
    await call(salary.getSalaries, who);
    assert.equal(where.userId, who.id);
    assert.deepEqual(where.status[Op.in], ['finalized', 'paid']);
  }
});

test('a manager cannot verify or reject a company-issued HR document', async t => {
  const offer = saved({ id: 7, userId: 4, type: 'offer_letter', issuedByCompany: true });
  t.mock.method(models.Document, 'findByPk', async () => offer);
  t.mock.method(models.User, 'findByPk', async () => ({ id: 4, managerId: manager.id, companyId: 1, role: 'employee' }));
  const res = await call(documents.verifyDocument, manager, { params: { id: 7 }, body: { status: 'rejected' } });
  assert.equal(res.statusCode, 403);
  assert.notEqual(offer.verificationStatus, 'rejected');
});

test('a manager working on a task from HR must request completion, but can close their own team\'s', async t => {
  const fromHr = saved({ id: 1, assignedTo: manager.id, assignedBy: admin.id, companyId: 1, status: 'in_progress' });
  t.mock.method(models.Task, 'findByPk', async () => fromHr);
  assert.equal((await call(tasks.updateTaskStatus, manager, { params: { id: 1 }, body: { status: 'done' } })).statusCode, 400);
  assert.equal((await call(tasks.updateTaskStatus, manager, { params: { id: 1 }, body: { status: 'in_progress' } })).statusCode, 200);
  const teamTask = saved({ id: 2, assignedTo: employee.id, assignedBy: manager.id, companyId: 1, status: 'in_progress' });
  t.mock.method(models.Task, 'findByPk', async () => teamTask);
  assert.equal((await call(tasks.updateTaskStatus, manager, { params: { id: 2 }, body: { status: 'done' } })).statusCode, 200);
});

test('a refused task that is reassigned or revised goes out again as a fresh task', async t => {
  const refused = () => saved({ id: 5, assignedTo: employee.id, assignedBy: manager.id, companyId: 1,
    status: 'todo', approvalStatus: 'refused', refusalReason: 'busy', refusedAt: new Date() });
  let task = refused();
  t.mock.method(models.Task, 'findByPk', async () => task);
  t.mock.method(models.User, 'findByPk', async () => ({ id: 9, role: 'employee', companyId: 1, managerId: manager.id }));
  await call(tasks.updateTask, manager, { params: { id: 5 }, body: { assignedTo: 9 } });
  assert.equal(task.approvalStatus, 'none');
  assert.equal(task.status, 'todo');
  assert.equal(task.refusalReason, null);
  task = refused();
  await call(tasks.updateTask, manager, { params: { id: 5 }, body: { dueDate: '2026-12-01' } });
  assert.equal(task.approvalStatus, 'none');
});

test('a manager\'s own and team leave lists hold requests only; the calendar keeps holidays', async t => {
  let where;
  t.mock.method(models.User, 'findAll', async () => [{ id: 4 }, { id: 5 }]);
  t.mock.method(models.Leave, 'findAll', async opts => { where = opts.where; return []; });
  await call(leaves.getLeaves, manager, { query: { scope: 'own' } });
  assert.deepEqual(where, { userId: manager.id });
  await call(leaves.getLeaves, manager, { query: { scope: 'team' } });
  assert.deepEqual(where, { userId: { [Op.in]: [4, 5] } });
  await call(leaves.getLeaves, manager);
  assert.ok(where[Op.or].some(clause => clause.type), 'calendar includes company holidays');
});

test('acting on a request whose employee was deleted gives a clear answer, not a crash', async t => {
  t.mock.method(models.Leave, 'findByPk', async () => saved({ id: 1, status: 'pending', type: 'casual', user: null }));
  const leave = await call(leaves.actionLeave, manager, { params: { id: 1 }, body: { action: 'approve' } });
  assert.equal(leave.statusCode, 404);
  t.mock.method(models.Timesheet, 'findByPk', async () => saved({ id: 1, status: 'pending', user: null }));
  const sheet = await call(timesheets.actionTimesheet, manager, { params: { id: 1 }, body: { action: 'approve' } });
  assert.equal(sheet.statusCode, 404);
});

test('manager screens never build markup from what people typed', () => {
  const root = path.resolve(__dirname, '..');
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const tasksPage = read('views/manager/tasks.ejs');
  assert.ok(!tasksPage.includes('JSON.stringify(t)'), 'task buttons pass ids, not task data');
  assert.ok(/esc\(t\.refusalReason\)/.test(tasksPage));
  assert.ok(/escapeHtml\(l\.reason\)/.test(read('views/manager/leaves.ejs')));
  assert.ok(/escapeHtml\(l\.reason\)/.test(read('views/manager/leave-calendar.ejs')));
  const sheet = read('views/manager/timesheets.ejs');
  assert.ok(/escH\(e\.description/.test(sheet) && /escH\(t\.notes\)/.test(sheet));
  const docs = read('views/manager/documents.ejs');
  assert.ok(!docs.includes('document.write'), 'documents open by id, not by writing their title into a page');
  assert.ok(!read('views/manager/policies.ejs').includes('JSON.stringify(p)'));
});
