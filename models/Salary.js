const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Salary = sequelize.define('Salary', {
  userId:    { type: DataTypes.INTEGER, allowNull: false },
  companyId: { type: DataTypes.INTEGER, allowNull: true },
  month:     { type: DataTypes.INTEGER, allowNull: false },
  year:      { type: DataTypes.INTEGER, allowNull: false },

  // ── CTC & Attendance ──────────────────────────────────────────────
  baseSalary:   { type: DataTypes.FLOAT, defaultValue: 0 },  // CTC per month
  leaveTaken:   { type: DataTypes.FLOAT, defaultValue: 0 },  // Leave days taken
  allowedLeave: { type: DataTypes.FLOAT, defaultValue: 0 },  // Allowed leave days

  // ── Earnings components ───────────────────────────────────────────
  basicSalary:      { type: DataTypes.FLOAT, defaultValue: 0 },
  da:               { type: DataTypes.FLOAT, defaultValue: 0 },   // auto: 10% of prop CTC
  hra:              { type: DataTypes.FLOAT, defaultValue: 0 },
  conveyance:       { type: DataTypes.FLOAT, defaultValue: 0 },   // fixed input
  conveyanceWorking:{ type: DataTypes.FLOAT, defaultValue: 0 },   // auto: proportional
  medicalExpenses:  { type: DataTypes.FLOAT, defaultValue: 0 },   // fixed input
  medicalWorking:   { type: DataTypes.FLOAT, defaultValue: 0 },   // auto: proportional
  specialAllowance: { type: DataTypes.FLOAT, defaultValue: 0 },
  bonus:            { type: DataTypes.FLOAT, defaultValue: 0 },
  ta:               { type: DataTypes.FLOAT, defaultValue: 0 },   // Travel Allowance

  // ── Totals (auto-calculated) ──────────────────────────────────────
  allowances:  { type: DataTypes.FLOAT, defaultValue: 0 },  // sum of all allowances
  grossSalary: { type: DataTypes.FLOAT, defaultValue: 0 },

  // ── Deductions ────────────────────────────────────────────────────
  pfContribution:  { type: DataTypes.FLOAT, defaultValue: 0 },
  professionTax:   { type: DataTypes.FLOAT, defaultValue: 0 },
  tds:             { type: DataTypes.FLOAT, defaultValue: 0 },
  salaryAdvance:   { type: DataTypes.FLOAT, defaultValue: 0 },
  deductions:      { type: DataTypes.FLOAT, defaultValue: 0 },  // total deductions (auto)
  absentDeduction: { type: DataTypes.FLOAT, defaultValue: 0 },

  // ── Net pay ───────────────────────────────────────────────────────
  netSalary: { type: DataTypes.FLOAT, defaultValue: 0 },

  // ── Hours/days tracking ───────────────────────────────────────────
  expectedHours: { type: DataTypes.FLOAT, defaultValue: 160 },
  actualHours:   { type: DataTypes.FLOAT, defaultValue: 0 },
  overtime:      { type: DataTypes.FLOAT, defaultValue: 0 },
  overtimeRate:  { type: DataTypes.FLOAT, defaultValue: 1.5 },
  overtimePay:   { type: DataTypes.FLOAT, defaultValue: 0 },
  totalWorkDays: { type: DataTypes.INTEGER, defaultValue: 0 },
  presentDays:   { type: DataTypes.INTEGER, defaultValue: 0 },
  absentDays:    { type: DataTypes.INTEGER, defaultValue: 0 },

  // ── Status & audit ────────────────────────────────────────────────
  status:      { type: DataTypes.STRING(20), defaultValue: 'draft' },
  paidAt:      { type: DataTypes.DATE, allowNull: true },
  notes:       { type: DataTypes.TEXT, defaultValue: '' },
  generatedBy: { type: DataTypes.INTEGER, allowNull: true },
  finalizedBy: { type: DataTypes.INTEGER, allowNull: true },
  finalizedAt: { type: DataTypes.DATE, allowNull: true },

  currency:       { type: DataTypes.STRING(10), defaultValue: 'INR' },

  // ── Bank snapshot ─────────────────────────────────────────────────
  empBankName:    { type: DataTypes.STRING, defaultValue: '' },
  empBankAccount: { type: DataTypes.STRING, defaultValue: '' },
  empBankIfsc:    { type: DataTypes.STRING, defaultValue: '' },
}, { timestamps: true });

// ── Round to nearest 10 (DHPE-style) ─────────────────────────────────
function r10(n) { return Math.round((n || 0) / 10) * 10; }

function calcNetSalary(salary) {
  const calDays = (salary.month && salary.year)
    ? new Date(salary.year, salary.month, 0).getDate()
    : 30;
  const payrollDays = (salary.totalWorkDays && Number(salary.totalWorkDays) > 0)
    ? Number(salary.totalWorkDays)
    : calDays;
  const workedDays = Math.max(0, payrollDays - (salary.leaveTaken || 0));

  // CTC = sum of all fixed salary components
  salary.baseSalary = (salary.basicSalary || 0) + (salary.hra || 0)
    + (salary.conveyance || 0) + (salary.medicalExpenses || 0)
    + (salary.specialAllowance || 0) + (salary.bonus || 0) + (salary.ta || 0);

  // Proportional CTC → used for DA
  const ctc = salary.baseSalary;
  const propCtc = payrollDays > 0 ? r10(ctc / payrollDays * workedDays) : 0;

  // Auto-calculated earnings
  salary.da                 = r10(propCtc * 0.10);
  salary.conveyanceWorking  = payrollDays > 0 ? r10((salary.conveyance || 0) / payrollDays * workedDays) : (salary.conveyance || 0);
  salary.medicalWorking     = payrollDays > 0 ? r10((salary.medicalExpenses || 0) / payrollDays * workedDays) : (salary.medicalExpenses || 0);

  // Gross = basic + DA + HRA + conv(working) + medical(working) + special + bonus + TA
  salary.grossSalary = (salary.basicSalary || 0) + salary.da + (salary.hra || 0)
    + salary.conveyanceWorking + salary.medicalWorking
    + (salary.specialAllowance || 0) + (salary.bonus || 0) + (salary.ta || 0);

  // Sync allowances (non-basic additions)
  salary.allowances = salary.da + (salary.hra || 0) + salary.conveyanceWorking
    + salary.medicalWorking + (salary.specialAllowance || 0) + (salary.bonus || 0) + (salary.ta || 0);

  // Total deductions
  const totalDed = (salary.pfContribution || 0) + (salary.professionTax || 0)
    + (salary.tds || 0) + (salary.salaryAdvance || 0);
  salary.deductions      = totalDed;
  salary.absentDeduction = 0; // handled via proportional calc

  salary.netSalary = salary.grossSalary - totalDed;
  if (salary.netSalary < 0) salary.netSalary = 0;
}

Salary.beforeCreate(calcNetSalary);
Salary.beforeUpdate(calcNetSalary);

module.exports = Salary;
