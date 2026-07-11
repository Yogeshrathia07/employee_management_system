require('dotenv').config();
const express = require('express');
const path = require('path');
const ejs = require('ejs');
const { Op } = require('sequelize');

const { sequelize, Company, User } = require('./models');
const { pageAuth, redirectAuthenticatedUser } = require('./middleware/auth');
const { cleanupDuplicateIndexes } = require('./config/mysqlIndexCleanup');
const { getSuperadminCredentials } = require('./config/superadminCredentials');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads/photos', express.static(path.join(__dirname, 'uploads', 'photos')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.engine('ejs', (filePath, options, callback) => {
  ejs.renderFile(
    filePath,
    options,
    { root: path.join(__dirname, 'views'), views: [path.join(__dirname, 'views')] },
    callback
  );
});

app.use('/api', require('./routes/index'));

app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', redirectAuthenticatedUser, (req, res) => {
  const superadmin = getSuperadminCredentials();
  res.render('login', { superadminEmail: superadmin.email });
});

app.use('/employee', pageAuth('employee'));
app.use('/manager', pageAuth('manager'));
app.use('/admin', pageAuth('admin', 'superadmin'));
app.use('/superadmin', pageAuth('superadmin'));

app.get('/employee/dashboard', (req, res) => res.render('employee/dashboard', { title: 'Dashboard' }));
app.get('/employee/profile', (req, res) => res.render('employee/profile', { title: 'Profile' }));
app.get('/employee/leaves', (req, res) => res.render('employee/leaves', { title: 'Request Leave' }));
app.get('/employee/leave-calendar', (req, res) => res.render('employee/leave-calendar', { title: 'Leave Calendar' }));
app.get('/employee/timesheets', (req, res) => res.render('employee/timesheets', { title: 'Timesheets' }));
app.get('/employee/salary', (req, res) => res.redirect('/employee/profile#salary'));
app.get('/employee/documents', (req, res) => res.render('employee/documents', { title: 'Documents', pageRole: 'employee' }));
app.get('/employee/tasks', (req, res) => res.render('employee/tasks', { title: 'My Tasks' }));
app.get('/employee/policies', (req, res) => res.render('employee/policies', { title: 'Company Policy' }));
app.get('/employee/notifications-view', (req, res) => res.render('employee/notifications', { title: 'Notifications' }));

app.get('/manager/dashboard', (req, res) => res.render('manager/dashboard', { title: 'Dashboard' }));
app.get('/manager/profile', (req, res) => res.render('employee/profile', { title: 'Profile' }));
app.get('/manager/leaves', (req, res) => res.render('manager/leaves', { title: 'Leave Requests' }));
app.get('/manager/leave-calendar', (req, res) => res.render('manager/leave-calendar', { title: 'Leave Calendar' }));
app.get('/manager/timesheets', (req, res) => res.render('manager/timesheets', { title: 'Timesheets' }));
app.get('/manager/tasks', (req, res) => res.render('manager/tasks', { title: 'Assign Tasks' }));
app.get('/manager/policies', (req, res) => res.render('manager/policies', { title: 'Company Policy' }));
app.get('/manager/notifications-view', (req, res) => res.render('employee/notifications', { title: 'Notifications' }));
app.get('/manager/documents', (req, res) => res.render('manager/documents', { title: 'Team Documents' }));
app.get('/manager/my-documents', (req, res) => res.render('employee/documents', { title: 'My Documents', pageRole: 'manager' }));

app.get('/admin/dashboard', (req, res) => res.render('admin/dashboard', { title: 'Dashboard' }));
app.get('/admin/users', (req, res) => res.render('admin/users', { title: 'Employees' }));
app.get('/admin/leaves', (req, res) => res.render('admin/leaves', { title: 'Leave Management' }));
app.get('/admin/leave-calendar', (req, res) => res.render('admin/leave-calendar', { title: 'Leave Calendar' }));
app.get('/admin/timesheets', (req, res) => res.render('admin/timesheets', { title: 'Timesheets' }));
app.get('/admin/salary', (req, res) => res.render('admin/payroll_spreadsheet', { title: 'Payroll', pageRole: 'admin' }));
app.get('/admin/payroll-spreadsheet', (req, res) => res.redirect('/admin/salary'));
app.get('/admin/salary-slip-preview', (req, res) => res.render('admin/salary_slip_preview', { title: 'Salary Slip Preview' }));
app.get('/admin/documents', (req, res) => res.render('admin/documents', { title: 'Documents' }));
app.get('/admin/notifications', (req, res) => res.render('admin/notifications', { title: 'Notifications' }));
app.get('/admin/policies', (req, res) => res.render('admin/policies', { title: 'Company Policy' }));
app.get('/admin/recycle-bin', (req, res) => res.redirect('/admin/dashboard'));
app.get('/admin/tasks', (req, res) => res.render('admin/tasks', { title: 'Tasks' }));
app.get('/admin/accounts', (req, res) => res.render('superadmin/accounts', { title: 'Accounts', pageRole: 'admin' }));

app.get('/superadmin/dashboard', (req, res) => res.render('superadmin/dashboard', { title: 'Dashboard' }));
app.get('/superadmin/companies', (req, res) => res.render('superadmin/companies', { title: 'Companies' }));
app.get('/superadmin/users', (req, res) => res.render('superadmin/users', { title: 'All Users' }));
app.get('/superadmin/salary', (req, res) => res.render('admin/payroll_spreadsheet', { title: 'All Payroll', pageRole: 'superadmin' }));
app.get('/superadmin/recycle-bin', (req, res) => res.render('superadmin/recycle-bin', { title: 'Recycle Bin' }));
app.get('/superadmin/policies', (req, res) => res.render('superadmin/policies', { title: 'Company Policies' }));
app.get('/superadmin/accounts', (req, res) => res.render('superadmin/accounts', { title: 'Accounts', pageRole: 'superadmin' }));
app.get('/superadmin/projects', (req, res) => res.render('superadmin/projects', { title: 'Projects' }));
app.get('/superadmin/tasks', (req, res) => res.render('superadmin/tasks', { title: 'Tasks' }));

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ message: 'Route not found' });
  }
  res.redirect('/login');
});

const PORT = process.env.PORT || 5500;
const SHOULD_ALTER_SCHEMA = String(process.env.DB_SYNC_ALTER || 'true').toLowerCase() !== 'false';

sequelize.authenticate()
  .then(async () => {
    await cleanupDuplicateIndexes(sequelize, { logger: console.log });
    return sequelize.sync({ alter: SHOULD_ALTER_SCHEMA });
  })
  .then(async () => {
    console.log('MySQL connected & tables synced');
    if (!SHOULD_ALTER_SCHEMA) {
      console.log('Schema alter is disabled via DB_SYNC_ALTER=false');
    }
    await seedInitialData();
    const superadmin = getSuperadminCredentials();
    app.listen(PORT, () => {
      console.log(`\nEMS Platform running at http://localhost:${PORT}`);
      console.log(`Login page: http://localhost:${PORT}/login`);
      console.log('\nConfigured superadmin:');
      console.log(`   ${superadmin.email} (password from SUPERADMIN_PASSWORD)`);
      console.log('\nDemo accounts (password: EmsDemo@2026):');
      console.log('   Admin       : admin@demo.com');
      console.log('   Manager     : manager@demo.com');
      console.log('   Employee    : employee@demo.com\n');
    });
  })
  .catch(err => {
    console.error('MySQL connection failed:', err.message);
    process.exit(1);
  });

async function seedInitialData() {
  const superadminConfig = getSuperadminCredentials();
  const emailConflict = await User.findOne({
    where: {
      email: superadminConfig.email,
      role: { [Op.ne]: 'superadmin' },
    },
  });
  if (emailConflict) {
    throw new Error('SUPERADMIN_EMAIL is already used by another user');
  }

  let superadmin = await User.findOne({
    where: { role: 'superadmin' },
    order: [['id', 'ASC']],
  });

  if (!superadmin) {
    console.log('Creating env-configured superadmin account...');
    superadmin = await User.create({
      name: superadminConfig.name,
      email: superadminConfig.email,
      password: superadminConfig.password,
      role: 'superadmin',
      status: 'active',
    });
  } else {
    let changed = false;
    if (superadmin.name !== superadminConfig.name) {
      superadmin.name = superadminConfig.name;
      changed = true;
    }
    if (superadmin.email !== superadminConfig.email) {
      superadmin.email = superadminConfig.email;
      changed = true;
    }
    if (superadmin.status !== 'active') {
      superadmin.status = 'active';
      changed = true;
    }
    if (superadmin.companyId !== null) {
      superadmin.companyId = null;
      changed = true;
    }
    if (superadmin.role !== 'superadmin') {
      superadmin.role = 'superadmin';
      changed = true;
    }
    if (!(await superadmin.comparePassword(superadminConfig.password))) {
      superadmin.password = superadminConfig.password;
      changed = true;
    }
    if (changed) {
      await superadmin.save();
      console.log('Synced superadmin credentials from .env');
    }
  }

  const otherUsersCount = await User.count({
    where: { role: { [Op.ne]: 'superadmin' } },
  });
  if (otherUsersCount > 0) return;

  console.log('Seeding initial demo data...');

  let company = await Company.findOne({ where: { name: 'DHPE' } });
  if (!company) {
    company = await Company.create({
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
  }

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

  await User.create({
    name: 'Bob Smith',
    email: 'bob@demo.com',
    password: 'EmsDemo@2026',
    role: 'employee',
    companyId: company.id,
    managerId: manager.id,
    baseSalary: 38000,
    department: 'Engineering',
    status: 'active',
  });

  await User.create({
    name: 'Carol Jones',
    email: 'carol@demo.com',
    password: 'EmsDemo@2026',
    role: 'employee',
    companyId: company.id,
    managerId: manager.id,
    baseSalary: 42000,
    department: 'Design',
    status: 'active',
  });

  console.log('Seed data created successfully!');
}
