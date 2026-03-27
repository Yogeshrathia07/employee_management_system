const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Salary = sequelize.define('Salary', {
  userId: { type: DataTypes.INTEGER, allowNull: false },
  companyId: { type: DataTypes.INTEGER, allowNull: true },
  month: { type: DataTypes.INTEGER, allowNull: false },
  year: { type: DataTypes.INTEGER, allowNull: false },
  baseSalary: { type: DataTypes.FLOAT, defaultValue: 0 },
  expectedHours: { type: DataTypes.FLOAT, defaultValue: 160 },
  actualHours: { type: DataTypes.FLOAT, defaultValue: 0 },
  allowances: { type: DataTypes.FLOAT, defaultValue: 0 },
  deductions: { type: DataTypes.FLOAT, defaultValue: 0 },
  overtime: { type: DataTypes.FLOAT, defaultValue: 0 },
  overtimeRate: { type: DataTypes.FLOAT, defaultValue: 1.5 },
  netSalary: { type: DataTypes.FLOAT, defaultValue: 0 },
  status: { type: DataTypes.STRING(20), defaultValue: 'draft' },
  paidAt: { type: DataTypes.DATE, allowNull: true },
  notes: { type: DataTypes.TEXT, defaultValue: '' },
  // Employee bank details snapshot (at time of generation)
  empBankName: { type: DataTypes.STRING, defaultValue: '' },
  empBankAccount: { type: DataTypes.STRING, defaultValue: '' },
  empBankIfsc: { type: DataTypes.STRING, defaultValue: '' },
  // Breakdown details
  totalWorkDays: { type: DataTypes.INTEGER, defaultValue: 0 },
  presentDays: { type: DataTypes.INTEGER, defaultValue: 0 },
  absentDays: { type: DataTypes.INTEGER, defaultValue: 0 },
  overtimePay: { type: DataTypes.FLOAT, defaultValue: 0 },
  absentDeduction: { type: DataTypes.FLOAT, defaultValue: 0 },
  grossSalary: { type: DataTypes.FLOAT, defaultValue: 0 },
  // Audit
  generatedBy: { type: DataTypes.INTEGER, allowNull: true },
  finalizedBy: { type: DataTypes.INTEGER, allowNull: true },
  finalizedAt: { type: DataTypes.DATE, allowNull: true },
}, { timestamps: true });

function calcNetSalary(salary) {
  const hourlyRate = salary.expectedHours > 0 ? salary.baseSalary / salary.expectedHours : 0;
  salary.overtimePay = salary.overtime * hourlyRate * salary.overtimeRate;
  salary.grossSalary = salary.baseSalary + salary.allowances + salary.overtimePay;

  // Absent deduction: if actual hours < expected, deduct proportionally
  if (salary.actualHours < salary.expectedHours && salary.expectedHours > 0) {
    const missedHours = salary.expectedHours - salary.actualHours;
    salary.absentDeduction = missedHours * hourlyRate;
  } else {
    salary.absentDeduction = 0;
  }

  salary.netSalary = salary.grossSalary - salary.deductions - salary.absentDeduction;
  if (salary.netSalary < 0) salary.netSalary = 0;
}

Salary.beforeCreate(calcNetSalary);
Salary.beforeUpdate(calcNetSalary);

module.exports = Salary;
