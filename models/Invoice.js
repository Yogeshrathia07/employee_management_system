const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Invoice = sequelize.define('Invoice', {

  // ── Identification ────────────────────────────────────────────────────────
  invoiceNumber: { type: DataTypes.STRING(50),  allowNull: false },
  documentType:  { type: DataTypes.STRING(50),  defaultValue: 'Tax Invoice' },
  invoiceType:   { type: DataTypes.ENUM('B2B', 'B2C'), defaultValue: 'B2B' },
  invoiceDate:   { type: DataTypes.DATEONLY,    allowNull: false },
  dueDate:       { type: DataTypes.DATEONLY,    allowNull: true },
  isRABill:      { type: DataTypes.BOOLEAN,     defaultValue: false },
  placeOfSupply: { type: DataTypes.STRING(150), defaultValue: '' },

  // ── Bill Period (optional) ───────────────────────────────────────────────
  billMonth:       { type: DataTypes.STRING(20),  defaultValue: '' },  // e.g. "Feb-26"
  billPeriodFrom:  { type: DataTypes.DATEONLY,    allowNull: true },
  billPeriodTo:    { type: DataTypes.DATEONLY,    allowNull: true },

  // ── Work Order / Project (optional) ─────────────────────────────────────
  workOrder:    { type: DataTypes.STRING(200), defaultValue: '' },
  projectName:  { type: DataTypes.STRING(300), defaultValue: '' },
  workDetails:  { type: DataTypes.TEXT,         defaultValue: '' },

  // ── Seller (Company) ─────────────────────────────────────────────────────
  sellerName:      { type: DataTypes.STRING(200), defaultValue: '' },
  sellerGstin:     { type: DataTypes.STRING(20),  defaultValue: '' },
  sellerAddress:   { type: DataTypes.TEXT,         defaultValue: '' },
  sellerState:     { type: DataTypes.STRING(100),  defaultValue: '' },
  sellerStateCode: { type: DataTypes.STRING(5),    defaultValue: '' },
  sellerPhone:     { type: DataTypes.STRING(20),   defaultValue: '' },
  sellerEmail:     { type: DataTypes.STRING(200),  defaultValue: '' },
  sellerPan:       { type: DataTypes.STRING(20),   defaultValue: '' },

  // ── Buyer (Customer) ─────────────────────────────────────────────────────
  customerName:      { type: DataTypes.STRING(200), defaultValue: '' },
  customerGstin:     { type: DataTypes.STRING(20),  defaultValue: '' },
  customerPan:       { type: DataTypes.STRING(20),  defaultValue: '' },
  customerEmail:     { type: DataTypes.STRING(200), defaultValue: '' },
  customerAddress:   { type: DataTypes.TEXT,         defaultValue: '' },
  customerState:     { type: DataTypes.STRING(100),  defaultValue: '' },
  customerStateCode: { type: DataTypes.STRING(5),    defaultValue: '' },

  // ── Line Items (JSON) ────────────────────────────────────────────────────
  items: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    get() {
      const v = this.getDataValue('items');
      try { return JSON.parse(v || '[]'); } catch (e) { return []; }
    },
    set(v) { this.setDataValue('items', JSON.stringify(v || [])); },
  },

  // ── Tax Rates (global) ───────────────────────────────────────────────────
  sgstRate: { type: DataTypes.DECIMAL(5, 2), defaultValue: 9 },
  cgstRate: { type: DataTypes.DECIMAL(5, 2), defaultValue: 9 },

  // ── Tax Totals ────────────────────────────────────────────────────────────
  subtotal:    { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
  totalCgst:   { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
  totalSgst:   { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
  totalIgst:   { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
  totalTax:    { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
  roundOff:    { type: DataTypes.DECIMAL(8, 2),  defaultValue: 0 },
  totalAmount: { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },

  // ── Payment ───────────────────────────────────────────────────────────────
  paymentStatus: { type: DataTypes.ENUM('Unpaid', 'Paid', 'Partial'), defaultValue: 'Unpaid' },
  paymentMode:   { type: DataTypes.STRING(50), defaultValue: '' },
  paidAt:        { type: DataTypes.DATE, allowNull: true },

  // ── Bank Details ──────────────────────────────────────────────────────────
  bankName:    { type: DataTypes.STRING(100), defaultValue: '' },
  bankAcName:  { type: DataTypes.STRING(150), defaultValue: '' },
  bankAccount: { type: DataTypes.STRING(50),  defaultValue: '' },
  bankIfsc:    { type: DataTypes.STRING(20),  defaultValue: '' },
  bankBranch:  { type: DataTypes.STRING(100), defaultValue: '' },

  // ── Document Status ───────────────────────────────────────────────────────
  status: {
    type: DataTypes.ENUM('Draft', 'Sent', 'Paid', 'Overdue', 'Cancelled'),
    defaultValue: 'Draft',
  },

  // ── Notes ─────────────────────────────────────────────────────────────────
  notes:           { type: DataTypes.TEXT, defaultValue: '' },
  termsConditions: { type: DataTypes.TEXT, defaultValue: '' },

  // ── Metadata ──────────────────────────────────────────────────────────────
  createdBy: { type: DataTypes.INTEGER, allowNull: true },

}, { timestamps: true });

module.exports = Invoice;
