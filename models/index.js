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
const CompanyPolicy   = require('./CompanyPolicy');
const AppSetting      = require('./AppSetting');

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

// ─── CompanyPolicy ───
CompanyPolicy.belongsTo(Company, { foreignKey: 'companyId', as: 'company' });
CompanyPolicy.belongsTo(User,    { foreignKey: 'createdBy', as: 'creator' });

module.exports = {
  sequelize, Company, User, Leave, Timesheet, Salary,
  Document, Notification, NotificationRead, RecycleBin,
  Task, CompanyPolicy, AppSetting,
};
