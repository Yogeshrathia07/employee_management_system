const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Client = sequelize.define('Client', {
  clientCode:    { type: DataTypes.STRING(20),  allowNull: true, unique: true },
  name:          { type: DataTypes.STRING(200), allowNull: false },
  contactPerson: { type: DataTypes.STRING(200), defaultValue: '' },
  phone:         { type: DataTypes.STRING(20),  defaultValue: '' },
  email:         { type: DataTypes.STRING(200), defaultValue: '' },
  gstin:         { type: DataTypes.STRING(20),  defaultValue: '' },
  pan:           { type: DataTypes.STRING(20),  defaultValue: '' },
  billingAddress:{ type: DataTypes.TEXT,        defaultValue: '' },
  state:         { type: DataTypes.STRING(100), defaultValue: '' },
  stateCode:     { type: DataTypes.STRING(5),   defaultValue: '' },
  status:        { type: DataTypes.ENUM('Active', 'Inactive'), defaultValue: 'Active' },
  createdBy:     { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = Client;
