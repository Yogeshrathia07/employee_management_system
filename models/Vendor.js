const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Vendor = sequelize.define('Vendor', {
  vendorCode:    { type: DataTypes.STRING(20),  allowNull: true, unique: true },
  name:          { type: DataTypes.STRING(200), allowNull: false },
  contactPerson: { type: DataTypes.STRING(200), defaultValue: '' },
  phone:         { type: DataTypes.STRING(20),  defaultValue: '' },
  email:         { type: DataTypes.STRING(200), defaultValue: '' },
  category:      { type: DataTypes.STRING(100), defaultValue: '' },
  gstin:         { type: DataTypes.STRING(20),  defaultValue: '' },
  pan:           { type: DataTypes.STRING(20),  defaultValue: '' },
  address:       { type: DataTypes.TEXT,        defaultValue: '' },
  state:         { type: DataTypes.STRING(100), defaultValue: '' },
  stateCode:     { type: DataTypes.STRING(5),   defaultValue: '' },

  // Bank details
  bankName:    { type: DataTypes.STRING(100), defaultValue: '' },
  bankAcName:  { type: DataTypes.STRING(150), defaultValue: '' },
  bankAccount: { type: DataTypes.STRING(50),  defaultValue: '' },
  bankIfsc:    { type: DataTypes.STRING(20),  defaultValue: '' },
  bankBranch:  { type: DataTypes.STRING(100), defaultValue: '' },

  paymentTerms: { type: DataTypes.STRING(200), defaultValue: '' },
  status:       { type: DataTypes.ENUM('Active', 'Inactive'), defaultValue: 'Active' },
  createdBy:    { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = Vendor;
