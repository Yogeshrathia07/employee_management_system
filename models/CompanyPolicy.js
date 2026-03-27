const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CompanyPolicy = sequelize.define('CompanyPolicy', {
  companyId:  { type: DataTypes.INTEGER, allowNull: false },
  title:      { type: DataTypes.STRING, allowNull: false },
  content:    { type: DataTypes.TEXT, defaultValue: '' },
  fileUrl:    { type: DataTypes.STRING, defaultValue: '' },   // Optional PDF attachment filename
  createdBy:  { type: DataTypes.INTEGER, allowNull: false },
  isActive:   { type: DataTypes.BOOLEAN, defaultValue: true },
}, { timestamps: true });

module.exports = CompanyPolicy;
