const sequelize       = require('../config/database');
const Company         = require('./Company');
const User            = require('./User');
const Leave           = require('./Leave');
const Timesheet       = require('./Timesheet');
const Salary          = require('./Salary');
const Document        = require('./Document');
const Notification    = require('./Notification');
const NotificationRead= require('./NotificationRead');
const RecycleBin      = require('./RecycleBin');
const Task            = require('./Task');
const Project         = require('./Project');
const CompanyPolicy   = require('./CompanyPolicy');
const AppSetting            = require('./AppSetting');
const Invoice               = require('./Invoice');
const SpreadsheetWorkbook   = require('./SpreadsheetWorkbook');

// ─── Accounts Module Models ───
const Vendor          = require('./Vendor');
const Client          = require('./Client');
const Quotation       = require('./Quotation');
const Proforma        = require('./Proforma');
const PurchaseOrder   = require('./PurchaseOrder');
const WorkOrder       = require('./WorkOrder');
const ProjectAccount  = require('./ProjectAccount');

// ─── User <-> Company ───
User.belongsTo(Company, { foreignKey: 'companyId', as: 'company' });
Company.hasMany(User,   { foreignKey: 'companyId' });

// ─── User self-reference (manager) ───
User.belongsTo(User, { foreignKey: 'managerId', as: 'manager' });
User.hasMany(User,   { foreignKey: 'managerId', as: 'subordinates' });

// ─── Leave ───
Leave.belongsTo(User,    { foreignKey: 'userId',     as: 'user' });
Leave.belongsTo(User,    { foreignKey: 'approvedBy', as: 'approver' });
Leave.belongsTo(Company, { foreignKey: 'companyId',  as: 'company' });

// ─── Timesheet ───
Timesheet.belongsTo(User,    { foreignKey: 'userId',     as: 'user' });
Timesheet.belongsTo(User,    { foreignKey: 'approvedBy', as: 'approver' });
Timesheet.belongsTo(Company, { foreignKey: 'companyId',  as: 'company' });

// ─── Salary ───
Salary.belongsTo(User,    { foreignKey: 'userId',    as: 'user' });
Salary.belongsTo(Company, { foreignKey: 'companyId', as: 'company' });

// ─── Document ───
Document.belongsTo(User,    { foreignKey: 'userId',      as: 'user' });
Document.belongsTo(User,    { foreignKey: 'uploadedBy',  as: 'uploader' });
Document.belongsTo(User,    { foreignKey: 'verifiedBy',  as: 'verifier' });
Document.belongsTo(Company, { foreignKey: 'companyId',   as: 'company' });

// ─── Notification ───
Notification.belongsTo(User,    { foreignKey: 'createdBy',  as: 'creator' });
Notification.belongsTo(Company, { foreignKey: 'companyId',  as: 'company' });
Notification.hasMany(NotificationRead, { foreignKey: 'notificationId', as: 'reads' });
NotificationRead.belongsTo(Notification, { foreignKey: 'notificationId' });
NotificationRead.belongsTo(User,         { foreignKey: 'userId' });

// ─── RecycleBin ───
RecycleBin.belongsTo(User, { foreignKey: 'deletedBy', as: 'deleter' });

// ─── Task ───
Task.belongsTo(User,    { foreignKey: 'assignedTo', as: 'assignee' });
Task.belongsTo(User,    { foreignKey: 'assignedBy', as: 'assigner' });
Task.belongsTo(Company, { foreignKey: 'companyId',  as: 'company' });
User.hasMany(Task, { foreignKey: 'assignedTo', as: 'tasks' });

// ─── Project ───
Project.belongsTo(User,    { foreignKey: 'managerId', as: 'manager' });
Project.belongsTo(User,    { foreignKey: 'createdBy', as: 'creator' });
Project.belongsTo(Company, { foreignKey: 'companyId', as: 'company' });
User.hasMany(Project,      { foreignKey: 'managerId', as: 'projects' });

// ─── CompanyPolicy ───
CompanyPolicy.belongsTo(Company, { foreignKey: 'companyId', as: 'company' });
CompanyPolicy.belongsTo(User,    { foreignKey: 'createdBy', as: 'creator' });

// ─── SpreadsheetWorkbook ───
SpreadsheetWorkbook.belongsTo(User, { foreignKey: 'userId', as: 'owner' });

// ══════════════════════════════════════════════════════════════════════════
// ─── ACCOUNTS MODULE ASSOCIATIONS ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

// ─── Vendor Associations ───
Vendor.hasMany(PurchaseOrder, { foreignKey: 'vendorId', as: 'purchaseOrders' });
PurchaseOrder.belongsTo(Vendor, { foreignKey: 'vendorId', as: 'vendor' });

Vendor.hasMany(WorkOrder, { foreignKey: 'vendorId', as: 'vendorWorkOrders' });
WorkOrder.belongsTo(Vendor, { foreignKey: 'vendorId', as: 'vendor' });

Vendor.hasMany(Invoice, { foreignKey: 'vendorId', as: 'vendorInvoices' });

// ─── Client Associations ───
Client.hasMany(Quotation, { foreignKey: 'clientId', as: 'quotations' });
Quotation.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

Client.hasMany(Proforma, { foreignKey: 'clientId', as: 'proformas' });
Proforma.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

Client.hasMany(Invoice, { foreignKey: 'clientId', as: 'clientInvoices' });
Invoice.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

Client.hasMany(WorkOrder, { foreignKey: 'clientId', as: 'clientWorkOrders' });
WorkOrder.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

Client.hasMany(ProjectAccount, { foreignKey: 'clientId', as: 'projectAccounts' });
ProjectAccount.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

// ─── ProjectAccount Associations ───
ProjectAccount.hasMany(PurchaseOrder, { foreignKey: 'projectAccountId', as: 'purchaseOrders' });
PurchaseOrder.belongsTo(ProjectAccount, { foreignKey: 'projectAccountId', as: 'projectAccount' });

ProjectAccount.hasMany(Invoice, { foreignKey: 'projectAccountId', as: 'invoices' });
Invoice.belongsTo(ProjectAccount, { foreignKey: 'projectAccountId', as: 'projectAccount' });

ProjectAccount.hasMany(WorkOrder, { foreignKey: 'projectAccountId', as: 'workOrders' });
WorkOrder.belongsTo(ProjectAccount, { foreignKey: 'projectAccountId', as: 'projectAccount' });

// ─── Quotation → Proforma → Invoice conversion chain ───
Quotation.hasOne(Proforma, { foreignKey: 'sourceQuotationId', as: 'resultingProforma' });
Proforma.belongsTo(Quotation, { foreignKey: 'sourceQuotationId', as: 'sourceQuotation' });

Proforma.hasOne(Invoice, { foreignKey: 'sourceDocId', as: 'resultingInvoice',
  constraints: false, scope: { sourceDocType: 'proforma' } });

module.exports = {
  sequelize, Company, User, Leave, Timesheet, Salary,
  Document, Notification, NotificationRead, RecycleBin,
  Task, Project, CompanyPolicy, AppSetting, Invoice, SpreadsheetWorkbook,
  // Accounts
  Vendor, Client, Quotation, Proforma, PurchaseOrder, WorkOrder, ProjectAccount,
};
