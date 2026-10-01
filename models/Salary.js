const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const PayrollCalc = require('../public/js/payroll-calc');

const Salary = sequelize.define('Salary', {
  userId:    { type: DataTypes.INTEGER, allowNull: false },
  companyId: { type: DataTypes.INTEGER, allowNull: true },
  month:     { type: DataTypes.INTEGER, allowNull: false },
  year:      { type: DataTypes.INTEGER, allowNull: false },

  // ── CTC & Attendance ──────────────────────────────────────────────
  baseSalary:   { type: DataTypes.FLOAT, defaultValue: 0 },  // CTC per month
  leaveTaken:   { type: DataTypes.FLOAT, defaultValue: 0 },  // Leave days taken
  allowedLeave: { type: DataTypes.FLOAT, defaultValue: 0 },  // Allowed leave days
  totalDays:    { type: DataTypes.FLOAT, allowNull: true },  // Days in the pay period
  workedDays:   { type: DataTypes.FLOAT, allowNull: true },  // Payable days (incl. paid leave)
  paidLeave:    { type: DataTypes.FLOAT, defaultValue: 0 },  // auto: min(leaveTaken, allowedLeave)
  lopDays:      { type: DataTypes.FLOAT, defaultValue: 0 },  // auto: leave beyond allowance

  // ── Earnings components ───────────────────────────────────────────
  basicSalary:      { type: DataTypes.FLOAT, defaultValue: 0 },
  da:               { type: DataTypes.FLOAT, defaultValue: 0 },   // fixed input (Dearness Allowance)
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
  applyAbsentDeduction: { type: DataTypes.BOOLEAN, defaultValue: true },
  manualDeductionDays: { type: DataTypes.FLOAT, defaultValue: 0 },
  manualDeductionAmount: { type: DataTypes.FLOAT, defaultValue: 0 },

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
  notes:       { type: DataTypes.TEXT },
  generatedBy: { type: DataTypes.INTEGER, allowNull: true },
  finalizedBy: { type: DataTypes.INTEGER, allowNull: true },
  finalizedAt: { type: DataTypes.DATE, allowNull: true },

  currency:       { type: DataTypes.STRING(10), defaultValue: 'INR' },

  // ── Bank snapshot ─────────────────────────────────────────────────
  empBankName:    { type: DataTypes.STRING, defaultValue: '' },
  empBankAccount: { type: DataTypes.STRING, defaultValue: '' },
  empBankIfsc:    { type: DataTypes.STRING, defaultValue: '' },
}, { timestamps: true });

// Inputs for PayrollCalc. Rows saved before totalDays existed were written by
// the old payroll sheet, which kept its "Worked Days" in totalWorkDays against
// a calendar-day month — read them the same way so old slips keep their days.
function payrollInput(salary) {
  const s = salary && typeof salary.get === 'function' ? salary.get({ plain: true }) : (salary || {});
  const calDays = PayrollCalc.daysInMonth(s.month, s.year);
  let totalDays = Number(s.totalDays);
  let workedDays = s.workedDays;
  if (!(totalDays > 0)) {
    totalDays = calDays;
    const legacyWorked = Number(s.totalWorkDays);
    if ((workedDays === null || workedDays === undefined || workedDays === '') && legacyWorked > 0 && legacyWorked <= calDays) {
      workedDays = legacyWorked;
    }
  }
  return {
    month: s.month,
    year: s.year,
    totalDays,
    workedDays,
    allowedLeave: s.allowedLeave,
    leaveTaken: s.leaveTaken,
    basicSalary: s.basicSalary,
    da: s.da,
    hra: s.hra,
    conveyance: s.conveyance,
    medicalExpenses: s.medicalExpenses,
    specialAllowance: s.specialAllowance,
    bonus: s.bonus,
    ta: s.ta,
    pfContribution: s.pfContribution,
    professionTax: s.professionTax,
    tds: s.tds,
    salaryAdvance: s.salaryAdvance,
    manualDeductionAmount: s.manualDeductionAmount,
    applyAbsentDeduction: s.applyAbsentDeduction,
  };
}

function computePayroll(salary) {
  return PayrollCalc.compute(payrollInput(salary));
}

// Copy the calculated figures onto a record (instance or plain object).
function applyPayroll(target, calc) {
  target.totalDays         = calc.totalDays;
  target.workedDays        = calc.workedDays;
  target.paidLeave         = calc.paidLeave;
  target.lopDays           = calc.lopDays;
  target.totalWorkDays     = Math.round(calc.totalDays);
  target.presentDays       = Math.round(calc.presentDays);
  target.absentDays        = Math.round(calc.unpaidDays);
  target.baseSalary        = calc.ctc;
  target.conveyanceWorking = calc.conveyanceWorking;
  target.medicalWorking    = calc.medicalWorking;
  target.grossSalary       = calc.grossSalary;
  target.allowances        = calc.allowances;
  target.absentDeduction   = calc.absentDeduction;
  target.manualDeductionDays = 0; // no longer used in calculation
  target.deductions        = calc.totalDeductions;
  target.netSalary         = calc.netSalary;
  return target;
}

function calcNetSalary(salary) {
  applyPayroll(salary, computePayroll(salary));
}

Salary.beforeCreate(calcNetSalary);
Salary.beforeUpdate(calcNetSalary);

// Plain JSON with freshly calculated figures — what every API/PDF consumer shows.
Salary.withPayroll = function (salary) {
  const plain = salary && typeof salary.toJSON === 'function' ? salary.toJSON() : Object.assign({}, salary || {});
  const calc = computePayroll(plain);
  applyPayroll(plain, calc);
  plain.payroll = calc;
  return plain;
};
Salary.computePayroll = computePayroll;

module.exports = Salary;
