const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Quotation = sequelize.define('Quotation', {
  quotationNumber: { type: DataTypes.STRING(50),  allowNull: false },
  clientId:        { type: DataTypes.INTEGER,     allowNull: true },
  clientName:      { type: DataTypes.STRING(200), defaultValue: '' },
  clientGstin:     { type: DataTypes.STRING(20),  defaultValue: '' },
  clientPan:       { type: DataTypes.STRING(20),  defaultValue: '' },
  clientEmail:     { type: DataTypes.STRING(200), defaultValue: '' },
  clientAddress:   { type: DataTypes.TEXT,        defaultValue: '' },
  clientState:     { type: DataTypes.STRING(100), defaultValue: '' },
  clientStateCode: { type: DataTypes.STRING(5),   defaultValue: '' },

  // Seller
  sellerName:      { type: DataTypes.STRING(200), defaultValue: '' },
  sellerGstin:     { type: DataTypes.STRING(20),  defaultValue: '' },
  sellerAddress:   { type: DataTypes.TEXT,        defaultValue: '' },
  sellerState:     { type: DataTypes.STRING(100), defaultValue: '' },
  sellerStateCode: { type: DataTypes.STRING(5),   defaultValue: '' },
  sellerPhone:     { type: DataTypes.STRING(20),  defaultValue: '' },
  sellerEmail:     { type: DataTypes.STRING(200), defaultValue: '' },
  sellerPan:       { type: DataTypes.STRING(20),  defaultValue: '' },

  date:      { type: DataTypes.DATEONLY, allowNull: false },
  validTill: { type: DataTypes.DATEONLY, allowNull: true },

  items: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    get() { try { return JSON.parse(this.getDataValue('items') || '[]'); } catch(e) { return []; } },
    set(v) { this.setDataValue('items', JSON.stringify(v || [])); },
  },

  subtotal:    { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  totalCgst:   { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  totalSgst:   { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  totalIgst:   { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  totalTax:    { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  roundOff:    { type: DataTypes.DECIMAL(8,2),  defaultValue: 0 },
  totalAmount: { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },

  sgstRate: { type: DataTypes.DECIMAL(5,2), defaultValue: 9 },
  cgstRate: { type: DataTypes.DECIMAL(5,2), defaultValue: 9 },

  status: {
    type: DataTypes.ENUM('Draft','Sent','Accepted','Rejected','Converted'),
    defaultValue: 'Draft',
  },
  notes:           { type: DataTypes.TEXT, defaultValue: '' },
  termsConditions: { type: DataTypes.TEXT, defaultValue: '' },

  // Conversion tracking
  convertedToId:   { type: DataTypes.INTEGER,    allowNull: true },
  convertedToType: { type: DataTypes.STRING(30), defaultValue: '' },

  // Bank details
  bankName:    { type: DataTypes.STRING(100), defaultValue: '' },
  bankAcName:  { type: DataTypes.STRING(150), defaultValue: '' },
  bankAccount: { type: DataTypes.STRING(50),  defaultValue: '' },
  bankIfsc:    { type: DataTypes.STRING(20),  defaultValue: '' },
  bankBranch:  { type: DataTypes.STRING(100), defaultValue: '' },

  createdBy: { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = Quotation;
