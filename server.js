require('dotenv').config();
const express = require('express');
const path = require('path');
const { sequelize, Company, User } = require('./models');

const app = express();

// ─── Middleware ───
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads/photos', express.static(path.join(__dirname, 'uploads', 'photos')));

// ─── View Engine ───
const ejs = require('ejs');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.engine('ejs', (filePath, options, callback) => {
  ejs.renderFile(filePath, options, { root: path.join(__dirname, 'views'), views: [path.join(__dirname, 'views')] }, callback);
});

// ─── API Routes ───
app.use('/api', require('./routes/index'));

// ─── Page Routes ───

// Root redirect
app.get('/', (req, res) => res.redirect('/login'));

// Login
app.get('/login', (req, res) => res.render('login'));

// Employee pages
app.get('/employee/dashboard',      (req, res) => res.render('employee/dashboard',       { title: 'Dashboard' }));
app.get('/employee/profile',        (req, res) => res.render('employee/profile',         { title: 'Profile' }));
app.get('/employee/leaves',         (req, res) => res.render('employee/leaves',          { title: 'Request Leave' }));
app.get('/employee/leave-calendar', (req, res) => res.render('employee/leave-calendar',  { title: 'Leave Calendar' }));
app.get('/employee/timesheets',     (req, res) => res.render('employee/timesheets',      { title: 'Timesheets' }));
app.get('/employee/salary',         (req, res) => res.redirect('/employee/profile#salary'));
app.get('/employee/documents',      (req, res) => res.render('employee/documents',       { title: 'Documents' }));
app.get('/employee/tasks',          (req, res) => res.render('employee/tasks',           { title: 'My Tasks' }));
app.get('/employee/policies',       (req, res) => res.render('employee/policies',        { title: 'Company Policy' }));
app.get('/employee/notifications-view', (req, res) => res.render('employee/notifications', { title: 'Notifications' }));

// Manager pages
app.get('/manager/dashboard',       (req, res) => res.render('manager/dashboard',      { title: 'Dashboard' }));
app.get('/manager/profile',         (req, res) => res.render('employee/profile',       { title: 'Profile' }));
app.get('/manager/leaves',          (req, res) => res.render('manager/leaves',         { title: 'Leave Requests' }));
app.get('/manager/leave-calendar',  (req, res) => res.render('manager/leave-calendar', { title: 'Leave Calendar' }));
app.get('/manager/timesheets',      (req, res) => res.render('manager/timesheets',     { title: 'Timesheets' }));
app.get('/manager/tasks',           (req, res) => res.render('manager/tasks',          { title: 'Assign Tasks' }));
app.get('/manager/policies',             (req, res) => res.render('manager/policies',          { title: 'Company Policy' }));
app.get('/manager/notifications-view',   (req, res) => res.render('employee/notifications',      { title: 'Notifications' }));
app.get('/manager/documents',       (req, res) => res.render('manager/documents',      { title: 'Team Documents' }));

// Admin pages
app.get('/admin/dashboard',     (req, res) => res.render('admin/dashboard',     { title: 'Dashboard' }));
app.get('/admin/users',         (req, res) => res.render('admin/users',         { title: 'Employees' }));
app.get('/admin/leaves',        (req, res) => res.render('admin/leaves',        { title: 'Leave Management' }));
app.get('/admin/leave-calendar',(req, res) => res.render('admin/leave-calendar',{ title: 'Leave Calendar' }));
app.get('/admin/timesheets',    (req, res) => res.render('admin/timesheets',    { title: 'Timesheets' }));
app.get('/admin/salary',        (req, res) => res.render('admin/salary',        { title: 'Payroll' }));
app.get('/admin/documents',     (req, res) => res.render('admin/documents',     { title: 'Documents' }));
app.get('/admin/notifications', (req, res) => res.render('admin/notifications', { title: 'Notifications' }));
app.get('/admin/policies',      (req, res) => res.render('admin/policies',      { title: 'Company Policy' }));
app.get('/admin/recycle-bin',   (req, res) => res.render('admin/recycle-bin',   { title: 'Recycle Bin' }));

// Super Admin pages
app.get('/superadmin/dashboard',   (req, res) => res.render('superadmin/dashboard',   { title: 'Dashboard' }));
app.get('/superadmin/companies',   (req, res) => res.render('superadmin/companies',   { title: 'Companies' }));
app.get('/superadmin/users',       (req, res) => res.render('superadmin/users',       { title: 'All Users' }));
app.get('/superadmin/recycle-bin', (req, res) => res.render('superadmin/recycle-bin', { title: 'Recycle Bin' }));
app.get('/superadmin/policies',    (req, res) => res.render('superadmin/policies',    { title: 'Company Policies' }));
app.get('/superadmin/accounts',    (req, res) => res.render('superadmin/accounts',    { title: 'Accounts' }));

// 404 fallback
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ message: 'Route not found' });
  }
  res.redirect('/login');
});

// ── Pre-sync index cleanup ──────────────────────────────────────────────────
// MySQL has a hard limit of 64 indexes per table. Previous syncs with ENUM
// columns auto-created extra indexes. This helper drops all non-unique,
// non-primary indexes so alter can run cleanly.
async function dropExcessIndexes(tableName) {
  try {
    const [rows] = await sequelize.query(
      `SHOW INDEX FROM \`${tableName}\` WHERE Key_name != 'PRIMARY' AND Non_unique = 1`
    );
    for (const row of rows) {
      const keyName = row.Key_name;
      try {
        await sequelize.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${keyName}\``);
      } catch (_) { /* already gone or not droppable */ }
    }
  } catch (_) { /* table may not exist yet — that's fine */ }
}

const TABLE_NAMES = [
  'Users', 'Leaves', 'Timesheets', 'Salaries', 'Documents',
  'Notifications', 'NotificationReads', 'RecycleBins', 'Tasks', 'CompanyPolicies', 'Companies',
];

// ─── Database & Server Start ───
const PORT = process.env.PORT || 5500;

sequelize.authenticate()
  .then(async () => {
    // Drop excess indexes before alter to stay under MySQL's 64-key limit
    for (const t of TABLE_NAMES) await dropExcessIndexes(t);
    return sequelize.sync({ alter: true });
  })
  .then(async () => {
    console.log('MySQL connected & tables synced');
    await seedInitialData();
    app.listen(PORT, () => {
      console.log(`\nEMS Platform running at http://localhost:${PORT}`);
      console.log(`Login page: http://localhost:${PORT}/login`);
      console.log('\nDemo accounts (password: EmsDemo@2026):');
      console.log('   Super Admin : superadmin@ems.com');
      console.log('   Admin       : admin@demo.com');
      console.log('   Manager     : manager@demo.com');
      console.log('   Employee    : employee@demo.com\n');
    });
  })
  .catch(err => {
    console.error('MySQL connection failed:', err.message);

    process.exit(1);
  });

// ─── Seed Initial Data ───
async function seedInitialData() {
  const existing = await User.findOne({ where: { email: 'superadmin@ems.com' } });
  if (existing) return;

  console.log('Seeding initial data...');

  const company = await Company.create({
    name: 'DHPE',
    email: 'contact@dhpe.in',
    phone: '+91-9876543210',
    industry: 'Technology',
    address: '182/1 Purbachal, Rahara, Khardaha, North 24 PGS, Kolkata, West Bengal, Pin-700118',
    panNo: 'AJFPM8922M',
    gstNo: '19AJFPM8922M2ZJ',
    status: 'active',
    authorizedSignatory: 'Admin',
  });

  await User.create({
    name: 'Super Admin',
    email: 'superadmin@ems.com',
    password: 'EmsDemo@2026',
    role: 'superadmin',
    status: 'active',
  });

  await User.create({
    name: 'John Admin',
    email: 'admin@demo.com',
    password: 'EmsDemo@2026',
    role: 'admin',
    companyId: company.id,
    baseSalary: 80000,
    department: 'Management',
    status: 'active',
  });

  const manager = await User.create({
    name: 'Sarah Manager',
    email: 'manager@demo.com',
    password: 'EmsDemo@2026',
    role: 'manager',
    companyId: company.id,
    baseSalary: 60000,
    department: 'Engineering',
    status: 'active',
  });

  await User.create({
    name: 'Alex Employee',
    email: 'employee@demo.com',
    password: 'EmsDemo@2026',
    role: 'employee',
    companyId: company.id,
    managerId: manager.id,
    baseSalary: 40000,
    department: 'Engineering',
    status: 'active',
  });

  await User.bulkCreate([
    {
      name: 'Bob Smith',
      email: 'bob@demo.com',
      password: 'EmsDemo@2026',
      role: 'employee',
      companyId: company.id,
      managerId: manager.id,
      baseSalary: 38000,
      department: 'Engineering',
      status: 'active',
    },
    {
      name: 'Carol Jones',
      email: 'carol@demo.com',
      password: 'EmsDemo@2026',
      role: 'employee',
      companyId: company.id,
      managerId: manager.id,
      baseSalary: 42000,
      department: 'Design',
      status: 'active',
    },
  ], { individualHooks: true });

  console.log('Seed data created successfully!');
}
// — Superadmin can access admin pages directly —
// (already handled: superadmin sidebar links to /admin/* routes)
