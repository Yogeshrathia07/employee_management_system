const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Proforma = sequelize.define('Proforma', {
  proformaNumber: { type: DataTypes.STRING(50), allowNull: false },
  clientId:       { type: DataTypes.INTEGER,    allowNull: true },
  sourceQuotationId: { type: DataTypes.INTEGER, allowNull: true },
  showTaxInPdf:   { type: DataTypes.BOOLEAN,    defaultValue: true },

  // Customer / Buyer
  customerName:      { type: DataTypes.STRING(200), defaultValue: '' },
  customerGstin:     { type: DataTypes.STRING(20),  defaultValue: '' },
  customerPan:       { type: DataTypes.STRING(20),  defaultValue: '' },
  customerEmail:     { type: DataTypes.STRING(200), defaultValue: '' },
  customerAddress:   { type: DataTypes.TEXT,        defaultValue: '' },
  customerState:     { type: DataTypes.STRING(100), defaultValue: '' },
  customerStateCode: { type: DataTypes.STRING(5),   defaultValue: '' },

  // Seller
  sellerName:      { type: DataTypes.STRING(200), defaultValue: '' },
  sellerGstin:     { type: DataTypes.STRING(20),  defaultValue: '' },
  sellerAddress:   { type: DataTypes.TEXT,        defaultValue: '' },
  sellerState:     { type: DataTypes.STRING(100), defaultValue: '' },
  sellerStateCode: { type: DataTypes.STRING(5),   defaultValue: '' },
  sellerPhone:     { type: DataTypes.STRING(20),  defaultValue: '' },
  sellerEmail:     { type: DataTypes.STRING(200), defaultValue: '' },
  sellerPan:       { type: DataTypes.STRING(20),  defaultValue: '' },

  // Dates
  date:         { type: DataTypes.DATEONLY, allowNull: false },
  validityDate: { type: DataTypes.DATEONLY, allowNull: true },
  placeOfSupply:{ type: DataTypes.STRING(150), defaultValue: '' },

  // Bill details
  billMonth:      { type: DataTypes.STRING(20),  defaultValue: '' },
  billPeriodFrom: { type: DataTypes.DATEONLY,    allowNull: true },
  billPeriodTo:   { type: DataTypes.DATEONLY,    allowNull: true },
  workOrder:      { type: DataTypes.STRING(200), defaultValue: '' },
  projectName:    { type: DataTypes.STRING(300), defaultValue: '' },
  workDetails:    { type: DataTypes.TEXT,        defaultValue: '' },

  // Items
  items: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    get() { try { return JSON.parse(this.getDataValue('items') || '[]'); } catch(e) { return []; } },
    set(v) { this.setDataValue('items', JSON.stringify(v || [])); },
  },

  // Tax
  sgstRate: { type: DataTypes.DECIMAL(5,2), defaultValue: 9 },
  cgstRate: { type: DataTypes.DECIMAL(5,2), defaultValue: 9 },

  subtotal:    { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  totalCgst:   { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  totalSgst:   { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  totalIgst:   { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  totalTax:    { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  roundOff:    { type: DataTypes.DECIMAL(8,2),  defaultValue: 0 },
  totalAmount: { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },

  // Payment & delivery
  paymentTerms:     { type: DataTypes.STRING(300), defaultValue: '' },
  deliveryTimeline: { type: DataTypes.STRING(300), defaultValue: '' },
  warranty:         { type: DataTypes.STRING(300), defaultValue: '' },

  // Bank details
  bankName:    { type: DataTypes.STRING(100), defaultValue: '' },
  bankAcName:  { type: DataTypes.STRING(150), defaultValue: '' },
  bankAccount: { type: DataTypes.STRING(50),  defaultValue: '' },
  bankIfsc:    { type: DataTypes.STRING(20),  defaultValue: '' },
  bankBranch:  { type: DataTypes.STRING(100), defaultValue: '' },

  // Status & conversion
  status: {
    type: DataTypes.ENUM('Draft','Sent','Confirmed','Rejected','Converted'),
    defaultValue: 'Draft',
  },
  convertedToInvoiceId: { type: DataTypes.INTEGER, allowNull: true },

  notes:           { type: DataTypes.TEXT, defaultValue: '' },
  termsConditions: { type: DataTypes.TEXT, defaultValue: '' },
  createdBy:       { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = Proforma;
