'use strict';
// Role and company boundaries for admin, manager and employee actions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-roles-'));
const models = require('../models');
const leaves = require('../controllers/leaveController');
const timesheets = require('../controllers/timesheetController');
const tasks = require('../controllers/taskController');
const users = require('../controllers/userController');
const notifications = require('../controllers/notificationController');
const policies = require('../controllers/policyController');
const salary = require('../controllers/salaryController');

const adminA = { id: 2, role: 'admin', companyId: 1 };
const adminB = { id: 20, role: 'admin', companyId: 2 };
const managerA = { id: 3, role: 'manager', companyId: 1 };
const employeeA = { id: 4, role: 'employee', companyId: 1 };
const employeeB = { id: 40, role: 'employee', companyId: 2 };

function call(handler, user, { params = {}, body = {}, query = {} } = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {}, download(file) { this.file = file; }, sendFile(file) { this.file = file; },
  };
  return Promise.resolve(handler({ user, params, body, query }, res)).then(() => res);
}
const saved = obj => Object.assign(obj, { save: async () => obj, destroy: async () => obj, toJSON: () => ({ ...obj }), changed: () => false });

test('leave: another company admin cannot approve or delete, and only HR adds holidays', async t => {
  const leave = saved({ id: 9, userId: 4, status: 'pending', type: 'casual', user: { id: 4, role: 'employee', managerId: 3, companyId: 1 } });
  t.mock.method(models.Leave, 'findByPk', async () => leave);
  assert.equal((await call(leaves.actionLeave, adminB, { params: { id: 9 }, body: { action: 'approve' } })).statusCode, 403);
  assert.equal((await call(leaves.deleteLeave, adminB, { params: { id: 9 } })).statusCode, 403);
  assert.equal(leave.status, 'pending');
  assert.equal((await call(leaves.actionLeave, managerA, { params: { id: 9 }, body: { action: 'bogus' } })).statusCode, 400);
  t.mock.method(models.User, 'findByPk', async () => ({ id: 4, gender: 'male' }));
  const holiday = await call(leaves.createLeave, employeeA, { body: { type: 'holiday', startDate: '2099-01-01', endDate: '2099-01-01' } });
  assert.equal(holiday.statusCode, 403);
});

test('timesheet: dates are required and another company admin cannot act on it', async t => {
  assert.equal((await call(timesheets.createTimesheet, employeeA, { body: { entries: [] } })).statusCode, 400);
  const ts = saved({ id: 5, userId: 4, status: 'pending', user: { id: 4, role: 'employee', managerId: 3, companyId: 1 } });
  t.mock.method(models.Timesheet, 'findByPk', async () => ts);
  for (const [handler, extra] of [[timesheets.actionTimesheet, { body: { action: 'approve' } }], [timesheets.updateTimesheet, { body: { notes: 'x' } }], [timesheets.deleteTimesheet, {}]]) {
    assert.equal((await call(handler, adminB, { params: { id: 5 }, ...extra })).statusCode, 403);
  }
  assert.equal(ts.status, 'pending');
});

test('tasks: managers assign only to their team, admins stay in their company', async t => {
  t.mock.method(models.User, 'findByPk', async id => ({ 4: { id: 4, role: 'employee', companyId: 1, managerId: 3 }, 40: { id: 40, role: 'employee', companyId: 2, managerId: 30 } })[id]);
  t.mock.method(models.Task, 'create', async data => ({ id: 1, ...data }));
  t.mock.method(models.Task, 'findByPk', async () => saved({ id: 1, assignedBy: 3, assignedTo: 4, companyId: 1 }));
  assert.equal((await call(tasks.createTask, managerA, { body: { title: 'x', assignedTo: 40 } })).statusCode, 403);
  assert.equal((await call(tasks.createTask, adminA, { body: { title: 'x', assignedTo: 40 } })).statusCode, 403);
  assert.equal((await call(tasks.createTask, managerA, { body: { title: 'x', assignedTo: 4 } })).statusCode, 201);
  const otherManager = { id: 30, role: 'manager', companyId: 2 };
  for (const [handler, body] of [[tasks.updateTask, { title: 'x' }], [tasks.updateTaskStatus, { status: 'done' }], [tasks.deleteTask, {}]]) {
    assert.equal((await call(handler, otherManager, { params: { id: 1 }, body })).statusCode, 403);
  }
  assert.equal((await call(tasks.approveCompletion, adminB, { params: { id: 1 } })).statusCode, 403);
  let where;
  t.mock.method(models.Task, 'findAll', async opts => { where = opts.where; return []; });
  await call(tasks.getTasks, adminB, { query: { companyId: 1 } });
  assert.equal(where.companyId, 2, 'admin cannot read another company through ?companyId');
});

test('users: admins manage only employees/managers of their company', async t => {
  t.mock.method(models.User, 'findOne', async () => null);
  t.mock.method(models.User, 'create', async data => saved({ id: 99, ...data }));
  for (const role of ['superadmin', 'admin']) {
    const res = await call(users.createUser, adminA, { body: { name: 'x', email: role + '@x.test', role } });
    assert.equal(res.statusCode, 403, 'admin created a ' + role);
  }
  t.mock.method(models.User, 'findByPk', async id => ({ 7: { id: 7, role: 'manager', companyId: 2 }, 8: saved({ id: 8, role: 'admin', companyId: 1 }) })[id]);
  assert.equal((await call(users.createUser, adminA, { body: { name: 'x', email: 'e@x.test', managerId: 7 } })).statusCode, 400);
  assert.equal((await call(users.resetPassword, adminA, { params: { id: 8 }, body: { newPassword: 'Takeover@123' } })).statusCode, 403);
  assert.equal((await call(users.updateUser, adminA, { params: { id: 8 }, body: { role: 'employee' } })).statusCode, 403);
});

test('profile photo cannot point at files outside the photos folder', async t => {
  const me = saved({ id: 4, profilePhoto: null });
  t.mock.method(models.User, 'findByPk', async () => me);
  await call(users.updateMyProfile, employeeA, { body: { profilePhoto: '../../server.js' } });
  assert.equal(me.profilePhoto, null);
  me.profilePhoto = '../../server.js';
  const res = await call(users.getPhoto, null, { params: { id: 4 } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.file, undefined);
});

test('notifications and policies stay inside their company; unread ignores hidden reads', async t => {
  t.mock.method(models.Notification, 'findByPk', async () => saved({ id: 1, companyId: 1, status: 'active', filePath: 'n.pdf' }));
  assert.equal((await call(notifications.downloadFile, employeeB, { params: { id: 1 } })).statusCode, 404);
  assert.equal((await call(notifications.deleteNotification, adminB, { params: { id: 1 } })).statusCode, 404);
  t.mock.method(models.Notification, 'findAll', async () => [{ id: 2 }]);
  t.mock.method(models.NotificationRead, 'count', async ({ where }) => (where.notificationId ? 0 : 5));
  assert.deepEqual((await call(notifications.getUnreadCount, employeeA)).body, { unread: 1 });
  t.mock.method(models.CompanyPolicy, 'findByPk', async () => saved({ id: 3, companyId: 1, isActive: true, fileUrl: 'p.pdf' }));
  assert.equal((await call(policies.viewPolicy, employeeB, { params: { id: 3 } })).statusCode, 404);
  assert.equal((await call(policies.updatePolicy, adminB, { params: { id: 3 }, body: { title: 'x' } })).statusCode, 404);
});

test('salary preview is limited to the admin company', async t => {
  t.mock.method(models.User, 'findByPk', async () => ({ id: 4, companyId: 1 }));
  const res = await call(salary.getSalaryPreview, adminB, { query: { userId: 4, month: 1, year: 2030 } });
  assert.equal(res.statusCode, 403);
});
