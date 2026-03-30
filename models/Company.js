const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Company = sequelize.define('Company', {
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false },
  phone: { type: DataTypes.STRING, defaultValue: '' },
  industry: { type: DataTypes.STRING, defaultValue: '' },
  address: { type: DataTypes.TEXT, defaultValue: '' },
  panNo: { type: DataTypes.STRING, defaultValue: '' },
  gstNo: { type: DataTypes.STRING, defaultValue: '' },
  status: { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
  // Bank details for payslip
  bankName: { type: DataTypes.STRING, defaultValue: '' },
  bankAccount: { type: DataTypes.STRING, defaultValue: '' },
  bankIfsc: { type: DataTypes.STRING, defaultValue: '' },
  // Branding — logoUrl stores filename of uploaded logo
  logoUrl: { type: DataTypes.STRING, defaultValue: '' },
  sealUrl: { type: DataTypes.STRING, defaultValue: '' },
  signatureUrl: { type: DataTypes.STRING, defaultValue: '' },
  authorizedSignatory: { type: DataTypes.STRING, defaultValue: '' },
  currency: { type: DataTypes.STRING(10), defaultValue: 'INR' },
}, { timestamps: true });

module.exports = Company;
