const express = require('express');
const router  = express.Router();
const path    = require('path');
const multer  = require('multer');
const { auth, requireRole } = require('../middleware/auth');

// ─── Multer: documents (PDF only, 10MB) ───────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'documents');
    const fs = require('fs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed for document uploads'));
  },
});

// ─── Multer: photos (images, 5MB) ────────────────────────────────────────────
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'photos');
    const fs = require('fs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, 'photo-' + req.user.id + '-' + Date.now() + path.extname(file.originalname));
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP allowed'));
  },
});

// ─── Multer: notifications (multiple types, 10MB) ─────────────────────────────
const notifUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.xlsx', '.xls', '.csv', '.txt', '.pptx'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
const authCtrl = require('../controllers/authController');
router.post('/auth/login', authCtrl.login);

// ─── Users ────────────────────────────────────────────────────────────────────
const userCtrl = require('../controllers/userController');
router.get('/users/me',                  auth, userCtrl.getMe);
router.put('/users/me/profile',          auth, userCtrl.updateMyProfile);
router.post('/users/me/photo',           auth, photoUpload.single('photo'), userCtrl.uploadPhoto);
router.get('/users/:id/photo',           userCtrl.getPhoto);
router.post('/users/change-password',    auth, userCtrl.changeOwnPassword);
router.post('/users/:id/reset-password', auth, requireRole('admin', 'superadmin'), userCtrl.resetPassword);
router.get('/users/:id/details',         auth, requireRole('admin', 'superadmin'), userCtrl.getUserDetails);
router.get('/users',                     auth, requireRole('admin', 'manager', 'superadmin'), userCtrl.getUsers);
router.post('/users',                    auth, requireRole('admin', 'superadmin'), userCtrl.createUser);
router.put('/users/:id',                 auth, requireRole('admin', 'superadmin'), userCtrl.updateUser);
router.patch('/users/:id/verify',        auth, requireRole('admin', 'superadmin'), userCtrl.verifyEmployee);
router.delete('/users/:id',              auth, requireRole('admin', 'superadmin'), userCtrl.deleteUser);

// ─── Leaves ───────────────────────────────────────────────────────────────────
const leaveCtrl = require('../controllers/leaveController');
router.get('/leaves',                auth, leaveCtrl.getLeaves);
router.post('/leaves',               auth, leaveCtrl.createLeave);
router.patch('/leaves/:id/action',   auth, requireRole('manager', 'admin', 'superadmin'), leaveCtrl.actionLeave);
router.delete('/leaves/:id',         auth, leaveCtrl.deleteLeave);

// ─── Timesheets ───────────────────────────────────────────────────────────────
const tsCtrl = require('../controllers/timesheetController');
router.get('/timesheets',              auth, tsCtrl.getTimesheets);
router.get('/timesheets/check',        auth, tsCtrl.checkExisting);
router.post('/timesheets',             auth, tsCtrl.createTimesheet);
router.put('/timesheets/:id',          auth, tsCtrl.updateTimesheet);
router.patch('/timesheets/:id/action', auth, requireRole('manager', 'admin', 'superadmin'), tsCtrl.actionTimesheet);
router.delete('/timesheets/:id',       auth, tsCtrl.deleteTimesheet);

// ─── Salary ───────────────────────────────────────────────────────────────────
const salaryCtrl = require('../controllers/salaryController');
router.get('/salary',                    auth, salaryCtrl.getSalaries);
router.get('/salary/export/csv',         auth, requireRole('admin', 'superadmin'), salaryCtrl.exportCSV);
router.get('/salary/preview',            auth, requireRole('admin', 'superadmin'), salaryCtrl.getSalaryPreview);
router.get('/salary/:id/payslip',        auth, salaryCtrl.generatePayslip);
router.post('/salary',                   auth, requireRole('admin', 'superadmin'), salaryCtrl.createSalary);
router.post('/salary/generate-bulk',     auth, requireRole('admin', 'superadmin'), salaryCtrl.generateBulk);
router.put('/salary/:id',                auth, requireRole('admin', 'superadmin'), salaryCtrl.updateSalary);
router.patch('/salary/:id/pay',          auth, requireRole('admin', 'superadmin'), salaryCtrl.paySalary);
router.delete('/salary/:id',             auth, requireRole('admin', 'superadmin'), salaryCtrl.deleteSalary);

// ─── Documents ────────────────────────────────────────────────────────────────
const docCtrl = require('../controllers/documentController');
router.get('/documents/mandatory-status/:userId', auth, requireRole('admin', 'superadmin', 'manager'), docCtrl.getMandatoryDocStatus);
router.get('/documents',                auth, docCtrl.getDocuments);
router.post('/documents',               auth, upload.single('file'), docCtrl.uploadDocument);
router.patch('/documents/:id/verify',   auth, requireRole('admin', 'superadmin', 'manager'), docCtrl.verifyDocument);
router.get('/documents/:id/download',   auth, docCtrl.downloadDocument);
router.get('/documents/:id/view',       auth, docCtrl.viewDocument);
router.delete('/documents/:id',         auth, docCtrl.deleteDocument);

// ─── Notifications ────────────────────────────────────────────────────────────
const notifCtrl = require('../controllers/notificationController');
router.get('/notifications/unread-count',      auth, notifCtrl.getUnreadCount);
router.patch('/notifications/mark-all-read',   auth, notifCtrl.markAllRead);
router.get('/notifications',                   auth, notifCtrl.getNotifications);
router.post('/notifications',                  auth, requireRole('admin', 'superadmin'), notifUpload.single('file'), notifCtrl.createNotification);
router.patch('/notifications/:id/toggle',      auth, requireRole('admin', 'superadmin'), notifCtrl.toggleNotification);
router.patch('/notifications/:id/read',        auth, notifCtrl.markRead);
router.patch('/notifications/:id',             auth, requireRole('admin', 'superadmin'), notifCtrl.editNotification);
router.delete('/notifications/:id',            auth, requireRole('admin', 'superadmin'), notifCtrl.deleteNotification);
router.get('/notifications/:id/download',      auth, notifCtrl.downloadFile);

// ─── Companies ────────────────────────────────────────────────────────────────
const companyCtrl = require('../controllers/companyController');
router.get('/companies/stats',           auth, requireRole('superadmin'), companyCtrl.getCompanyStats);
router.get('/companies',                 auth, requireRole('superadmin', 'admin'), companyCtrl.getCompanies);
router.post('/companies',                auth, requireRole('superadmin'), companyCtrl.createCompany);
router.put('/companies/own',             auth, requireRole('admin'), companyCtrl.updateOwnCompany);
router.put('/companies/:id',             auth, requireRole('superadmin'), companyCtrl.updateCompany);
router.post('/companies/:id/logo',       auth, requireRole('superadmin'), photoUpload.single('logo'), companyCtrl.uploadLogo);
router.get('/companies/:id/logo',        companyCtrl.getLogo);
router.delete('/companies/:id',          auth, requireRole('superadmin'), companyCtrl.deleteCompany);

// ─── App Settings ──────────────────────────────────────────────────────────────
const settingCtrl = require('../controllers/settingController');
router.get('/settings/login-hero',       settingCtrl.getPublicLoginHero);
router.get('/settings/login-hero/image', settingCtrl.getLoginHeroImage);
router.post('/settings/login-hero',      auth, requireRole('superadmin'), photoUpload.single('image'), settingCtrl.upsertLoginHero);

// ─── Recycle Bin ──────────────────────────────────────────────────────────────
const recycleBinCtrl = require('../controllers/recycleBinController');
router.get('/recycle-bin',             auth, requireRole('admin', 'superadmin'), recycleBinCtrl.getItems);
router.post('/recycle-bin/custom',     auth, requireRole('admin', 'superadmin'), recycleBinCtrl.storeCustomItem);
router.post('/recycle-bin/:id/restore',auth, requireRole('admin', 'superadmin'), recycleBinCtrl.restoreItem);
router.delete('/recycle-bin/:id',      auth, requireRole('admin', 'superadmin'), recycleBinCtrl.permanentDelete);
router.delete('/recycle-bin',          auth, requireRole('admin', 'superadmin'), recycleBinCtrl.emptyBin);

// ─── Tasks ────────────────────────────────────────────────────────────────────
const taskCtrl = require('../controllers/taskController');
router.get('/tasks',                              auth, taskCtrl.getTasks);
router.post('/tasks',                             auth, requireRole('manager', 'admin', 'superadmin'), taskCtrl.createTask);
router.put('/tasks/:id',                          auth, requireRole('manager', 'admin', 'superadmin'), taskCtrl.updateTask);
router.patch('/tasks/:id/status',                 auth, taskCtrl.updateTaskStatus);
router.patch('/tasks/:id/request-completion',     auth, taskCtrl.requestCompletion);
router.patch('/tasks/:id/approve-completion',     auth, requireRole('manager', 'admin', 'superadmin'), taskCtrl.approveCompletion);
router.patch('/tasks/:id/refuse',                 auth, taskCtrl.refuseTask);
router.delete('/tasks/:id',                       auth, requireRole('manager', 'admin', 'superadmin'), taskCtrl.deleteTask);

// ─── Projects ─────────────────────────────────────────────────────────────────
const projectCtrl = require('../controllers/projectController');
router.get('/projects',       auth, projectCtrl.getProjects);
router.post('/projects',      auth, requireRole('superadmin'), projectCtrl.createProject);
router.put('/projects/:id',   auth, requireRole('superadmin'), projectCtrl.updateProject);
router.delete('/projects/:id',auth, requireRole('superadmin'), projectCtrl.deleteProject);

// ─── Proformas (PDF only — data stored client-side) ───────────────────────────
const proformaCtrl = require('../controllers/proformaController');
router.post('/proformas/pdf', auth, requireRole('superadmin'), proformaCtrl.generatePDF);

// ─── Invoices ─────────────────────────────────────────────────────────────────
const invoiceCtrl = require('../controllers/invoiceController');
router.get('/invoices',              auth, requireRole('superadmin'), invoiceCtrl.getInvoices);
router.get('/invoices/:id',          auth, requireRole('superadmin'), invoiceCtrl.getInvoice);
router.post('/invoices',             auth, requireRole('superadmin'), invoiceCtrl.createInvoice);
router.put('/invoices/:id',          auth, requireRole('superadmin'), invoiceCtrl.updateInvoice);
router.patch('/invoices/:id/pay',    auth, requireRole('superadmin'), invoiceCtrl.markPaid);
router.get('/invoices/:id/pdf',      auth, requireRole('superadmin'), invoiceCtrl.downloadPDF);
router.delete('/invoices/:id',       auth, requireRole('superadmin'), invoiceCtrl.deleteInvoice);

// ─── Spreadsheet Workbooks ────────────────────────────────────────────────────
const ssCtrl = require('../controllers/spreadsheetController');
router.get('/spreadsheet',        auth, requireRole('admin', 'superadmin'), ssCtrl.getWorkbooks);
router.get('/spreadsheet/:id',    auth, requireRole('admin', 'superadmin'), ssCtrl.getWorkbook);
router.post('/spreadsheet',       auth, requireRole('admin', 'superadmin'), ssCtrl.createWorkbook);
router.put('/spreadsheet/:id',    auth, requireRole('admin', 'superadmin'), ssCtrl.updateWorkbook);
router.delete('/spreadsheet/:id', auth, requireRole('admin', 'superadmin'), ssCtrl.deleteWorkbook);

// ─── Company Policies ─────────────────────────────────────────────────────────
const policyCtrl = require('../controllers/policyController');
router.get('/policies',                   auth, policyCtrl.getPolicies);
router.post('/policies',                  auth, requireRole('superadmin', 'admin'), upload.single('file'), policyCtrl.createPolicy);
router.put('/policies/:id',               auth, requireRole('superadmin', 'admin'), upload.single('file'), policyCtrl.updatePolicy);
router.delete('/policies/:id',            auth, requireRole('superadmin', 'admin'), policyCtrl.deletePolicy);
router.get('/policies/:id/download',      auth, policyCtrl.downloadPolicy);
router.get('/policies/:id/view',          auth, policyCtrl.viewPolicy);

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ACCOUNTS MODULE — Interconnected Routes ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Vendors ──────────────────────────────────────────────────────────────────
const vendorCtrl = require('../controllers/vendorController');
router.get('/vendors',           auth, requireRole('superadmin'), vendorCtrl.getVendors);
router.get('/vendors/:id',       auth, requireRole('superadmin'), vendorCtrl.getVendor);
router.post('/vendors',          auth, requireRole('superadmin'), vendorCtrl.createVendor);
router.put('/vendors/:id',       auth, requireRole('superadmin'), vendorCtrl.updateVendor);
router.delete('/vendors/:id',    auth, requireRole('superadmin'), vendorCtrl.deleteVendor);

// ─── Clients ──────────────────────────────────────────────────────────────────
const clientCtrl = require('../controllers/clientController');
router.get('/clients',           auth, requireRole('superadmin'), clientCtrl.getClients);
router.get('/clients/:id',       auth, requireRole('superadmin'), clientCtrl.getClient);
router.post('/clients',          auth, requireRole('superadmin'), clientCtrl.createClient);
router.put('/clients/:id',       auth, requireRole('superadmin'), clientCtrl.updateClient);
router.delete('/clients/:id',    auth, requireRole('superadmin'), clientCtrl.deleteClient);

// ─── Quotations ───────────────────────────────────────────────────────────────
const quotationCtrl = require('../controllers/quotationController');
router.get('/quotations',                         auth, requireRole('superadmin'), quotationCtrl.getQuotations);
router.get('/quotations/:id',                     auth, requireRole('superadmin'), quotationCtrl.getQuotation);
router.post('/quotations',                        auth, requireRole('superadmin'), quotationCtrl.createQuotation);
router.put('/quotations/:id',                     auth, requireRole('superadmin'), quotationCtrl.updateQuotation);
router.delete('/quotations/:id',                  auth, requireRole('superadmin'), quotationCtrl.deleteQuotation);
router.post('/quotations/:id/convert-to-proforma',auth, requireRole('superadmin'), quotationCtrl.convertToProforma);
router.post('/quotations/:id/convert-to-invoice', auth, requireRole('superadmin'), quotationCtrl.convertToInvoice);

// ─── Proformas (DB-backed CRUD + conversion) ──────────────────────────────────
const proformaDbCtrl = require('../controllers/proformaDbController');
router.get('/proformas-db',                          auth, requireRole('superadmin'), proformaDbCtrl.getProformas);
router.get('/proformas-db/:id',                      auth, requireRole('superadmin'), proformaDbCtrl.getProforma);
router.post('/proformas-db',                         auth, requireRole('superadmin'), proformaDbCtrl.createProforma);
router.put('/proformas-db/:id',                      auth, requireRole('superadmin'), proformaDbCtrl.updateProforma);
router.delete('/proformas-db/:id',                   auth, requireRole('superadmin'), proformaDbCtrl.deleteProforma);
router.post('/proformas-db/:id/convert-to-invoice',  auth, requireRole('superadmin'), proformaDbCtrl.convertToInvoice);

// ─── Purchase Orders ──────────────────────────────────────────────────────────
const poCtrl = require('../controllers/purchaseOrderController');
router.get('/purchase-orders',        auth, requireRole('superadmin'), poCtrl.getPurchaseOrders);
router.get('/purchase-orders/:id',    auth, requireRole('superadmin'), poCtrl.getPurchaseOrder);
router.post('/purchase-orders',       auth, requireRole('superadmin'), poCtrl.createPurchaseOrder);
router.put('/purchase-orders/:id',    auth, requireRole('superadmin'), poCtrl.updatePurchaseOrder);
router.delete('/purchase-orders/:id', auth, requireRole('superadmin'), poCtrl.deletePurchaseOrder);

// ─── Work Orders (CWO + VWO) ─────────────────────────────────────────────────
const woCtrl = require('../controllers/workOrderController');
router.get('/work-orders',        auth, requireRole('superadmin'), woCtrl.getWorkOrders);
router.get('/work-orders/:id',    auth, requireRole('superadmin'), woCtrl.getWorkOrder);
router.post('/work-orders',       auth, requireRole('superadmin'), woCtrl.createWorkOrder);
router.put('/work-orders/:id',    auth, requireRole('superadmin'), woCtrl.updateWorkOrder);
router.delete('/work-orders/:id', auth, requireRole('superadmin'), woCtrl.deleteWorkOrder);

// ─── Project Accounts ────────────────────────────────────────────────────────
const paCtrl = require('../controllers/projectAccountController');
router.get('/project-accounts',        auth, requireRole('superadmin'), paCtrl.getProjectAccounts);
router.get('/project-accounts/:id',    auth, requireRole('superadmin'), paCtrl.getProjectAccount);
router.post('/project-accounts',       auth, requireRole('superadmin'), paCtrl.createProjectAccount);
router.put('/project-accounts/:id',    auth, requireRole('superadmin'), paCtrl.updateProjectAccount);
router.delete('/project-accounts/:id', auth, requireRole('superadmin'), paCtrl.deleteProjectAccount);

module.exports = router;

