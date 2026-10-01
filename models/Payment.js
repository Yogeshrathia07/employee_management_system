const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// One record per payment received, with its full breakup:
// Net = Gross + GST − TDS − GST TDS − Retention − Advance Recovery − Other Recovery
// Fresh definition objects per column (Sequelize mutates them while defining).
const money = () => ({ type: DataTypes.DECIMAL(14, 2), defaultValue: 0 });
const percent = () => ({ type: DataTypes.DECIMAL(6, 3), defaultValue: 0 });

const Payment = sequelize.define('Payment', {
  paymentNumber: { type: DataTypes.STRING(40), allowNull: false },
  paymentType:   { type: DataTypes.STRING(20), defaultValue: 'bill' },   // bill | advance
  companyId:     { type: DataTypes.INTEGER, allowNull: true },
  invoiceId:     { type: DataTypes.INTEGER, allowNull: true },
  clientId:      { type: DataTypes.INTEGER, allowNull: true },

  // Snapshot of the party / bill at the time of payment
  partyName:     { type: DataTypes.STRING(200), defaultValue: '' },
  partyGstin:    { type: DataTypes.STRING(20),  defaultValue: '' },
  partyPan:      { type: DataTypes.STRING(20),  defaultValue: '' },
  invoiceNumber: { type: DataTypes.STRING(60),  defaultValue: '' },
  raBillNo:      { type: DataTypes.INTEGER, allowNull: true },

  paymentDate:   { type: DataTypes.DATEONLY, allowNull: false },
  financialYear: { type: DataTypes.STRING(10), defaultValue: '' },
  paymentMode:   { type: DataTypes.STRING(40),  defaultValue: '' },
  referenceNo:   { type: DataTypes.STRING(120), defaultValue: '' },     // UTR / cheque / transaction no.
  bankName:      { type: DataTypes.STRING(120), defaultValue: '' },
  notes:         { type: DataTypes.TEXT },

  grossAmount: money(),              // bill / payment value excl. GST
  gstRate: percent(),
  gstAmount: money(),

  tdsRuleId:     { type: DataTypes.INTEGER, allowNull: true },
  tdsCode:       { type: DataTypes.STRING(30),  defaultValue: '' },
  tdsSection:    { type: DataTypes.STRING(20),  defaultValue: '' },
  tdsNature:     { type: DataTypes.STRING(120), defaultValue: '' },
  tdsRate: percent(),
  tdsBaseAmount: money(),              // amount TDS was calculated on (after threshold rules)
  tdsAmount: money(),
  tdsOverride:   { type: DataTypes.BOOLEAN, defaultValue: false },
  tdsNote:       { type: DataTypes.TEXT },

  gstTdsRate: percent(),
  gstTdsAmount: money(),
  retentionRate: percent(),
  retentionAmount: money(),
  advanceRecovery: money(),
  otherRecovery: money(),
  otherRecoveryNote: { type: DataTypes.STRING(200), defaultValue: '' },

  totalDeductions: money(),
  netAmount: money(),            // net payable / received

  createdBy:     { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = Payment;
